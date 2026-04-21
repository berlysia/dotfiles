import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const targetFile = process.argv[2];
const templateTomlPath = process.argv[3];
if (!targetFile || !templateTomlPath) {
  console.error("Usage: merge-config.ts <target.toml> <template.toml>");
  process.exit(1);
}

// Resolve dasel binary: prefer direct PATH lookup, fall back to `mise which`
function resolveDasel(): string {
  const direct = spawnSync("which", ["dasel"], { encoding: "utf8" });
  if (direct.status === 0) return direct.stdout.trim();
  const mise = spawnSync("mise", ["which", "dasel"], { encoding: "utf8" });
  if (mise.status === 0) return mise.stdout.trim();
  throw new Error("dasel not found. Install via mise: add dasel to .mise.toml");
}

const DASEL = resolveDasel();

function toJson(tomlPath: string): Record<string, unknown> {
  const r = spawnSync(DASEL, ["query", "--root", "-i", "toml", "-o", "json"], {
    input: readFileSync(tomlPath),
    encoding: "utf8",
  });
  if (r.status !== 0) return {};
  return JSON.parse(r.stdout);
}

function toToml(json: Record<string, unknown>): string {
  const r = spawnSync(DASEL, ["query", "--root", "-i", "json", "-o", "toml"], {
    input: JSON.stringify(json),
    encoding: "utf8",
  });
  if (r.status !== 0) throw new Error(r.stderr ?? "dasel failed");
  return r.stdout;
}

// Extract verbatim sections by top-level table key (preserves original formatting)
function extractSections(content: string, prefixes: string[]): string {
  const lines = content.split("\n");
  const captured: string[] = [];
  let capturing = false;

  for (const line of lines) {
    const m = line.match(/^\[([^\[\]]+)\]/);
    if (m) {
      // First bare key before any dot (handles [projects."/path/with.dots"])
      const topKey = m[1]?.match(/^([A-Za-z0-9_-]+)/)?.[1] ?? "";
      capturing = prefixes.includes(topKey);
    }
    if (capturing) captured.push(line);
  }

  return captured.join("\n").trim();
}

const existingJson = toJson(targetFile);
const templateJson = toJson(templateTomlPath);

// Keys forced from template (security/infrastructure)
const FORCED = [
  "mcp_servers",
  "sandbox_mode",
  "sandbox_workspace_write",
  "shell_environment_policy",
  "allow_login_shell",
  "approval_policy",
  "network_access",
];
// Keys preserved verbatim from existing file (dasel cannot round-trip faithfully)
const VERBATIM = ["model_providers", "projects"];
// Keys to drop (deprecated)
const DEPRECATED = ["features"];

// User overrides: existing minus forced/deprecated/verbatim
const userOverrides: Record<string, unknown> = { ...existingJson };
for (const k of [...FORCED, ...DEPRECATED, ...VERBATIM]) {
  delete userOverrides[k];
}

// Merged: template base + user overrides, then re-force infra keys from template
const merged: Record<string, unknown> = { ...templateJson, ...userOverrides };
for (const k of FORCED) {
  if (k in templateJson) merged[k] = templateJson[k];
  else delete merged[k];
}
for (const k of VERBATIM) {
  delete merged[k];
}

process.stdout.write(toToml(merged));

const preserved = extractSections(readFileSync(targetFile, "utf8"), VERBATIM);
if (preserved) {
  process.stdout.write("\n" + preserved + "\n");
}
