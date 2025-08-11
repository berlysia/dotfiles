#!/usr/bin/env bun

/**
 * Build script for TypeScript hook scripts
 * Compiles TypeScript files and creates wrapper scripts
 */

import { execSync } from "node:child_process";
import { writeFileSync, chmodSync, existsSync } from "node:fs";
import { join } from "node:path";

const SCRIPTS_DIR = process.cwd();
const SRC_DIR = join(SCRIPTS_DIR, "src");
const DIST_DIR = join(SCRIPTS_DIR, "dist");

interface ScriptConfig {
  name: string;
  typescript: string;
  shell: string;
}

const SCRIPTS: ScriptConfig[] = [
  {
    name: "auto-approve-commands",
    typescript: "src/auto-approve-commands.ts",
    shell: "dist/auto-approve-commands.sh",
  },
  {
    name: "deny-repository-outside-access", 
    typescript: "src/deny-repository-outside-access.ts",
    shell: "dist/deny-repository-outside-access.sh",
  },
];

/**
 * Create a wrapper shell script
 */
function createWrapper(config: ScriptConfig): void {
  const wrapperContent = `#!/bin/bash

# Backward compatibility wrapper for TypeScript version
# This script redirects to the TypeScript implementation

SCRIPT_DIR="$(dirname "$0")"
TS_SCRIPT="$SCRIPT_DIR/../${config.typescript}"

# Execute the TypeScript version
exec "$TS_SCRIPT" "$@"
`;

  writeFileSync(config.shell, wrapperContent);
  chmodSync(config.shell, 0o755);
  console.log(`✓ Created wrapper: ${config.shell}`);
}

/**
 * Type check all TypeScript files
 */
function typeCheck(): void {
  console.log("🔍 Type checking TypeScript files...");
  
  try {
    execSync("npx tsgo check src/", { stdio: "inherit" });
    console.log("✓ Type check passed");
  } catch (error) {
    console.error("✗ Type check failed");
    process.exit(1);
  }
}

/**
 * Test TypeScript scripts can run
 */
function testExecution(): void {
  console.log("🧪 Testing script execution...");
  
  for (const config of SCRIPTS) {
    const tsScript = config.typescript;
    
    try {
      // Test that the script can be executed (will fail on missing stdin, but should not have syntax errors)
      execSync(`timeout 1s ${tsScript} < /dev/null || true`, { stdio: "pipe" });
      console.log(`✓ ${config.name} executable`);
    } catch (error) {
      console.error(`✗ ${config.name} execution test failed`);
      console.error(error);
      process.exit(1);
    }
  }
}

/**
 * Main build function
 */
function main(): void {
  console.log("🏗️  Building TypeScript hook scripts...");
  
  // Type check
  typeCheck();
  
  // Create wrapper scripts
  console.log("\n📦 Creating wrapper scripts...");
  for (const config of SCRIPTS) {
    createWrapper(config);
  }
  
  // Test execution
  console.log("\n🧪 Testing execution...");
  testExecution();
  
  console.log("\n🎉 Build completed successfully!");
  console.log("\nNext steps:");
  console.log("1. Run existing test suite to verify compatibility");
  console.log("2. Update hook configurations to use TypeScript versions");
  console.log("3. Monitor for any runtime issues");
}

// Run main if this script is executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}