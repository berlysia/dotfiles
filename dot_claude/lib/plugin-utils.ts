/**
 * Plugin utilities for Claude Code plugin management
 * Manages plugin dependencies and tracks installed plugins
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

// File paths for plugin management
export const PLUGIN_DEPENDENCIES_PATH = join(
  process.env.HOME || "",
  ".claude",
  "plugin-dependencies.json",
);
export const INSTALLED_PLUGINS_PATH = join(
  process.env.HOME || "",
  ".claude",
  "installed-plugins.json",
);

/**
 * Plugin dependency definition
 */
export interface PluginDependency {
  name: string;
  marketplace: string;
  purpose: string;
}

/**
 * Parse a plugin key (name@marketplace) into its components
 */
export function parsePluginKey(key: string): {
  name: string;
  marketplace: string;
} {
  const atIndex = key.lastIndexOf("@");
  if (atIndex === -1) {
    return { name: key, marketplace: "" };
  }
  return {
    name: key.slice(0, atIndex),
    marketplace: key.slice(atIndex + 1),
  };
}

/**
 * Create a plugin key from name and marketplace
 */
export function makePluginKey(name: string, marketplace: string): string {
  return `${name}@${marketplace}`;
}

/**
 * Load plugin dependencies from file
 */
export function loadDependencies(): PluginDependency[] {
  if (!existsSync(PLUGIN_DEPENDENCIES_PATH)) {
    return [];
  }
  try {
    const content = readFileSync(PLUGIN_DEPENDENCIES_PATH, "utf-8");
    return JSON.parse(content) as PluginDependency[];
  } catch {
    return [];
  }
}

/**
 * Load installed plugins from file
 */
export function loadInstalledPlugins(): Set<string> {
  if (!existsSync(INSTALLED_PLUGINS_PATH)) {
    return new Set();
  }
  try {
    const content = readFileSync(INSTALLED_PLUGINS_PATH, "utf-8");
    const data = JSON.parse(content);
    return new Set(Array.isArray(data) ? data : []);
  } catch {
    return new Set();
  }
}

/**
 * Find plugins that are in dependencies but not installed
 */
export function findMissingPlugins(
  dependencies: PluginDependency[],
  installed: Set<string>,
): PluginDependency[] {
  return dependencies.filter((dep) => {
    const key = makePluginKey(dep.name, dep.marketplace);
    return !installed.has(key);
  });
}

/**
 * Find plugins that are installed but not in dependencies
 */
export function findUntrackedPlugins(
  dependencies: PluginDependency[],
  installedKeys: string[],
): string[] {
  const dependencyKeys = new Set(
    dependencies.map((dep) => makePluginKey(dep.name, dep.marketplace)),
  );
  return installedKeys.filter((key) => !dependencyKeys.has(key));
}
