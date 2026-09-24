// A PreToolUse hook that always throws. cc-hooks-ts turns the uncaught
// exception into exit 1 (non-blocking); run-guard.sh must turn that into exit 2.
import { defineHook, runHook } from "cc-hooks-ts";

const hook = defineHook({
  trigger: { PreToolUse: true },
  run: () => {
    throw new Error("simulated guard failure");
  },
});

if (import.meta.main) {
  await runHook(hook);
}
