#!/usr/bin/env -S bun run --silent
/**
 * Shows missing Claude Code plugins and generates install commands.
 * Run: bun ~/.claude/scripts/show-missing-plugins.ts
 */

import {
  loadDependencies,
  loadInstalledPlugins,
  findMissingPlugins,
} from "../lib/plugin-utils.ts";

function main(): void {
  const dependencies = loadDependencies();
  const installed = loadInstalledPlugins();
  const missing = findMissingPlugins(dependencies, installed);

  if (missing.length === 0) {
    console.log("✅ All required plugins are already installed!");
    return;
  }

  console.log("📦 Missing plugins:");
  for (const dep of missing) {
    console.log(`   - ${dep.name}: ${dep.purpose}`);
  }
  console.log("");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("Run the following commands to install:");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("");
  for (const dep of missing) {
    console.log(`claude -p "/plugin install ${dep.name}@${dep.marketplace}"`);
  }
  console.log("");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
}

main();
