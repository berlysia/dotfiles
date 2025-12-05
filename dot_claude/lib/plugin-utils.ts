/**
 * Shared utilities for plugin dependency management.
 */

import { readFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

// Paths
export const HOME = process.env.HOME ?? process.env.USERPROFILE ?? "";
export const PLUGIN_DEPENDENCIES_PATH = join(
  HOME,
  ".claude/plugin-dependencies.json"
);
export const INSTALLED_PLUGINS_PATH = join(
  HOME,
  ".claude/plugins/installed_plugins.json"
);

// Source directory path (for development/testing)
const __dirname = dirname(fileURLToPath(import.meta.url));
export const SOURCE_PLUGIN_DEPENDENCIES_PATH = join(
  __dirname,
  "../plugin-dependencies.json"
);

// Types
export interface PluginDependency {
  name: string;
  marketplace: string;
  purpose: string;
}

export interface PluginDependencies {
  $schema?: string;
  description?: string;
  plugins: PluginDependency[];
}

export interface InstalledPluginInfo {
  version: string;
  installedAt: string;
  lastUpdated: string;
  installPath: string;
  gitCommitSha: string;
  isLocal: boolean;
}

export interface InstalledPlugins {
  version: number;
  plugins: Record<string, InstalledPluginInfo>;
}

// Utilities
export function loadDependencies(): PluginDependency[] {
  // Try installed path first, then source path
  const pathsToTry = [PLUGIN_DEPENDENCIES_PATH, SOURCE_PLUGIN_DEPENDENCIES_PATH];

  for (const path of pathsToTry) {
    if (existsSync(path)) {
      try {
        const content = readFileSync(path, "utf-8");
        const deps = JSON.parse(content) as PluginDependencies;
        return deps.plugins;
      } catch {
        continue;
      }
    }
  }

  console.error("⚠️  Failed to read plugin-dependencies.json");
  process.exit(1);
}

export function loadInstalledPlugins(): Set<string> {
  if (!existsSync(INSTALLED_PLUGINS_PATH)) {
    return new Set();
  }
  try {
    const content = readFileSync(INSTALLED_PLUGINS_PATH, "utf-8");
    const installed = JSON.parse(content) as InstalledPlugins;
    return new Set(Object.keys(installed.plugins ?? {}));
  } catch {
    return new Set();
  }
}

export function loadInstalledPluginsRaw(): InstalledPlugins | null {
  if (!existsSync(INSTALLED_PLUGINS_PATH)) {
    return null;
  }
  try {
    const content = readFileSync(INSTALLED_PLUGINS_PATH, "utf-8");
    return JSON.parse(content) as InstalledPlugins;
  } catch {
    return null;
  }
}

export function parsePluginKey(key: string): { name: string; marketplace: string } {
  const atIndex = key.lastIndexOf("@");
  if (atIndex === -1) {
    return { name: key, marketplace: "" };
  }
  return {
    name: key.slice(0, atIndex),
    marketplace: key.slice(atIndex + 1),
  };
}

export function makePluginKey(name: string, marketplace: string): string {
  return `${name}@${marketplace}`;
}

export function findMissingPlugins(
  dependencies: PluginDependency[],
  installed: Set<string>
): PluginDependency[] {
  return dependencies.filter((dep) => {
    const key = makePluginKey(dep.name, dep.marketplace);
    return !installed.has(key);
  });
}

export function findUntrackedPlugins(
  dependencies: PluginDependency[],
  installedKeys: string[]
): string[] {
  const trackedKeys = new Set(
    dependencies.map((p) => makePluginKey(p.name, p.marketplace))
  );
  return installedKeys.filter((key) => !trackedKeys.has(key));
}
