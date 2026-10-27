import { readFileSync } from "node:fs";

export type FetchOpts = {
  timeoutMs: number;
  verbose: boolean;
  /** Codex: also account/usage/read. OpenCode: also 24h model/tool usage. */
  details: boolean;
  authFile?: string;
};

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function readJsonFile(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}
