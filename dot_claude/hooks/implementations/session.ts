#!/usr/bin/env -S bun run --silent

import { existsSync } from "node:fs";
import { defineHook } from "cc-hooks-ts";
import {
  findUntrackedPlugins,
  INSTALLED_PLUGINS_PATH,
  loadDependencies,
  loadInstalledPlugins,
  PLUGIN_DEPENDENCIES_PATH,
} from "../../lib/plugin-utils.ts";
import { logEvent } from "../lib/centralized-logging.ts";

function checkPluginSync(): string | null {
  if (
    !existsSync(PLUGIN_DEPENDENCIES_PATH) ||
    !existsSync(INSTALLED_PLUGINS_PATH)
  ) {
    return null;
  }

  try {
    const dependencies = loadDependencies();
    const installed = loadInstalledPlugins();
    const installedKeys = Array.from(installed);

    const untracked = findUntrackedPlugins(dependencies, installedKeys);

    if (untracked.length > 0) {
      const names = untracked.map((k) => k.split("@")[0]).join(", ");
      return `📦 New plugins detected: ${names}\n   Run: bun ~/.claude/scripts/sync-plugin-dependencies.ts`;
    }
  } catch {
    // ignore errors
  }
  return null;
}

/**
 * Session management hooks
 * Handles SessionStart events using centralized logging
 */
const hook = defineHook({
  trigger: { SessionStart: true },
  run: (context) => {
    try {
      // Log session start using centralized logger
      logEvent("SessionStart", context.input.session_id);

      const pluginSyncMessage = checkPluginSync();
      const messages = [
        "🚀 Claude Code session started. Ready for development!",
      ];
      if (pluginSyncMessage) {
        messages.push(pluginSyncMessage);
      }

      return context.success({
        messageForUser: messages.join("\n"),
      });
    } catch (error) {
      console.error(`Session start error: ${error}`);
      return context.success({});
    }
  },
});

export default hook;

if (import.meta.main) {
  const { runHook } = await import("cc-hooks-ts");
  await runHook(hook);
}
