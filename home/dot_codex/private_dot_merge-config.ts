import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const targetFile = process.argv[2];
const templateTomlPath = process.argv[3];
const overlayTomlPath = process.argv[4];
if (!targetFile || !templateTomlPath) {
  console.error(
    "Usage: merge-config.ts <target.toml> <template.toml> [overlay.toml]",
  );
  process.exit(1);
}

// Resolve dasel binary: prefer direct PATH lookup, fall back to `mise which`,
// then probe mise installs layout directly. The last fallback exists because
// mise can report a tool as "not currently active" even when the binary is
// present on disk (e.g. immediately after `mise install` upgrades to a newer
// `latest`, before the user runs `mise use`); without it, chezmoi apply fails
// loudly on a host where the binary is actually available.
function resolveDasel(): string {
  const direct = spawnSync("which", ["dasel"], { encoding: "utf8" });
  if (direct.status === 0 && direct.stdout.trim()) return direct.stdout.trim();
  const mise = spawnSync("mise", ["which", "dasel"], { encoding: "utf8" });
  if (mise.status === 0 && mise.stdout.trim()) return mise.stdout.trim();

  const dataHome = process.env.XDG_DATA_HOME || join(homedir(), ".local/share");
  const base = join(dataHome, "mise/installs/dasel");
  if (existsSync(base)) {
    const versions = ["latest", ...readdirSync(base).sort().reverse()];
    for (const v of versions) {
      const candidate = join(base, v, "dasel");
      if (existsSync(candidate)) return candidate;
    }
  }
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

// Strict variant for authoritative inputs (template/overlay): a parse failure
// must abort rendering instead of silently degrading to {} — a {} template
// would strip every FORCED key from the output without any signal.
function toJsonStrict(tomlPath: string): Record<string, unknown> {
  const r = spawnSync(DASEL, ["query", "--root", "-i", "toml", "-o", "json"], {
    input: readFileSync(tomlPath),
    encoding: "utf8",
  });
  if (r.status !== 0) {
    throw new Error(
      `failed to parse ${tomlPath}: ${r.stderr ?? "dasel failed"}`,
    );
  }
  const parsed: unknown = JSON.parse(r.stdout);
  // dasel reports invalid TOML as exit 0 + "{}", so an empty result is
  // indistinguishable from a parse failure — reject both (an authoritative
  // base/overlay that resolves to {} is wrong either way).
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    Array.isArray(parsed) ||
    Object.keys(parsed).length === 0
  ) {
    throw new Error(`failed to parse ${tomlPath}: empty or invalid TOML table`);
  }
  return parsed as Record<string, unknown>;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// Tables merge recursively; scalars and arrays are overlay-wins wholesale.
function deepMerge(
  base: Record<string, unknown>,
  overlay: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(overlay)) {
    const b = out[k];
    out[k] = isPlainObject(b) && isPlainObject(v) ? deepMerge(b, v) : v;
  }
  return out;
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

// Target may legitimately be absent (fresh machine with a host overlay):
// treat as empty instead of throwing, so base+overlay still composes.
const existingJson = existsSync(targetFile) ? toJson(targetFile) : {};

// Forced values are the deep merge of base + host overlay (overlay may only
// extend FORCED keys; anything else would silently collide with VERBATIM
// deletion or the user-preserve path, so reject it outright).
let templateJson = toJsonStrict(templateTomlPath);
if (overlayTomlPath) {
  const overlayJson = toJsonStrict(overlayTomlPath);
  const invalidKeys = Object.keys(overlayJson).filter(
    (k) => !FORCED.includes(k),
  );
  if (invalidKeys.length > 0) {
    console.error(
      `overlay contains non-FORCED top-level keys: ${invalidKeys.join(", ")}`,
    );
    process.exit(1);
  }
  templateJson = deepMerge(templateJson, overlayJson);
}

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

const preserved = existsSync(targetFile)
  ? extractSections(readFileSync(targetFile, "utf8"), VERBATIM)
  : "";
if (preserved) {
  process.stdout.write("\n" + preserved + "\n");
}
