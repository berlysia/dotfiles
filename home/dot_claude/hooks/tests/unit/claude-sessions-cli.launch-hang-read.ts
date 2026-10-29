// Launcher for claude-sessions-cli.test.ts: readSessionFiles never resolves,
// so only the watchdog can end the process.
import { runMain } from "../../cli/claude-sessions.ts";
import { defaultListSessionsDeps } from "../../lib/sessions/list-sessions.ts";

await runMain(
  ["--json"],
  { HOME: "/nonexistent-home" },
  {
    watchdogMs: 200,
    deps: {
      listSessionsDeps: {
        ...defaultListSessionsDeps(),
        readSessionFiles: () => new Promise(() => {}),
      },
    },
  },
);
