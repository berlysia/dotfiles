import { ok, strictEqual } from "node:assert";
import { describe, it } from "node:test";
import { runCheck } from "../../implementations/completion-gate.ts";

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
