import { existsSync } from "node:fs";
import { isRecord } from "./lib.ts";

/**
 * Providers whose key ai-usage reads from opencode's stored credentials.
 * delegation's offload check must accept every one of them (a test walks this
 * list), so a provider added here cannot silently become a refusal there.
 */
export const SARASHINA_INTEGRATION_ID = "sarashina";
export const ZAI_INTEGRATION_ID = "zai-coding-plan";
export const OPENCODE_CREDENTIAL_PROVIDERS = [
  SARASHINA_INTEGRATION_ID,
  ZAI_INTEGRATION_ID,
] as const;

export const CREDENTIAL_STORE_UNREADABLE =
  "opencode credential store unreadable";

const BUSY_TIMEOUT_MS = 200;

// Loaded on first use, not by a static import: Node 22 prints an
// ExperimentalWarning to stderr when node:sqlite loads, which would reach every
// command that imports this module (delegation route reaches it via ai-usage).
function loadSqlite(): typeof import("node:sqlite") {
  const mod = process.getBuiltinModule("node:sqlite");
  if (mod === undefined) throw new Error("node:sqlite is unavailable");
  return mod;
}

/**
 * Key of the newest active credential for `integrationId`, or undefined when
 * there is none. A missing database file is "not configured" (undefined);
 * a database that cannot be opened, is busy, or has the wrong schema is a
 * fault and throws a fixed message. Neither SQLite's message nor the stored
 * value is carried, and the Error has no `cause`, since either could hold a
 * key. Lives here, not in lib.ts, so providers that never touch the database
 * do not load node:sqlite.
 */
export function readOpencodeCredentialKey(
  dbPath: string,
  integrationId: string,
): string | undefined {
  if (!existsSync(dbPath)) return undefined;
  let value: string | undefined;
  try {
    const db = new (loadSqlite().DatabaseSync)(dbPath, { readOnly: true });
    try {
      db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
      const row = db
        .prepare(
          "SELECT value FROM credential WHERE integration_id = ? AND active = 1 ORDER BY time_updated DESC LIMIT 1",
        )
        .get(integrationId) as { value: unknown } | undefined;
      if (typeof row?.value === "string") value = row.value;
    } finally {
      db.close();
    }
  } catch {
    throw new Error(CREDENTIAL_STORE_UNREADABLE);
  }
  if (value === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed) || typeof parsed.key !== "string" || !parsed.key)
    return undefined;
  return parsed.key;
}
