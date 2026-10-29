// Launcher for claude-sessions-cli.test.ts: importing the CLI module must not
// run main. If it did, the process would print a list and exit before "after".
import "../../cli/claude-sessions.ts";

await new Promise((resolve) => setTimeout(resolve, 100));
process.stdout.write("after");
