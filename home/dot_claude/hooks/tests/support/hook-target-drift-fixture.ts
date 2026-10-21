// Shared by unit/hook-target-drift.test.ts and heavy/hook-target-drift.test.ts.
// Pure functions and constants only; lsFilesOutput() starts git and therefore
// lives in the heavy file.
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// 本テストの守備範囲は非対称である。tmpl 内の `.ts` 参照は全て検査するが、
// `bash .../foo.sh` のような非 .ts 参照は一切検査しない（spec R3）。逆に
// implementations 配下でない `.ts` 参照は「非正準」として意図的に落とす
// （spec R8）。落ちた場合はテストを緩める前に spec K7 を読むこと。
export const REPO_ROOT = fileURLToPath(
  new URL("../../../../../", import.meta.url),
);
export const TMPL_REL = "home/dot_claude/.settings.hooks.json.tmpl";
export const IMPL_PREFIX = "home/dot_claude/hooks/implementations/";
export const PREFIX = "{{ .chezmoi.homeDir }}/.claude/hooks/implementations/";

// JSON 構造を解釈せず全文走査する。chezmoi でレンダリングすると
// `{{ if dig "only_private" false . }}` が片枝に潰れ、gate 内の 2 実装が
// 参照集合から落ちる（spec K1）。全文走査ならどの枝の参照も等しく拾う。
// 条件分岐は `only_private` のほかに `claude_hooks.auto_approval` にもある
// （auto-approve 系 3 実装と home-destruction-guard は互いに排他の枝に置かれる）。
export const REF = /\.claude\/hooks\/implementations\/([^"'\s/]+)\.ts/g;
export const TS_REF = /[^"'\s]*\.ts(?=[\s"'])/g;

export const ASSERT1_HINT =
  "本検査は tmpl 内に名前が文字列として現れるかのみを見る（hook が実際に発火するかは検査しない）。" +
  "onlyImpls が出た場合、共有ロジックなら home/dot_claude/hooks/lib/ へ移す。" +
  "例外を認める必要が生じたら本ファイル先頭に ALLOWLIST 定数を置く（spec K5）";
export const ASSERT3_HINT =
  "implementations 配下でない .ts 参照も意図的に落とす（spec R8）。" +
  "正当な追加なら守備範囲の見直しが必要 — テストを緩める前に spec K7 を読むこと";

export function referencedNames(raw: string): Set<string> {
  return new Set([...raw.matchAll(REF)].map((m) => m[1] as string));
}

export function namesFromLsFiles(
  output: string,
  isPresent: (repoRelPath: string) => boolean,
): Set<string> {
  const names = new Set<string>();
  for (const line of output.split("\n")) {
    if (!line) continue;
    // git の core.quotePath は既定 true で、非 ASCII 名を引用符 + 8 進エスケープで
    // 返す。CI (actions/checkout) は既定側であり、引用行を素で slice すると
    // 1 文字ずれて深さフィルタに落ちる = CI でのみ静かな false negative になる。
    // lsFilesOutput() 側で quotePath=false を渡した上で、想定外の行形式は捨てる。
    if (!line.startsWith(IMPL_PREFIX)) continue;
    const rest = line.slice(IMPL_PREFIX.length);
    if (rest.includes("/")) continue;
    if (!rest.endsWith(".ts")) continue;
    if (!isPresent(line)) continue;
    names.add(rest.slice(0, -3));
  }
  return names;
}

export function symmetricDiff(
  refs: ReadonlySet<string>,
  impls: ReadonlySet<string>,
): { onlyRefs: string[]; onlyImpls: string[] } {
  return {
    onlyRefs: [...refs].filter((n) => !impls.has(n)).sort(),
    onlyImpls: [...impls].filter((n) => !refs.has(n)).sort(),
  };
}

export function tsRefCoverage(raw: string): { matched: number; total: number } {
  return {
    matched: [...raw.matchAll(TS_REF)].length,
    total: (raw.match(/\.ts/g) ?? []).length,
  };
}

export function nonCanonicalRefs(raw: string): string[] {
  const bad: string[] = [];
  for (const m of raw.matchAll(TS_REF)) {
    const token = m[0];
    const name = token.slice(token.lastIndexOf("/") + 1);
    const expected = PREFIX + name;
    const end = (m.index as number) + token.length;
    const actual = raw.slice(end - expected.length, end);
    if (actual !== expected) bad.push(actual);
  }
  return bad;
}

export const raw = readFileSync(`${REPO_ROOT}${TMPL_REL}`, "utf-8");
export const CANON = `${PREFIX}discord-notification.ts`;

export const mutate = (from: string, to: string): string => {
  const i = raw.indexOf(from);
  assert.notStrictEqual(i, -1, `変異アンカーが見つからない: ${from}`);
  return raw.slice(0, i) + to + raw.slice(i + from.length);
};

export const lsLines = (names: readonly string[]): string =>
  names.map((n) => `${IMPL_PREFIX}${n}.ts`).join("\n");
