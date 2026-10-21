import { ok, strictEqual } from "node:assert";
import { describe, it } from "node:test";
import {
  describeCheckFailure,
  runCheck,
} from "../../implementations/completion-gate.ts";

describe("completion-gate runCheck", () => {
  it("passes a command that succeeds with more than 1 MiB of output", () => {
    // The hook test suite prints over 1 MiB; execSync's default maxBuffer
    // (1 MiB) killed it with ENOBUFS and the gate reported a passing run as failed.
    const command = `node -e "process.stdout.write('x'.repeat(4 * 1024 * 1024))"`;
    strictEqual(runCheck(command, "test"), null);
  });

  it("shows the end of stdout, where a test runner prints its failures", () => {
    const command = `node -e "console.error('runner banner'); console.log('ok 1'); console.log('failing tests: x'); process.exit(1)"`;
    const result = runCheck(command, "test");
    ok(result?.startsWith("test failed:\n"));
    ok(result?.trimEnd().endsWith("failing tests: x"), result ?? "");
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
    ok(/child processes/i.test(text), text);
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
  it("returns null for a command that succeeds", () => {
    strictEqual(runCheck("true", "test"), null);
  });

  it("returns a failed text for a command that fails", () => {
    ok(runCheck("false", "test")?.startsWith("test failed:"));
  });
});
