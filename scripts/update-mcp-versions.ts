#!/usr/bin/env bun

import { readFileSync, writeFileSync } from "node:fs";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import { resolve } from "node:path";

const execAsync = promisify(exec);

// MCP packages that need version management
const MCP_PACKAGES = [
  "@mizchi/readability",
  "chrome-devtools-mcp",
  "@playwright/mcp",
  "@upstash/context7-mcp",
  "o3-search-mcp",
] as const;

interface ClaudeConfig {
  mcpServers: Record<
    string,
    {
      type?: string;
      command: string;
      args: string[];
      env?: Record<string, string>;
    }
  >;
  preferredNotifChannel?: string;
  defaultMode?: string;
}

/**
 * Get the latest version of an npm package
 */
async function getLatestVersion(packageName: string): Promise<string> {
  try {
    const { stdout } = await execAsync(`npm view ${packageName} version`);
    return stdout.trim();
  } catch (error) {
    throw new Error(
      `Failed to get version for ${packageName}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/**
 * Update package version in args array
 */
function updatePackageVersion(
  args: string[],
  packageName: string,
  version: string
): { updated: boolean; args: string[] } {
  let updated = false;
  const newArgs = args.map((arg) => {
    if (arg.endsWith("@latest") && arg.startsWith(packageName)) {
      updated = true;
      return `${packageName}@${version}`;
    }
    return arg;
  });
  return { updated, args: newArgs };
}

async function main() {
  const configPath = resolve(import.meta.dir, "../.claude.json");

  console.log("Reading .claude.json...");
  const configContent = readFileSync(configPath, "utf-8");
  const config: ClaudeConfig = JSON.parse(configContent);

  console.log("\nFetching latest versions for MCP packages...\n");

  const updates: Array<{ package: string; version: string }> = [];
  let hasChanges = false;

  // Fetch latest versions in parallel
  const versionPromises = MCP_PACKAGES.map(async (packageName) => {
    const version = await getLatestVersion(packageName);
    return { packageName, version };
  });

  const versions = await Promise.all(versionPromises);

  // Update config with new versions
  for (const { packageName, version } of versions) {
    for (const [serverName, serverConfig] of Object.entries(
      config.mcpServers
    )) {
      const result = updatePackageVersion(
        serverConfig.args,
        packageName,
        version
      );
      if (result.updated) {
        serverConfig.args = result.args;
        hasChanges = true;
        updates.push({ package: packageName, version });
        console.log(`✓ ${packageName}: ${version}`);
      }
    }
  }

  if (!hasChanges) {
    console.log("\n✓ No updates needed. All packages are already pinned.");
    process.exit(0);
  }

  // Write updated config
  const updatedContent = JSON.stringify(config, null, 2) + "\n";
  writeFileSync(configPath, updatedContent, "utf-8");

  console.log("\n✓ Successfully updated .claude.json");
  console.log("\nUpdated packages:");
  updates.forEach(({ package: pkg, version }) => {
    console.log(`  - ${pkg}@${version}`);
  });

  console.log(
    '\nNext steps:\n  1. Review changes: git diff .claude.json\n  2. Commit: git add .claude.json && git commit -m "chore: update MCP package versions"'
  );
}

main().catch((error) => {
  console.error("Error:", error instanceof Error ? error.message : String(error));
  process.exit(1);
});
