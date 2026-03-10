#!/usr/bin/env -S bun run --silent

import { basename } from "node:path";
import { defineHook } from "cc-hooks-ts";
import { createAskResponse } from "../lib/context-helpers.ts";
import "../types/tool-schemas.ts";

/**
 * PreToolUse guard that warns on modifications to linter/formatter config files.
 *
 * Forces a permission prompt so the user can explicitly allow or deny the edit.
 * Prevents agents from silently weakening code quality rules.
 */

const PROTECTED_BASENAMES = new Set([
  "biome.json",
  "biome.jsonc",
  ".eslintrc",
  ".eslintrc.js",
  ".eslintrc.json",
  ".eslintrc.yml",
  "eslint.config.js",
  "eslint.config.mjs",
  "eslint.config.ts",
  ".prettierrc",
  ".prettierrc.json",
  ".prettierrc.js",
  "prettier.config.js",
  "prettier.config.mjs",
  ".oxfmtrc.json",
  ".oxfmtrc.jsonc",
  "tsconfig.json",
  "tsconfig.build.json",
  "lefthook.yml",
  "lefthook-local.yml",
  ".pre-commit-config.yaml",
  "oxlint.json",
  ".oxlintrc.json",
  ".golangci.yml",
  ".swiftlint.yml",
]);

const PROTECTED_PATTERNS = [/^\.eslintrc/, /^oxlint/];

function isProtectedFile(filePath: string): boolean {
  const base = basename(filePath);
  if (PROTECTED_BASENAMES.has(base)) return true;
  return PROTECTED_PATTERNS.some((p) => p.test(base));
}

function getFilePath(
  tool_name: string,
  tool_input: Record<string, unknown>,
): string | null {
  if (!["Write", "Edit", "MultiEdit"].includes(tool_name)) return null;
  return (
    (tool_input.file_path as string) || (tool_input.path as string) || null
  );
}

const hook = defineHook({
  trigger: { PreToolUse: true },
  run: (context) => {
    const { tool_name, tool_input } = context.input;

    const filePath = getFilePath(
      tool_name,
      tool_input as Record<string, unknown>,
    );
    if (!filePath) return context.success({});

    if (isProtectedFile(filePath)) {
      return context.json(
        createAskResponse(
          `${basename(filePath)} is a protected linter/formatter config file.\n` +
            "Agent modifications to linter configs can weaken code quality rules.\n" +
            "Allow this edit only if the user explicitly requested it.",
        ),
      );
    }

    return context.success({});
  },
});

export default hook;

if (import.meta.main) {
  const { runHook } = await import("cc-hooks-ts");
  await runHook(hook);
}
