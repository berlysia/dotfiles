#!/usr/bin/env -S bun run --silent

import { defineHook } from "cc-hooks-ts";
import { existsSync } from "node:fs";
import { execSync } from "node:child_process";
import { extname } from "node:path";
import "../types/tool-schemas.ts";

/**
 * Auto-format files after Edit/MultiEdit/Write operations
 * Converted from auto-format.sh using cc-hooks-ts
 */
const hook = defineHook({
  trigger: { PostToolUse: true },
  run: (context) => {
    const { tool_name, tool_input } = context.input;

    // Only process file writing/editing tools
    const formatableTools = ["Edit", "MultiEdit", "Write"];
    if (!formatableTools.includes(tool_name)) {
      return context.success({});
    }

    try {
      // Extract file path from tool input
      const filePath = extractFilePath(tool_name, tool_input);
      if (!filePath) {
        return context.success({});
      }

      // Check if file exists
      if (!existsSync(filePath)) {
        return context.success({});
      }

      // Check if file extension is formattable
      if (!isFormattableFile(filePath)) {
        return context.success({});
      }

      // Attempt to format the file
      const formatResult = attemptFormat(filePath);

      if (formatResult.success) {
        console.log(`✅ Formatted ${filePath} with ${formatResult.formatter}`);
      }

      // Always return success - formatting failures should not block operations
      return context.success({});

    } catch (error) {
      console.error(`Auto-format error: ${error}`);
      // Don't block on formatting errors
      return context.success({});
    }
  }
});

interface FormatResult {
  success: boolean;
  formatter?: string;
  error?: string;
}

/**
 * Extract file path from tool input
 */
function extractFilePath(tool_name: string, tool_input: any): string | null {
  switch (tool_name) {
    case "Write":
      return tool_input.file_path || null;

    case "Edit":
    case "MultiEdit":
      return tool_input.file_path || null;

    default:
      return null;
  }
}

/**
 * Check if file has a formattable extension
 */
function isFormattableFile(filePath: string): boolean {
  const ext = extname(filePath).slice(1); // Remove leading dot

  const formattableExtensions = [
    'js', 'jsx', 'ts', 'tsx', 'json', 'jsonc',
    'css', 'scss', 'html', 'md', 'mdx',
    'yml', 'yaml', 'toml', 'rs', 'go', 'py'
  ];

  return formattableExtensions.includes(ext);
}

/**
 * Check if command exists
 */
function commandExists(command: string): boolean {
  try {
    execSync(`command -v ${command}`, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if local binary exists
 */
function localBinaryExists(path: string): boolean {
  return existsSync(path);
}

/**
 * Execute formatter command safely
 */
function execFormatter(command: string, filePath: string): boolean {
  try {
    execSync(command.replace('$FILE', `"${filePath}"`), {
      stdio: 'ignore',
      timeout: 10000 // 10 second timeout
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Attempt to format file with available formatters
 */
function attemptFormat(filePath: string): FormatResult {
  // Try Biome first (fastest)
  if (existsSync("biome.json") || existsSync("biome.jsonc")) {
    // Global biome
    if (commandExists("biome")) {
      if (execFormatter("biome format --write $FILE", filePath)) {
        return { success: true, formatter: "biome (global)" };
      }
    }

    // Local biome
    if (localBinaryExists("node_modules/.bin/biome")) {
      if (execFormatter("./node_modules/.bin/biome format --write $FILE", filePath)) {
        return { success: true, formatter: "biome (local)" };
      }
    }

    // NPX biome
    if (commandExists("npx") && existsSync("package.json")) {
      try {
        const packageJson = require(process.cwd() + "/package.json");
        if (packageJson.dependencies?.["@biomejs/biome"] ||
          packageJson.devDependencies?.["@biomejs/biome"]) {
          if (execFormatter("npx biome format --write $FILE", filePath)) {
            return { success: true, formatter: "biome (npx)" };
          }
        }
      } catch {
        // Ignore package.json parse errors
      }
    }
  }

  // Try Deno fmt
  if (existsSync("deno.json") || existsSync("deno.jsonc")) {
    if (commandExists("deno")) {
      if (execFormatter("deno fmt $FILE", filePath)) {
        return { success: true, formatter: "deno fmt" };
      }
    }
  }

  // Try Prettier
  const prettierConfigs = [
    ".prettierrc", ".prettierrc.json", ".prettierrc.js",
    ".prettierrc.yml", ".prettierrc.yaml", "prettier.config.js"
  ];

  if (prettierConfigs.some(config => existsSync(config))) {
    // Global prettier
    if (commandExists("prettier")) {
      if (execFormatter("prettier --write $FILE", filePath)) {
        return { success: true, formatter: "prettier (global)" };
      }
    }

    // Local prettier
    if (localBinaryExists("node_modules/.bin/prettier")) {
      if (execFormatter("./node_modules/.bin/prettier --write $FILE", filePath)) {
        return { success: true, formatter: "prettier (local)" };
      }
    }

    // NPX prettier
    if (commandExists("npx") && existsSync("package.json")) {
      try {
        const packageJson = require(process.cwd() + "/package.json");
        if (packageJson.dependencies?.["prettier"] ||
          packageJson.devDependencies?.["prettier"]) {
          if (execFormatter("npx prettier --write $FILE", filePath)) {
            return { success: true, formatter: "prettier (npx)" };
          }
        }
      } catch {
        // Ignore package.json parse errors
      }
    }
  }

  // No formatter found or all failed
  return { success: false, error: "No suitable formatter found" };
}

export default hook;

if (import.meta.main) {
  const { runHook } = await import("cc-hooks-ts");
  await runHook(hook);
}
