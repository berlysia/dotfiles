import { ok, strictEqual } from "node:assert";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import documentWorkflowGuardHook from "../../implementations/document-workflow-guard.ts";
import {
  DEFAULT_PARSE_BUDGET_MS,
  extractCommandsStructured,
  getParseBudgetMs,
  parseForCollect,
  parserGiveUpMark,
  parserGiveUpReasonSince,
  setParseBudgetMs,
} from "../../lib/bash-parser.ts";
import {
  ConsoleCapture,
  createPreToolUseContextFor,
  createWorkflowRepo,
  EnvironmentHelper,
  invokeRun,
  pendingWorkflowRepo,
  TEST_WORKFLOW_DIR,
} from "../support/test-helpers.ts";

// The preload gives every test process a patient budget; this file measures
// the production one. It is set in before() and restored in after() rather
// than at module load, so the file stays correct even if a runner ever loads
// several files into one process.
let preloadBudgetMs = 0;
before(() => {
  preloadBudgetMs = getParseBudgetMs();
  setParseBudgetMs(DEFAULT_PARSE_BUDGET_MS);
});
after(() => {
  setParseBudgetMs(preloadBudgetMs);
});

describe("bash-parser: production parse budget", () => {
  for (const [name, command] of [
    ["a long run of redirects", `echo perf-limit-a ${">".repeat(20000)}`],
    ["repeated subshells", `${"(a) ".repeat(5000)}perf-limit-b`],
  ] as const) {
    it(`gives up within 1 s on ${name}`, async () => {
      const mark = parserGiveUpMark();
      const start = performance.now();
      const result = await extractCommandsStructured(command);
      ok(performance.now() - start < 1000);
      strictEqual(result.parsingMethod, "fallback");
      ok(parserGiveUpReasonSince(mark)?.includes("within 100 ms"));
    });
  }

  it("answers a cut input again within 50 ms", async () => {
    const command = `echo perf-limit-d ${">".repeat(20000)}`;
    strictEqual(await parseForCollect(command), null);
    const start = performance.now();
    strictEqual(await parseForCollect(command), null);
    ok(performance.now() - start < 50);
  });
});

describe("document-workflow-guard: production parse budget", () => {
  const envHelper = new EnvironmentHelper();
  const consoleCapture = new ConsoleCapture();

  beforeEach(() => {
    consoleCapture.reset();
    consoleCapture.start();
    envHelper.set("DOCUMENT_WORKFLOW_DIR", TEST_WORKFLOW_DIR);
  });

  afterEach(() => {
    consoleCapture.stop();
    envHelper.restore();
  });

  it("denies a write hidden behind a cut input within 1 s", async () => {
    const repo = createWorkflowRepo(pendingWorkflowRepo());
    envHelper.set("CLAUDE_TEST_CWD", repo);
    const context = createPreToolUseContextFor(
      documentWorkflowGuardHook,
      "Bash",
      {
        command: `for f in a; do tee src/a.ts; done; echo ${">".repeat(20000)}`,
      },
    );
    const start = performance.now();
    await invokeRun(documentWorkflowGuardHook, context);
    ok(performance.now() - start < 1000);
    context.assertDeny();
  });
});
