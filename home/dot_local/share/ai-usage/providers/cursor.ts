import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { type FetchOpts, isRecord, readJsonFile } from "../lib.ts";

const API2 = "https://api2.cursor.sh";
const DASHBOARD = `${API2}/aiserver.v1.DashboardService`;

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
  opts: FetchOpts,
): Promise<{ token: string; source: string }> {
  const fromEnv = process.env.CURSOR_ACCESS_TOKEN?.trim();
  if (fromEnv) return { token: fromEnv, source: "CURSOR_ACCESS_TOKEN" };

  const apiKey = process.env.CURSOR_API_KEY?.trim();
  if (apiKey) {
    const token = await exchangeApiKey(apiKey, opts.timeoutMs);
    return { token, source: "CURSOR_API_KEY" };
  }

  const authPath =
    opts.authFile ?? join(homedir(), ".config", "cursor", "auth.json");
  if (!existsSync(authPath)) {
    throw new Error(
      `No Cursor credentials. Set CURSOR_ACCESS_TOKEN / CURSOR_API_KEY, or log in with cursor-agent so ${authPath} exists.`,
    );
  }
  let parsed: unknown;
  try {
    parsed = readJsonFile(authPath);
  } catch (error) {
    throw new Error(
      `Failed to read ${authPath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!isRecord(parsed) || typeof parsed.accessToken !== "string") {
    throw new Error(`${authPath} has no accessToken string.`);
  }
  return { token: parsed.accessToken, source: authPath };
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

export async function fetchCursorUsage(
  opts: FetchOpts,
): Promise<Record<string, unknown>> {
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
