/**
 * Mock cc-hooks-ts module for local development and testing
 * This file provides the defineHook function used by all hook implementations
 */

export interface HookContext {
  input: Record<string, any>;
  success: (result?: any) => any;
  fail: (result?: any) => any;
  blockingError: (message: string) => any;
}

export interface HookConfig {
  trigger: Record<string, boolean>;
  run: (context: HookContext) => any;
}

export function defineHook(config: HookConfig) {
  return config;
}

export default { defineHook };