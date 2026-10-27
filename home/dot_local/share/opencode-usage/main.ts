#!/usr/bin/env bun
/**
 * Fetch OpenCode / Z.ai Coding Plan quota JSON.
 *
 * For the common `zai-coding-plan` auth entry this hits Z.ai's monitor API
 * (same source community quota plugins use). Unofficial; fields may change.
 *
 * Auth (first match):
 *   1. ZAI_CODING_API_KEY / ZAI_API_KEY
 *   2. ~/.local/share/opencode/auth.json → zai-coding-plan.key
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const ZAI_BASE = "https://api.z.ai";
const QUOTA_PATH = "/api/monitor/usage/quota/limit";
const MODEL_USAGE_PATH = "/api/monitor/usage/model-usage";
const TOOL_USAGE_PATH = "/api/monitor/usage/tool-usage";

type CliOptions = {
  timeoutMs: number;
  help: boolean;
  authPath: string;
  details: boolean;
};

function printHelp(): void {
  process.stdout.write(`Usage: opencode-usage [options]

Fetch Z.ai Coding Plan quota used by OpenCode's zai-coding-plan provider.

Auth (first match):
  ZAI_CODING_API_KEY / ZAI_API_KEY
  ~/.local/share/opencode/auth.json  (zai-coding-plan.key)

Options:
  --details               Also fetch 24h model-usage and tool-usage
  --timeout <seconds>     HTTP timeout (default: 20)
  --auth-file <path>      Override auth.json path
  -h, --help              Show this help

Output (stdout): JSON with fetchedAt, plan level, and normalized limits.
The API key is never printed. Errors on stderr; exit 0 on success.
`);
}

function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = {
    timeoutMs: 20_000,
    help: false,
    authPath: join(homedir(), ".local", "share", "opencode", "auth.json"),
    details: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) continue;
    if (arg === "-h" || arg === "--help") {
      opts.help = true;
    } else if (arg === "--details") {
      opts.details = true;
    } else if (arg === "--auth-file") {
      const path = argv[++i];
      if (!path) throw new Error("--auth-file needs a path");
      opts.authPath = path;
    } else if (arg.startsWith("--auth-file=")) {
      opts.authPath = arg.slice("--auth-file=".length);
    } else if (arg === "--timeout") {
      const raw = argv[++i];
      const seconds = Number(raw);
      if (!Number.isFinite(seconds) || seconds <= 0) {
        throw new Error(
          `--timeout needs a positive number of seconds, got ${raw}`,
        );
      }
      opts.timeoutMs = Math.round(seconds * 1000);
    } else if (arg.startsWith("--timeout=")) {
      const seconds = Number(arg.slice("--timeout=".length));
      if (!Number.isFinite(seconds) || seconds <= 0) {
        throw new Error(
          `--timeout needs a positive number of seconds, got ${arg}`,
        );
      }
      opts.timeoutMs = Math.round(seconds * 1000);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return opts;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function resolveApiKey(opts: CliOptions): { key: string; source: string } {
  const fromEnv =
    process.env.ZAI_CODING_API_KEY?.trim() || process.env.ZAI_API_KEY?.trim();
  if (fromEnv) {
    return {
      key: fromEnv,
      source: process.env.ZAI_CODING_API_KEY?.trim()
        ? "ZAI_CODING_API_KEY"
        : "ZAI_API_KEY",
    };
  }

  if (!existsSync(opts.authPath)) {
    throw new Error(
      `No Z.ai credentials. Set ZAI_CODING_API_KEY, or run opencode auth login so ${opts.authPath} has zai-coding-plan.`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(opts.authPath, "utf8"));
  } catch (error) {
    throw new Error(
      `Failed to read ${opts.authPath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (!isRecord(parsed)) {
    throw new Error(`${opts.authPath} is not a JSON object.`);
  }
  const entry = parsed["zai-coding-plan"];
  if (!isRecord(entry) || typeof entry.key !== "string" || !entry.key) {
    throw new Error(
      `${opts.authPath} has no zai-coding-plan.key. Run: opencode auth login`,
    );
  }
  return { key: entry.key, source: `${opts.authPath}#zai-coding-plan` };
}

/**
 * Z.ai monitor `unit` codes used by Coding Plan quota windows.
 * Observed via community plugins / live responses; not an official enum.
 */
function describeLimitWindow(
  type: unknown,
  unit: unknown,
  number: unknown,
): string | undefined {
  if (type === "TOKENS_LIMIT" && unit === 3 && number === 5) return "5h";
  if (type === "TOKENS_LIMIT" && unit === 6 && number === 1) return "weekly";
  if (type === "TIME_LIMIT" && unit === 5 && number === 1) return "mcp-monthly";
  return undefined;
}

function normalizeLimits(raw: unknown): unknown {
  if (!isRecord(raw) || !Array.isArray(raw.limits)) return raw;
  return {
    ...raw,
    limits: raw.limits.map((limit) => {
      if (!isRecord(limit)) return limit;
      const window = describeLimitWindow(limit.type, limit.unit, limit.number);
      return window ? { ...limit, window } : limit;
    }),
  };
}

async function zaiGet(
  key: string,
  path: string,
  timeoutMs: number,
  query?: Record<string, string>,
): Promise<unknown> {
  const url = new URL(path, ZAI_BASE);
  if (query) {
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  }
  const res = await fetch(url, {
    method: "GET",
    headers: {
      // Z.ai monitor expects the raw key (Bearer also works today).
      Authorization: key,
      "Accept-Language": "en-US,en",
      "Content-Type": "application/json",
    },
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`${path} returned non-JSON (HTTP ${res.status})`);
  }
  if (!res.ok) {
    const message =
      isRecord(body) && typeof body.msg === "string"
        ? body.msg
        : text.slice(0, 200);
    throw new Error(`${path} failed (HTTP ${res.status}): ${message}`);
  }
  if (isRecord(body) && body.success === false) {
    throw new Error(
      `${path} failed: ${typeof body.msg === "string" ? body.msg : "success=false"}`,
    );
  }
  return body;
}

function rollingDayBounds(): { startTime: string; endTime: string } {
  const end = new Date();
  end.setMinutes(59, 59, 999);
  const start = new Date(end);
  start.setDate(start.getDate() - 1);
  start.setMinutes(0, 0, 0);
  return {
    startTime: String(start.getTime()),
    endTime: String(end.getTime()),
  };
}

async function fetchUsage(opts: CliOptions): Promise<Record<string, unknown>> {
  const { key, source } = resolveApiKey(opts);
  const quotaBody = await zaiGet(key, QUOTA_PATH, opts.timeoutMs);
  const data =
    isRecord(quotaBody) && "data" in quotaBody ? quotaBody.data : quotaBody;

  const out: Record<string, unknown> = {
    fetchedAt: new Date().toISOString(),
    authSource: source,
    provider: "zai-coding-plan",
    quota: normalizeLimits(data),
  };

  if (opts.details) {
    const bounds = rollingDayBounds();
    const [modelUsage, toolUsage] = await Promise.all([
      zaiGet(key, MODEL_USAGE_PATH, opts.timeoutMs, bounds),
      zaiGet(key, TOOL_USAGE_PATH, opts.timeoutMs, bounds),
    ]);
    out.modelUsage = isRecord(modelUsage) ? modelUsage.data : modelUsage;
    out.toolUsage = isRecord(toolUsage) ? toolUsage.data : toolUsage;
    out.detailsWindow = bounds;
  }

  return out;
}

async function main(): Promise<void> {
  let opts: CliOptions;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 2;
    return;
  }

  if (opts.help) {
    printHelp();
    return;
  }

  try {
    const payload = await fetchUsage(opts);
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(
      `opencode-usage: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}

await main();
