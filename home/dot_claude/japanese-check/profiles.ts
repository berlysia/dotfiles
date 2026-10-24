// 種類の表（data/profiles.json）の形、検証、モジュールの列の導出。
// hook と検査器と CI が同じ関数を呼ぶ。import は `node:` と兄弟の葉だけ。
//
// 検証は、表を全体として使えるかと、行ごとに使えるかの 2 段に分ける。warnings は
// ファイル由来の文字列を含めない（固定の文言と行の番号だけ）。

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileBounded } from "./safe-read.ts";
import { GENRES, READERS, STRUCTURES } from "./types.ts";
import type { Genre, Reader, Structure } from "./types.ts";

export const PROFILES_SCHEMA = 1;
export const MAX_PROFILES_BYTES = 64 * 1024;
export const MAX_PROFILE_ROWS = 64;
export const DEFAULT_PROFILE_IDS = ["rewrite-default", "compose-default"];

// 検証が読む欄。結果に使う欄はハッシュに入れ、使わない欄は入れない。
export const PROFILE_FIELDS = [
  "id",
  "label",
  "signals",
  "structure",
  "action",
  "genre",
  "stockBoundary",
] as const;
export const HASHED_PROFILE_FIELDS = [
  "id",
  "structure",
  "action",
  "genre",
  "stockBoundary",
] as const;
export const UNHASHED_PROFILE_FIELDS = ["label", "signals"] as const;

export interface ProfileRow {
  id: string;
  label: string;
  signals: string[];
  structure: Structure;
  action: boolean;
  genre?: Genre;
  stockBoundary: boolean;
}

export type ProfilesResult =
  | { ok: true; rows: ProfileRow[]; warnings: string[] }
  | { ok: false; reason: string };

export interface ResolvedModule {
  id: string;
  scope: "all" | "no-section-move";
}
export interface ResolvedProfile {
  modules: ResolvedModule[];
  genre?: Genre;
  stockBoundary: boolean;
}

const ID_PATTERN = /^[a-z][a-z0-9-]{0,31}$/u;
const FORBIDDEN = /[\p{C}\p{Zl}\p{Zp}]/u;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function field(row: Record<string, unknown>, name: string): unknown {
  return Object.hasOwn(row, name) ? row[name] : undefined;
}

function textWithin(value: unknown, max: number): value is string {
  if (typeof value !== "string" || value === "") return false;
  let length = 0;
  for (const _ of value) length += 1;
  return length <= max && !FORBIDDEN.test(value);
}

function oneOf<T extends string>(
  list: readonly T[],
  value: unknown,
): value is T {
  return (
    typeof value === "string" && (list as readonly string[]).includes(value)
  );
}

// 行を使えるなら行、使えないなら固定の理由を返す
function checkRow(raw: unknown): ProfileRow | string {
  if (!isRecord(raw)) return "オブジェクトではない";
  const id = field(raw, "id");
  if (typeof id !== "string" || !ID_PATTERN.test(id)) return "id の形が不正";
  if (!textWithin(field(raw, "label"), 80)) return "label の形が不正";
  const signals = field(raw, "signals");
  if (
    !Array.isArray(signals) ||
    signals.length < 1 ||
    signals.length > 10 ||
    !signals.every((item) => textWithin(item, 200))
  )
    return "signals の形が不正";
  const structure = field(raw, "structure");
  if (!oneOf(STRUCTURES, structure)) return "structure が未知";
  const genre = field(raw, "genre");
  if (genre !== undefined && !oneOf(GENRES, genre)) return "genre が未知";
  const action = field(raw, "action");
  const stockBoundary = field(raw, "stockBoundary");
  if (typeof action !== "boolean") return "action が真偽でない";
  if (typeof stockBoundary !== "boolean") return "stockBoundary が真偽でない";
  if (action && structure !== "business" && structure !== "caller")
    return "action の行の構成は business か caller に限る";
  const row: ProfileRow = {
    id,
    label: field(raw, "label") as string,
    signals: signals as string[],
    structure,
    action,
    stockBoundary,
  };
  if (genre !== undefined) row.genre = genre;
  return row;
}

/** JSON を読んだ後の値を検証する。例外を投げない */
export function validateProfiles(value: unknown): ProfilesResult {
  if (!isRecord(value))
    return { ok: false, reason: "種類の表の最上位がオブジェクトでない" };
  if (field(value, "schema") !== PROFILES_SCHEMA)
    return {
      ok: false,
      reason: `種類の表の schema が ${PROFILES_SCHEMA} でない`,
    };
  const rawRows = field(value, "rows");
  if (!Array.isArray(rawRows))
    return { ok: false, reason: "種類の表の rows が配列でない" };
  if (rawRows.length > MAX_PROFILE_ROWS)
    return {
      ok: false,
      reason: `種類の表の行が ${MAX_PROFILE_ROWS} 件を超える`,
    };
  const seen = new Set<string>();
  for (const raw of rawRows) {
    const id = isRecord(raw) ? field(raw, "id") : undefined;
    if (typeof id !== "string") continue;
    if (seen.has(id)) return { ok: false, reason: "種類の表の id が重複する" };
    seen.add(id);
  }
  const rows: ProfileRow[] = [];
  const warnings: string[] = [];
  rawRows.forEach((raw: unknown, index: number) => {
    const result = checkRow(raw);
    if (typeof result === "string") {
      warnings.push(`種類の表の行 ${index + 1} を飛ばした: ${result}`);
      return;
    }
    if (isRecord(raw)) {
      const known = PROFILE_FIELDS as readonly string[];
      if (Object.keys(raw).some((name) => !known.includes(name)))
        warnings.push(`種類の表の行 ${index + 1} に未知の欄があり、無視した`);
    }
    rows.push(result);
  });
  for (const id of DEFAULT_PROFILE_IDS)
    if (!rows.some((row) => row.id === id))
      return { ok: false, reason: "種類の表に既定の行が無い" };
  return { ok: true, rows, warnings };
}

const READ_FAILURES: Record<string, string> = {
  missing: "種類の表が無い",
  "not-file": "種類の表が通常のファイルでない",
  "too-large": "種類の表が大きすぎる",
  error: "種類の表を読めない",
};

/** 自分の dir の data/profiles.json を読む。例外を投げない */
export function loadProfiles(
  dir: string = dirname(fileURLToPath(import.meta.url)),
): ProfilesResult {
  const read = readFileBounded(
    join(dir, "data", "profiles.json"),
    MAX_PROFILES_BYTES,
  );
  if (!read.ok)
    return {
      ok: false,
      reason: READ_FAILURES[read.reason] ?? "種類の表を読めない",
    };
  let value: unknown;
  try {
    value = JSON.parse(read.bytes.toString("utf8"));
  } catch {
    return { ok: false, reason: "種類の表が壊れている" };
  }
  return validateProfiles(value);
}

/** 行と読み手の指定から、重ねるモジュールの列を導く。順は固定 */
export function resolveModules(
  row: ProfileRow,
  reader?: Reader,
): ResolvedProfile {
  const adhd =
    reader !== undefined && (READERS as readonly string[]).includes(reader);
  const structure: Structure =
    adhd && row.structure !== "caller" ? "business" : row.structure;
  const modules: ResolvedModule[] = [
    { id: "fact", scope: "all" },
    { id: structure, scope: "all" },
  ];
  if (row.action || adhd)
    modules.push({
      id: "action",
      scope: row.structure === "caller" ? "no-section-move" : "all",
    });
  modules.push(
    { id: "polish", scope: "all" },
    { id: "notation", scope: "all" },
    { id: "check", scope: "all" },
  );
  const resolved: ResolvedProfile = {
    modules,
    stockBoundary: row.stockBoundary,
  };
  if (row.genre !== undefined) resolved.genre = row.genre;
  return resolved;
}

/** 効くモジュールの列と genre を、欄の順を固定した JSON にして取る。行の id は含めない */
export function describeResolved(
  resolved: ResolvedProfile,
  genre: Genre | undefined,
): string {
  return JSON.stringify({
    modules: resolved.modules.map((module) => [module.id, module.scope]),
    genre: genre ?? null,
    stockBoundary: resolved.stockBoundary,
  });
}
