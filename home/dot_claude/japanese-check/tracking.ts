import {
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import {
  atomicJson,
  defaultStateDir,
  digest,
  fail,
  missing,
  object,
  prepareState,
  sessionDir,
} from "./state.ts";

export function track(
  file: string,
  session: string,
  stateDir = defaultStateDir(),
): void {
  prepareState(stateDir);
  const path = realpathSync(file);
  atomicJson(
    join(sessionDir(session, stateDir), "documents", `${digest(path)}.json`),
    { path },
  );
}

export function tracked(
  session: string,
  stateDir = defaultStateDir(),
): string[] {
  const dir = join(sessionDir(session, stateDir), "documents");
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch (error) {
    if (missing(error)) return [];
    fail(error);
  }
  return names
    .filter((name) => name.endsWith(".json"))
    .map((name) => {
      const value: unknown = JSON.parse(readFileSync(join(dir, name), "utf8"));
      if (!object(value) || typeof value.path !== "string")
        throw new Error("文書の追跡記録が不正です。");
      return value.path;
    })
    .filter((file) => {
      try {
        return statSync(file).isFile();
      } catch (error) {
        if (missing(error)) return false;
        fail(error);
      }
    });
}

export function baseline(
  session: string,
  files: string[],
  stateDir = defaultStateDir(),
): Record<string, string> {
  prepareState(stateDir);
  const path = join(sessionDir(session, stateDir), "baseline.json");
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    if (!missing(error)) fail(error);
    const hashes = Object.fromEntries(
      files.map((file) => [file, digest(readFileSync(file))]),
    );
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    try {
      writeFileSync(path, JSON.stringify(hashes), { flag: "wx", mode: 0o600 });
    } catch (writeError) {
      if (!object(writeError) || writeError.code !== "EEXIST") fail(writeError);
      return baseline(session, files, stateDir);
    }
    return hashes;
  }
  if (
    !object(value) ||
    !Object.values(value).every((hash) => typeof hash === "string")
  )
    throw new Error("文書の開始状態が不正です。");
  return value as Record<string, string>;
}
