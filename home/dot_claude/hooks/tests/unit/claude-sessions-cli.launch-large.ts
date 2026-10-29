// Launcher for claude-sessions-cli.test.ts: runCli with 1500 rows, then
// emitAndExit, the same path the entry takes.
import { runCli } from "../../cli/claude-sessions.ts";
import { emitAndExit } from "../../lib/emit-and-exit.ts";
import type { SessionRow } from "../../lib/sessions/types.ts";

const sessions: SessionRow[] = Array.from({ length: 1500 }, (_, i) => ({
  sessionId: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
  name: `n${i}`,
  addressable: true,
  duplicateName: false,
  status: "idle",
  liveness: "alive",
  isSelf: false,
  repoStatus: "git",
  repo: "/r/.git",
  worktree: "/r",
  branch: "main",
}));

const result = await runCli(
  ["--json"],
  { HOME: "/h" },
  {
    listSessions: async () => ({
      ok: true,
      value: {
        list: {
          schemaVersion: 1,
          verifiedWith: "x",
          sessions,
          scanned: 1500,
          skipped: 0,
          invalid: 0,
          selfFound: null,
          shapeSuspect: false,
          runningVersion: null,
        },
        internalRows: [],
      },
    }),
  },
);
emitAndExit(result);
