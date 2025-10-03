#!/usr/bin/env bun

import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// Get current file directory (Node.js standard way)
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// MCP packages that need version management
const MCP_PACKAGES = [
  "@mizchi/readability",
  "chrome-devtools-mcp",
  "@playwright/mcp",
  "@upstash/context7-mcp",
  "o3-search-mcp",
] as const;

interface PackageJson {
  devDependencies?: Record<string, string>;
}

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
 * Clean version string by removing range specifiers (^, ~, etc.)
 */
function cleanVersion(version: string): string {
  return version.replace(/^[\^~>=<]/, "").trim();
}

/**
 * Get version from package.json devDependencies
 */
function getVersionFromPackageJson(
  packageJson: PackageJson,
  packageName: string
): string | null {
  const version = packageJson.devDependencies?.[packageName];
  if (!version) {
    return null;
  }
  return cleanVersion(version);
}

/**
 * Update package version in args array
 * Handles both @latest format and existing pinned versions
 */
function updatePackageVersion(
  args: string[],
  packageName: string,
  version: string
): { updated: boolean; args: string[] } {
  let updated = false;
  const newArgs = args.map((arg) => {
    // Match package@version or package@latest
    if (arg.startsWith(packageName) && arg.includes("@")) {
      const currentVersion = arg.split("@").pop();
      if (currentVersion !== version) {
        updated = true;
        return `${packageName}@${version}`;
      }
    }
    return arg;
  });
  return { updated, args: newArgs };
}

async function main() {
  const packageJsonPath = resolve(__dirname, "../package.json");
  const configPath = resolve(__dirname, "../.claude.json");

  console.log("Reading package.json...");
  const packageJsonContent = readFileSync(packageJsonPath, "utf-8");
  const packageJson: PackageJson = JSON.parse(packageJsonContent);

  console.log("Reading .claude.json...");
  const configContent = readFileSync(configPath, "utf-8");
  const config: ClaudeConfig = JSON.parse(configContent);

  console.log("\nSyncing MCP package versions from package.json...\n");

  const updates: Array<{ package: string; version: string }> = [];
  let hasChanges = false;

  // Get versions from package.json
  for (const packageName of MCP_PACKAGES) {
    const version = getVersionFromPackageJson(packageJson, packageName);

    if (!version) {
      console.warn(`⚠ Warning: ${packageName} not found in package.json devDependencies`);
      continue;
    }

    // Update config with versions from package.json
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
    console.log("\n✓ No updates needed. All packages are already in sync.");
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
    '\n💡 .claude.json has been synced with package.json versions'
  );
}

main().catch((error) => {
  console.error("Error:", error instanceof Error ? error.message : String(error));
  process.exit(1);
});
