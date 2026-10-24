// 検査器が実行時に要る外部パッケージの一覧と、その判定。葉のモジュール:
// import は `node:` と safe-read.ts だけ。
//
// 判定は、検査器自身の dir（`import.meta.url` から求める。cwd、argv、検査対象の dir
// からは求めない）の `node_modules` と、その親の `node_modules` の 2 か所だけを見る。
// `require.resolve` を使わないのは、解決が cwd や上の dir の `node_modules` に流れて、
// 検査対象の dir に置かれた偽のパッケージを読み込みかねないため。判定は
// `package.json` の版だけを見て、パッケージの中身の改変は見ない。

import { realpathSync, statSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileBounded } from "./safe-read.ts";

export const MAX_PACKAGE_JSON_BYTES = 64 * 1024;

export type DependencyGroup = "analyzer" | "grammar";
export interface DependencyEntry {
  name: string;
  group: DependencyGroup;
}

// 今の実際の import と一致させる。analyzer は sudachi を使う全部の経路、
// grammar は `--profile` の check だけ。
export const DEPENDENCIES: readonly DependencyEntry[] = [
  { name: "sudachi", group: "analyzer" },
];

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

export function findDependency(
  name: string,
  dir: string = selfDir(),
): FindDependencyResult {
  let reason: "missing" | "invalid" = "missing";
  for (const base of [dir, dirname(dir)]) {
    const nodeModules = realpathOrNull(join(base, "node_modules"));
    const packageDir = realpathOrNull(join(base, "node_modules", name));
    if (!nodeModules || !packageDir) continue;
    reason = "invalid";
    if (!allowedRoots(dir).some((root) => within(packageDir, root))) continue;
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

export function checkDependencies(
  groups: readonly DependencyGroup[],
  dir: string = selfDir(),
  deps: readonly DependencyEntry[] = DEPENDENCIES,
): DependencyCheck {
  const found: FoundInGroup[] = [];
  const missing: string[] = [];
  for (const dep of deps) {
    if (!groups.includes(dep.group)) continue;
    const result = findDependency(dep.name, dir);
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
