import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { gate } from "../../implementations/japanese-document-gate.ts";
import {
  checkerVersion,
  digest,
  recordCheck,
  recordDecision,
  track,
  verify,
} from "../../../japanese-check/receipts.ts";

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
    const deps = { stateDir, candidates: () => [] as string[] };
    const input = (
      event: string,
      tool = "Write",
      args: Record<string, unknown> = { file_path: file },
    ) => ({
      hook_event_name: event,
      session_id: session,
      cwd: root,
      tool_name: tool,
      tool_input: args,
    });
    return { file, stateDir, content, session, deps, input };
  }

  it("registers an edited Japanese document and prevents completion until a full check", () => {
    const f = fixture();
    const notice = gate(f.input("PostToolUse"), f.deps);
    assert.ok(JSON.stringify(notice).includes("missing"));
    assert.equal(gate(f.input("Stop"), f.deps)?.decision, "block");
    recordCheck(f.file, digest(f.content), f.content, 0, f.stateDir);
    assert.equal(gate(f.input("Stop"), f.deps), null);
  });

  it("invalidates receipts when the body changes, including after review", () => {
    const f = fixture();
    track(f.file, f.session, f.stateDir);
    recordCheck(f.file, digest(f.content), f.content, 1, f.stateDir);
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
    recordCheck(f.file, digest(f.content), f.content, 2, f.stateDir);
    assert.equal(verify(f.file, f.stateDir).status, "needs-review");
    assert.throws(
      () =>
        recordDecision(f.file, digest(f.content), " ", "checked", f.stateDir),
      /理由/u,
    );
    assert.throws(
      () => recordCheck(f.file, digest("違う内容"), f.content, 0, f.stateDir),
      /変更/u,
    );
  });

  it("preserves an existing decision only for the exact same checked body", () => {
    const f = fixture();
    recordCheck(f.file, digest(f.content), f.content, 1, f.stateDir);
    recordDecision(
      f.file,
      digest(f.content),
      "字義どおりの用法",
      "checked",
      f.stateDir,
    );
    assert.equal(
      recordCheck(f.file, digest(f.content), f.content, 1, f.stateDir).status,
      "ready",
    );
    assert.equal(
      recordCheck(f.file, digest(f.content), "別の抽出テキスト", 1, f.stateDir)
        .status,
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
      recordCheck(
        f.file,
        digest(f.content),
        "別の抽出テキスト",
        1,
        f.stateDir,
        digest("別の原文"),
      ).status,
      "needs-review",
    );
  });

  it("binds extracted text to the artifact bytes and invalidates on artifact changes", () => {
    const f = fixture();
    const artifact = join(root, `artifact-${number}.pdf`);
    writeFileSync(artifact, "binary-version-one");
    recordCheck(
      artifact,
      digest("binary-version-one"),
      f.content,
      0,
      f.stateDir,
    );
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

  it("uses changed contents to discover shell writes without claiming pre-existing dirty files", () => {
    const f = fixture();
    const deps = { ...f.deps, candidates: () => [f.file] };
    assert.equal(
      gate(f.input("PreToolUse", "Bash", { command: "cat draft.md" }), deps),
      null,
    );
    assert.equal(
      gate(f.input("PostToolUse", "Bash", { command: "cat draft.md" }), deps),
      null,
    );
    writeFileSync(f.file, "シェルで改稿した文書です。\n");
    assert.ok(
      gate(f.input("PostToolUse", "Bash", { command: "sed draft.md" }), deps),
    );
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
    recordCheck(f.file, digest(f.content), f.content, 0, f.stateDir);
    const paths = readdirSync(join(f.stateDir, "receipts"));
    assert.equal(paths.length, 1);
    const saved = readFileSync(
      join(f.stateDir, "receipts", paths[0] ?? ""),
      "utf8",
    );
    assert.ok(!saved.includes(f.content.trim()));
    assert.ok(saved.includes(checkerVersion()));
    track(f.file, "../../untrusted-session", f.stateDir);
    assert.equal(readdirSync(join(f.stateDir, "sessions")).length, 1);
  });
});
