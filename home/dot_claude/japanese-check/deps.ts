// 検査器が実行時に要る外部パッケージの一覧と、その判定。葉のモジュール:
// import は `node:` と safe-read.ts だけ。
//
// 判定は `package.json` の版だけを見て、パッケージの中身の改変は見ない（解析器の
// 辞書の中身は adapter が別に照合する）。探す場所はグループごとに決まる。
// - analyzer: 実行環境の dir（`resolveRuntimeDir()`）の `node_modules` だけ。辞書は
//   実行環境の dir にしか無いので、解析器を別の場所から読むと、ハッシュに入る版と
//   実際に読む辞書の組がずれる。
// - grammar: 検査器自身の dir（`import.meta.url` から求める。cwd、argv、検査対象の
//   dir からは求めない）の `node_modules` と、その親の `node_modules`。
// `require.resolve` を使わないのは、解決が cwd や上の dir の `node_modules` に流れて、
// 検査対象の dir に置かれた偽のパッケージを読み込みかねないため。

import { realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileBounded } from "./safe-read.ts";

export const MAX_PACKAGE_JSON_BYTES = 64 * 1024;

export type DependencyGroup = "analyzer" | "grammar";
export interface DependencyEntry {
  name: string;
  group: DependencyGroup;
}

export interface FoundDependency {
  name: string;
  version: string;
  entry: string;
}
export type FindDependencyResult =
  | ({ ok: true } & FoundDependency)
  | { ok: false; reason: "missing" | "invalid" };

export interface FoundInGroup extends FoundDependency {
  group: DependencyGroup;
}
export interface DependencyCheck {
  ok: boolean;
  found: FoundInGroup[];
  missing: string[];
}

/** 欠けた依存の名前は一覧から取る。fs が返した文字列は使わない */
export class DependencyMissingError extends Error {
  readonly names: string[];
  constructor(names: string[]) {
    super("検査器の依存が欠けている");
    this.names = names;
  }
}

const VERSION_PATTERN = /^[0-9A-Za-z.+-]{1,64}$/u;

function selfDir(): string {
  return dirname(fileURLToPath(import.meta.url));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function realpathOrNull(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

function within(child: string, parent: string): boolean {
  return child.startsWith(parent.endsWith(sep) ? parent : parent + sep);
}

// エントリは次の形だけから決める。ほかの形（条件の入れ子、配列）は使わない。
function entryPath(manifest: Record<string, unknown>): string | null {
  if (Object.hasOwn(manifest, "exports")) {
    const exported = manifest.exports;
    if (typeof exported === "string") return exported;
    if (!isRecord(exported) || !Object.hasOwn(exported, ".")) return null;
    const root = exported["."];
    if (typeof root === "string") return root;
    if (!isRecord(root)) return null;
    if (typeof root.import === "string") return root.import;
    if (typeof root.default === "string") return root.default;
    return null;
  }
  return typeof manifest.main === "string" ? manifest.main : null;
}

// パッケージの realpath が許される根。検査器の dir とその祖先の `node_modules` の
// realpath（Node の解決の上り方と同じ。workspace では実体が祖先の `.bun` などにある）。
function allowedRoots(dir: string): string[] {
  const roots: string[] = [];
  for (let current = dir; ; current = dirname(current)) {
    const real = realpathOrNull(join(current, "node_modules"));
    if (real) roots.push(real);
    if (dirname(current) === current) break;
  }
  return roots;
}

const RUNTIME_DIR_ENV = "JAPANESE_CHECK_RUNTIME_DIR";

/**
 * The runtime directory of the analyzer (lindera and the dictionary). Only a
 * default under HOME or an absolute path in JAPANESE_CHECK_RUNTIME_DIR; never
 * the cwd, argv or the directory of the document being checked. The variable is
 * an exception to "resolve only from the checker's own directory": CI and the
 * tests, which start the checker with a different HOME, need it. What makes it
 * safe to read is `runtimeDirState`, which the caller must apply.
 */
export function resolveRuntimeDir(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  const fromEnv = env[RUNTIME_DIR_ENV];
  if (fromEnv && isAbsolute(fromEnv)) return fromEnv;
  const home = env.HOME && isAbsolute(env.HOME) ? env.HOME : homedir();
  return join(home, ".config", "japanese-check");
}

function ownedAndClosed(path: string): boolean {
  try {
    const stat = statSync(realpathSync(path));
    if (!stat.isDirectory()) return false;
    if (typeof process.getuid === "function" && stat.uid !== process.getuid())
      return false;
    return (stat.mode & 0o022) === 0;
  } catch {
    return false;
  }
}

/**
 * `absent`: there is no such directory. `unsafe`: it exists, but it, or its
 * node_modules or unidic, is not a directory owned by the current user with no
 * group or other write permission. A subdirectory that does not exist is left to
 * the dependency lookup and the adapter, which fail with their own messages.
 */
export function runtimeDirState(dir: string): "ok" | "absent" | "unsafe" {
  if (realpathOrNull(dir) === null) return "absent";
  if (!ownedAndClosed(dir)) return "unsafe";
  for (const name of ["node_modules", "unidic"]) {
    const child = join(dir, name);
    if (realpathOrNull(child) !== null && !ownedAndClosed(child))
      return "unsafe";
  }
  return "ok";
}

/**
 * Looks for `name` under the `node_modules` of each base, in order. The package
 * directory must resolve under one of `roots` (realpaths of the `node_modules`
 * directories it may live in).
 */
export function findDependency(
  name: string,
  bases: readonly string[] = [selfDir(), dirname(selfDir())],
  roots: readonly string[] = allowedRoots(selfDir()),
): FindDependencyResult {
  let reason: "missing" | "invalid" = "missing";
  for (const base of bases) {
    const nodeModules = realpathOrNull(join(base, "node_modules"));
    const packageDir = realpathOrNull(join(base, "node_modules", name));
    if (!nodeModules || !packageDir) continue;
    reason = "invalid";
    if (!roots.some((root) => within(packageDir, root))) continue;
    const read = readFileBounded(
      join(packageDir, "package.json"),
      MAX_PACKAGE_JSON_BYTES,
    );
    if (!read.ok) continue;
    let manifest: unknown;
    try {
      manifest = JSON.parse(read.bytes.toString("utf8"));
    } catch {
      continue;
    }
    if (
      !isRecord(manifest) ||
      manifest.name !== name ||
      typeof manifest.version !== "string" ||
      !VERSION_PATTERN.test(manifest.version)
    )
      continue;
    const relative = entryPath(manifest);
    if (relative === null) continue;
    const entry = realpathOrNull(join(packageDir, relative));
    if (!entry || !within(entry, packageDir)) continue;
    try {
      if (!statSync(entry).isFile()) continue;
    } catch {
      continue;
    }
    return { ok: true, name, version: manifest.version, entry };
  }
  return { ok: false, reason };
}

/** `findDependency` with the places the dependency's group may look in. */
export function findDependencyInGroup(
  dep: DependencyEntry,
  dir: string = selfDir(),
  runtimeDir: string = resolveRuntimeDir(),
): FindDependencyResult {
  if (dep.group === "analyzer") {
    // An unusable runtime directory makes the analyzer missing instead of
    // throwing: a caller that must not throw (receipts) reports it as an
    // incomplete checker.
    if (runtimeDirState(runtimeDir) !== "ok")
      return { ok: false, reason: "invalid" };
    const root = realpathOrNull(join(runtimeDir, "node_modules"));
    return findDependency(dep.name, [runtimeDir], root ? [root] : []);
  }
  return findDependency(dep.name, [dir, dirname(dir)], allowedRoots(dir));
}

export function checkDependencies(
  groups: readonly DependencyGroup[],
  deps: readonly DependencyEntry[],
  dir: string = selfDir(),
  runtimeDir: string = resolveRuntimeDir(),
): DependencyCheck {
  // No default list: a caller that forgot to pass one would otherwise check
  // nothing and pass.
  if (deps.length === 0)
    return { ok: false, found: [], missing: ["dependencies"] };
  const found: FoundInGroup[] = [];
  const missing: string[] = [];
  for (const dep of deps) {
    if (!groups.includes(dep.group)) continue;
    const result = findDependencyInGroup(dep, dir, runtimeDir);
    if (result.ok)
      found.push({
        group: dep.group,
        name: result.name,
        version: result.version,
        entry: result.entry,
      });
    else missing.push(dep.name);
  }
  return { ok: missing.length === 0, found, missing };
}
