// Shared by unit/workflow-bash-sync.test.ts and heavy/workflow-bash-sync.test.ts.
// The describe-level EnvironmentHelper and beforeEach/afterEach stay in each
// test file.
import { createHook } from "../../implementations/workflow-bash-sync.ts";

export const PATIENT_TIMEOUT_MS = 10_000;
export const hook = createHook(() => ({
  tripwireGitTimeoutMs: PATIENT_TIMEOUT_MS,
}));

export function additionalContextOf(ctx: { jsonCalls: any[] }): string {
  return ctx.jsonCalls.at(-1)?.hookSpecificOutput?.additionalContext ?? "";
}
