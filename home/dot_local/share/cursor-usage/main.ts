#!/usr/bin/env bun
/**
 * Fetch Cursor personal-plan usage via the same DashboardService RPCs the
 * Agent CLI / IDE use (api2.cursor.sh). Unofficial; fields may change.
 *
 * Auth (first match wins):
 *   1. CURSOR_ACCESS_TOKEN
 *   2. CURSOR_API_KEY  → exchange_user_api_key
 *   3. ~/.config/cursor/auth.json  (accessToken from `agent` / cursor-agent login)
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const API2 = "https://api2.cursor.sh";
const DASHBOARD = `${API2}/aiserver.v1.DashboardService`;

type CliOptions = {
  timeoutMs: number;
  help: boolean;
  authPath: string;
};

function printHelp(): void {
  process.stdout.write(`Usage: cursor-usage [options]

Fetch Cursor account usage JSON (unofficial DashboardService RPCs).

Auth (first match):
  CURSOR_ACCESS_TOKEN     Bearer access token
  CURSOR_API_KEY          User API key (crsr_...); exchanged for a token
  ~/.config/cursor/auth.json   accessToken from cursor-agent login

Options:
  --timeout <seconds>     HTTP timeout (default: 20)
  --auth-file <path>      Override auth.json path
  -h, --help              Show this help

Output (stdout): JSON with fetchedAt, planInfo, periodUsage, hardLimit.
Errors on stderr; exit 0 on success.
`);
}

function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = {
    timeoutMs: 20_000,
    help: false,
    authPath: join(homedir(), ".config", "cursor", "auth.json"),
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) continue;
    if (arg === "-h" || arg === "--help") {
      opts.help = true;
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

async function exchangeApiKey(
  apiKey: string,
  timeoutMs: number,
): Promise<string> {
  const res = await fetch(`${API2}/auth/exchange_user_api_key`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: "{}",
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(
      `API key exchange failed (HTTP ${res.status}): ${text.slice(0, 200)}`,
    );
  }
  if (!res.ok || !isRecord(body) || typeof body.accessToken !== "string") {
    const message =
      isRecord(body) && typeof body.message === "string"
        ? body.message
        : text.slice(0, 200);
    throw new Error(`API key exchange failed (HTTP ${res.status}): ${message}`);
  }
  return body.accessToken;
}

async function resolveAccessToken(
  opts: CliOptions,
): Promise<{ token: string; source: string }> {
  const fromEnv = process.env.CURSOR_ACCESS_TOKEN?.trim();
  if (fromEnv) return { token: fromEnv, source: "CURSOR_ACCESS_TOKEN" };

  const apiKey = process.env.CURSOR_API_KEY?.trim();
  if (apiKey) {
    const token = await exchangeApiKey(apiKey, opts.timeoutMs);
    return { token, source: "CURSOR_API_KEY" };
  }

  if (!existsSync(opts.authPath)) {
    throw new Error(
      `No Cursor credentials. Set CURSOR_ACCESS_TOKEN / CURSOR_API_KEY, or log in with cursor-agent so ${opts.authPath} exists.`,
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
  if (!isRecord(parsed) || typeof parsed.accessToken !== "string") {
    throw new Error(`${opts.authPath} has no accessToken string.`);
  }
  return { token: parsed.accessToken, source: opts.authPath };
}

async function dashboardRpc(
  token: string,
  method: string,
  timeoutMs: number,
  body: Record<string, unknown> = {},
): Promise<unknown> {
  const res = await fetch(`${DASHBOARD}/${method}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "Connect-Protocol-Version": "1",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`${method} returned non-JSON (HTTP ${res.status})`);
  }
  if (!res.ok) {
    const message =
      isRecord(parsed) && typeof parsed.message === "string"
        ? parsed.message
        : text.slice(0, 200);
    throw new Error(`${method} failed (HTTP ${res.status}): ${message}`);
  }
  return parsed;
}

async function fetchUsage(opts: CliOptions): Promise<Record<string, unknown>> {
  const { token, source } = await resolveAccessToken(opts);
  const [periodUsage, planInfo, hardLimit] = await Promise.all([
    dashboardRpc(token, "GetCurrentPeriodUsage", opts.timeoutMs),
    dashboardRpc(token, "GetPlanInfo", opts.timeoutMs),
    dashboardRpc(token, "GetHardLimit", opts.timeoutMs),
  ]);

  return {
    fetchedAt: new Date().toISOString(),
    authSource: source,
    ...(isRecord(planInfo) ? planInfo : { planInfo }),
    periodUsage,
    hardLimit,
  };
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
      `cursor-usage: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}

await main();
