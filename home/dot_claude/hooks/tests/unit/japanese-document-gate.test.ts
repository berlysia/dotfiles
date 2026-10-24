import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  lutimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, it, mock } from "node:test";
import { gate } from "../../lib/japanese-document-gate/gate.ts";
import type { GateDeps } from "../../lib/japanese-document-gate/gate.ts";
import {
  autoTrackable,
  gitDocumentCandidates,
  inWorkflowDir,
} from "../../lib/japanese-document-gate/discovery.ts";
import type {
  Candidates,
  RunGit,
} from "../../lib/japanese-document-gate/discovery.ts";
import { analyzePublication } from "../../lib/japanese-document-gate/publication.ts";
import { getHomeDir } from "../../lib/path-utils.ts";
import { main } from "../../../japanese-check/cli.ts";
import {
  checkerVersion,
  clearCheckerVersionCache,
  recordCheck,
  recordDecision,
  verify,
} from "../../../japanese-check/receipts.ts";
import type { DependencyEntry } from "../../../japanese-check/deps.ts";
import { defaultStateDir, digest } from "../../../japanese-check/state.ts";
import {
  readMark,
  saveSnapshot,
  track,
  tracked,
} from "../../../japanese-check/tracking.ts";
import { shellSingleQuote } from "../../lib/shell-quote.ts";

const itUnlessRoot = { skip: process.getuid?.() === 0 };

describe("Japanese document receipts and completion gate", () => {
  const root = mkdtempSync(join(tmpdir(), "japanese-document-gate-"));
  after(() => rmSync(root, { recursive: true, force: true }));
  let number = 0;
  function fixture() {
    const key = String(++number);
    const file = join(root, `${key}.md`);
    const stateDir = join(root, `state-${key}`);
    const content = "人が読むための説明です。\n";
    writeFileSync(file, content);
    const session = `session-${key}`;
    const deps: GateDeps = {
      stateDir,
      candidates: () => ({ ok: true, paths: [] }),
      now: () => 0,
    };
    const input = (
      event: string,
      tool = "Write",
      args: Record<string, unknown> = { file_path: file },
      extra: Record<string, unknown> = {},
    ) => ({
      hook_event_name: event,
      session_id: session,
      cwd: root,
      tool_name: tool,
      tool_input: args,
      ...extra,
    });
    return { file, stateDir, content, session, deps, input };
  }

  it("registers an edited Japanese document and prevents completion until a full check", () => {
    const f = fixture();
    const notice = gate(f.input("PostToolUse"), f.deps);
    assert.ok(JSON.stringify(notice).includes("missing"));
    assert.equal(gate(f.input("Stop"), f.deps)?.decision, "block");
    recordCheck({
      file: f.file,
      expectedHash: digest(f.content),
      body: f.content,
      candidates: 0,
      stateDir: f.stateDir,
    });
    assert.equal(gate(f.input("Stop"), f.deps), null);
  });

  it("invalidates receipts when the body changes, including after review", () => {
    const f = fixture();
    track(f.file, f.session, f.stateDir);
    recordCheck({
      file: f.file,
      expectedHash: digest(f.content),
      body: f.content,
      candidates: 1,
      stateDir: f.stateDir,
    });
    assert.equal(verify(f.file, f.stateDir).status, "needs-review");
    recordDecision(
      f.file,
      digest(f.content),
      "用語として定義しているため残す",
      "checked",
      f.stateDir,
    );
    assert.equal(verify(f.file, f.stateDir).status, "ready");
    writeFileSync(f.file, "変更した説明です。\n");
    assert.equal(verify(f.file, f.stateDir).status, "stale");
    assert.equal(gate(f.input("Stop"), f.deps)?.decision, "block");
    assert.throws(
      () =>
        recordDecision(
          f.file,
          digest(f.content),
          "以前の理由",
          "checked",
          f.stateDir,
        ),
      /変更/u,
    );
  });

  it("requires current-hash review and never promotes candidates merely because check succeeded", () => {
    const f = fixture();
    assert.throws(
      () =>
        recordDecision(
          f.file,
          digest(f.content),
          "理由",
          "checked",
          f.stateDir,
        ),
      /先に/u,
    );
    recordCheck({
      file: f.file,
      expectedHash: digest(f.content),
      body: f.content,
      candidates: 2,
      stateDir: f.stateDir,
    });
    assert.equal(verify(f.file, f.stateDir).status, "needs-review");
    assert.throws(
      () =>
        recordDecision(f.file, digest(f.content), " ", "checked", f.stateDir),
      /理由/u,
    );
    assert.throws(
      () =>
        recordCheck({
          file: f.file,
          expectedHash: digest("違う内容"),
          body: f.content,
          candidates: 0,
          stateDir: f.stateDir,
        }),
      /変更/u,
    );
  });

  it("preserves an existing decision only for the exact same checked body", () => {
    const f = fixture();
    recordCheck({
      file: f.file,
      expectedHash: digest(f.content),
      body: f.content,
      candidates: 1,
      stateDir: f.stateDir,
    });
    recordDecision(
      f.file,
      digest(f.content),
      "字義どおりの用法",
      "checked",
      f.stateDir,
    );
    assert.equal(
      recordCheck({
        file: f.file,
        expectedHash: digest(f.content),
        body: f.content,
        candidates: 1,
        stateDir: f.stateDir,
      }).status,
      "ready",
    );
    assert.equal(
      recordCheck({
        file: f.file,
        expectedHash: digest(f.content),
        body: "別の抽出テキスト",
        candidates: 1,
        stateDir: f.stateDir,
      }).status,
      "needs-review",
    );
    recordDecision(
      f.file,
      digest(f.content),
      "抽出テキストを確認",
      "checked",
      f.stateDir,
    );
    assert.equal(
      recordCheck({
        file: f.file,
        expectedHash: digest(f.content),
        body: "別の抽出テキスト",
        candidates: 1,
        stateDir: f.stateDir,
        comparisonHash: digest("別の原文"),
      }).status,
      "needs-review",
    );
  });

  it("binds extracted text to the artifact bytes and invalidates on artifact changes", () => {
    const f = fixture();
    const artifact = join(root, `artifact-${number}.pdf`);
    writeFileSync(artifact, "binary-version-one");
    recordCheck({
      file: artifact,
      expectedHash: digest("binary-version-one"),
      body: f.content,
      candidates: 0,
      stateDir: f.stateDir,
    });
    assert.equal(verify(artifact, f.stateDir).status, "ready");
    writeFileSync(artifact, "binary-version-two");
    assert.equal(verify(artifact, f.stateDir).status, "stale");
  });

  it("lets unfinished drafts be reported but blocks their publication", () => {
    const f = fixture();
    track(f.file, f.session, f.stateDir);
    recordDecision(
      f.file,
      digest(f.content),
      "依存がなく検査できないため未検証の草稿",
      "draft",
      f.stateDir,
    );
    assert.equal(gate(f.input("Stop"), f.deps), null);
    const denial = gate(
      f.input("PreToolUse", "Bash", { command: "git push" }),
      f.deps,
    );
    assert.ok(JSON.stringify(denial).includes('"permissionDecision":"deny"'));
    assert.ok(JSON.stringify(denial).includes("draft"));
  });

  it("records explicit exclusions but invalidates them if a document later changes", () => {
    const f = fixture();
    track(f.file, f.session, f.stateDir);
    recordDecision(
      f.file,
      digest(f.content),
      "日本語のない成果物として確認",
      "excluded",
      f.stateDir,
    );
    assert.equal(gate(f.input("Stop"), f.deps), null);
    writeFileSync(f.file, "日本語の内容を追加。\n");
    assert.equal(gate(f.input("Stop"), f.deps)?.decision, "block");
  });

  it("attributes shell writes by the difference between this call's Pre and Post", () => {
    const f = fixture();
    const deps: GateDeps = {
      ...f.deps,
      candidates: () => ({ ok: true, paths: [f.file] }),
    };
    const bash = (event: string) =>
      f.input(
        event,
        "Bash",
        { command: "cat draft.md" },
        { tool_use_id: "t1" },
      );
    assert.equal(gate(bash("PreToolUse"), deps), null);
    assert.equal(gate(bash("PostToolUse"), deps), null);
    assert.equal(gate(f.input("Stop"), deps), null);
    const sed = (event: string) =>
      f.input(
        event,
        "Bash",
        { command: "sed draft.md" },
        { tool_use_id: "t2" },
      );
    gate(sed("PreToolUse"), deps);
    writeFileSync(f.file, "シェルで改稿した文書です。\n");
    assert.ok(gate(sed("PostToolUse"), deps));
    assert.equal(gate(f.input("Stop"), deps)?.decision, "block");
  });

  it("catches Codex patches and handles sessions independently", () => {
    const f = fixture();
    const patch = `*** Begin Patch\n*** Update File: ${f.file}\n@@\n-a\n+b\n*** End Patch`;
    assert.ok(
      gate(f.input("PostToolUse", "apply_patch", { command: patch }), f.deps),
    );
    assert.equal(
      gate({ ...f.input("Stop"), session_id: "other-session" }, f.deps),
      null,
    );
    assert.equal(gate(f.input("Stop"), f.deps)?.decision, "block");
  });

  it("ignores English-only files and agent-only instructions", () => {
    const f = fixture();
    writeFileSync(f.file, "Only English instructions.\n");
    assert.equal(gate(f.input("PostToolUse"), f.deps), null);
    const agentFile = join(root, "AGENTS.md");
    writeFileSync(agentFile, f.content);
    assert.equal(
      gate(f.input("PostToolUse", "Write", { file_path: agentFile }), f.deps),
      null,
    );
  });

  it("checks Japanese body files before posting and refuses inline unverified Japanese", () => {
    const f = fixture();
    assert.ok(
      JSON.stringify(
        gate(
          f.input("PreToolUse", "Bash", {
            command: `gh pr create --body-file '${f.file}'`,
          }),
          f.deps,
        ),
      ).includes('"permissionDecision":"deny"'),
    );
    assert.ok(
      JSON.stringify(
        gate(
          f.input("PreToolUse", "Bash", {
            command: 'gh issue create --body "日本語の本文"',
          }),
          f.deps,
        ),
      ).includes('"permissionDecision":"deny"'),
    );
  });

  it("stores hashes and reasons instead of source text, and hashes session ids", () => {
    const f = fixture();
    recordCheck({
      file: f.file,
      expectedHash: digest(f.content),
      body: f.content,
      candidates: 0,
      stateDir: f.stateDir,
    });
    const paths = readdirSync(join(f.stateDir, "receipts"));
    assert.equal(paths.length, 1);
    const saved = readFileSync(
      join(f.stateDir, "receipts", paths[0] ?? ""),
      "utf8",
    );
    assert.ok(!saved.includes(f.content.trim()));
    assert.ok(saved.includes(checkerVersion().hash));
    track(f.file, "../../untrusted-session", f.stateDir);
    assert.equal(readdirSync(join(f.stateDir, "sessions")).length, 1);
  });
});

describe("japanese-document-gate entry", () => {
  const entry = fileURLToPath(
    new URL("../../implementations/japanese-document-gate.ts", import.meta.url),
  );
  const dir = mkdtempSync(join(tmpdir(), "japanese-document-gate-entry-"));
  after(() => rmSync(dir, { recursive: true, force: true }));

  function launch(stdin: string) {
    // The default state dir is found by walking up to a `.git`; refuse to run
    // where that would land in a real repository.
    for (let d = dir; ; d = dirname(d)) {
      assert.equal(existsSync(join(d, ".git")), false, `.git above ${dir}`);
      if (dirname(d) === d) break;
    }
    return spawnSync("bun", [entry], {
      input: stdin,
      encoding: "utf8",
      cwd: dir,
      env: { ...process.env, HOME: dir },
      timeout: 15000,
    });
  }

  it("prints {} for a Stop event with nothing tracked", () => {
    const result = launch(
      JSON.stringify({ hook_event_name: "Stop", session_id: "s", cwd: dir }),
    );
    assert.equal(result.status, 0);
    assert.equal(result.stdout, "{}\n");
  });

  it("reports a systemMessage when the input is not JSON", () => {
    const result = launch("not json");
    assert.equal(result.status, 0);
    const lines = result.stdout.split("\n").filter(Boolean);
    assert.equal(lines.length, 1);
    const output: unknown = JSON.parse(lines[0] ?? "");
    assert.ok(
      output && typeof output === "object" && "systemMessage" in output,
    );
    assert.ok(!("decision" in output));
    assert.ok(!JSON.stringify(output).includes("permissionDecision"));
  });
});

describe("japanese-document-gate recovery, attribution, exclusion and publication", () => {
  const root = mkdtempSync(join(tmpdir(), "japanese-document-gate-more-"));
  after(() => rmSync(root, { recursive: true, force: true }));
  let number = 0;

  function setup() {
    const key = String(++number);
    const dir = join(root, `case-${key}`);
    mkdirSync(dir);
    const stateDir = join(dir, "state");
    const session = `session-${key}`;
    let candidates: Candidates = { ok: true, paths: [] };
    const deps: GateDeps = {
      stateDir,
      candidates: () => candidates,
      now: () => 0,
    };
    const input = (
      event: string,
      tool: string,
      args: Record<string, unknown>,
      extra: Record<string, unknown> = {},
    ) => ({
      hook_event_name: event,
      session_id: session,
      cwd: dir,
      tool_name: tool,
      tool_input: args,
      ...extra,
    });
    const stop = () => input("Stop", "", {});
    const document = (name: string, text = "日本語の文書です。\n") => {
      const path = join(dir, name);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, text);
      return path;
    };
    const bash = (event: string, id: string | undefined, cmd = "true") =>
      input(
        event,
        "Bash",
        { command: cmd },
        id === undefined ? {} : { tool_use_id: id },
      );
    return {
      dir,
      stateDir,
      session,
      deps,
      input,
      stop,
      document,
      bash,
      setCandidates: (value: Candidates) => {
        candidates = value;
      },
      trackedPaths: () => tracked(session, stateDir).paths,
    };
  }
  const denied = (output: unknown) =>
    JSON.stringify(output).includes('"permissionDecision":"deny"');

  describe("corrupt records", () => {
    it("treats a broken receipt as stale and recoverable by a new check", () => {
      const s = setup();
      const file = s.document("a.md");
      track(file, s.session, s.stateDir);
      recordCheck({
        file,
        expectedHash: digest(readFileSync(file)),
        body: "x",
        candidates: 0,
        stateDir: s.stateDir,
      });
      const [name] = readdirSync(join(s.stateDir, "receipts"));
      writeFileSync(join(s.stateDir, "receipts", name ?? ""), "{");
      const result = verify(file, s.stateDir);
      assert.equal(result.status, "stale");
      assert.equal(result.corrupt, true);
      const stop = gate(s.stop(), s.deps);
      assert.equal(stop?.decision, "block");
      assert.match(
        String(stop?.reason),
        /記録が壊れている（check で作り直せる）/u,
      );
      recordCheck({
        file,
        expectedHash: digest(readFileSync(file)),
        body: "x",
        candidates: 0,
        stateDir: s.stateDir,
      });
      assert.equal(verify(file, s.stateDir).status, "ready");
    });

    it("removes a broken tracking entry and reports it with the unchecked document", () => {
      const s = setup();
      const good = s.document("good.md");
      const bad = s.document("bad.md");
      track(good, s.session, s.stateDir);
      track(bad, s.session, s.stateDir);
      const documents = join(
        s.stateDir,
        "sessions",
        digest(s.session),
        "documents",
      );
      writeFileSync(join(documents, `${digest(bad)}.json`), "{");
      const post = gate(
        s.input("PostToolUse", "Write", { file_path: join(s.dir, "none.txt") }),
        s.deps,
      );
      const text = JSON.stringify(post);
      assert.ok(text.includes("good.md"));
      assert.ok(text.includes("壊れた追跡項目を 1 件消した"));
      assert.deepEqual(readdirSync(documents), [`${digest(good)}.json`]);
      // The entry is gone now, so a second pass only reports the document.
      assert.ok(
        !JSON.stringify(gate(s.stop(), s.deps)).includes("壊れた追跡項目"),
      );
    });

    it("reports a removed broken entry on Stop too", () => {
      const s = setup();
      const good = s.document("good.md");
      track(good, s.session, s.stateDir);
      const documents = join(
        s.stateDir,
        "sessions",
        digest(s.session),
        "documents",
      );
      writeFileSync(join(documents, "broken.json"), "{");
      const stop = gate(s.stop(), s.deps);
      assert.equal(stop?.decision, "block");
      assert.ok(String(stop?.reason).includes("good.md"));
      assert.ok(String(stop?.reason).includes("壊れた追跡項目を 1 件消した"));
    });
  });

  describe("Bash attribution", () => {
    it("claims only what changed between this call's Pre and Post", () => {
      const s = setup();
      const a = s.document("a.md", "第一版です。\n");
      writeFileSync(a, "他のセッションの第二版です。\n");
      s.setCandidates({ ok: true, paths: [a] });
      gate(s.bash("PreToolUse", "t1"), s.deps);
      gate(s.bash("PostToolUse", "t1"), s.deps);
      assert.deepEqual(s.trackedPaths(), []);
    });

    it("tracks a new document, a changed one, and skips a removed one", () => {
      const s = setup();
      const a = s.document("a.md", "第一版です。\n");
      const gone = s.document("gone.md");
      s.setCandidates({ ok: true, paths: [] });
      gate(s.bash("PreToolUse", "t1"), s.deps);
      const b = s.document("b.md");
      s.setCandidates({ ok: true, paths: [b] });
      gate(s.bash("PostToolUse", "t1"), s.deps);
      assert.deepEqual(s.trackedPaths(), [b]);

      s.setCandidates({ ok: true, paths: [a, gone] });
      gate(s.bash("PreToolUse", "t2"), s.deps);
      writeFileSync(a, "第二版です。\n");
      rmSync(gone);
      gate(s.bash("PostToolUse", "t2"), s.deps);
      assert.deepEqual(s.trackedPaths().sort(), [a, b].sort());
    });

    it(
      "skips an unreadable document and keeps the others",
      itUnlessRoot,
      () => {
        const s = setup();
        const a = s.document("a.md", "第一版です。\n");
        const b = s.document("b.md", "第一版です。\n");
        s.setCandidates({ ok: true, paths: [a, b] });
        gate(s.bash("PreToolUse", "t1"), s.deps);
        chmodSync(a, 0o000);
        writeFileSync(b, "第二版です。\n");
        try {
          gate(s.bash("PostToolUse", "t1"), s.deps);
        } finally {
          chmodSync(a, 0o644);
        }
        assert.deepEqual(s.trackedPaths(), [b]);
      },
    );

    it("does not track without a tool_use_id and notifies once per session", () => {
      const s = setup();
      const a = s.document("a.md");
      s.setCandidates({ ok: true, paths: [a] });
      assert.equal(gate(s.bash("PreToolUse", undefined), s.deps), null);
      const first = gate(s.bash("PostToolUse", undefined), s.deps);
      assert.match(JSON.stringify(first), /特定できませんでした/u);
      assert.equal(gate(s.bash("PreToolUse", undefined), s.deps), null);
      assert.equal(gate(s.bash("PostToolUse", undefined), s.deps), null);
      assert.deepEqual(s.trackedPaths(), []);
    });

    it("does not track when the Pre listing failed", () => {
      const s = setup();
      s.setCandidates({ ok: false, reason: "timeout" });
      gate(s.bash("PreToolUse", "t1"), s.deps);
      const c = s.document("c.md");
      s.setCandidates({ ok: true, paths: [c] });
      const post = gate(s.bash("PostToolUse", "t1"), s.deps);
      assert.match(JSON.stringify(post), /特定できませんでした/u);
      assert.deepEqual(s.trackedPaths(), []);
    });

    it("drops the snapshot and notifies when the Post listing failed", () => {
      const s = setup();
      s.setCandidates({ ok: true, paths: [] });
      gate(s.bash("PreToolUse", "t1"), s.deps);
      const snapshots = join(
        s.stateDir,
        "sessions",
        digest(s.session),
        "snapshots",
      );
      assert.equal(readdirSync(snapshots).length, 1);
      s.setCandidates({ ok: false, reason: "git" });
      const post = gate(s.bash("PostToolUse", "t1"), s.deps);
      assert.match(JSON.stringify(post), /特定できませんでした/u);
      assert.equal(readdirSync(snapshots).length, 0);
      assert.deepEqual(s.trackedPaths(), []);
    });

    it("treats a broken snapshot as absent and deletes it", () => {
      const s = setup();
      s.setCandidates({ ok: true, paths: [] });
      gate(s.bash("PreToolUse", "t1"), s.deps);
      const snapshots = join(
        s.stateDir,
        "sessions",
        digest(s.session),
        "snapshots",
      );
      const [name] = readdirSync(snapshots);
      writeFileSync(join(snapshots, name ?? ""), "{");
      s.setCandidates({ ok: true, paths: [s.document("c.md")] });
      const post = gate(s.bash("PostToolUse", "t1"), s.deps);
      assert.match(JSON.stringify(post), /特定できませんでした/u);
      assert.equal(readdirSync(snapshots).length, 0);
      assert.deepEqual(s.trackedPaths(), []);
    });

    it("compares each call with its own snapshot, and a repeated Pre replaces it", () => {
      const s = setup();
      const a = s.document("a.md", "第一版です。\n");
      const b = s.document("b.md", "第一版です。\n");
      s.setCandidates({ ok: true, paths: [a] });
      gate(s.bash("PreToolUse", "t1"), s.deps);
      s.setCandidates({ ok: true, paths: [b] });
      gate(s.bash("PreToolUse", "t2"), s.deps);
      writeFileSync(a, "第二版です。\n");
      s.setCandidates({ ok: true, paths: [a] });
      gate(s.bash("PostToolUse", "t1"), s.deps);
      assert.deepEqual(s.trackedPaths(), [a]);
      writeFileSync(b, "第二版です。\n");
      s.setCandidates({ ok: true, paths: [b] });
      gate(s.bash("PostToolUse", "t2"), s.deps);
      assert.deepEqual(s.trackedPaths().sort(), [a, b].sort());

      const c = s.document("c.md", "第一版です。\n");
      s.setCandidates({ ok: true, paths: [] });
      gate(s.bash("PreToolUse", "t3"), s.deps);
      s.setCandidates({ ok: true, paths: [c] });
      gate(s.bash("PreToolUse", "t3"), s.deps);
      s.setCandidates({ ok: true, paths: [c] });
      gate(s.bash("PostToolUse", "t3"), s.deps);
      assert.ok(!s.trackedPaths().includes(c));
    });

    it("hashes a hostile tool_use_id and writes nothing outside the state directory", () => {
      const s = setup();
      s.setCandidates({ ok: true, paths: [] });
      gate(s.bash("PreToolUse", "../../x"), s.deps);
      const snapshots = join(
        s.stateDir,
        "sessions",
        digest(s.session),
        "snapshots",
      );
      const names = readdirSync(snapshots);
      assert.equal(names.length, 1);
      assert.match(names[0] ?? "", /^[0-9a-f]{64}\.json$/u);
      assert.deepEqual(readdirSync(s.dir), ["state"]);
      assert.equal(existsSync(join(s.stateDir, "sessions", "x")), false);
    });

    it("keeps every state directory 0700 and every file 0600", () => {
      const s = setup();
      const a = s.document("a.md");
      recordCheck({
        file: a,
        expectedHash: digest(readFileSync(a)),
        body: "x",
        candidates: 1,
        stateDir: s.stateDir,
      });
      track(a, s.session, s.stateDir);
      s.setCandidates({ ok: true, paths: [] });
      gate(s.bash("PreToolUse", "t1"), s.deps);
      const walk = (dir: string): string[] =>
        readdirSync(dir).flatMap((name) => {
          const path = join(dir, name);
          return lstatSync(path).isDirectory() ? [path, ...walk(path)] : [path];
        });
      const inspect = () => {
        const all = walk(s.stateDir);
        assert.ok(all.some((path) => path.includes("snapshots")));
        for (const path of all) {
          const mode = lstatSync(path).mode & 0o777;
          assert.equal(
            mode,
            lstatSync(path).isDirectory() ? 0o700 : 0o600,
            path,
          );
        }
      };
      inspect();
      gate(s.bash("PostToolUse", "none"), s.deps);
      gate(s.input("PostToolUse", "Write", { file_path: a }), s.deps);
      assert.equal(gate(s.stop(), s.deps)?.decision, "block");
      for (const path of walk(s.stateDir)) {
        const mode = lstatSync(path).mode & 0o777;
        assert.equal(mode, lstatSync(path).isDirectory() ? 0o700 : 0o600, path);
      }
    });
  });

  describe("git candidates with an injected runner", () => {
    function runner(replies: Array<Partial<ReturnType<RunGit>>>): {
      run: RunGit;
      calls: string[][];
    } {
      const calls: string[][] = [];
      const run: RunGit = (args) => {
        calls.push(args);
        return {
          status: 0,
          stdout: "",
          stderr: "",
          timedOut: false,
          ...(replies[calls.length - 1] ?? {}),
        };
      };
      return { run, calls };
    }

    it("resolves porcelain paths against the repository root", () => {
      const s = setup();
      s.document("repo/docs/a.md");
      mkdirSync(join(s.dir, "repo", "sub"));
      const repo = join(s.dir, "repo");
      const { run, calls } = runner([
        { stdout: `${repo}\n` },
        { stdout: "?? docs/a.md\0" },
      ]);
      const result = gitDocumentCandidates(join(repo, "sub"), run);
      assert.deepEqual(result, {
        ok: true,
        paths: [join(repo, "docs", "a.md")],
      });
      assert.deepEqual(calls[0]?.slice(0, 5), [
        "--no-optional-locks",
        "-C",
        join(repo, "sub"),
        "-c",
        "core.fsmonitor=",
      ]);
      assert.ok(calls[1]?.includes("--untracked-files=all"));
    });

    it("treats a non-repository as having no candidates", () => {
      const { run } = runner([
        { status: 128, stderr: "fatal: not a git repository (or any parent)" },
      ]);
      assert.deepEqual(gitDocumentCandidates("/nowhere", run), {
        ok: true,
        paths: [],
      });
    });

    it("reports a timeout from either call and an unstartable git", () => {
      assert.deepEqual(
        gitDocumentCandidates(
          "/r",
          runner([{ status: null, timedOut: true }]).run,
        ),
        { ok: false, reason: "timeout" },
      );
      assert.deepEqual(
        gitDocumentCandidates(
          "/r",
          runner([{ stdout: "/r\n" }, { status: null, timedOut: true }]).run,
        ),
        { ok: false, reason: "timeout" },
      );
      assert.deepEqual(
        gitDocumentCandidates(
          "/r",
          runner([{ status: null, timedOut: false }]).run,
        ),
        { ok: false, reason: "git" },
      );
    });

    it("does not start the second call once the first used the whole deadline", () => {
      const { run, calls } = runner([{ stdout: "/r\n" }]);
      let now = 0;
      const result = gitDocumentCandidates("/r", run, 100, () => (now += 100));
      assert.deepEqual(result, { ok: false, reason: "timeout" });
      assert.equal(calls.length, 1);
    });
  });

  describe("workflow directory exclusion", () => {
    it("recognises .tmp/sessions only as adjacent path segments", () => {
      assert.equal(inWorkflowDir("/r/.tmp/sessions/ab/spec.md"), true);
      assert.equal(inWorkflowDir("/r/.tmp/sessionsX/a.md"), false);
      assert.equal(inWorkflowDir("/r/docs/sessions/a.md"), false);
      assert.equal(inWorkflowDir("/r/.tmp/docs/sessions/a.md"), false);
    });

    it("does not track workflow documents but tracks lookalikes", () => {
      const s = setup();
      const workflow = s.document(".tmp/sessions/abcd1234/spec.md");
      const lookalike = s.document(".tmp/sessionsX/a.md");
      const docs = s.document("docs/sessions/a.md");
      for (const file of [workflow, lookalike, docs])
        gate(s.input("PostToolUse", "Write", { file_path: file }), s.deps);
      assert.deepEqual(s.trackedPaths().sort(), [lookalike, docs].sort());
    });

    it("normalises a path with .. before the test", () => {
      const s = setup();
      const real = s.document("docs/a.md");
      s.document(".tmp/sessions/placeholder.md");
      gate(
        s.input("PostToolUse", "Write", {
          file_path: join(s.dir, ".tmp/sessions/../../docs/a.md"),
        }),
        s.deps,
      );
      assert.deepEqual(s.trackedPaths(), [real]);
    });

    it("skips an already tracked workflow document on Stop and publication", () => {
      const s = setup();
      const plan = s.document(".tmp/sessions/abcd1234/plan.md");
      track(plan, s.session, s.stateDir);
      assert.equal(gate(s.stop(), s.deps), null);
      const body = s.document(".tmp/sessions/abcd1234/body.md");
      const push = s.input("PreToolUse", "Bash", {
        command: `gh pr create --body-file ${body}`,
      });
      assert.equal(gate(push, s.deps), null);
    });

    it("still checks a workflow document when the CLI is run by hand", async () => {
      const s = setup();
      const spec = s.document(".tmp/sessions/abcd1234/spec.md");
      const output = mock.method(console, "log", () => {});
      try {
        await main(["check", spec], { stateDir: s.stateDir });
      } finally {
        output.mock.restore();
      }
      assert.notEqual(verify(spec, s.stateDir).status, "missing");
    });
  });

  describe("publication commands", () => {
    it("ignores publication words inside other commands", () => {
      assert.equal(
        analyzePublication('echo "git commit -m 日本語"', "/").publishing,
        false,
      );
      const api = analyzePublication("gh api repos/x/y -F body=日本語", "/");
      assert.equal(api.publishing, false);
      assert.equal(api.unverifiedJapaneseBody, false);
    });

    it("denies inline Japanese in every flag spelling", () => {
      const s = setup();
      for (const command of [
        'git commit -am "日本語の本文"',
        'git commit -a -m "日本語"',
        'git commit -m"日本語"',
        "git commit --message=日本語",
        'git -C /repo commit -m "日本語"',
        'gh pr create -b "日本語"',
        'gh issue comment 1 --body "日本語"',
        "gh pr edit 1 --body=日本語",
      ]) {
        assert.ok(
          denied(gate(s.input("PreToolUse", "Bash", { command }), s.deps)),
          command,
        );
      }
    });

    it("does not read words after --", () => {
      const s = setup();
      for (const command of [
        'git commit -m "fix typo" -- 日本語.md',
        "gh issue create --title x -- -b 日本語",
      ])
        assert.equal(
          gate(s.input("PreToolUse", "Bash", { command }), s.deps),
          null,
          command,
        );
    });

    it("denies a heredoc body read from stdin when the command has Japanese", () => {
      const s = setup();
      const command = "git commit -F - <<'EOF'\n日本語の本文\nEOF";
      assert.ok(
        denied(gate(s.input("PreToolUse", "Bash", { command }), s.deps)),
      );
    });

    it("tracks and blocks an unchecked body file in any spelling", () => {
      for (const make of [
        (n: string) => `git commit -F ${n}`,
        (n: string) => `git commit -F${n}`,
        (n: string) => `gh pr create -F${n}`,
      ]) {
        const s = setup();
        const file = s.document("msg.md");
        const output = gate(
          s.input("PreToolUse", "Bash", { command: make("msg.md") }),
          s.deps,
        );
        assert.ok(denied(output), make("msg.md"));
        assert.deepEqual(s.trackedPaths(), [file]);
      }
    });

    it("lets a checked body file through", () => {
      const s = setup();
      const file = s.document("body.md");
      recordCheck({
        file,
        expectedHash: digest(readFileSync(file)),
        body: "x",
        candidates: 0,
        stateDir: s.stateDir,
      });
      const command = "gh pr create --title x --body-file body.md";
      assert.equal(
        gate(s.input("PreToolUse", "Bash", { command }), s.deps),
        null,
      );
    });

    it("sees through assignments and env/sudo wrappers", () => {
      for (const command of [
        "FOO=1 git push",
        "env git push",
        "sudo git push",
      ]) {
        const s = setup();
        track(s.document("a.md"), s.session, s.stateDir);
        assert.ok(
          denied(gate(s.input("PreToolUse", "Bash", { command }), s.deps)),
          command,
        );
      }
    });
  });

  // Text a person or the model would read from any gate output.
  const textOf = (output: unknown): string => {
    const value = output as Record<string, any> | null;
    return String(
      value?.reason ??
        value?.systemMessage ??
        value?.hookSpecificOutput?.additionalContext ??
        value?.hookSpecificOutput?.permissionDecisionReason ??
        "",
    );
  };
  const post = (s: ReturnType<typeof setup>, file: string) =>
    gate(s.input("PostToolUse", "Write", { file_path: file }), s.deps);
  const push = (s: ReturnType<typeof setup>) =>
    gate(s.input("PreToolUse", "Bash", { command: "git push" }), s.deps);

  describe("corrupt tracking entries are never removed silently", () => {
    function withBrokenEntry() {
      const s = setup();
      const good = s.document("good.md");
      track(good, s.session, s.stateDir);
      recordCheck({
        file: good,
        expectedHash: digest(readFileSync(good)),
        body: "x",
        candidates: 0,
        stateDir: s.stateDir,
      });
      const documents = join(
        s.stateDir,
        "sessions",
        digest(s.session),
        "documents",
      );
      writeFileSync(join(documents, "broken.json"), "{");
      return s;
    }

    it("announces on Stop without blocking when nothing else is pending", () => {
      const s = withBrokenEntry();
      const stop = gate(s.stop(), s.deps);
      assert.equal(stop?.decision, undefined);
      assert.match(String(stop?.systemMessage), /壊れた追跡項目を 1 件消した/u);
    });

    it("announces on PostToolUse through additionalContext", () => {
      const s = withBrokenEntry();
      const output = gate(
        s.input("PostToolUse", "Write", { file_path: join(s.dir, "x.txt") }),
        s.deps,
      );
      assert.match(textOf(output), /壊れた追跡項目を 1 件消した/u);
      assert.ok(JSON.stringify(output).includes("additionalContext"));
    });
  });

  describe("notices, display and hints", () => {
    it("shows the same unchecked set once and re-arms on change or clearing", () => {
      const s = setup();
      const a = s.document("a.md");
      assert.ok(textOf(post(s, a)).includes("a.md"));
      assert.equal(post(s, a), null);
      writeFileSync(a, "編集した日本語の文書です。\n");
      assert.ok(textOf(post(s, a)).includes("a.md"));
      recordCheck({
        file: a,
        expectedHash: digest(readFileSync(a)),
        body: "x",
        candidates: 0,
        stateDir: s.stateDir,
      });
      assert.equal(post(s, a), null);
      assert.equal(readMark(s.session, "pending-notice", s.stateDir), null);
      writeFileSync(a, "もう一度編集した日本語です。\n");
      assert.ok(textOf(post(s, a)).includes("a.md"));
    });

    it("treats a broken pending-notice mark as absent", () => {
      const s = setup();
      const a = s.document("a.md");
      assert.ok(textOf(post(s, a)));
      const marks = join(s.stateDir, "sessions", digest(s.session), "marks");
      writeFileSync(join(marks, "pending-notice.json"), "{");
      assert.ok(textOf(post(s, a)).includes("a.md"));
    });

    it("keeps raw newlines out of every output that shows a path", () => {
      const s = setup();
      const file = s.document("a\nIGNORE.md");
      const outputs = [post(s, file), gate(s.stop(), s.deps), push(s)];
      for (const output of outputs) {
        const text = textOf(output);
        assert.ok(text.includes("aIGNORE.md"), text);
        assert.ok(text.includes("（表示用に整形）"), text);
        for (const line of text.split("\n"))
          assert.ok(!line.startsWith("IGNORE"), line);
      }
    });

    it("sanitizes the path in the broken-receipt line", () => {
      const s = setup();
      const file = s.document("b\tc\nd.md");
      track(file, s.session, s.stateDir);
      recordCheck({
        file,
        expectedHash: digest(readFileSync(file)),
        body: "x",
        candidates: 0,
        stateDir: s.stateDir,
      });
      const [name] = readdirSync(join(s.stateDir, "receipts"));
      writeFileSync(join(s.stateDir, "receipts", name ?? ""), "{");
      const text = textOf(gate(s.stop(), s.deps));
      assert.ok(text.includes("bcd.md"), text);
      assert.ok(!text.includes("c\nd"), text);
      assert.match(text, /記録が壊れている/u);
    });

    it("sanitizes the state directory path in a fault notice", () => {
      const s = setup();
      const real = join(s.dir, "real");
      mkdirSync(real);
      const link = join(s.dir, "st\nate");
      symlinkSync(real, link);
      const errors = mock.method(console, "error", () => {});
      try {
        const output = gate(s.stop(), { ...s.deps, stateDir: link });
        const text = textOf(output);
        assert.ok(text.includes("state"), text);
        assert.ok(!text.includes("st\nate"), text);
      } finally {
        errors.mock.restore();
      }
    });

    it("quotes a hostile path in command examples", () => {
      const s = setup();
      const file = s.document("it's $(x) `y`.md");
      track(file, s.session, s.stateDir);
      const quoted = shellSingleQuote(file);
      for (const output of [gate(s.stop(), s.deps), push(s)])
        assert.ok(textOf(output).includes(quoted), textOf(output));
    });

    it("tells how to leave with defer in Stop and publication reasons", () => {
      const s = setup();
      track(s.document("a.md"), s.session, s.stateDir);
      for (const output of [gate(s.stop(), s.deps), push(s)])
        assert.match(textOf(output), /defer/u);
      const inline = gate(
        s.input("PreToolUse", "Bash", {
          command: 'gh issue create --body "日本語の本文"',
        }),
        s.deps,
      );
      assert.match(textOf(inline), /defer/u);
    });
  });

  describe("faults never block", () => {
    function symlinkedState(s: ReturnType<typeof setup>) {
      const real = join(s.dir, "real-state");
      mkdirSync(real);
      const link = join(s.dir, "linked-state");
      symlinkSync(real, link);
      return { ...s.deps, stateDir: link };
    }
    const quiet = <T>(run: () => T): { value: T; errors: unknown[][] } => {
      const errors = mock.method(console, "error", () => {});
      try {
        const value = run();
        return { value, errors: errors.mock.calls.map((c) => c.arguments) };
      } finally {
        errors.mock.restore();
      }
    };

    it("announces a symlinked state directory on Stop with detail on stderr", () => {
      const s = setup();
      const { value, errors } = quiet(() => gate(s.stop(), symlinkedState(s)));
      assert.equal(value?.decision, undefined);
      assert.match(String(value?.systemMessage), /symlink/u);
      assert.match(String(value?.systemMessage), /所有者/u);
      assert.ok(errors.length > 0);
    });

    it("does not deny a publication command", () => {
      const s = setup();
      const { value } = quiet(() =>
        gate(
          s.input("PreToolUse", "Bash", { command: "git push" }),
          symlinkedState(s),
        ),
      );
      assert.ok(!denied(value));
      assert.match(String(value?.systemMessage), /symlink/u);
    });

    it("announces through additionalContext on PostToolUse", () => {
      const s = setup();
      const { value } = quiet(() =>
        gate(
          s.input("PostToolUse", "Write", { file_path: s.document("a.md") }),
          symlinkedState(s),
        ),
      );
      assert.match(textOf(value), /symlink/u);
      assert.ok(JSON.stringify(value).includes("additionalContext"));
    });

    it("reports an unexpected exception without blocking", () => {
      const s = setup();
      track(s.document("a.md"), s.session, s.stateDir);
      const { value } = quiet(() =>
        gate(s.stop(), {
          ...s.deps,
          now: () => {
            throw new Error("clock");
          },
        }),
      );
      assert.equal(value?.decision, undefined);
      assert.match(String(value?.systemMessage), /unexpected/u);
    });

    it(
      "treats a document whose receipt cannot be read as stale and keeps judging the rest",
      itUnlessRoot,
      () => {
        const s = setup();
        const a = s.document("a.md");
        const b = s.document("b.md");
        track(a, s.session, s.stateDir);
        track(b, s.session, s.stateDir);
        recordCheck({
          file: a,
          expectedHash: digest(readFileSync(a)),
          body: "x",
          candidates: 0,
          stateDir: s.stateDir,
        });
        const receipts = join(s.stateDir, "receipts");
        const [name] = readdirSync(receipts);
        chmodSync(join(receipts, name ?? ""), 0o000);
        try {
          const { value } = quiet(() => gate(s.stop(), s.deps));
          assert.equal(value?.decision, "block");
          const reason = String(value?.reason);
          assert.ok(reason.includes("a.md"), reason);
          assert.ok(reason.includes("b.md"), reason);
          assert.match(reason, /記録を読めなかった/u);
        } finally {
          chmodSync(join(receipts, name ?? ""), 0o600);
        }
      },
    );
  });

  describe("pruning old state on Stop", () => {
    const NOW = Date.now();
    const DAY = 24 * 60 * 60 * 1000;
    const HOUR = 60 * 60 * 1000;
    const age = (path: string, ms: number) => {
      const seconds = (NOW - ms) / 1000;
      lutimesSync(path, seconds, seconds);
    };
    const ageTree = (path: string, ms: number) => {
      if (lstatSync(path).isDirectory())
        for (const name of readdirSync(path)) ageTree(join(path, name), ms);
      age(path, ms);
    };
    const withNow = (s: ReturnType<typeof setup>): GateDeps => ({
      ...s.deps,
      now: () => NOW,
    });
    const sessionPath = (s: ReturnType<typeof setup>, session: string) =>
      join(s.stateDir, "sessions", digest(session));
    const seedSession = (s: ReturnType<typeof setup>, session: string) => {
      track(s.document(`${session}.md`), session, s.stateDir);
      return sessionPath(s, session);
    };

    it("removes only other sessions whose newest file is over 7 days old", () => {
      const s = setup();
      const old = seedSession(s, "old");
      const recent = seedSession(s, "recent");
      const mine = seedSession(s, s.session);
      ageTree(old, 8 * DAY);
      ageTree(recent, 6 * DAY);
      ageTree(mine, 8 * DAY);
      gate(s.stop(), withNow(s));
      assert.equal(existsSync(old), false);
      assert.equal(existsSync(recent), true);
      assert.equal(existsSync(mine), true);
    });

    it("removes current-session snapshots over an hour old", () => {
      const s = setup();
      saveSnapshot(s.session, "stale", {}, s.stateDir);
      saveSnapshot(s.session, "fresh", {}, s.stateDir);
      const dir = join(sessionPath(s, s.session), "snapshots");
      age(join(dir, `${digest("stale")}.json`), 2 * HOUR);
      age(join(dir, `${digest("fresh")}.json`), 10 * 60 * 1000);
      gate(s.stop(), withNow(s));
      assert.deepEqual(readdirSync(dir), [`${digest("fresh")}.json`]);
    });

    it("removes old *.tmp files but never receipts", () => {
      const s = setup();
      const a = s.document("a.md");
      recordCheck({
        file: a,
        expectedHash: digest(readFileSync(a)),
        body: "x",
        candidates: 0,
        stateDir: s.stateDir,
      });
      const receipts = join(s.stateDir, "receipts");
      const [receipt] = readdirSync(receipts);
      writeFileSync(join(receipts, "leftover.tmp"), "");
      writeFileSync(join(s.stateDir, "top.tmp"), "");
      age(join(receipts, "leftover.tmp"), 2 * HOUR);
      age(join(s.stateDir, "top.tmp"), 2 * HOUR);
      age(join(receipts, receipt ?? ""), 2 * HOUR);
      gate(s.stop(), withNow(s));
      assert.equal(existsSync(join(receipts, "leftover.tmp")), false);
      assert.equal(existsSync(join(s.stateDir, "top.tmp")), false);
      assert.equal(existsSync(join(receipts, receipt ?? "")), true);
    });

    it("neither follows nor removes a symlink under sessions/", () => {
      const s = setup();
      seedSession(s, s.session);
      const outside = join(s.dir, "outside");
      mkdirSync(outside);
      writeFileSync(join(outside, "keep.md"), "x");
      age(join(outside, "keep.md"), 8 * DAY);
      age(outside, 8 * DAY);
      const link = join(s.stateDir, "sessions", "evil");
      symlinkSync(outside, link);
      age(link, 8 * DAY);
      gate(s.stop(), withNow(s));
      assert.equal(existsSync(join(outside, "keep.md")), true);
      assert.ok(lstatSync(link).isSymbolicLink());
    });

    it("does not follow a symlink inside a session it removes", () => {
      const s = setup();
      const old = seedSession(s, "old");
      const outside = join(s.dir, "outside.md");
      writeFileSync(outside, "x");
      symlinkSync(outside, join(old, "documents", "link.json"));
      ageTree(old, 8 * DAY);
      gate(s.stop(), withNow(s));
      assert.equal(existsSync(old), false);
      assert.equal(readFileSync(outside, "utf8"), "x");
    });

    it("treats a swept snapshot as absent on the following Post", () => {
      const s = setup();
      s.setCandidates({ ok: true, paths: [] });
      gate(s.bash("PreToolUse", "t1"), withNow(s));
      const dir = join(sessionPath(s, s.session), "snapshots");
      ageTree(dir, 2 * HOUR);
      gate(s.stop(), withNow(s));
      const output = gate(s.bash("PostToolUse", "t1"), withNow(s));
      assert.match(textOf(output), /特定できませんでした/u);
      assert.deepEqual(s.trackedPaths(), []);
    });

    it(
      "reports a prune failure on stderr and still blocks on unchecked documents",
      itUnlessRoot,
      () => {
        const s = setup();
        track(s.document("a.md"), s.session, s.stateDir);
        const old = seedSession(s, "old");
        ageTree(old, 8 * DAY);
        chmodSync(old, 0o000);
        const errors = mock.method(console, "error", () => {});
        try {
          const stop = gate(s.stop(), withNow(s));
          assert.equal(stop?.decision, "block");
          assert.ok(
            errors.mock.calls.some((call) =>
              String(call.arguments[0]).includes("prune"),
            ),
          );
        } finally {
          errors.mock.restore();
          chmodSync(old, 0o700);
        }
      },
    );

    it("removes nothing when the state directory is a symlink", () => {
      const s = setup();
      const real = join(s.dir, "real-state");
      mkdirSync(join(real, "sessions"), { recursive: true });
      const old = join(real, "sessions", "old-session");
      mkdirSync(old);
      writeFileSync(join(old, "f.json"), "{}");
      ageTree(old, 8 * DAY);
      const link = join(s.dir, "linked-state");
      symlinkSync(real, link);
      const errors = mock.method(console, "error", () => {});
      try {
        const stop = gate(s.stop(), { ...withNow(s), stateDir: link });
        assert.match(String(stop?.systemMessage), /symlink/u);
      } finally {
        errors.mock.restore();
      }
      assert.equal(existsSync(join(old, "f.json")), true);
    });
  });

  describe("home-based state directory", () => {
    it("resolves HOME the same way as hooks/lib/path-utils", () => {
      const saved = process.env.HOME;
      process.env.HOME = "/x/home";
      try {
        assert.equal(
          defaultStateDir(),
          join(getHomeDir(), ".claude", "state", "japanese-check"),
        );
      } finally {
        if (saved === undefined) delete process.env.HOME;
        else process.env.HOME = saved;
      }
    });
  });
});

describe("autoTrackable (temporary directories are not tracked automatically)", () => {
  const scratch = mkdtempSync(join("/tmp", "japanese-auto-track-"));
  after(() => rmSync(scratch, { recursive: true, force: true }));
  const roots = { tmp: ["/tmp"], home: "/home/u" };
  // 実在する日本語の文書を、指定した絶対パスに作る。
  const doc = (dir: string, name = "a.md") => {
    mkdirSync(dir, { recursive: true });
    const file = join(dir, name);
    writeFileSync(file, "人が読むための説明です。\n");
    return file;
  };

  it("excludes a document under /tmp when the cwd is elsewhere", () => {
    const file = doc(join(scratch, "x"));
    assert.equal(autoTrackable(file, "/work/repo", roots), false);
  });

  it("keeps a document when the cwd is inside, equal to, or under the temp root", () => {
    const file = doc(join(scratch, "repo"), "doc.md");
    assert.equal(autoTrackable(file, scratch, roots), true);
    assert.equal(autoTrackable(file, join(scratch, "repo"), roots), true);
    const other = doc(join(scratch, "y"));
    assert.equal(autoTrackable(other, join(scratch, "x"), roots), true);
    assert.equal(autoTrackable(other, "/tmp", roots), true);
  });

  it("keeps a document under a non-first root that overlaps the cwd", () => {
    const file = doc(join(scratch, "dot-tmp"));
    const r = { tmp: ["/tmp", join(scratch, "dot-tmp")], home: "/home/u" };
    // 先頭の /tmp は cwd が外なので外す。2 つ目だけでは外れないことを見る。
    assert.equal(
      autoTrackable(file, "/work/repo", {
        tmp: [r.tmp[1] ?? ""],
        home: r.home,
      }),
      false,
    );
    assert.equal(
      autoTrackable(file, scratch, {
        tmp: ["/nonexistent", scratch],
        home: "/home/u",
      }),
      true,
    );
  });

  it("does not apply the overlap rule to the first root", () => {
    const file = doc(join(scratch, "x"));
    assert.equal(
      autoTrackable(file, "/work/repo", {
        tmp: ["/tmp", "/home"],
        home: "/home/u",
      }),
      false,
    );
  });

  it("applies the overlap rule to later roots (home ancestor is kept)", () => {
    const file = doc("/var/tmp/japanese-auto-track-probe");
    try {
      assert.equal(
        autoTrackable(file, "/work/repo", {
          tmp: ["/nonexistent", "/var/tmp"],
          home: "/var",
        }),
        true,
      );
      assert.equal(
        autoTrackable(file, "/work/repo", {
          tmp: ["/nonexistent", "/var/tmp/"],
          home: "/home/u",
        }),
        false,
      );
    } finally {
      rmSync("/var/tmp/japanese-auto-track-probe", {
        recursive: true,
        force: true,
      });
    }
  });

  it("ignores unusable roots and falls back to /tmp alone", () => {
    const file = doc(join(scratch, "x"));
    for (const bad of ["/", "", "tmp"]) {
      assert.equal(
        autoTrackable(file, "/work/repo", {
          tmp: ["/tmp", bad],
          home: "/home/u",
        }),
        false,
      );
    }
    const outside = doc(
      join(scratch, "..", "japanese-auto-track-outside"),
      "o.md",
    );
    try {
      assert.equal(
        autoTrackable(outside, "/work/repo", {
          tmp: ["/nonexistent", "/"],
          home: "/home/u",
        }),
        true,
      );
    } finally {
      rmSync(join(scratch, "..", "japanese-auto-track-outside"), {
        recursive: true,
        force: true,
      });
    }
  });

  it("does not use an unusable home for the overlap rule", () => {
    const file = doc("/var/tmp/japanese-auto-track-home");
    try {
      for (const home of ["/", "", "relative"]) {
        assert.equal(
          autoTrackable(file, "/work/repo", {
            tmp: ["/nonexistent", "/var/tmp"],
            home,
          }),
          false,
        );
      }
    } finally {
      rmSync("/var/tmp/japanese-auto-track-home", {
        recursive: true,
        force: true,
      });
    }
  });

  it("excludes the home directory's documents when home is under the temp root (accepted limit)", () => {
    const home = join(scratch, "home");
    const file = doc(home, "n.md");
    assert.equal(
      autoTrackable(file, "/work/repo", { tmp: ["/tmp"], home }),
      false,
    );
  });

  it("compares by path segment and resolves dot segments", () => {
    // /tmpfoo は /tmp の下ではない（区切りの / を含めて比べる）。作らずに
    // 判定だけ確かめるため、roots の側を /tmp にして近い名前の root と比べる。
    const near = `${scratch}-near`;
    const file = doc(near);
    try {
      assert.equal(
        autoTrackable(file, "/work/repo", { tmp: [scratch], home: "/home/u" }),
        true,
      );
    } finally {
      rmSync(near, { recursive: true, force: true });
    }
    const dots = doc("/var/tmp/japanese-auto-track-dots");
    try {
      const viaDots = "/tmp/../var/tmp/japanese-auto-track-dots/a.md";
      assert.equal(autoTrackable(viaDots, "/work/repo", roots), true);
      assert.equal(dots.endsWith("a.md"), true);
    } finally {
      rmSync("/var/tmp/japanese-auto-track-dots", {
        recursive: true,
        force: true,
      });
    }
  });

  it("returns false when the document itself is not trackable", () => {
    assert.equal(
      autoTrackable("/work/repo/missing.md", "/work/repo", roots),
      false,
    );
  });
});

describe("autoTrackable through the gate", () => {
  const scratch = mkdtempSync(join("/tmp", "japanese-auto-gate-"));
  after(() => rmSync(scratch, { recursive: true, force: true }));
  const cwd = "/work/repo";
  let n = 0;
  function setup() {
    const key = String(++n);
    const stateDir = join(scratch, `state-${key}`);
    const file = join(scratch, `${key}.md`);
    const content = "人が読むための説明です。\n";
    writeFileSync(file, content);
    let candidates: Candidates = { ok: true, paths: [] };
    const deps: GateDeps = {
      stateDir,
      candidates: () => candidates,
      now: () => 0,
    };
    const input = (
      event: string,
      tool: string,
      args: Record<string, unknown>,
      extra: Record<string, unknown> = {},
    ) => ({
      hook_event_name: event,
      session_id: `s-${key}`,
      cwd,
      tool_name: tool,
      tool_input: args,
      ...extra,
    });
    return {
      file,
      content,
      stateDir,
      deps,
      input,
      session: `s-${key}`,
      setCandidates: (value: Candidates) => {
        candidates = value;
      },
    };
  }

  it("does not track a Write to a temp document, but track and Stop still block it", () => {
    const s = setup();
    gate(s.input("PostToolUse", "Write", { file_path: s.file }), s.deps);
    assert.deepEqual(tracked(s.session, s.stateDir).paths, []);
    track(s.file, s.session, s.stateDir);
    const stop = gate(s.input("Stop", "", {}), s.deps);
    assert.equal(stop?.decision, "block");
  });

  it("denies publishing an unchecked temp document and passes once checked", () => {
    for (const command of [
      (f: string) => `gh pr create --body-file '${f}'`,
      (f: string) => `git commit -F '${f}'`,
    ]) {
      const s = setup();
      const input = () =>
        s.input("PreToolUse", "Bash", { command: command(s.file) });
      assert.ok(
        JSON.stringify(gate(input(), s.deps)).includes(
          '"permissionDecision":"deny"',
        ),
      );
      recordCheck({
        file: s.file,
        expectedHash: digest(s.content),
        body: s.content,
        candidates: 0,
        stateDir: s.stateDir,
      });
      assert.ok(
        !JSON.stringify(gate(input(), s.deps)).includes(
          '"permissionDecision":"deny"',
        ),
      );
    }
  });

  it("does not claim a temp document that appears between a Bash call's Pre and Post", () => {
    const s = setup();
    gate(
      s.input("PreToolUse", "Bash", { command: "true" }, { tool_use_id: "t1" }),
      s.deps,
    );
    s.setCandidates({ ok: true, paths: [s.file] });
    gate(
      s.input(
        "PostToolUse",
        "Bash",
        { command: "true" },
        { tool_use_id: "t1" },
      ),
      s.deps,
    );
    assert.deepEqual(tracked(s.session, s.stateDir).paths, []);
  });
});

describe("gate with a checker that is missing a part", () => {
  const checkerSource = fileURLToPath(
    new URL("../../../japanese-check/", import.meta.url),
  );
  const root = mkdtempSync(join(tmpdir(), "japanese-gate-incomplete-"));
  after(() => rmSync(root, { recursive: true, force: true }));
  let number = 0;
  const content = "人が読むための説明です。\n";

  function fixture(absent = "absent-grammar") {
    const key = String(++number);
    const dir = join(root, `case-${key}`, "japanese-check");
    cpSync(checkerSource, dir, { recursive: true });
    const pkg = join(dir, "node_modules", "sudachi");
    mkdirSync(pkg, { recursive: true });
    writeFileSync(
      join(pkg, "package.json"),
      JSON.stringify({ name: "sudachi", version: "9.9.9", main: "index.js" }),
    );
    writeFileSync(join(pkg, "index.js"), "module.exports = {};\n");
    const stateDir = join(root, `state-${key}`);
    const session = `session-${key}`;
    const documents = (count: number) =>
      Array.from({ length: count }, (_, i) => {
        const file = join(root, `doc-${key}-${i}.md`);
        writeFileSync(file, content);
        return file;
      });
    let deps: DependencyEntry[] = [
      { name: "sudachi", group: "analyzer" },
      { name: absent, group: "grammar" },
    ];
    const gateDeps: GateDeps = {
      stateDir,
      candidates: () => ({ ok: true, paths: [] }),
      now: () => 0,
      verify: (file, state) => verify(file, state, { dir, deps }),
    };
    const input = (event: string, tool = "Write", file = "") => ({
      hook_event_name: event,
      session_id: session,
      cwd: root,
      tool_name: tool,
      tool_input: { file_path: file },
    });
    const record = (file: string) =>
      recordCheck({
        file,
        expectedHash: digest(content),
        body: content,
        candidates: 0,
        stateDir,
        dir,
        deps,
      });
    clearCheckerVersionCache();
    return {
      dir,
      stateDir,
      session,
      documents,
      gateDeps,
      input,
      record,
      setAbsent: (name: string) => {
        deps = [
          { name: "sudachi", group: "analyzer" },
          { name, group: "grammar" },
        ];
      },
    };
  }

  it("treats a ready document as pending and names the missing part", () => {
    const f = fixture();
    const [file] = f.documents(1) as [string];
    track(file, f.session, f.stateDir);
    assert.equal(f.record(file).status, "ready");
    const stop = gate(f.input("Stop"), f.gateDeps);
    assert.equal(stop?.decision, "block");
    assert.match(
      String(stop?.reason),
      /検査器の部品が欠けている（absent-grammar）/u,
    );
    assert.match(String(stop?.reason), /chezmoi apply/u);
  });

  it("announces the same missing set once and again when the names change", () => {
    const f = fixture();
    const [file] = f.documents(1) as [string];
    track(file, f.session, f.stateDir);
    f.record(file);
    const first = gate(f.input("PostToolUse", "Write", file), f.gateDeps);
    assert.ok(JSON.stringify(first).includes("absent-grammar"));
    assert.equal(gate(f.input("PostToolUse", "Write", file), f.gateDeps), null);
    f.setAbsent("another-part");
    f.record(file);
    const third = gate(f.input("PostToolUse", "Write", file), f.gateDeps);
    assert.ok(JSON.stringify(third).includes("another-part"));
  });

  it("leaves draft and excluded documents as they were", () => {
    const f = fixture();
    const [draft, excluded] = f.documents(2) as [string, string];
    for (const file of [draft, excluded]) track(file, f.session, f.stateDir);
    f.record(draft);
    f.record(excluded);
    recordDecision(draft, digest(content), "草稿", "draft", f.stateDir, {
      dir: f.dir,
      deps: [
        { name: "sudachi", group: "analyzer" },
        { name: "absent-grammar", group: "grammar" },
      ],
    });
    recordDecision(
      excluded,
      digest(content),
      "対象外",
      "excluded",
      f.stateDir,
      {
        dir: f.dir,
        deps: [
          { name: "sudachi", group: "analyzer" },
          { name: "absent-grammar", group: "grammar" },
        ],
      },
    );
    assert.equal(gate(f.input("Stop"), f.gateDeps), null);
  });

  it("reports a throwing verification as unreadable for ready, excluded and draft alike", () => {
    const f = fixture();
    const [ready, excluded, draft] = f.documents(3) as [string, string, string];
    for (const file of [ready, excluded, draft]) {
      track(file, f.session, f.stateDir);
      f.record(file);
    }
    const options = {
      dir: f.dir,
      deps: [
        { name: "sudachi", group: "analyzer" },
        { name: "absent-grammar", group: "grammar" },
      ] as DependencyEntry[],
    };
    recordDecision(
      excluded,
      digest(content),
      "対象外",
      "excluded",
      f.stateDir,
      options,
    );
    recordDecision(
      draft,
      digest(content),
      "草稿",
      "draft",
      f.stateDir,
      options,
    );
    const errors = mock.method(console, "error", () => {});
    try {
      const stop = gate(f.input("Stop"), {
        ...f.gateDeps,
        verify: () => {
          throw new Error("boom");
        },
      });
      assert.equal(stop?.decision, "block");
      assert.equal(
        String(stop?.reason).match(/記録を読めなかった/gu)?.length,
        3,
      );
    } finally {
      errors.mock.restore();
    }
  });
});
