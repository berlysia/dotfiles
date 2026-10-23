import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export function digest(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

export function defaultStateDir(cwd = process.cwd()): string {
  const start = resolve(cwd);
  for (let dir = start; ; dir = dirname(dir)) {
    if (existsSync(join(dir, ".git")))
      return join(dir, ".tmp", "japanese-check");
    if (dirname(dir) === dir) return join(start, ".tmp", "japanese-check");
  }
}

export function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function missing(error: unknown): boolean {
  return object(error) && error.code === "ENOENT";
}

export function fail(error: unknown): never {
  console.error("[japanese-check receipts]", error);
  throw error;
}

export function prepareState(stateDir: string): void {
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  try {
    writeFileSync(join(stateDir, ".gitignore"), "*\n", {
      flag: "wx",
      mode: 0o600,
    });
  } catch (error) {
    if (!object(error) || error.code !== "EEXIST") fail(error);
  }
}

export function atomicJson(path: string, data: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temp, JSON.stringify(data), { mode: 0o600 });
  renameSync(temp, path);
}

export function sessionDir(session: string, stateDir: string): string {
  // Session IDs are hashed, never interpreted as paths.
  return join(stateDir, "sessions", digest(session));
}
