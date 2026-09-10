/**
 * Common test helpers and mocks for cc-hooks-ts hook testing
 */

import { deepStrictEqual, strictEqual } from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ExtractAllHookInputsForEvent,
  defineHook as originalDefineHook,
  ToolSchema,
} from "cc-hooks-ts";
import {
  createAllowResponse,
  createAskResponse,
  createDenyResponse,
} from "../../lib/context-helpers.ts";
import {
  computeDocumentHash,
  SPEC_NORMALIZERS,
} from "../../lib/document-hash.ts";
import { deriveDefaultWorkflowDir } from "../../lib/workflow-paths.ts";
import { writeDocCache } from "../../lib/workflow-review-core.ts";

// Extend ToolSchema to include Search tool (not yet in cc-hooks-ts)
interface ExtendedToolSchema extends ToolSchema {
  Search: {
    pattern: string;
    path?: string;
  };
}

// Re-export for use in tests
export { createAskResponse, createDenyResponse, createAllowResponse };

// Extract types from defineHook function
type HookDefinition = Parameters<typeof originalDefineHook>[0];
type HookTrigger = HookDefinition["trigger"];

// Type to extract proper input based on trigger events
type ExtractHookInput<TTrigger extends HookTrigger> = {
  [EventKey in keyof TTrigger]: EventKey extends
    | "PreToolUse"
    | "PostToolUse"
    | "Notification"
    | "UserPromptSubmit"
    | "Stop"
    | "SubagentStop"
    | "PreCompact"
    | "SessionStart"
    | "SessionEnd"
    ? ExtractAllHookInputsForEvent<EventKey>
    : never;
}[keyof TTrigger];

function hasOutput(x: unknown): x is { output: unknown } {
  return typeof x === "object" && x !== null && "output" in x;
}

/**
 * The session id every context builder uses unless a test overrides it.
 *
 * Extracted to a constant because `resolveWorkflowDir` derives the workflow dir
 * from the first eight characters of this value: a test that asserts on the
 * derived dir has to be able to name the same eight characters, and a literal
 * repeated at eight call sites cannot be kept in step with them.
 */
export const TEST_SESSION_ID = "test-session";

export interface ContextOverrides {
  session_id?: string;
  cwd?: string;
  /**
   * Set on PostToolUse `context.input.agent_id` (never on `tool_response`) to
   * simulate a subagent-originated tool call. Absent by default, matching a
   * main-loop call.
   */
  agent_id?: string;
}

/**
 * Mock context object that simulates cc-hooks-ts hook context with proper type safety
 */
export class MockHookContext<TTrigger extends HookTrigger> {
  public successCalls: any[] = [];
  public failCalls: any[] = [];
  public jsonCalls: any[] = [];
  public nonBlockingErrorCalls: any[] = [];
  public input: ExtractHookInput<TTrigger>;

  constructor(input: ExtractHookInput<TTrigger>) {
    this.input = input;
  }

  success = (result: any = {}) => {
    this.successCalls.push(result);
    return result;
  };

  fail = (result: any = {}) => {
    this.failCalls.push(result);
    return result;
  };

  blockingError = (message: string) => {
    this.failCalls.push(message);
    return { kind: "blocking-error" as const, payload: message };
  };

  json = <P>(payload: P) => {
    // cc-hooks-ts typically wraps outputs as { event, output }
    const stored = hasOutput(payload) ? payload.output : (payload as unknown);
    this.jsonCalls.push(stored);
    return { kind: "json" as const, payload };
  };

  nonBlockingError = (message: string = "") => {
    this.nonBlockingErrorCalls.push(message);
    return { kind: "non-blocking-error" as const, payload: message };
  };

  /**
   * Mock defer method for async hook operations
   * In real cc-hooks-ts, defer allows running async operations with a timeout
   * Note: Type uses 'any' to avoid exactOptionalPropertyTypes compatibility issues
   */
  defer = (handler: () => any, _options?: any): any => {
    return handler();
  };

  assertSuccess(expectedResult: any = {}) {
    strictEqual(this.successCalls.length, 1, "success() should be called once");
    strictEqual(this.failCalls.length, 0, "fail() should not be called");
    deepStrictEqual(this.successCalls[0], expectedResult);
  }

  assertFail(expectedResult: any = {}) {
    strictEqual(this.failCalls.length, 1, "fail() should be called once");
    strictEqual(this.successCalls.length, 0, "success() should not be called");
    deepStrictEqual(this.failCalls[0], expectedResult);
  }

  assertJSON(expectedPayload: any) {
    strictEqual(this.jsonCalls.length, 1, "json() should be called once");
    strictEqual(this.successCalls.length, 0, "success() should not be called");
    strictEqual(this.failCalls.length, 0, "fail() should not be called");
    deepStrictEqual(this.jsonCalls[0], expectedPayload);
  }

  assertNonBlockingError(expectedMessage: string = "") {
    strictEqual(
      this.nonBlockingErrorCalls.length,
      1,
      "nonBlockingError() should be called once",
    );
    deepStrictEqual(this.nonBlockingErrorCalls[0], expectedMessage);
  }

  assertDeny(expectedReason?: string) {
    strictEqual(
      this.jsonCalls.length,
      1,
      "json() should be called once for deny response",
    );
    strictEqual(this.successCalls.length, 0, "success() should not be called");
    strictEqual(this.failCalls.length, 0, "fail() should not be called");

    const response = this.jsonCalls[0];
    strictEqual(response.hookSpecificOutput.hookEventName, "PreToolUse");
    strictEqual(response.hookSpecificOutput.permissionDecision, "deny");

    if (expectedReason !== undefined) {
      strictEqual(
        response.hookSpecificOutput.permissionDecisionReason,
        expectedReason,
      );
    }
  }

  assertAllow(expectedReason?: string) {
    strictEqual(
      this.jsonCalls.length,
      1,
      "json() should be called once for allow response",
    );
    strictEqual(this.successCalls.length, 0, "success() should not be called");
    strictEqual(this.failCalls.length, 0, "fail() should not be called");

    const response = this.jsonCalls[0];
    strictEqual(response.hookSpecificOutput.hookEventName, "PreToolUse");
    strictEqual(response.hookSpecificOutput.permissionDecision, "allow");

    if (expectedReason !== undefined) {
      strictEqual(
        response.hookSpecificOutput.permissionDecisionReason,
        expectedReason,
      );
    }
  }

  assertAsk(expectedReason?: string) {
    strictEqual(
      this.jsonCalls.length,
      1,
      "json() should be called once for ask response",
    );
    strictEqual(this.successCalls.length, 0, "success() should not be called");
    strictEqual(this.failCalls.length, 0, "fail() should not be called");

    const response = this.jsonCalls[0];
    strictEqual(response.hookSpecificOutput.hookEventName, "PreToolUse");
    strictEqual(response.hookSpecificOutput.permissionDecision, "ask");

    if (expectedReason !== undefined) {
      strictEqual(
        response.hookSpecificOutput.permissionDecisionReason,
        expectedReason,
      );
    }
  }

  assertPass() {
    strictEqual(
      this.successCalls.length,
      1,
      "success() should be called once for pass",
    );
    strictEqual(
      this.jsonCalls.length,
      0,
      "json() should not be called for pass",
    );
    strictEqual(this.failCalls.length, 0, "fail() should not be called");
  }

  reset() {
    this.successCalls = [];
    this.failCalls = [];
    this.jsonCalls = [];
    this.nonBlockingErrorCalls = [];
  }
}

/**
 * Hook definition mock that captures the hook configuration
 */
export class MockHookDefinition<TTrigger extends HookTrigger, R = unknown> {
  public trigger: TTrigger;
  public run: (ctx: MockHookContext<TTrigger>) => Promise<R> | R;

  constructor(config: {
    trigger: TTrigger;
    run: (ctx: MockHookContext<TTrigger>) => Promise<R> | R;
  }) {
    this.trigger = config.trigger;
    this.run = config.run;
  }

  async execute(input: ExtractHookInput<TTrigger>) {
    const context = new MockHookContext<TTrigger>(input);
    const result = await this.run(context);
    return { context, result };
  }
}

/**
 * Simulates defineHook from cc-hooks-ts
 */
export function defineHook<TTrigger extends HookTrigger, R = unknown>(config: {
  trigger: TTrigger;
  run: (ctx: MockHookContext<TTrigger>) => Promise<R> | R;
}) {
  return new MockHookDefinition<TTrigger, R>(config);
}

/**
 * Invoke a hook's run function with a context, using the hook's parameter type.
 * Centralizes the minimal cast to avoid sprinkling `as any` across tests.
 */
export async function invokeRun<H extends { run: (...args: any[]) => any }>(
  hook: H,
  context: unknown,
) {
  type Ctx = Parameters<H["run"]>[0];
  const run = hook.run as (ctx: Ctx) => unknown;
  return await run(context as Ctx);
}

/**
 * Create a PreToolUse context object that matches the hook's expected run parameter type.
 * This avoids scattering casts in tests by centralizing a single, typed construction.
 */
export function createPreToolUseContextFor<
  H extends { run: (ctx: any) => any },
  Name extends keyof ExtendedToolSchema,
  Input,
>(
  _hook: H,
  tool_name: Name,
  tool_input: Input,
  overrides: ContextOverrides = {},
): Parameters<H["run"]>[0] & MockHookContext<{ PreToolUse: true }> {
  type Ctx = Parameters<H["run"]>[0];
  const baseInput = {
    hook_event_name: "PreToolUse" as const,
    cwd: overrides.cwd ?? "/test",
    session_id: overrides.session_id ?? TEST_SESSION_ID,
    transcript_path: "/test/transcript",
    tool_name,
    tool_input,
  } as ExtractAllHookInputsForEvent<"PreToolUse">;
  // Reuse MockHookContext behavior for capturing calls
  const ctx = new MockHookContext<{ PreToolUse: true }>(baseInput);
  return ctx as unknown as Ctx & MockHookContext<{ PreToolUse: true }>;
}

export function createPostToolUseContextFor<
  H extends { run: (ctx: any) => any },
  Name extends keyof ToolSchema,
  Input,
  Response = Record<string, never>,
>(
  _hook: H,
  tool_name: Name,
  tool_input: Input,
  tool_response: Response = {} as Response,
  overrides: ContextOverrides = {},
): Parameters<H["run"]>[0] & MockHookContext<{ PostToolUse: true }> {
  type Ctx = Parameters<H["run"]>[0];
  const baseInput = {
    hook_event_name: "PostToolUse" as const,
    cwd: overrides.cwd ?? "/test",
    session_id: overrides.session_id ?? TEST_SESSION_ID,
    transcript_path: "/test/transcript",
    tool_name,
    tool_input,
    tool_response,
    ...(overrides.agent_id !== undefined
      ? { agent_id: overrides.agent_id }
      : {}),
  } as ExtractAllHookInputsForEvent<"PostToolUse">;
  const ctx = new MockHookContext<{ PostToolUse: true }>(baseInput);
  return ctx as unknown as Ctx & MockHookContext<{ PostToolUse: true }>;
}

/**
 * Test utilities for file system operations
 */
export interface FileSystemMock {
  files: Map<string, string>;
  directories: Set<string>;

  appendFileSync(path: string, content: string): void;
  readFileSync(path: string, encoding?: string): string;
  writeFileSync(path: string, content: string): void;
  existsSync(path: string): boolean;
  mkdirSync(path: string, options?: { recursive?: boolean }): void;
}

export function createFileSystemMock(): FileSystemMock {
  const files = new Map<string, string>();
  const directories = new Set<string>();

  return {
    files,
    directories,

    appendFileSync(path: string, content: string) {
      const existing = files.get(path) || "";
      files.set(path, existing + content);
    },

    readFileSync(path: string, _encoding?: string): string {
      const content = files.get(path);
      if (content === undefined) {
        const error: any = new Error(
          `ENOENT: no such file or directory, open '${path}'`,
        );
        error.code = "ENOENT";
        throw error;
      }
      return content;
    },

    writeFileSync(path: string, content: string) {
      files.set(path, content);
    },

    existsSync(path: string): boolean {
      return files.has(path) || directories.has(path);
    },

    mkdirSync(path: string, options?: { recursive?: boolean }) {
      directories.add(path);

      // Add parent directories if recursive
      if (options?.recursive) {
        const parts = path.split("/");
        for (let i = 1; i <= parts.length; i++) {
          directories.add(parts.slice(0, i).join("/"));
        }
      }
    },
  };
}

/**
 * Capture console output during tests
 */
export class ConsoleCapture {
  private originalConsole = {
    log: console.log,
    error: console.error,
    warn: console.warn,
    info: console.info,
  };

  public logs: string[] = [];
  public errors: string[] = [];
  public warns: string[] = [];
  public infos: string[] = [];

  start() {
    console.log = (...args) => this.logs.push(args.join(" "));
    console.error = (...args) => this.errors.push(args.join(" "));
    console.warn = (...args) => this.warns.push(args.join(" "));
    console.info = (...args) => this.infos.push(args.join(" "));
  }

  stop() {
    console.log = this.originalConsole.log;
    console.error = this.originalConsole.error;
    console.warn = this.originalConsole.warn;
    console.info = this.originalConsole.info;
  }

  reset() {
    this.logs = [];
    this.errors = [];
    this.warns = [];
    this.infos = [];
  }
}

/**
 * Environment variable helper
 */
export class EnvironmentHelper {
  private originalEnv: Record<string, string | undefined> = {};

  set(key: string, value: string | undefined) {
    if (!(key in this.originalEnv)) {
      this.originalEnv[key] = process.env[key];
    }

    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  restore() {
    for (const [key, value] of Object.entries(this.originalEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    this.originalEnv = {};
  }
}

/**
 * Helper functions for creating properly typed test contexts
 */
export const createPreToolUseContext = <Name extends keyof ToolSchema>(
  tool_name: Name,
  tool_input: any,
) => {
  const input: ExtractAllHookInputsForEvent<"PreToolUse"> = {
    hook_event_name: "PreToolUse" as const,
    cwd: "/test",
    session_id: TEST_SESSION_ID,
    transcript_path: "/test/transcript",
    tool_name,
    tool_input,
  };

  return new MockHookContext<{ PreToolUse: true }>(input);
};

/**
 * Safely run a hook with a MockHookContext without sprinkling casts in tests.
 */
// Note: No run wrapper needed; tests should call hook.run(context) directly.

export const createPostToolUseContext = <Name extends keyof ToolSchema>(
  tool_name: Name,
  tool_input: ToolSchema[Name]["input"],
  tool_response: ToolSchema[Name]["response"],
) => {
  const input = {
    hook_event_name: "PostToolUse" as const,
    cwd: "/test",
    session_id: TEST_SESSION_ID,
    transcript_path: "/test/transcript",
    tool_name,
    tool_input,
    tool_response,
  } as ExtractAllHookInputsForEvent<"PostToolUse">;

  return new MockHookContext<{ PostToolUse: true }>(input);
};

export const createNotificationContext = (message?: string) => {
  return new MockHookContext<{ Notification: true }>({
    hook_event_name: "Notification",
    cwd: "/test",
    session_id: TEST_SESSION_ID,
    transcript_path: "/test/transcript",
    message,
  });
};

export const createStopContext = (stop_hook_active?: boolean) => {
  return new MockHookContext<{ Stop: true }>({
    hook_event_name: "Stop",
    cwd: "/test",
    session_id: TEST_SESSION_ID,
    transcript_path: "/test/transcript",
    stop_hook_active,
  });
};

/**
 * Stop context carrying `last_assistant_message` alongside `stop_hook_active`
 * (plan-3 T6). `createStopContext` above only carries the latter, so the
 * announce-then-stop branch (which reads the message text) needs this
 * dedicated builder rather than overloading the existing one.
 */
export function createStopContextFor<H extends { run: (ctx: any) => any }>(
  _hook: H,
  overrides: {
    last_assistant_message?: string | undefined;
    stop_hook_active?: boolean | undefined;
    cwd?: string | undefined;
    session_id?: string | undefined;
  } = {},
): Parameters<H["run"]>[0] & MockHookContext<{ Stop: true }> {
  type Ctx = Parameters<H["run"]>[0];
  const baseInput = {
    hook_event_name: "Stop" as const,
    cwd: overrides.cwd ?? "/test",
    session_id: overrides.session_id ?? TEST_SESSION_ID,
    transcript_path: "/test/transcript",
    stop_hook_active: overrides.stop_hook_active,
    last_assistant_message: overrides.last_assistant_message,
  } as ExtractAllHookInputsForEvent<"Stop">;
  const ctx = new MockHookContext<{ Stop: true }>(baseInput);
  return ctx as unknown as Ctx & MockHookContext<{ Stop: true }>;
}

export const createSessionStartContext = (
  source: string,
  overrides: ContextOverrides = {},
) => {
  return new MockHookContext<{ SessionStart: true }>({
    hook_event_name: "SessionStart",
    cwd: overrides.cwd ?? "/test",
    session_id: overrides.session_id ?? TEST_SESSION_ID,
    transcript_path: "/test/transcript",
    source,
  });
};

/**
 * Shared workflow-repo fixtures (originally local to document-workflow-guard.test.ts;
 * plan-2 needs the same "plan.md at a known workflow dir" shape from
 * workflow-bash-sync.test.ts and interpreter-write-classify.test.ts, so they are
 * exported here as the single source rather than re-defined per test file).
 */

export interface ReviewMarkerOptions {
  verdict: "pass" | "needs-work" | "blocker";
  hashOverride?: string | undefined;
}

export interface WorkflowRepoOptions {
  planStatus: "drafting" | "complete";
  approvalStatus: "pending" | "approved";
  review?: ReviewMarkerOptions | undefined;
}

/** Mirrors the guard's hashing (SPEC_NORMALIZERS) so fixture hashes never desync from marker hashes. */
export function computeWorkflowRepoPlanHash(content: string): string {
  return computeDocumentHash(content, SPEC_NORMALIZERS);
}

export function buildPlanContent(options: WorkflowRepoOptions): string {
  const reviewStatus = options.review?.verdict ?? "pending";
  const base = [
    "## Approval",
    `- Plan Status: ${options.planStatus}`,
    `- Review Status: ${reviewStatus}`,
    `- Approval Status: ${options.approvalStatus}`,
  ].join("\n");
  if (!options.review) {
    return base;
  }

  const hash = options.review.hashOverride ?? computeWorkflowRepoPlanHash(base);
  return `${base}\n\n<!-- auto-review: verdict=${options.review.verdict}; hash=${hash}; at=2026-02-19T00:00:00.000Z; reviewers=logic-validator -->`;
}

/** Fixed relative workflow dir used by fixtures that pin `DOCUMENT_WORKFLOW_DIR` explicitly. */
export const TEST_WORKFLOW_DIR = ".tmp/sessions/test";

/**
 * A temp repo with a workflow dir at `TEST_WORKFLOW_DIR` containing
 * research.md + plan.md. Callers must also set
 * `envHelper.set("DOCUMENT_WORKFLOW_DIR", TEST_WORKFLOW_DIR)` for the guard to
 * resolve to this directory instead of the session-derived one.
 */
export function createWorkflowRepo(options: WorkflowRepoOptions): string {
  const repo = mkdtempSync(join(tmpdir(), "document-workflow-guard-"));
  mkdirSync(join(repo, TEST_WORKFLOW_DIR), { recursive: true });
  writeFileSync(join(repo, TEST_WORKFLOW_DIR, "research.md"), "research");
  writeFileSync(
    join(repo, TEST_WORKFLOW_DIR, "plan.md"),
    buildPlanContent(options),
  );
  return repo;
}

export function pendingWorkflowRepo(): WorkflowRepoOptions {
  return {
    planStatus: "drafting",
    approvalStatus: "pending",
  };
}

export function approvedWorkflowRepo(): WorkflowRepoOptions {
  return {
    planStatus: "complete",
    approvalStatus: "approved",
    review: { verdict: "pass" },
  };
}

/**
 * A temp repo with a *session-derived* workflow dir (`.tmp/sessions/<sid8>`,
 * matching `deriveDefaultWorkflowDir`) holding only a draft plan.md. Unlike
 * `createWorkflowRepo`, no `DOCUMENT_WORKFLOW_DIR` env pin is needed: the
 * default session id (`TEST_SESSION_ID`) derives to this same dir, so hooks
 * under test that only rely on session-id derivation (e.g. workflow-bash-sync)
 * resolve it without any env setup.
 */
export function draftPlanRepo(sessionId: string = TEST_SESSION_ID): string {
  const repo = mkdtempSync(join(tmpdir(), "draft-plan-"));
  const wfRel = deriveDefaultWorkflowDir(sessionId);
  mkdirSync(join(repo, wfRel), { recursive: true });
  writeFileSync(
    join(repo, wfRel, "plan.md"),
    buildPlanContent(pendingWorkflowRepo()),
  );
  return repo;
}

/**
 * A temp repo `git init`-ed, with a session-derived workflow dir holding
 * research.md + plan.md, and an empty `src/` directory ready for tripwire
 * fixtures to write gate-closed changes into. No commit is made: `git status
 * --porcelain` reports untracked files without one, which is all the
 * tripwire's rolling baseline needs.
 */
export function createGitWorkflowRepo(
  options: WorkflowRepoOptions = pendingWorkflowRepo(),
  sessionId: string = TEST_SESSION_ID,
): string {
  const repo = mkdtempSync(join(tmpdir(), "git-workflow-"));
  execFileSync("git", ["init", "-q"], { cwd: repo });
  execFileSync("git", ["config", "user.email", "test@example.com"], {
    cwd: repo,
  });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: repo });
  const wfRel = deriveDefaultWorkflowDir(sessionId);
  mkdirSync(join(repo, wfRel), { recursive: true });
  writeFileSync(join(repo, wfRel, "research.md"), "research");
  writeFileSync(join(repo, wfRel, "plan.md"), buildPlanContent(options));
  mkdirSync(join(repo, "src"), { recursive: true });
  return repo;
}

/**
 * Seed a standalone workflow dir (not a session-derived one — `runWorkflowCli`
 * takes `wfDir` directly rather than deriving it) for `cli/workflow.ts` tests
 * (plan-3 T2). Writes:
 * - `<doc>` with a `## Reviewer Outputs (Round <round>)` skeleton (one per
 *   round up to `round`) ahead of a pending `## Approval` block
 * - `spec.md` (only when `doc` is `plan-N.md`) already approved, so
 *   parent-spec-hash is computable
 * - `.round-baseline` recording `<round>\t<ISO now>`
 * - `reviewer-runs.log` with one line per `ledgerSlugs` entry, timestamped
 *   after the baseline line above
 */
export interface SeedWorkflowOptions {
  doc: string;
  round: number;
  ledgerSlugs: string[];
  sessionId?: string;
}

export function seedWorkflow(options: SeedWorkflowOptions): {
  wf: string;
  ledger: string;
} {
  const wf = mkdtempSync(join(tmpdir(), "workflow-cli-"));
  const sessionId = options.sessionId ?? "test-ses";

  if (/^plan-\d+\.md$/.test(options.doc)) {
    writeFileSync(
      join(wf, "spec.md"),
      [
        "## Goal",
        "seed spec",
        "",
        "## Approval",
        "- Plan Status: complete",
        "- Review Status: pass",
        "- Approval Status: approved",
        "",
        "<!-- auto-review: verdict=pass; hash=seed; at=2026-01-01T00:00:00.000Z; reviewers=logic-validator -->",
      ].join("\n"),
    );
  }

  const roundSections: string[] = [];
  for (let round = 1; round <= options.round; round++) {
    roundSections.push(`## Reviewer Outputs (Round ${round})`, "");
    for (const slug of options.ledgerSlugs) {
      roundSections.push(`### ${slug}`, "- verdict: ", "- 主指摘: ", "");
    }
  }

  const docContent = [
    "## Files",
    "```",
    "src/a.ts",
    "```",
    "",
    "## Tasks",
    "- T1: implement",
    "",
    ...roundSections,
    "## Approval",
    "- Plan Status: complete",
    "- Review Status: pending",
    "- Approval Status: pending",
  ].join("\n");
  writeFileSync(join(wf, options.doc), docContent);

  writeFileSync(
    join(wf, ".round-baseline"),
    `${options.round}\t${new Date().toISOString()}\n`,
  );

  const ledger = join(wf, "reviewer-runs.log");
  const ledgerLines = options.ledgerSlugs.map(
    (slug) => `${sessionId}\t${slug}\t${new Date().toISOString()}`,
  );
  writeFileSync(
    ledger,
    ledgerLines.length > 0 ? `${ledgerLines.join("\n")}\n` : "",
  );

  return { wf, ledger };
}

/**
 * Seed a fresh workflow dir whose per-doc review cache already records
 * `planHash` for `docName`, for `isCompleteAndChanged` tests (plan-3 T5).
 */
export function seedCache(docName: string, planHash: string): string {
  const wf = mkdtempSync(join(tmpdir(), "cache-seed-"));
  writeDocCache(wf, docName, {
    planHash,
    recommendedAt: new Date().toISOString(),
  });
  return wf;
}

export const createUserPromptSubmitContext = (prompt: string) => {
  return new MockHookContext<{ UserPromptSubmit: true }>({
    hook_event_name: "UserPromptSubmit",
    cwd: "/test",
    session_id: TEST_SESSION_ID,
    transcript_path: "/test/transcript",
    prompt,
  });
};
