// Launcher for claude-sessions-cli.test.ts: the read phase answers from the
// dir-basic fixture, identifyRepo never finishes and ignores its signal, and
// each abort listener appends a line to LAUNCH_RECORD synchronously.
import { appendFileSync } from "node:fs";
import { runMain } from "../../cli/claude-sessions.ts";
import { FIXTURE_DIR, injectedDeps } from "../support/sessions-inject.ts";

const record = process.env.LAUNCH_RECORD as string;
const { deps } = injectedDeps({
  identifyRepo: (cwd, signal) => {
    appendFileSync(record, `call ${cwd}\n`);
    signal.addEventListener("abort", () =>
      appendFileSync(record, `abort ${cwd}\n`),
    );
    return new Promise(() => {});
  },
});

await runMain(
  ["--json"],
  { CLAUDE_SESSIONS_DIR: FIXTURE_DIR },
  {
    watchdogMs: 200,
    deps: { listSessionsDeps: deps },
  },
);
