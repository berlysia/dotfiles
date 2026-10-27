import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { type FetchOpts, isRecord, readJsonFile } from "../lib.ts";

const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";

export async function fetchClaudeUsage(
  opts: FetchOpts,
): Promise<Record<string, unknown>> {
  const authPath =
    opts.authFile ?? join(homedir(), ".claude", ".credentials.json");
  const fromEnv = process.env.CLAUDE_ACCESS_TOKEN?.trim();

  let token: string;
  let authSource: string;
  if (fromEnv) {
    token = fromEnv;
    authSource = "CLAUDE_ACCESS_TOKEN";
  } else {
    if (!existsSync(authPath)) {
      throw new Error(
        `No Claude credentials. Set CLAUDE_ACCESS_TOKEN or keep ${authPath} (claudeAiOauth.accessToken).`,
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
    const oauth = isRecord(parsed) ? parsed.claudeAiOauth : undefined;
    if (!isRecord(oauth) || typeof oauth.accessToken !== "string") {
      throw new Error(`${authPath} has no claudeAiOauth.accessToken.`);
    }
    token = oauth.accessToken;
    authSource = authPath;
  }

  const res = await fetch(USAGE_URL, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      "anthropic-beta": "oauth-2025-04-20",
    },
    signal: AbortSignal.timeout(opts.timeoutMs),
  });
  const text = await res.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`Claude usage returned non-JSON (HTTP ${res.status})`);
  }
  if (!res.ok) {
    const message =
      isRecord(body) && typeof body.error === "object" && body.error !== null
        ? JSON.stringify(body.error)
        : text.slice(0, 200);
    throw new Error(`Claude usage failed (HTTP ${res.status}): ${message}`);
  }
  if (!isRecord(body) || (!("five_hour" in body) && !("seven_day" in body))) {
    throw new Error(`Unexpected Claude usage shape: ${text.slice(0, 300)}`);
  }

  return {
    fetchedAt: new Date().toISOString(),
    authSource,
    ...body,
  };
}
