import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { type FetchOpts, isRecord, readJsonFile } from "../lib.ts";
import {
  readOpencodeCredentialKey,
  ZAI_INTEGRATION_ID,
} from "../opencode-credential.ts";

const ZAI_BASE = "https://api.z.ai";
const QUOTA_PATH = "/api/monitor/usage/quota/limit";
const MODEL_USAGE_PATH = "/api/monitor/usage/model-usage";
const TOOL_USAGE_PATH = "/api/monitor/usage/tool-usage";

/**
 * opencode v2.x stores credentials in its SQLite DB (`credential` table).
 * auth.json is no longer updated on re-login and can hold a revoked key,
 * so the active DB credential wins over the legacy auth.json entry.
 * A store that cannot be read counts as "no key in the DB" so the lookup
 * falls through to auth.json as before.
 */
function resolveApiKeyFromOpencodeDb(
  dbPath: string,
): { key: string } | undefined {
  try {
    const key = readOpencodeCredentialKey(dbPath, ZAI_INTEGRATION_ID);
    return key === undefined ? undefined : { key };
  } catch {
    return undefined;
  }
}

export function resolveApiKey(opts: FetchOpts): {
  key: string;
  source: string;
} {
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

  // Explicit --auth-file keeps meaning "auth.json-style file".
  if (opts.authFile) {
    const fromFile = resolveApiKeyFromAuthFile(opts.authFile);
    return { key: fromFile, source: `${opts.authFile}#zai-coding-plan` };
  }

  const dbPath = join(homedir(), ".local", "share", "opencode", "opencode.db");
  const fromDb = resolveApiKeyFromOpencodeDb(dbPath);
  if (fromDb) {
    return { key: fromDb.key, source: `${dbPath}#credential` };
  }

  const authPath = join(homedir(), ".local", "share", "opencode", "auth.json");
  if (existsSync(authPath)) {
    const key = resolveApiKeyFromAuthFile(authPath);
    return { key, source: `${authPath}#zai-coding-plan` };
  }
  throw new Error(
    `No Z.ai credentials. Set ZAI_CODING_API_KEY, or run opencode auth login so ${dbPath} has an active zai-coding-plan credential.`,
  );
}

function resolveApiKeyFromAuthFile(authPath: string): string {
  let parsed: unknown;
  try {
    parsed = readJsonFile(authPath);
  } catch (error) {
    throw new Error(
      `Failed to read ${authPath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (!isRecord(parsed)) {
    throw new Error(`${authPath} is not a JSON object.`);
  }
  const entry = parsed["zai-coding-plan"];
  if (!isRecord(entry) || typeof entry.key !== "string" || !entry.key) {
    throw new Error(
      `${authPath} has no zai-coding-plan.key. Run: opencode auth login`,
    );
  }
  return entry.key;
}

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

/**
 * The z.ai monitor API parses/renders timestamps as UTC+8 wall clock
 * ("yyyy-MM-dd HH:mm:ss"), regardless of the client timezone.
 */
const ZAI_TZ_OFFSET_MS = 8 * 60 * 60 * 1000;

function formatZaiTimestamp(date: Date): string {
  const shifted = new Date(date.getTime() + ZAI_TZ_OFFSET_MS);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())} ${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())}:${pad(shifted.getUTCSeconds())}`;
}

function rollingDayBounds(): { startTime: string; endTime: string } {
  const end = new Date();
  end.setMinutes(59, 59, 999);
  const start = new Date(end);
  start.setDate(start.getDate() - 1);
  start.setMinutes(0, 0, 0);
  return {
    startTime: formatZaiTimestamp(start),
    endTime: formatZaiTimestamp(end),
  };
}

export async function fetchOpencodeUsage(
  opts: FetchOpts,
): Promise<Record<string, unknown>> {
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
