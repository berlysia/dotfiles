// Launcher for claude-sessions-cli.test.ts: 600 KB through emitAndExit.
import { emitAndExit } from "../../lib/emit-and-exit.ts";

emitAndExit({ code: 0, stdout: "x".repeat(600_000), stderr: "" });
