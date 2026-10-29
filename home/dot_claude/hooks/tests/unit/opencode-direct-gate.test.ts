#!/usr/bin/env node --test

import { ok, strictEqual } from "node:assert";
import { afterEach, beforeEach, describe, it } from "node:test";
import hook, {
  type ExtractCommands,
  judgeOpencodeCommand,
  runOpencodeGate,
} from "../../implementations/opencode-direct-gate.ts";
import {
  ConsoleCapture,
  createPreToolUseContextFor,
  EnvironmentHelper,
  invokeRun,
} from "../support/test-helpers.ts";
import { withParseBudget } from "../support/parse-budget.ts";

const env = new EnvironmentHelper();
const consoleCapture = new ConsoleCapture();
beforeEach(() => {
  consoleCapture.start();
  env.set("CLAUDE_TEST_MODE", "1");
});
afterEach(() => {
  consoleCapture.stop();
  env.restore();
});

const decisionOf = async (command: string) =>
  (await judgeOpencodeCommand(command)).decision;

/** Wraps `inner` in `levels` layers of `bash -c '...'`. */
function nestBash(inner: string, levels: number): string {
  let command = inner;
  for (let i = 0; i < levels; i++) {
    command = `bash -c '${command.replaceAll("'", `'\\''`)}'`;
  }
  return command;
}

describe("judgeOpencodeCommand", () => {
  const denied = [
    'opencode run "x"',
    "npx -y opencode-ai run x",
    "npx opencode-ai@latest run x",
    "bunx opencode-ai@1.2.3 run x",
    "env A=1 timeout 60 opencode run x",
    "timeout -s KILL 5 opencode run x",
    "bash -lc 'opencode run x'",
    "bash -o pipefail -c 'opencode run x'",
    'eval "opencode run x"',
    "out=$(opencode run x)",
    "cd /tmp/x && opencode run --agent worktree-read x",
    "opencode debug config --standalone",
    "opencode --help",
    "opencode run x <<'EOF'\nprompt\nEOF",
    "FOO=1 opencode run x",
    "echo hi | opencode run x",
    "(opencode run x)",
    "{ opencode run x; }",
    "if true; then opencode run x; fi",
    "echo $(opencode run x)",
    "echo `opencode run x`",
    "bash -c 'a; opencode run x'",
    "sudo -u root opencode run x",
    "/usr/local/bin/opencode run x",
    "npm exec opencode-ai run",
    "bun x opencode-ai run",
    "pnpm dlx opencode-ai run",
    "yarn dlx opencode-ai run",
    "mise x node@22 -- opencode run",
  ];
  for (const command of denied) {
    it(`denies ${command}`, async () => {
      strictEqual(await decisionOf(command), "deny");
    });
  }

  const allowed = [
    "bash -c 'echo ok'",
    "command -v opencode",
    "which opencode",
    "opencode --version",
    "opencode models",
    "opencode debug config",
    "opencode debug agents",
    "opencode debug paths",
    'git commit -m "opencode run の記録"',
    "grep -rn opencode home/",
    "cd ~/.config/opencode && ls",
    "node tests/opencode-containment.mjs",
    "delegation offload --exposure external-ok --model sarashina/sarashina3.2-mini-thinking --brief-file /tmp/x/brief.md",
    "opencode --version && ls",
    "git commit -F - <<'EOF'\nopencode run x\nEOF",
  ];
  for (const command of allowed) {
    it(`allows ${command.split("\n")[0]}`, async () => {
      strictEqual(await decisionOf(command), "allow");
    });
  }

  it("reads three nested bash -c layers and allows a harmless innermost", async () => {
    strictEqual(await decisionOf(nestBash("echo opencode", 3)), "allow");
  });

  it("denies a fourth layer without reading it", async () => {
    strictEqual(await decisionOf(nestBash("echo opencode", 4)), "deny");
  });

  it("names delegation offload in the reason", async () => {
    const verdict = await judgeOpencodeCommand("opencode run x");
    ok(
      verdict.decision === "deny" &&
        verdict.reason.includes("delegation offload"),
    );
  });

  it("denies when the parser gives up, and points at -F", async () => {
    await withParseBudget(0, async () => {
      // A text no earlier test parsed: the parser remembers results by text.
      const verdict = await judgeOpencodeCommand("opencode run budget-zero");
      ok(verdict.decision === "deny" && verdict.reason.includes("-F"));
    });
  });

  it("does not parse a command without opencode, so a 0 ms budget still allows", async () => {
    await withParseBudget(0, async () => {
      strictEqual(await decisionOf("ls"), "allow");
    });
  });

  it("denies when the parse fails inside a nested string", async () => {
    let calls = 0;
    const real: ExtractCommands = async (text) => {
      const { prepareDenyInput } = await import("../../lib/deny-input.ts");
      return { commands: (await prepareDenyInput(text)).individualCommands };
    };
    const extract: ExtractCommands = (text) => {
      calls++;
      return calls === 1 ? real(text) : Promise.resolve({ gaveUp: "テスト" });
    };
    const verdict = await judgeOpencodeCommand("bash -c 'opencode --version'", {
      extract,
    });
    strictEqual(verdict.decision, "deny");
  });

  // Observation, not a requirement: the body of `bash <<'EOF'` is data to the
  // masker, so it is not judged (plan-4 Risks lists it as excluded).
  it("records how a heredoc fed to bash is judged", async () => {
    const verdict = await judgeOpencodeCommand(
      "bash <<'EOF'\nopencode run x\nEOF",
    );
    strictEqual(verdict.decision, "allow");
  });
});

describe("opencode-direct-gate run", () => {
  const runWith = async (
    tool: "Bash" | "Read",
    input: object,
    judge?: Parameters<typeof runOpencodeGate>[1],
  ) => {
    const context = createPreToolUseContextFor(hook, tool as "Bash", input);
    if (judge) await runOpencodeGate(context, judge);
    else await invokeRun(hook, context);
    return context;
  };

  it("denies opencode run through the hook run", async () => {
    const context = await runWith("Bash", { command: "opencode run x" });
    const out = context.jsonCalls[0]?.hookSpecificOutput;
    strictEqual(out?.permissionDecision, "deny");
    ok(out?.permissionDecisionReason?.includes("delegation offload"));
  });

  it("passes ls", async () => {
    const context = await runWith("Bash", { command: "ls" });
    strictEqual(context.jsonCalls.length, 0);
  });

  it("ignores other tools", async () => {
    const context = await runWith("Read", { file_path: "/x" });
    strictEqual(context.jsonCalls.length, 0);
  });

  it("denies when the judge throws", async () => {
    const context = await runWith("Bash", { command: "opencode run x" }, () => {
      throw new Error("boom");
    });
    strictEqual(
      context.jsonCalls[0]?.hookSpecificOutput?.permissionDecision,
      "deny",
    );
  });
});
