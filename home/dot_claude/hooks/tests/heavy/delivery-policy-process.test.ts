import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  realpathSync,
} from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import {
  appendLedger,
  buildDeliveryPolicyQuestion,
  ledgerPath,
} from "../../lib/delivery-policy.ts";
import { hasBun } from "../support/claude-worktree-entry-fixture.ts";

// Starts the recording hook and the CLI as processes, so a broken entrypoint
// wiring fails here even when the exported functions pass their unit tests.
// Every run gets its own home: the real ~/.claude/state stays untouched.

const HOOKS_DIR = join(import.meta.dirname, "..", "..");
const RECORDER = join(
  HOOKS_DIR,
  "implementations",
  "delivery-policy-recorder.ts",
);
const CLI = join(HOOKS_DIR, "cli", "delivery-policy.ts");
const roots: string[] = [];

function freshDir(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  roots.push(dir);
  return dir;
}

after(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
});

const VIEW = JSON.stringify({
  nameWithOwner: "berlysia/dotfiles",
  owner: { id: "x", login: "berlysia" },
  isInOrganization: false,
  defaultBranchRef: { name: "main" },
  url: "https://github.com/berlysia/dotfiles",
});

// The real entry builds its deps from the passwd home and the real gh. This
// small entry runs the same hook through cc-hooks-ts's runHook with a temp
// home and a fake gh, run from the hooks dir so bare imports resolve.
const FAKE_DEPS_ENTRY = `
const { runHook } = await import("cc-hooks-ts");
const { createRecorderHook } = await import(${JSON.stringify(RECORDER)});
const cfg = JSON.parse(process.env.DP_TEST_CONFIG);
const hook = createRecorderHook({
  home: cfg.home,
  ghFor: () => async () => ({ status: 0, stdout: cfg.view, stderr: "" }),
  now: () => new Date(cfg.now),
});
await runHook(hook);
`;

function postToolUse(response: unknown): string {
  return JSON.stringify({
    hook_event_name: "PostToolUse",
    session_id: "abcd1234-0000-0000-0000-000000000000",
    cwd: tmpdir(),
    transcript_path: "/tmp/transcript",
    tool_name: "AskUserQuestion",
    tool_input: {},
    tool_use_id: "toolu_test",
    tool_response: response,
  });
}

describe(
  "delivery-policy-recorder entry",
  { skip: !hasBun && "bun is not on PATH" },
  () => {
    it("records the answer and prints the prefixed line when started as a process", () => {
      const home = freshDir("dp-recorder-home-");
      const questions = buildDeliveryPolicyQuestion(
        "berlysia/dotfiles",
        "https://github.com/berlysia/dotfiles",
      );
      const key = (questions[0] as { question: string }).question;
      const r = spawnSync("bun", ["-e", FAKE_DEPS_ENTRY], {
        cwd: HOOKS_DIR,
        env: {
          PATH: process.env.PATH ?? "",
          DP_TEST_CONFIG: JSON.stringify({
            home,
            view: VIEW,
            now: "2026-10-23T01:02:03.000Z",
          }),
        },
        input: postToolUse({ questions, answers: { [key]: "merge" } }),
        encoding: "utf8",
      });
      assert.equal(r.status, 0, r.stderr);
      assert.match(
        r.stdout,
        /\[delivery-policy-recorder\] berlysia\/dotfiles を merge と記録した/,
      );
      const line = JSON.parse(
        readFileSync(ledgerPath(home), "utf-8").trim(),
      ) as Record<string, unknown>;
      assert.deepEqual(line, {
        v: 1,
        repo: "berlysia/dotfiles",
        scope: "merge",
        at: "2026-10-23T01:02:03.000Z",
      });
    });

    it("the real entry stays silent for an ordinary question", () => {
      const r = spawnSync("bun", [RECORDER], {
        cwd: HOOKS_DIR,
        env: { PATH: process.env.PATH ?? "" },
        input: postToolUse({
          questions: [{ question: "進めてよいか", options: [] }],
          answers: { 進めてよいか: "はい" },
        }),
        encoding: "utf8",
      });
      assert.equal(r.status, 0, r.stderr);
      assert.doesNotMatch(r.stdout, /delivery-policy-recorder/);
    });
  },
);

describe(
  "delivery-policy CLI entry",
  { skip: !hasBun && "bun is not on PATH" },
  () => {
    it("takes the home from the passwd database, not from HOME", () => {
      const fakeHome = freshDir("dp-cli-fakehome-");
      const entry = `
const { resolveCliDeps } = await import(${JSON.stringify(CLI)});
const resolved = resolveCliDeps(["--cwd", ${JSON.stringify(tmpdir())}, "show"]);
console.log(JSON.stringify({ ok: resolved.ok, home: resolved.deps?.home }));
`;
      const r = spawnSync("bun", ["-e", entry], {
        cwd: HOOKS_DIR,
        env: { PATH: process.env.PATH ?? "", HOME: fakeHome },
        encoding: "utf8",
      });
      assert.equal(r.status, 0, r.stderr);
      assert.deepEqual(JSON.parse(r.stdout), {
        ok: true,
        home: userInfo().homedir,
      });
      assert.notEqual(userInfo().homedir, fakeHome);
    });

    it("show runs as a process in a git repo with a fake gh first on PATH", () => {
      const repo = freshDir("dp-cli-repo-");
      const git = spawnSync("git", ["init", "-q", repo], { encoding: "utf8" });
      assert.equal(git.status, 0, git.stderr);
      const bin = freshDir("dp-cli-bin-");
      const fakeGh = join(bin, "gh");
      writeFileSync(
        fakeGh,
        `#!/usr/bin/env bash
if [ "$1" = "repo" ] && [ "$2" = "view" ]; then
  echo '{"nameWithOwner":"dp-fake-owner/dp-fake-repo","owner":{"id":"x","login":"dp-fake-owner"},"isInOrganization":false,"defaultBranchRef":{"name":"main"},"url":"https://github.com/dp-fake-owner/dp-fake-repo"}'
  exit 0
fi
echo "unexpected gh call: $*" >&2
exit 1
`,
      );
      chmodSync(fakeGh, 0o755);
      const r = spawnSync("bun", [CLI, "--cwd", repo, "show"], {
        cwd: HOOKS_DIR,
        env: { PATH: `${bin}:${process.env.PATH ?? ""}` },
        encoding: "utf8",
      });
      assert.equal(r.status, 0, r.stderr);
      assert.equal(r.stdout, "delivery-policy: scope: unrecorded\n");
    });

    it("exits 2 without --cwd, as a process", () => {
      const r = spawnSync("bun", [CLI, "show"], {
        cwd: HOOKS_DIR,
        env: { PATH: process.env.PATH ?? "" },
        encoding: "utf8",
      });
      assert.equal(r.status, 2);
      assert.match(r.stderr, /--cwd/);
    });
  },
);

const FAKE_REPO = "dp-fake-owner/dp-fake-repo";
const FAKE_SHA = "a".repeat(40);

// A gh that answers every read of a merge run. DP_CHECK picks pending or
// green, and `pr merge` leaves marker files so a test can see when it started
// and that it was allowed to finish.
const FAKE_GH = `#!/usr/bin/env bash
echo $$ >> "$DP_DIR/gh.pids"
if [ "$1" = repo ]; then
  echo '{"nameWithOwner":"${FAKE_REPO}","owner":{"id":"x","login":"dp-fake-owner"},"isInOrganization":false,"defaultBranchRef":{"name":"main"},"url":"https://github.com/${FAKE_REPO}"}'
  exit 0
fi
if [ "$1" = api ] && [ "$2" = user ]; then echo '{"login":"dp-fake-owner"}'; exit 0; fi
if [ "$1" = pr ] && [ "$2" = merge ]; then
  : > "$DP_DIR/merge-started"
  sleep "\${DP_MERGE_SLEEP:-0}"
  : > "$DP_DIR/merged"
  exit 0
fi
case "$*" in
  *headRefOid*) echo '{"data":{"repository":{"pullRequest":{"headRefOid":"${FAKE_SHA}","state":"OPEN"}}}}';;
  *checkSuites*)
    if [ "$DP_CHECK" = green ]; then s='"status":"COMPLETED","conclusion":"SUCCESS"'; else s='"status":"IN_PROGRESS","conclusion":null'; fi
    echo '{"data":{"repository":{"object":{"status":null,"checkSuites":{"nodes":[{"app":{"databaseId":15368},"checkRuns":{"nodes":[{"name":"status-check",'"$s"'}]}}]}}}}}';;
  *rules/branches*) echo '[{"type":"required_status_checks","parameters":{"required_status_checks":[{"context":"status-check"}]}}]';;
  *protection/required_status_checks*) echo "gh: Not Found (HTTP 404)" >&2; exit 1;;
  */files?*) echo '[{"filename":"docs/a.md"}]';;
  *graphql*) echo '{"data":{"repository":{"pullRequest":{"state":"OPEN","author":{"login":"dp-fake-owner"},"baseRepository":{"nameWithOwner":"${FAKE_REPO}"},"baseRefName":"main","headRefName":"feat/x","isCrossRepository":false,"changedFiles":1,"mergeStateStatus":"CLEAN"}}}}';;
  *) echo "unexpected gh call: $*" >&2; exit 1;;
esac
`;

// The real entry reads the ledger of the passwd home, which a test must not
// write; runCliMain takes a home of its own and is otherwise the same entry
// (signal handlers, stdout error handler, exit code).
const MERGE_ENTRY = `
const { runCliMain } = await import(${JSON.stringify(CLI)});
process.exitCode = await runCliMain(
  ["--cwd", process.env.DP_REPO, process.env.DP_CMD ?? "merge", "1"],
  { home: process.env.DP_HOME },
);
`;

interface RunningMerge {
  dir: string;
  stdout: () => string;
  waitForOutput: (pattern: RegExp) => Promise<void>;
  waitForFile: (name: string) => Promise<void>;
  signal: (name: NodeJS.Signals) => void;
  destroyStdout: () => void;
  closed: Promise<number | null>;
}

function startMerge(env: {
  check: "pending" | "green";
  mergeSleep?: number;
  command?: "merge" | "wait";
}): RunningMerge {
  const home = freshDir("dp-merge-home-");
  appendLedger(home, {
    repo: FAKE_REPO,
    scope: "merge",
    at: "2026-10-22T00:00:00.000Z",
  });
  const dir = freshDir("dp-merge-dir-");
  const repo = freshDir("dp-merge-repo-");
  const bin = freshDir("dp-merge-bin-");
  writeFileSync(join(bin, "gh"), FAKE_GH);
  chmodSync(join(bin, "gh"), 0o755);
  const child = spawn("bun", ["-e", MERGE_ENTRY], {
    cwd: HOOKS_DIR,
    env: {
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      DP_HOME: home,
      DP_DIR: dir,
      DP_REPO: repo,
      DP_CHECK: env.check,
      DP_CMD: env.command ?? "merge",
      DP_MERGE_SLEEP: String(env.mergeSleep ?? 0),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  child.stdout.on("data", (chunk: Buffer) => {
    out += chunk.toString("utf-8");
  });
  const until = (done: () => boolean): Promise<void> =>
    new Promise((resolve, reject) => {
      const started = Date.now();
      const tick = setInterval(() => {
        if (done()) {
          clearInterval(tick);
          resolve();
        } else if (Date.now() - started > 10_000) {
          clearInterval(tick);
          reject(new Error(`timed out; stdout so far: ${out}`));
        }
      }, 10);
    });
  return {
    dir,
    stdout: () => out,
    waitForOutput: (pattern) => until(() => pattern.test(out)),
    waitForFile: (name) => until(() => existsSync(join(dir, name))),
    signal: (name) => void child.kill(name),
    destroyStdout: () => void child.stdout.destroy(),
    closed: new Promise((resolve) =>
      child.on("close", (code) => resolve(code)),
    ),
  };
}

// Every fake gh logs its pid; none of them may outlive the CLI.
const noFakeGhLeft = (run: RunningMerge) =>
  readFileSync(join(run.dir, "gh.pids"), "utf-8")
    .split("\n")
    .filter((l) => l !== "")
    .every((pid) => {
      try {
        process.kill(Number(pid), 0);
        return false;
      } catch {
        return true;
      }
    });

describe(
  "delivery-policy merge, interrupted as a process",
  { skip: !hasBun && "bun is not on PATH" },
  () => {
    for (const name of ["SIGTERM", "SIGINT", "SIGHUP"] as const) {
      it(`${name} during the wait ends it in 2 s with one interrupted line and exit 10`, async () => {
        const run = startMerge({ check: "pending" });
        await run.waitForOutput(/delivery-policy: waiting:/);
        const sentAt = Date.now();
        run.signal(name);
        assert.equal(await run.closed, 10);
        assert.ok(Date.now() - sentAt < 2000, `${Date.now() - sentAt} ms`);
        const results = run
          .stdout()
          .split("\n")
          .filter((l) => /^delivery-policy: \d+:/.test(l));
        assert.deepEqual(results, [
          "delivery-policy: 10: interrupted; run the same command again",
        ]);
        assert.equal(noFakeGhLeft(run), true);
      });
    }

    it("a closed stdout pipe does not turn the interrupt into a crash", async () => {
      const run = startMerge({ check: "pending" });
      await run.waitForOutput(/delivery-policy: waiting:/);
      run.destroyStdout();
      run.signal("SIGTERM");
      assert.equal(await run.closed, 10);
    });

    it("SIGTERM while gh pr merge runs lets it finish and prints that result once", async () => {
      const run = startMerge({ check: "green", mergeSleep: 0.5 });
      await run.waitForFile("merge-started");
      run.signal("SIGTERM");
      assert.equal(await run.closed, 0);
      assert.equal(existsSync(join(run.dir, "merged")), true);
      const results = run
        .stdout()
        .split("\n")
        .filter((l) => /^delivery-policy: \d+:/.test(l));
      assert.equal(results.length, 1);
      assert.match(
        results[0] ?? "",
        /^delivery-policy: 0: merged #1 at aaaaaaaaaaaa/,
      );
      assert.equal(noFakeGhLeft(run), true);
    });
  },
);

describe(
  "delivery-policy wait, interrupted as a process",
  { skip: !hasBun && "bun is not on PATH" },
  () => {
    it("SIGTERM during the wait ends it with one interrupted line and exit 10, without gh pr merge", async () => {
      const run = startMerge({ check: "pending", command: "wait" });
      await run.waitForOutput(/delivery-policy: waiting:/);
      run.signal("SIGTERM");
      assert.equal(await run.closed, 10);
      const results = run
        .stdout()
        .split("\n")
        .filter((l) => /^delivery-policy: \d+:/.test(l));
      assert.deepEqual(results, [
        "delivery-policy: 10: interrupted; run the same command again",
      ]);
      assert.equal(existsSync(join(run.dir, "merge-started")), false);
      assert.equal(noFakeGhLeft(run), true);
    });

    it("a closed stdout pipe, then SIGTERM, is still exit 10", async () => {
      const run = startMerge({ check: "pending", command: "wait" });
      await run.waitForOutput(/delivery-policy: waiting:/);
      run.destroyStdout();
      run.signal("SIGTERM");
      assert.equal(await run.closed, 10);
    });

    it("green checks end with 0 and never start gh pr merge", async () => {
      const run = startMerge({ check: "green", command: "wait" });
      assert.equal(await run.closed, 0);
      assert.match(
        run.stdout(),
        /delivery-policy: 0: required checks passed at a{40}/,
      );
      assert.equal(existsSync(join(run.dir, "merge-started")), false);
    });
  },
);

// The guard ran its hook before module-level consts further down the file were
// initialized (top-level await), so every Edit was refused with a
// ReferenceError. Unit tests import the module fully first and cannot see it.
const GUARD = join(HOOKS_DIR, "implementations", "document-workflow-guard.ts");

describe(
  "document-workflow-guard entry",
  { skip: !hasBun && "bun is not on PATH" },
  () => {
    it("does not refuse an ordinary Edit when started as a process", () => {
      const dir = freshDir("dp-guard-cwd-");
      const input = {
        session_id: "s",
        transcript_path: join(dir, "t.jsonl"),
        cwd: dir,
        hook_event_name: "PreToolUse",
        tool_use_id: "t1",
        tool_name: "Edit",
        tool_input: {
          file_path: join(dir, "README.md"),
          old_string: "a",
          new_string: "b",
        },
      };
      const r = spawnSync("bun", [GUARD], {
        cwd: HOOKS_DIR,
        input: JSON.stringify(input),
        encoding: "utf8",
      });
      assert.equal(r.status, 0, r.stderr);
      assert.doesNotMatch(r.stdout, /"permissionDecision":"deny"/, r.stdout);
      assert.doesNotMatch(r.stdout, /ReferenceError/, r.stdout);
    });

    // The real PreToolUse payload carries tool_input as an object with
    // command, description and run_in_background (research.md); only the
    // JSON boolean true frees merge from the foreground refusal.
    it("reads run_in_background from the real PreToolUse shape on stdin", () => {
      const dir = freshDir("dp-guard-runbg-");
      const payload = (runInBackground: boolean) =>
        JSON.stringify({
          session_id: "s",
          transcript_path: join(dir, "t.jsonl"),
          cwd: dir,
          hook_event_name: "PreToolUse",
          tool_use_id: "t1",
          tool_name: "Bash",
          tool_input: {
            command: "~/.local/bin/delivery-policy merge 3",
            description: "merge PR 3",
            ...(runInBackground ? { run_in_background: true } : {}),
          },
        });
      const fg = spawnSync("bun", [GUARD], {
        cwd: HOOKS_DIR,
        input: payload(false),
        encoding: "utf8",
      });
      assert.equal(fg.status, 0, fg.stderr);
      assert.match(fg.stdout, /"permissionDecision":"deny"/, fg.stdout);
      assert.match(fg.stdout, /run_in_background: true/, fg.stdout);
      const bg = spawnSync("bun", [GUARD], {
        cwd: HOOKS_DIR,
        input: payload(true),
        encoding: "utf8",
      });
      assert.equal(bg.status, 0, bg.stderr);
      assert.doesNotMatch(bg.stdout, /"permissionDecision":"deny"/, bg.stdout);
      assert.doesNotMatch(bg.stdout, /delivery-policy/, bg.stdout);
    });
  },
);
