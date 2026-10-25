import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
  realpathSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import {
  DECISIONS_MAX_BYTES,
  formatDecisionRow,
  parseDecisionRows,
  PREFLIGHT_REASON,
  type DecisionRow,
} from "../../lib/ask-preflight.ts";
import { writeMarker as writeSignFailureMarker } from "../../lib/commit-sign-failure.ts";
import { buildApprovalQuestions } from "../../lib/workflow-approval.ts";
import { run as runInProcess } from "../../implementations/ask-preflight.ts";
import { hasBun } from "../support/claude-worktree-entry-fixture.ts";
import { buildPlanContent } from "../support/test-helpers.ts";

// Real-process tests of the hook entry. Every run gets its own state dir and
// log dir: the real ~/.claude/state and ~/.claude/logs must stay untouched.

const ENTRY = join(
  import.meta.dirname,
  "..",
  "..",
  "implementations",
  "ask-preflight.ts",
);
const HOUR = 60 * 60 * 1000;
const roots: string[] = [];

function freshDir(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  roots.push(dir);
  return dir;
}

after(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
});

interface Sandbox {
  state: string;
  logs: string;
  project: string;
}

function sandbox(): Sandbox {
  return {
    state: freshDir("ask-preflight-state-"),
    logs: freshDir("ask-preflight-logs-"),
    project: freshDir("ask-preflight-project-"),
  };
}

function env(box: Sandbox): NodeJS.ProcessEnv {
  const base = { ...process.env };
  delete base["CLAUDE_TEST_CWD"];
  return {
    ...base,
    ASK_PREFLIGHT_STATE_DIR: box.state,
    CLAUDE_LOGS_DIR: box.logs,
    CLAUDE_PROJECT_DIR: box.project,
  };
}

function runEntry(box: Sandbox, input: string) {
  return spawnSync("bun", [ENTRY], {
    input,
    encoding: "utf8",
    env: env(box),
    timeout: 20_000,
  });
}

function runEntryAsync(box: Sandbox, input: string) {
  return new Promise<{ status: number | null; stdout: string }>(
    (resolve, reject) => {
      const child = spawn("bun", [ENTRY], {
        env: env(box),
        stdio: ["pipe", "pipe", "ignore"],
      });
      let stdout = "";
      child.stdout.on("data", (chunk) => (stdout += chunk));
      child.on("error", reject);
      child.on("close", (status) => resolve({ status, stdout }));
      child.stdin.end(input);
    },
  );
}

let counter = 0;
function newSessionId(): string {
  counter += 1;
  return `apt${process.pid}x${counter}`;
}

function question(text: string, labels: string[] = ["A", "B"]) {
  return {
    questions: [
      {
        header: "H",
        question: text,
        options: labels.map((label) => ({ label, description: "d" })),
        multiSelect: false,
      },
    ],
  };
}

function preInput(
  sessionId: string,
  toolInput: unknown,
  extra: Record<string, unknown> = {},
) {
  return JSON.stringify({
    session_id: sessionId,
    transcript_path: "/t.jsonl",
    cwd: "/",
    hook_event_name: "PreToolUse",
    tool_name: "AskUserQuestion",
    tool_input: toolInput,
    tool_use_id: "tu1",
    ...extra,
  });
}

function promptInput(sessionId: string | undefined, extra = {}) {
  return JSON.stringify({
    ...(sessionId === undefined ? {} : { session_id: sessionId }),
    transcript_path: "/t.jsonl",
    cwd: "/",
    hook_event_name: "UserPromptSubmit",
    prompt: "hello",
    ...extra,
  });
}

const ORDINARY = question("アプローチ A と B のどちらにしますか");

function bounceMarker(box: Sandbox, sessionId: string): string {
  return join(box.state, "bounce", sessionId);
}

function writeDecisions(box: Sandbox, rows: DecisionRow[]): void {
  writeFileSync(
    join(box.state, "decisions.jsonl"),
    rows.map(formatDecisionRow).join(""),
  );
}

function readDecisions(box: Sandbox): DecisionRow[] {
  const path = join(box.state, "decisions.jsonl");
  return existsSync(path) ? parseDecisionRows(readFileSync(path, "utf8")) : [];
}

function row(
  kind: DecisionRow["kind"],
  sessionId: string,
  hash?: string,
): DecisionRow {
  return {
    at: "2026-10-23T00:00:00.000Z",
    sessionId,
    kind,
    ...(hash === undefined ? {} : { hash }),
  };
}

/** 30 bounces; the first `returned` were asked again before the next prompt. */
function thirtyBounces(returned: number): DecisionRow[] {
  const rows: DecisionRow[] = [];
  for (let i = 0; i < 30; i++) {
    const hash = i.toString(16).padStart(16, "0");
    rows.push(row("bounce", "old", hash));
    if (i < returned) rows.push(row("pass", "old", hash));
    rows.push(row("prompt", "old"));
  }
  return rows;
}

function assertSilent(result: { status: number | null; stdout: string }) {
  assert.equal(result.status, 0);
  assert.equal(result.stdout, "");
}

function allFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? allFiles(join(dir, entry.name))
      : [join(dir, entry.name)],
  );
}

describe(
  "ask-preflight entry as a process: PreToolUse",
  { skip: !hasBun && "bun is not on PATH" },
  () => {
    it("denies an ordinary question with the fixed text, exit 0, and leaves a marker", () => {
      const box = sandbox();
      const sid = newSessionId();
      const result = runEntry(box, preInput(sid, ORDINARY));
      assert.equal(result.status, 0, result.stderr);
      const out = JSON.parse(result.stdout);
      assert.equal(out.hookSpecificOutput.hookEventName, "PreToolUse");
      assert.equal(out.hookSpecificOutput.permissionDecision, "deny");
      assert.equal(
        out.hookSpecificOutput.permissionDecisionReason,
        PREFLIGHT_REASON,
      );
      assert.equal(statSync(bounceMarker(box, sid)).mode & 0o777, 0o600);
      assert.equal(statSync(join(box.state, "bounce")).mode & 0o777, 0o700);
    });

    it("lets the second question in the same input through, silently", () => {
      const box = sandbox();
      const sid = newSessionId();
      runEntry(box, preInput(sid, ORDINARY));
      assertSilent(runEntry(box, preInput(sid, ORDINARY)));
      assertSilent(runEntry(box, preInput(sid, question("別の質問ですか"))));
    });

    it("denies again after a user prompt", () => {
      const box = sandbox();
      const sid = newSessionId();
      runEntry(box, preInput(sid, ORDINARY));
      assertSilent(runEntry(box, promptInput(sid)));
      assert.equal(existsSync(bounceMarker(box, sid)), false);
      const again = runEntry(box, preInput(sid, ORDINARY));
      assert.equal(
        JSON.parse(again.stdout).hookSpecificOutput.permissionDecision,
        "deny",
      );
    });

    it("passes silently and leaves no marker for every exclusion", () => {
      const box = sandbox();
      const cases: [string, string][] = [
        [
          "subagent",
          preInput(newSessionId(), ORDINARY, { agent_id: "agent-1" }),
        ],
        [
          "approval question",
          preInput(newSessionId(), {
            questions: buildApprovalQuestions(
              [{ name: "spec.md", hash: "a".repeat(64), title: null }],
              { tree: null, id: null },
            ),
          }),
        ],
        ["push", preInput(newSessionId(), question("main に push しますか"))],
        [
          "answers pre-filled",
          preInput(newSessionId(), { ...ORDINARY, answers: { q: "A" } }),
        ],
      ];
      for (const [label, input] of cases) {
        const result = runEntry(box, input);
        assertSilent(result);
        assert.equal(/allow|"ask"/.test(result.stdout), false, label);
      }
      assert.equal(existsSync(join(box.state, "bounce")), false);
    });

    it("passes while a document in this session waits for approval", () => {
      const box = sandbox();
      const sid = newSessionId();
      const wfDir = join(box.project, ".tmp", "sessions", sid.slice(0, 8));
      mkdirSync(wfDir, { recursive: true });
      writeFileSync(join(wfDir, "research.md"), "x");
      writeFileSync(
        join(wfDir, "plan.md"),
        buildPlanContent({
          planStatus: "complete",
          approvalStatus: "pending",
          review: { verdict: "pass" },
        }),
      );
      assertSilent(runEntry(box, preInput(sid, ORDINARY)));
      assert.equal(existsSync(bounceMarker(box, sid)), false);
    });

    it("denies without creating a workflow dir when the project has none", () => {
      const box = sandbox();
      const sid = newSessionId();
      const result = runEntry(box, preInput(sid, ORDINARY));
      assert.equal(
        JSON.parse(result.stdout).hookSpecificOutput.permissionDecision,
        "deny",
      );
      assert.equal(existsSync(join(box.project, ".tmp")), false);
    });

    it("does nothing for another tool, an unknown event or broken input", () => {
      const box = sandbox();
      const sid = newSessionId();
      assertSilent(
        runEntry(box, preInput(sid, { command: "ls" }, { tool_name: "Bash" })),
      );
      assertSilent(
        runEntry(
          box,
          JSON.stringify({ hook_event_name: "Stop", session_id: sid }),
        ),
      );
      assertSilent(runEntry(box, JSON.stringify({ session_id: sid })));
      assertSilent(runEntry(box, "{not json"));
      assertSilent(runEntry(box, ""));
      assert.equal(
        existsSync(box.state) && allFiles(box.state).length > 0,
        false,
      );
    });

    it("denies exactly one of two questions asked at the same time", async () => {
      const box = sandbox();
      for (const stale of [false, true]) {
        const sid = newSessionId();
        if (stale) {
          mkdirSync(join(box.state, "bounce"), { recursive: true });
          const marker = bounceMarker(box, sid);
          writeFileSync(marker, "");
          const old = new Date(Date.now() - 2 * HOUR);
          utimesSync(marker, old, old);
        }
        const results = await Promise.all([
          runEntryAsync(box, preInput(sid, ORDINARY)),
          runEntryAsync(box, preInput(sid, ORDINARY)),
        ]);
        assert.deepEqual(
          results.map((r) => r.status),
          [0, 0],
        );
        assert.equal(
          results.filter((r) => r.stdout.includes('"deny"')).length,
          1,
          `stale=${stale}`,
        );
      }
    });

    it("treats a 59-minute-old marker as live and a 61-minute-old one as gone", () => {
      const box = sandbox();
      mkdirSync(join(box.state, "bounce"), { recursive: true });
      const young = newSessionId();
      const old = newSessionId();
      for (const [sid, minutes] of [
        [young, 59],
        [old, 61],
      ] as const) {
        const marker = bounceMarker(box, sid);
        writeFileSync(marker, "");
        const when = new Date(Date.now() - minutes * 60 * 1000);
        utimesSync(marker, when, when);
      }
      assertSilent(runEntry(box, preInput(young, ORDINARY)));
      assert.match(runEntry(box, preInput(old, ORDINARY)).stdout, /"deny"/);
    });

    it("sweeps another session's marker older than 24 hours when it bounces", () => {
      const box = sandbox();
      mkdirSync(join(box.state, "bounce"), { recursive: true });
      const stale = bounceMarker(box, "other-session");
      writeFileSync(stale, "");
      const old = new Date(Date.now() - 25 * HOUR);
      utimesSync(stale, old, old);
      runEntry(box, preInput(newSessionId(), ORDINARY));
      assert.equal(existsSync(stale), false);
    });

    it("passes without a marker when the session_id is not a safe name", () => {
      const box = sandbox();
      for (const sid of ["../x", "a/b", "a.b", ""]) {
        assertSilent(runEntry(box, preInput(sid, ORDINARY)));
      }
      assert.equal(existsSync(join(box.state, "bounce")), false);
    });

    it("passes when questions is not an array", () => {
      const box = sandbox();
      assertSilent(runEntry(box, preInput(newSessionId(), { questions: "x" })));
      assertSilent(runEntry(box, preInput(newSessionId(), { questions: [1] })));
    });

    it("passes when the bounce dir cannot be written", (t) => {
      if (process.getuid?.() === 0) {
        t.skip("root ignores directory modes");
        return;
      }
      const box = sandbox();
      mkdirSync(join(box.state, "bounce"), { recursive: true });
      chmodSync(join(box.state, "bounce"), 0o500);
      try {
        assertSilent(runEntry(box, preInput(newSessionId(), ORDINARY)));
      } finally {
        chmodSync(join(box.state, "bounce"), 0o700);
      }
    });

    it("never writes question text to the central log or decisions.jsonl", () => {
      const box = sandbox();
      const sid = newSessionId();
      const mark = "ZZ-LEAK-MARKER-ZZ";
      const labels = [`${mark}-label`, "B"];
      runEntry(box, preInput(sid, question(`${mark} どうしますか`, labels)));
      runEntry(box, preInput(sid, question(`${mark} 2 回目 push`, labels)));
      runEntry(box, promptInput(sid, { prompt: mark }));
      const files = [...allFiles(box.state), ...allFiles(box.logs)];
      assert.ok(files.length > 0);
      assert.ok(
        files.some((f) => f.endsWith("decisions.jsonl")),
        "decisions.jsonl was written",
      );
      for (const file of files) {
        assert.equal(readFileSync(file, "utf8").includes(mark), false, file);
      }
      const rows = readDecisions(box);
      assert.deepEqual(
        rows.map((r) => r.kind),
        ["bounce", "pass", "prompt"],
      );
      assert.equal(rows[0]?.hash?.length, 16);
    });

    it("writes the central log without the input", () => {
      const box = sandbox();
      const sid = newSessionId();
      runEntry(box, preInput(sid, ORDINARY));
      const logged = allFiles(box.logs)
        .map((f) => readFileSync(f, "utf8"))
        .join("\n");
      assert.ok(logged.includes("ask-preflight"));
      assert.equal(logged.includes("アプローチ"), false);
    });

    it("stops appending to a decisions.jsonl over 1 MB, without slowing down", () => {
      const box = sandbox();
      mkdirSync(box.state, { recursive: true });
      const path = join(box.state, "decisions.jsonl");
      writeFileSync(path, `${"x".repeat(DECISIONS_MAX_BYTES + 10)}\n`);
      const before = statSync(path).size;
      const started = Date.now();
      const result = runEntry(box, preInput(newSessionId(), ORDINARY));
      assert.ok(Date.now() - started < 4000);
      assert.equal(
        JSON.parse(result.stdout).hookSpecificOutput.permissionDecision,
        "deny",
      );
      assert.equal(statSync(path).size, before);
    });

    it("keeps the real state dir untouched", () => {
      const real = join(
        process.env["HOME"] ?? "",
        ".claude",
        "state",
        "ask-preflight",
      );
      const snapshot = () =>
        allFiles(real).map((f) => `${f}:${statSync(f).mtimeMs}`);
      const before = snapshot();
      const box = sandbox();
      const sid = newSessionId();
      runEntry(box, preInput(sid, ORDINARY));
      runEntry(box, promptInput(sid));
      assert.deepEqual(snapshot(), before);
    });
  },
);

describe(
  "ask-preflight entry as a process: UserPromptSubmit",
  { skip: !hasBun && "bun is not on PATH" },
  () => {
    it("does nothing without a session_id or with an empty input", () => {
      const box = sandbox();
      assertSilent(runEntry(box, promptInput(undefined)));
      assertSilent(runEntry(box, ""));
      assert.equal(allFiles(box.state).length, 0);
    });

    it("clears the marker and records a prompt row, with no output", () => {
      const box = sandbox();
      const sid = newSessionId();
      runEntry(box, preInput(sid, ORDINARY));
      assertSilent(runEntry(box, promptInput(sid)));
      assert.equal(existsSync(bounceMarker(box, sid)), false);
      assert.deepEqual(
        readDecisions(box).map((r) => r.kind),
        ["bounce", "prompt"],
      );
    });

    it("tells the user once, with the back-out steps, at 30 bounces and a low rate", () => {
      const box = sandbox();
      mkdirSync(box.state, { recursive: true });
      writeDecisions(box, thirtyBounces(28));
      const first = runEntry(box, promptInput(newSessionId()));
      assert.equal(first.status, 0, first.stderr);
      const out = JSON.parse(first.stdout);
      assert.deepEqual(Object.keys(out), ["systemMessage"]);
      assert.match(out.systemMessage, /6\.7%/);
      assert.ok(out.systemMessage.includes("chezmoi apply"));
      assert.ok(existsSync(join(box.state, "notified", "done")));
      assertSilent(runEntry(box, promptInput(newSessionId())));
    });

    it("tells the user the rate and the re-measurement note only at 50%", () => {
      const box = sandbox();
      mkdirSync(box.state, { recursive: true });
      writeDecisions(box, thirtyBounces(15));
      const out = JSON.parse(runEntry(box, promptInput(newSessionId())).stdout);
      assert.match(out.systemMessage, /50\.0%/);
      assert.ok(out.systemMessage.includes("transcript の再計測"));
      assert.equal(out.systemMessage.includes("chezmoi apply"), false);
    });

    it("tells the user about a missing UserPromptSubmit registration", () => {
      const box = sandbox();
      mkdirSync(box.state, { recursive: true });
      writeDecisions(
        box,
        thirtyBounces(0).filter((r) => r.kind !== "prompt"),
      );
      const out = JSON.parse(runEntry(box, promptInput(newSessionId())).stdout);
      assert.ok(out.systemMessage.includes("UserPromptSubmit"));
    });

    it("does not tell the user below 30 bounces", () => {
      const box = sandbox();
      mkdirSync(box.state, { recursive: true });
      writeDecisions(box, thirtyBounces(28).slice(3));
      assertSilent(runEntry(box, promptInput(newSessionId())));
    });

    it("tells the user once when two sessions submit at the same time", async () => {
      const box = sandbox();
      mkdirSync(box.state, { recursive: true });
      writeDecisions(box, thirtyBounces(28));
      const results = await Promise.all([
        runEntryAsync(box, promptInput(newSessionId())),
        runEntryAsync(box, promptInput(newSessionId())),
      ]);
      assert.deepEqual(
        results.map((r) => r.status),
        [0, 0],
      );
      assert.equal(results.filter((r) => r.stdout !== "").length, 1);
    });

    it("does not tell again when a notified marker is 30 hours old", () => {
      const box = sandbox();
      mkdirSync(join(box.state, "notified"), { recursive: true });
      const marker = join(box.state, "notified", "done");
      writeFileSync(marker, "");
      const old = new Date(Date.now() - 30 * HOUR);
      utimesSync(marker, old, old);
      writeDecisions(box, thirtyBounces(28));
      assertSilent(runEntry(box, promptInput(newSessionId())));
    });

    it("stops adding rows once the notified marker exists", () => {
      const box = sandbox();
      mkdirSync(join(box.state, "notified"), { recursive: true });
      writeFileSync(join(box.state, "notified", "done"), "");
      const sid = newSessionId();
      runEntry(box, preInput(sid, ORDINARY));
      runEntry(box, promptInput(sid));
      assert.equal(existsSync(join(box.state, "decisions.jsonl")), false);
    });
  },
);

describe("ask-preflight run(): wiring with injected state", () => {
  function deps(box: Sandbox, overrides = {}) {
    return {
      stateDir: box.state,
      signFailureMarkerDir: freshDir("ask-preflight-sign-"),
      hasApprovalCandidates: () => false,
      now: () => new Date(),
      ...overrides,
    };
  }

  const input = (sid: string, toolInput: unknown = ORDINARY) => ({
    session_id: sid,
    hook_event_name: "PreToolUse",
    tool_name: "AskUserQuestion",
    tool_input: toolInput,
  });

  it("passes while a signing-failure marker exists and does not touch it", () => {
    const box = sandbox();
    const d = deps(box);
    const sid = newSessionId();
    assert.equal(
      writeSignFailureMarker(d.signFailureMarkerDir, sid, [
        "gpg-failed-to-sign",
      ]),
      true,
    );
    assert.equal(runInProcess(input(sid), d), null);
    assert.equal(existsSync(join(d.signFailureMarkerDir, sid)), true);
    assert.equal(existsSync(bounceMarker(box, sid)), false);
  });

  it("passes when the approval-candidate lookup throws", () => {
    const box = sandbox();
    const d = deps(box, {
      hasApprovalCandidates: () => {
        throw new Error("boom");
      },
    });
    assert.equal(runInProcess(input(newSessionId()), d), null);
    assert.equal(existsSync(join(box.state, "bounce")), false);
  });

  it("sends no notice, and still bounces, when decisions.jsonl cannot be read or written", () => {
    const box = sandbox();
    mkdirSync(box.state, { recursive: true });
    // A directory where the file should be makes every read of it throw.
    mkdirSync(join(box.state, "decisions.jsonl"));
    const d = deps(box);
    assert.equal(
      runInProcess(
        { ...input("s", ORDINARY), hook_event_name: "UserPromptSubmit" },
        d,
      ),
      null,
    );
    const denied = runInProcess(input(newSessionId()), d) as {
      hookSpecificOutput: { permissionDecision: string };
    } | null;
    assert.equal(denied?.hookSpecificOutput.permissionDecision, "deny");
  });

  it("leaves a signing-failure marker alone on bounce and on prompt, and the other way round", () => {
    const box = sandbox();
    const d = deps(box);
    const sid = newSessionId();
    assert.notEqual(d.signFailureMarkerDir, join(box.state, "bounce"));
    runInProcess(input(sid), d);
    assert.equal(existsSync(bounceMarker(box, sid)), true);
    writeSignFailureMarker(d.signFailureMarkerDir, sid, ["gpg-failed-to-sign"]);
    runInProcess({ ...input(sid), hook_event_name: "UserPromptSubmit" }, d);
    assert.equal(existsSync(bounceMarker(box, sid)), false);
    assert.equal(existsSync(join(d.signFailureMarkerDir, sid)), true);
  });

  it("logs one line when the summary cannot be read", () => {
    const box = sandbox();
    mkdirSync(box.state, { recursive: true });
    mkdirSync(join(box.state, "decisions.jsonl"));
    const logsDir = process.env["CLAUDE_LOGS_DIR"] ?? "";
    const sid = newSessionId();
    runInProcess(
      { ...input(sid), hook_event_name: "UserPromptSubmit" },
      deps(box),
    );
    const logged = allFiles(logsDir)
      .map((f) => readFileSync(f, "utf8"))
      .join("\n");
    const lines = logged
      .split("\n")
      .filter((l) => l.includes(sid) && l.includes("could not summarize"));
    assert.equal(lines.length, 1);
  });

  it("passes with no salt rows written when the state dir cannot be created", () => {
    const box = sandbox();
    writeFileSync(join(box.state, "blocked"), "");
    const d = deps(box, { stateDir: join(box.state, "blocked", "sub") });
    assert.equal(runInProcess(input(newSessionId()), d), null);
  });
});
