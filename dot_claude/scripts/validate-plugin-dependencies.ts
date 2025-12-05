#!/usr/bin/env -S bun run --silent
/**
 * Validates that required Claude Code plugins are installed.
 * Reads dependencies from plugin-dependencies.json.
 */

import {
  loadDependencies,
  loadInstalledPlugins,
  findMissingPlugins,
} from "../lib/plugin-utils.ts";

function main(): void {
  const dependencies = loadDependencies();
  const installed = loadInstalledPlugins();

  if (installed.size === 0) {
    console.log("⚠️  Claude Code plugins not installed yet");
    console.log("   Run: bun ~/.claude/scripts/show-missing-plugins.ts");
    return;
  }

  const missing = findMissingPlugins(dependencies, installed);

  if (missing.length === 0) {
    console.log("✅ All required Claude Code plugins are installed");
    return;
  }

  console.log("⚠️  Missing Claude Code plugins:");
  for (const dep of missing) {
    console.log(`   - ${dep.name} (${dep.purpose})`);
  }
  console.log("");
  console.log("Run: bun ~/.claude/scripts/show-missing-plugins.ts");
  console.log("Or manually in Claude Code:");
  for (const dep of missing) {
    console.log(`   /plugin install ${dep.name}@${dep.marketplace}`);
  }
}

main();
