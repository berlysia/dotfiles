/**
 * Which settings files the hooks read, and the directory each file's `/path`
 * permission rules anchor at. Project and local settings are found under the
 * workspace root but anchor at the directory the session started in, so the
 * two are kept apart here. Reads neither the filesystem nor the environment.
 */

import { join } from "node:path";
import type { SettingsRoots } from "./project-root.ts";

type SettingsKind = "user" | "project" | "local";

export interface SettingsSource {
  kind: SettingsKind;
  path: string;
  settingsRoot: string;
}

export function listSettingsSources(
  roots: SettingsRoots,
  workspaceRoot: string | undefined,
): SettingsSource[] {
  const sources: SettingsSource[] = [
    {
      kind: "user",
      path: join(roots.user, "settings.json"),
      settingsRoot: roots.user,
    },
  ];
  if (!workspaceRoot) return sources;
  const dir = join(workspaceRoot, ".claude");
  sources.push(
    {
      kind: "project",
      path: join(dir, "settings.json"),
      settingsRoot: roots.project,
    },
    {
      kind: "local",
      path: join(dir, "settings.local.json"),
      settingsRoot: roots.project,
    },
  );
  return sources;
}
