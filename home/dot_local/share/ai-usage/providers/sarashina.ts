import { homedir } from "node:os";
import { join } from "node:path";
import { type FetchOpts, isRecord } from "../lib.ts";
import {
  readOpencodeCredentialKey,
  SARASHINA_INTEGRATION_ID,
} from "../opencode-credential.ts";

/**
 * Sarashina publishes no usage, balance or rate-limit headers; the only limit
 * is a chat RPM that no endpoint reports. What can be known without spending a
 * chat request is whether the key reaches the API and the model is listed.
 */
export const SARASHINA_MODELS_URL = "https://api.sarashina.ai/v1/models";
export const SARASHINA_MODEL_ID = "sarashina3.2-mini-thinking";

const KEY_PATTERN = /^[\x21-\x7e]{1,512}$/;
const MAX_BODY_BYTES = 1024 * 1024;
const MAX_RETRY_AFTER_SECONDS = 86_400;
const SAFE_ERROR_NAMES = new Set(["TimeoutError", "AbortError", "TypeError"]);

/** Never use the original message or cause: fetch errors can echo the key. */
function requestFailed(error: unknown): Error {
  const name =
    error instanceof Error && SAFE_ERROR_NAMES.has(error.name)
      ? error.name
      : "Error";
  return new Error(`sarashina request failed: ${name}`);
}

function parseRetryAfter(value: string | null): number | null {
  if (value === null || !/^\d{1,9}$/.test(value)) return null;
  const seconds = Number(value);
  return seconds <= MAX_RETRY_AFTER_SECONDS ? seconds : null;
}

async function readBoundedText(res: Response): Promise<string> {
  const declared = res.headers.get("content-length");
  if (declared !== null && Number(declared) > MAX_BODY_BYTES) {
    await res.body?.cancel().catch(() => undefined);
    throw new Error("sarashina invalid response");
  }
  if (res.body === null) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BODY_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new Error("sarashina invalid response");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function listsModel(body: unknown): boolean {
  if (!isRecord(body) || !Array.isArray(body.data)) return false;
  return body.data.some((m) => isRecord(m) && m.id === SARASHINA_MODEL_ID);
}

/**
 * `url` exists so tests can point at a stub; the CLI path always passes the
 * constant, because an env override would let the environment redirect the key.
 */
export async function fetchSarashinaUsage(
  opts: FetchOpts,
  url: string = SARASHINA_MODELS_URL,
): Promise<Record<string, unknown>> {
  // The key is opencode's stored credential, not an env var: the offload entry
  // runs opencode with the same stored credential, so both see one key.
  const dbPath = join(homedir(), ".local", "share", "opencode", "opencode.db");
  const key = readOpencodeCredentialKey(dbPath, SARASHINA_INTEGRATION_ID);
  if (key === undefined) return { configured: false };
  if (!KEY_PATTERN.test(key))
    throw new Error("invalid sarashina credential format");

  let res: Response;
  try {
    res = await fetch(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(opts.timeoutMs),
      redirect: "error",
    });
  } catch (error) {
    throw requestFailed(error);
  }

  if (res.status === 429) {
    await res.body?.cancel().catch(() => undefined);
    return {
      configured: true,
      status: 429,
      retryAfter: parseRetryAfter(res.headers.get("retry-after")),
    };
  }
  if (res.status !== 200) {
    await res.body?.cancel().catch(() => undefined);
    throw new Error(`sarashina HTTP ${res.status}`);
  }

  let text: string;
  try {
    text = await readBoundedText(res);
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === "sarashina invalid response"
    )
      throw error;
    throw requestFailed(error);
  }
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error("sarashina invalid response");
  }
  return { configured: true, status: 200, hasModel: listsModel(body) };
}
