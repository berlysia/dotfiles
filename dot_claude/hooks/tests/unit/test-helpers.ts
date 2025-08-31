/**
 * Common test helpers and mocks for cc-hooks-ts hook testing
 */

import { strictEqual, deepStrictEqual } from "node:assert";

/**
 * Mock context object that simulates cc-hooks-ts hook context
 */
export class MockHookContext {
  public successCalls: any[] = [];
  public failCalls: any[] = [];
  
  constructor(public input: Record<string, any> = {}) {}
  
  success = (result: any = {}) => {
    this.successCalls.push(result);
    return result;
  };
  
  fail = (result: any = {}) => {
    this.failCalls.push(result);
    return result;
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
  
  reset() {
    this.successCalls = [];
    this.failCalls = [];
  }
}

/**
 * Hook definition mock that captures the hook configuration
 */
export class MockHookDefinition {
  public trigger: Record<string, boolean> = {};
  public run?: (context: any) => any;
  
  constructor(config: { trigger: Record<string, boolean>; run: (context: any) => any }) {
    this.trigger = config.trigger;
    this.run = config.run;
  }
  
  async execute(input: Record<string, any> = {}): Promise<any> {
    if (!this.run) {
      throw new Error("Hook run function not defined");
    }
    
    const context = new MockHookContext(input);
    const result = await this.run(context);
    return { context, result };
  }
}

/**
 * Simulates defineHook from cc-hooks-ts
 */
export function defineHook(config: { 
  trigger: Record<string, boolean>; 
  run: (context: any) => any 
}): MockHookDefinition {
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