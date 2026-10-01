import { ok, strictEqual } from "node:assert";
import { describe, it } from "node:test";
import {
  BOUNDARY_DENY_GUIDANCE,
  createBoundaryDenyResponse,
} from "../../lib/context-helpers.ts";

describe("createBoundaryDenyResponse", () => {
  it("appends the guidance after a blank line and keeps the decision deny", () => {
    const res = createBoundaryDenyResponse("Destructive operation detected: x");
    const out = res.output.hookSpecificOutput;
    strictEqual(out.permissionDecision, "deny");
    strictEqual(
      out.permissionDecisionReason,
      `Destructive operation detected: x\n\n${BOUNDARY_DENY_GUIDANCE}`,
    );
    ok(BOUNDARY_DENY_GUIDANCE.includes("Do not retry the same effect"));
  });
});
