import { ok } from "node:assert";
import { describe, it } from "node:test";
import { runCheck } from "../../implementations/completion-gate.ts";

describe("completion-gate runCheck timeout", () => {
  it("reports a command cut off by its timeout as timed out, not as failed", () => {
    // `exec` makes sleep the direct child, so killing it leaves nothing behind.
    const text = runCheck("exec sleep 5", "test", 200);
    ok(text?.startsWith("test timed out after 0.2 s"), text ?? "null");
  });
});
