/**
 * Common test helpers and mocks for cc-hooks-ts hook testing
 */

import { strictEqual, deepStrictEqual } from "node:assert";
import { 
  defineHook as originalDefineHook,
  type ExtractAllHookInputsForEvent,
  type ToolSchema
} from "cc-hooks-ts";
import type { BuiltinToolName, PreToolUseHookInput, PostToolUseHookInput } from "../../types/project-types.ts";

// Extract types from defineHook function
type HookDefinition = Parameters<typeof originalDefineHook>[0];
type HookTrigger = HookDefinition['trigger'];
type HookHandler = HookDefinition['run'];

// Type to extract proper input based on trigger events
type ExtractHookInput<TTrigger extends HookTrigger> = {
  [EventKey in keyof TTrigger]: EventKey extends "PreToolUse" | "PostToolUse" | "Notification" | "UserPromptSubmit" | "Stop" | "SubagentStop" | "PreCompact" | "SessionStart" | "SessionEnd"
    ? ExtractAllHookInputsForEvent<EventKey>
    : never
}[keyof TTrigger];

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
  
  json = (payload: any) => {
    this.jsonCalls.push(payload);
    return { kind: "json" as const, payload };
  };
  
  nonBlockingError = (message: string = "") => {
    this.nonBlockingErrorCalls.push(message);
    return { kind: "non-blocking-error" as const, payload: message };
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
    strictEqual(this.nonBlockingErrorCalls.length, 1, "nonBlockingError() should be called once");
    deepStrictEqual(this.nonBlockingErrorCalls[0], expectedMessage);
  }
  
  assertDeny(expectedReason?: string) {
    strictEqual(this.jsonCalls.length, 1, "json() should be called once for deny response");
    strictEqual(this.successCalls.length, 0, "success() should not be called");
    strictEqual(this.failCalls.length, 0, "fail() should not be called");
    
    const response = this.jsonCalls[0];
    strictEqual(response.hookSpecificOutput.hookEventName, "PreToolUse");
    strictEqual(response.hookSpecificOutput.permissionDecision, "deny");
    
    if (expectedReason !== undefined) {
      strictEqual(response.hookSpecificOutput.permissionDecisionReason, expectedReason);
    }
  }
  
  assertAllow(expectedReason?: string) {
    strictEqual(this.jsonCalls.length, 1, "json() should be called once for allow response");
    strictEqual(this.successCalls.length, 0, "success() should not be called");
    strictEqual(this.failCalls.length, 0, "fail() should not be called");
    
    const response = this.jsonCalls[0];
    strictEqual(response.hookSpecificOutput.hookEventName, "PreToolUse");
    strictEqual(response.hookSpecificOutput.permissionDecision, "allow");
    
    if (expectedReason !== undefined) {
      strictEqual(response.hookSpecificOutput.permissionDecisionReason, expectedReason);
    }
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
export class MockHookDefinition<TTrigger extends HookTrigger> {
  public trigger: TTrigger;
  public run: HookHandler;
  
  constructor(config: {
    trigger: TTrigger;
    run: HookHandler;
  }) {
    this.trigger = config.trigger;
    this.run = config.run;
  }
  
  async execute(input: ExtractHookInput<TTrigger>) {
    const context = new MockHookContext<TTrigger>(input);
    const result = await this.run(context as any); // Type assertion still needed for handler compatibility
    return { context, result };
  }
}

/**
 * Simulates defineHook from cc-hooks-ts
 */
export function defineHook<TTrigger extends HookTrigger>(config: {
  trigger: TTrigger;
  run: HookHandler;
}): MockHookDefinition<TTrigger> {
  return new MockHookDefinition(config);
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
    
    readFileSync(path: string, encoding?: string): string {
      if (!files.has(path)) {
        const error: any = new Error(`ENOENT: no such file or directory, open '${path}'`);
        error.code = "ENOENT";
        throw error;
      }
      return files.get(path)!;
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
    }
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
    info: console.info
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
  tool_input: ToolSchema[Name]["input"]
) => {
  const input = {
    hook_event_name: "PreToolUse" as const,
    cwd: "/test",
    session_id: "test-session",
    transcript_path: "/test/transcript",
    tool_name,
    tool_input
  } as ExtractAllHookInputsForEvent<"PreToolUse">;
  
  return new MockHookContext<{ PreToolUse: true }>(input);
};

export const createPostToolUseContext = <Name extends keyof ToolSchema>(
  tool_name: Name, 
  tool_input: ToolSchema[Name]["input"], 
  tool_response: ToolSchema[Name]["response"]
) => {
  const input = {
    hook_event_name: "PostToolUse" as const,
    cwd: "/test",
    session_id: "test-session", 
    transcript_path: "/test/transcript",
    tool_name,
    tool_input,
    tool_response
  } as ExtractAllHookInputsForEvent<"PostToolUse">;
  
  return new MockHookContext<{ PostToolUse: true }>(input);
};

export const createNotificationContext = (message?: string) => {
  return new MockHookContext<{ Notification: true }>({
    hook_event_name: "Notification",
    cwd: "/test",
    session_id: "test-session",
    transcript_path: "/test/transcript",
    message
  });
};

export const createStopContext = (stop_hook_active?: boolean) => {
  return new MockHookContext<{ Stop: true }>({
    hook_event_name: "Stop",
    cwd: "/test",
    session_id: "test-session",
    transcript_path: "/test/transcript",
    stop_hook_active
  });
};

export const createSessionStartContext = (source: string) => {
  return new MockHookContext<{ SessionStart: true }>({
    hook_event_name: "SessionStart",
    cwd: "/test",
    session_id: "test-session",
    transcript_path: "/test/transcript",
    source
  });
};

export const createUserPromptSubmitContext = (prompt: string) => {
  return new MockHookContext<{ UserPromptSubmit: true }>({
    hook_event_name: "UserPromptSubmit",
    cwd: "/test", 
    session_id: "test-session",
    transcript_path: "/test/transcript",
    prompt
  });
};