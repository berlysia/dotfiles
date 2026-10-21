import { deepStrictEqual, ok, strictEqual } from "node:assert";
import { spawn } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  decideBlockReason,
  describeCheckFailure,
  parseCounterContent,
  runCheck,
} from "../../implementations/completion-gate.ts";

describe("completion-gate runCheck", () => {
  it("passes a command that succeeds with more than 1 MiB of output", async () => {
    // The hook test suite prints over 1 MiB; execSync's default maxBuffer
    // (1 MiB) killed it with ENOBUFS and the gate reported a passing run as failed.
    const command = `node -e "process.stdout.write('x'.repeat(4 * 1024 * 1024))"`;
    strictEqual(await runCheck(command, "test"), null);
  });

  it("shows the end of stdout, where a test runner prints its failures", async () => {
    const command = `node -e "console.error('runner banner'); console.log('ok 1'); console.log('failing tests: x'); process.exit(1)"`;
    const result = await runCheck(command, "test");
    ok(result?.text.startsWith("test failed:\n"));
    ok(result?.text.trimEnd().endsWith("failing tests: x"), result?.text ?? "");
  });
});

describe("completion-gate describeCheckFailure", () => {
  const timedOut = { code: "ETIMEDOUT", signal: "SIGTERM" };

  it("names a timeout, says the run was not judged, and keeps the end of the output", () => {
    const text = describeCheckFailure(
      { ...timedOut, stdout: "a\nb", stderr: "" },
      "test",
      120000,
    );
    ok(
      text.startsWith(
        "test timed out after 120 s: the run was cut off, not judged",
      ),
      text,
    );
    ok(text.includes("b"), text);
    ok(/process group/i.test(text), text);
  });

  it("tells the model not to change code, to check leftovers and rerun once, then report", () => {
    const text = describeCheckFailure(timedOut, "test", 120000);
    ok(/do not (change|edit|fix)/i.test(text), text);
    ok(/process/i.test(text) && /load/i.test(text), text);
    ok(/once/i.test(text), text);
    ok(/report/i.test(text), text);
  });

  it("reads Buffer output the same as a string", () => {
    const fromString = describeCheckFailure(
      { ...timedOut, stdout: "a\nb", stderr: "" },
      "test",
      120000,
    );
    const fromBuffer = describeCheckFailure(
      { ...timedOut, stdout: Buffer.from("a\nb"), stderr: Buffer.from("") },
      "test",
      120000,
    );
    strictEqual(fromBuffer, fromString);
  });

  it("writes a fractional timeout in seconds as a JavaScript number", () => {
    ok(
      describeCheckFailure(timedOut, "test", 200).startsWith(
        "test timed out after 0.2 s",
      ),
    );
  });

  it("keeps the ENOBUFS text for code ENOBUFS", () => {
    const text = describeCheckFailure({ code: "ENOBUFS" }, "test", 120000);
    ok(
      text.startsWith("test failed: output exceeded 67108864 bytes (ENOBUFS)"),
      text,
    );
    ok(text.endsWith("the run was cut off, not judged"), text);
  });

  it("decides by code, not by message: ETIMEDOUT with an ENOBUFS message is a timeout", () => {
    const text = describeCheckFailure(
      { code: "ETIMEDOUT", message: "spawnSync ENOBUFS" },
      "test",
      120000,
    );
    ok(text.startsWith("test timed out after 120 s"), text);
  });

  it("reports a signal without a code as an ordinary failure", () => {
    ok(
      describeCheckFailure({ signal: "SIGTERM" }, "test", 120000).startsWith(
        "test failed:",
      ),
    );
  });

  it("shows stderr then stdout for an ordinary failure", () => {
    const text = describeCheckFailure(
      { status: 1, stdout: "x" },
      "test",
      120000,
    );
    ok(text.startsWith("test failed:"), text);
    ok(text.includes("x"), text);
  });

  it("keeps only the last 20 lines of the output", () => {
    const stdout = Array.from({ length: 30 }, (_, i) => `line${i}`).join("\n");
    const text = describeCheckFailure({ status: 1, stdout }, "test", 120000);
    ok(text.includes("line29") && text.includes("line10"), text);
    ok(!text.includes("line9\n") && !text.includes("line0"), text);
  });

  for (const [label, value] of [
    ["null", null],
    ["an empty object", {}],
    ["a string", "boom"],
  ] as const) {
    it(`returns a non-empty string for ${label}`, () => {
      ok(describeCheckFailure(value, "test", 120000).length > 0);
    });
  }
});

describe("completion-gate runCheck results", () => {
  it("returns null for a command that succeeds", async () => {
    strictEqual(await runCheck("true", "test"), null);
  });

  it("returns a failure for a command that fails", async () => {
    const result = await runCheck("false", "test");
    strictEqual(result?.kind, "failure");
    ok(result?.text.startsWith("test failed:"), result?.text);
  });

  it("cuts off output past maxBufferBytes and says it was not judged", async () => {
    const command = `node -e "process.stdout.write('x'.repeat(4096))"`;
    const result = await runCheck(command, "test", { maxBufferBytes: 1024 });
    strictEqual(result?.kind, "output-limit");
    ok(
      result?.text.startsWith(
        "test failed: output exceeded 1024 bytes (ENOBUFS)",
      ),
      result?.text,
    );
  });

  for (const [name, command, options] of [
    ["a successful run", "true", {}],
    [
      "a run cut off by its timeout",
      "exec sleep 5",
      { timeoutMs: 200, killGraceMs: 100 },
    ],
  ] as const) {
    it(`registers SIGTERM/SIGINT handlers only while ${name} is running`, async () => {
      const before = {
        term: process.listenerCount("SIGTERM"),
        int: process.listenerCount("SIGINT"),
      };
      const pending = runCheck(command, "test", options);
      strictEqual(process.listenerCount("SIGTERM"), before.term + 1);
      strictEqual(process.listenerCount("SIGINT"), before.int + 1);
      await pending;
      strictEqual(process.listenerCount("SIGTERM"), before.term);
      strictEqual(process.listenerCount("SIGINT"), before.int);
    });
  }
});

describe("completion-gate decideBlockReason", () => {
  const failure = { kind: "failure" as const, text: "" };
  const timeout = { kind: "timeout" as const, text: "" };
  const outputLimit = { kind: "output-limit" as const, text: "" };

  it("is failed when any check failed", () => {
    strictEqual(decideBlockReason([failure]), "failed");
    strictEqual(decideBlockReason([failure, timeout]), "failed");
  });

  it("is not-judged when every check was cut off", () => {
    strictEqual(decideBlockReason([timeout]), "not-judged");
    strictEqual(decideBlockReason([outputLimit, timeout]), "not-judged");
  });
});

describe("completion-gate parseCounterContent", () => {
  for (const [content, count, reason] of [
    ["3 not-judged", 3, "not-judged"],
    ["3 failed", 3, "failed"],
    ["3", 3, undefined],
    ["3 xyz", 3, undefined],
    ["abc", 0, undefined],
    ["", 0, undefined],
  ] as const) {
    it(`reads ${JSON.stringify(content)} as ${count} / ${reason ?? "unknown"}`, () => {
      deepStrictEqual(parseCounterContent(content), { count, reason });
    });
  }
});

const hookEntry = join(
  import.meta.dirname,
  "..",
  "..",
  "implementations",
  "completion-gate.ts",
);

function runStopHook(cwd: string): Promise<{ code: number; stdout: string }> {
  const payload = JSON.stringify({
    hook_event_name: "Stop",
    session_id: "completion-gate-test",
    transcript_path: join(cwd, "transcript.jsonl"),
    cwd,
    stop_hook_active: false,
  });
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn("bun", [hookEntry], {
      cwd,
      env: { ...process.env, CLAUDE_TEST_CWD: cwd },
      stdio: ["pipe", "pipe", "ignore"],
    });
    let stdout = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.on("error", rejectPromise);
    child.on("close", (code) => resolvePromise({ code: code ?? -1, stdout }));
    child.stdin.end(payload);
  });
}

describe("completion-gate hook at the retry limit (as a process)", () => {
  // The limit path returns before checkTreeChange, so no git is started.
  for (const [counter, includes, excludes] of [
    ["3 not-judged", ["not judged"], ["failing check"]],
    ["3 failed", ["failing check"], ["not judged"]],
    ["3", [], ["not judged", "failing check"]],
  ] as const) {
    it(`tells the user about counter ${JSON.stringify(counter)} without blocking`, async () => {
      const cwd = mkdtempSync(join(tmpdir(), "completion-gate-limit-"));
      try {
        mkdirSync(join(cwd, ".tmp"));
        const counterPath = join(cwd, ".tmp", ".completion-gate-retries");
        writeFileSync(counterPath, counter);
        const { code, stdout } = await runStopHook(cwd);
        strictEqual(code, 0);
        const output = JSON.parse(stdout);
        ok(!("decision" in output), stdout);
        ok(output.systemMessage.startsWith("[completion-gate]"), stdout);
        for (const text of includes)
          ok(output.systemMessage.includes(text), stdout);
        for (const text of excludes)
          ok(!output.systemMessage.includes(text), stdout);
        strictEqual(readFileSync(counterPath, "utf-8"), counter);
      } finally {
        rmSync(cwd, { recursive: true, force: true });
      }
    });
  }
});
