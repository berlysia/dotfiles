import { deepStrictEqual, ok } from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

const CLI_PATH = join(import.meta.dirname, "../../cli/learnings.ts");
const HUMAN_ONLY = "この操作は人が端末から実行する";

describe("agent caller wiring as a process", () => {
  // 親の環境を継承せず、判定に使う変数は各ケースで明示する
  const childEnv = (home: string, extra: Record<string, string>) => ({
    PATH: process.env["PATH"] ?? "",
    HOME: home,
    BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
    ...extra,
  });
  for (const { name, extra, agent } of [
    { name: "without agent variables", extra: {}, agent: false },
    { name: "CLAUDECODE", extra: { CLAUDECODE: "1" }, agent: true },
    {
      name: "CODEX_SANDBOX",
      extra: { CODEX_SANDBOX: "seatbelt" },
      agent: true,
    },
  ] satisfies Array<{
    name: string;
    extra: Record<string, string>;
    agent: boolean;
  }>) {
    it(
      name,
      {
        skip:
          spawnSync("script", ["--version"]).status === null
            ? "script is not installed"
            : false,
      },
      () => {
        const home = realpathSync(
          mkdtempSync(join(tmpdir(), "agent-caller-wiring-")),
        );
        try {
          const quotedPath = `'${CLI_PATH.replaceAll("'", "'\\''")}'`;
          const r = spawnSync(
            "script",
            ["-qc", `bun ${quotedPath} promote L-000000000000`, "/dev/null"],
            {
              cwd: home,
              env: childEnv(home, extra),
              encoding: "utf8",
              timeout: 20_000,
            },
          );
          const output = `${r.stdout} ${r.stderr}`;
          ok(output.includes(agent ? HUMAN_ONLY : "store が無い"), output);
          ok(!output.includes(agent ? "store が無い" : HUMAN_ONLY), output);
          if (agent) deepStrictEqual(readdirSync(home), []);
        } finally {
          rmSync(home, { recursive: true, force: true });
        }
      },
    );
  }
});
