#!/usr/bin/env -S bun run --silent
/**
 * Syncs plugin-dependencies.json from installed_plugins.json.
 * Run: bun ~/.claude/scripts/sync-plugin-dependencies.ts
 */

import { readFileSync, writeFileSync, existsSync } from "fs";
import { dirname } from "path";
import { fileURLToPath } from "url";
import {
  INSTALLED_PLUGINS_PATH,
  parsePluginKey,
  makePluginKey,
  type PluginDependency,
  type PluginDependencies,
  type InstalledPlugins,
} from "../lib/plugin-utils.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEPENDENCIES_PATH = `${__dirname}/../plugin-dependencies.json`;

function loadExistingPurposes(): Map<string, string> {
  const purposes = new Map<string, string>();
  if (!existsSync(DEPENDENCIES_PATH)) {
    return purposes;
  }
  try {
    const content = readFileSync(DEPENDENCIES_PATH, "utf-8");
    const deps = JSON.parse(content) as PluginDependencies;
    for (const plugin of deps.plugins) {
      const key = makePluginKey(plugin.name, plugin.marketplace);
      purposes.set(key, plugin.purpose);
    }
  } catch {
    // ignore
  }
  return purposes;
}

function loadInstalledPluginKeys(): string[] {
  if (!existsSync(INSTALLED_PLUGINS_PATH)) {
    console.error("⚠️  installed_plugins.json not found");
    process.exit(1);
  }
  try {
    const content = readFileSync(INSTALLED_PLUGINS_PATH, "utf-8");
    const installed = JSON.parse(content) as InstalledPlugins;
    return Object.keys(installed.plugins ?? {});
  } catch (error) {
    console.error("⚠️  Failed to read installed_plugins.json:", error);
    process.exit(1);
  }
}

function main(): void {
  const existingPurposes = loadExistingPurposes();
  const installedKeys = loadInstalledPluginKeys();

  const plugins: PluginDependency[] = installedKeys
    .map((key) => {
      const { name, marketplace } = parsePluginKey(key);
      return {
        name,
        marketplace,
        purpose: existingPurposes.get(key) ?? "",
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  const output: PluginDependencies = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    description: "Claude Code plugin dependencies for this dotfiles",
    plugins,
  };

  writeFileSync(DEPENDENCIES_PATH, JSON.stringify(output, null, 2) + "\n");

  console.log(`✅ Synced ${plugins.length} plugins to plugin-dependencies.json`);

  const emptyPurpose = plugins.filter((p) => p.purpose === "");
  if (emptyPurpose.length > 0) {
    console.log("");
    console.log("⚠️  Plugins with empty purpose (please fill in manually):");
    for (const p of emptyPurpose) {
      console.log(`   - ${p.name}`);
    }
  }
}

main();
