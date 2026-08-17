import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

// 本テストの守備範囲は非対称である。tmpl 内の `.ts` 参照は全て検査するが、
// `bash .../foo.sh` のような非 .ts 参照は一切検査しない（spec R3）。逆に
// implementations 配下でない `.ts` 参照は「非正準」として意図的に落とす
// （spec R8）。落ちた場合はテストを緩める前に spec K7 を読むこと。
const REPO_ROOT = fileURLToPath(new URL("../../../../../", import.meta.url));
const TMPL_REL = "home/dot_claude/.settings.hooks.json.tmpl";
const IMPL_PREFIX = "home/dot_claude/hooks/implementations/";
const PREFIX = "{{ .chezmoi.homeDir }}/.claude/hooks/implementations/";

// JSON 構造を解釈せず全文走査する。chezmoi でレンダリングすると
// `{{ if dig "only_private" false . }}` が片枝に潰れ、gate 内の 2 実装が
// 参照集合から落ちる（spec K1）。全文走査ならどの枝の参照も等しく拾う。
const REF = /\.claude\/hooks\/implementations\/([^"'\s/]+)\.ts/g;
const TS_REF = /[^"'\s]*\.ts(?=[\s"'])/g;

const ASSERT1_HINT =
  "本検査は tmpl 内に名前が文字列として現れるかのみを見る（hook が実際に発火するかは検査しない）。" +
  "onlyImpls が出た場合、共有ロジックなら home/dot_claude/hooks/lib/ へ移す。" +
  "例外を認める必要が生じたら本ファイル先頭に ALLOWLIST 定数を置く（spec K5）";
const ASSERT3_HINT =
  "implementations 配下でない .ts 参照も意図的に落とす（spec R8）。" +
  "正当な追加なら守備範囲の見直しが必要 — テストを緩める前に spec K7 を読むこと";

function referencedNames(raw: string): Set<string> {
  return new Set([...raw.matchAll(REF)].map((m) => m[1] as string));
}

function namesFromLsFiles(
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

function symmetricDiff(
  refs: ReadonlySet<string>,
  impls: ReadonlySet<string>,
): { onlyRefs: string[]; onlyImpls: string[] } {
  return {
    onlyRefs: [...refs].filter((n) => !impls.has(n)).sort(),
    onlyImpls: [...impls].filter((n) => !refs.has(n)).sort(),
  };
}

function tsRefCoverage(raw: string): { matched: number; total: number } {
  return {
    matched: [...raw.matchAll(TS_REF)].length,
    total: (raw.match(/\.ts/g) ?? []).length,
  };
}

function nonCanonicalRefs(raw: string): string[] {
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

function lsFilesOutput(): string {
  return execFileSync(
    "git",
    [
      "-c",
      "core.quotePath=false",
      "ls-files",
      "--cached",
      "--others",
      "--exclude-standard",
      "--",
      IMPL_PREFIX,
    ],
    { cwd: REPO_ROOT, encoding: "utf-8" },
  );
}

const raw = readFileSync(`${REPO_ROOT}${TMPL_REL}`, "utf-8");
const CANON = `${PREFIX}discord-notification.ts`;

const mutate = (from: string, to: string): string => {
  const i = raw.indexOf(from);
  assert.notStrictEqual(i, -1, `変異アンカーが見つからない: ${from}`);
  return raw.slice(0, i) + to + raw.slice(i + from.length);
};

const lsLines = (names: readonly string[]): string =>
  names.map((n) => `${IMPL_PREFIX}${n}.ts`).join("\n");

describe("純関数の単体挙動", () => {
  it("referencedNames は正準参照から名前を抽出する", () => {
    assert.deepStrictEqual(
      [...referencedNames(`"bun ${CANON}"`)],
      ["discord-notification"],
    );
  });

  it("namesFromLsFiles は深さ 1 かつ実在する .ts のみを返す", () => {
    const output = [
      `${IMPL_PREFIX}session.ts`,
      `${IMPL_PREFIX}.claude/plans/nested.ts`,
      `${IMPL_PREFIX}removed.ts`,
      `${IMPL_PREFIX}README.md`,
    ].join("\n");
    assert.deepStrictEqual(
      [...namesFromLsFiles(output, (p) => !p.endsWith("removed.ts"))],
      ["session"],
    );
  });

  it("symmetricDiff は両方向の差分をソートして返す", () => {
    assert.deepStrictEqual(
      symmetricDiff(new Set(["b", "a"]), new Set(["a", "c"])),
      { onlyRefs: ["b"], onlyImpls: ["c"] },
    );
  });

  it("tsRefCoverage は TS_REF の被覆と生の .ts 出現数を返す", () => {
    assert.deepStrictEqual(tsRefCoverage(`"a/session.ts" "b/other.ts"`), {
      matched: 2,
      total: 2,
    });
  });

  it("nonCanonicalRefs は正準形の参照を違反としない", () => {
    assert.deepStrictEqual(nonCanonicalRefs(`"bun ${CANON}"`), []);
  });
});

describe("hook target drift（実リポジトリ）", () => {
  it("assert 1: 参照集合と実体集合が双方向一致する", () => {
    const impls = namesFromLsFiles(lsFilesOutput(), (p) =>
      existsSync(`${REPO_ROOT}${p}`),
    );
    // 両方向を 1 つの deepStrictEqual で見る。逐次 assert にすると
    // リネーム未追随（両方向が同時に立つ）で片方しか表示されない。
    assert.deepStrictEqual(
      symmetricDiff(referencedNames(raw), impls),
      { onlyRefs: [], onlyImpls: [] },
      ASSERT1_HINT,
    );
  });

  it("assert 2: 参照集合が空でない", () => {
    assert.ok(
      referencedNames(raw).size > 0,
      "REF が 1 件も拾えていない（走査器の故障）",
    );
  });

  it("assert 2b: TS_REF の被覆が生の .ts 出現数と一致する", () => {
    const { matched, total } = tsRefCoverage(raw);
    assert.ok(matched > 0, "TS_REF が 1 件も拾えていない（走査器の故障）");
    assert.strictEqual(
      matched,
      total,
      `TS_REF が拾えていない .ts 出現がある（走査器の縮退）: matched=${matched} total=${total}`,
    );
  });

  it("assert 3: 全 .ts 参照が正準絶対形である", () => {
    assert.deepStrictEqual(nonCanonicalRefs(raw), [], ASSERT3_HINT);
  });
});

describe("変異テスト: 検出すべき変異", () => {
  // 以下 4 本は referencedNames → namesFromLsFiles → symmetricDiff の
  // 実コードパスを通す。集合を手で組み立てると Set の組み込み挙動を
  // 検証するだけのトートロジーになり、assert 1 の検出力を固定できない。
  it("実装削除を assert 1 が捕捉する", () => {
    const refs = referencedNames(raw);
    const impls = namesFromLsFiles(
      lsLines([...refs].filter((n) => n !== "session")),
      () => true,
    );
    assert.deepStrictEqual(symmetricDiff(refs, impls).onlyRefs, ["session"]);
  });

  it("リネーム未追随を assert 1 が双方向で捕捉する", () => {
    const refs = referencedNames(raw);
    const impls = namesFromLsFiles(
      lsLines([...refs].map((n) => (n === "session" ? "session-start" : n))),
      () => true,
    );
    const diff = symmetricDiff(refs, impls);
    assert.deepStrictEqual(diff.onlyRefs, ["session"]);
    assert.deepStrictEqual(diff.onlyImpls, ["session-start"]);
  });

  it("孤児実装（tmpl 未参照）を assert 1 が捕捉する", () => {
    const refs = referencedNames(raw);
    const impls = namesFromLsFiles(lsLines([...refs, "orphan"]), () => true);
    assert.deepStrictEqual(symmetricDiff(refs, impls).onlyImpls, ["orphan"]);
  });

  it("規約外名の壊れた参照追加を assert 1 が捕捉する", () => {
    const m = mutate(CANON, `${PREFIX}new_hook.ts`);
    const impls = namesFromLsFiles(
      lsLines([...referencedNames(raw)]),
      () => true,
    );
    assert.deepStrictEqual(symmetricDiff(referencedNames(m), impls).onlyRefs, [
      "new_hook",
    ]);
  });

  it("サブディレクトリへの移動は深さ 1 フィルタが捕捉する", () => {
    assert.deepStrictEqual(
      [...namesFromLsFiles(`${IMPL_PREFIX}sub/session.ts`, () => true)],
      [],
    );
  });

  it("git rm なしの rm は existsSync フィルタが捕捉する", () => {
    assert.deepStrictEqual(
      [...namesFromLsFiles(`${IMPL_PREFIX}session.ts`, () => false)],
      [],
    );
  });

  it("引用された行（core.quotePath=true 相当）は fail-closed で捨てる", () => {
    const quoted = `"${IMPL_PREFIX}\\346\\227\\245.ts"`;
    assert.deepStrictEqual([...namesFromLsFiles(quoted, () => true)], []);
  });

  it("接頭辞破壊 (hooks→hook) を assert 3 が捕捉する", () => {
    const m = mutate(
      "/.claude/hooks/implementations/discord-notification.ts",
      "/.claude/hook/implementations/discord-notification.ts",
    );
    assert.strictEqual(nonCanonicalRefs(m).length, 1);
  });

  it("語の破壊 (implementations→implementation) を assert 3 が捕捉する", () => {
    const m = mutate(
      "/.claude/hooks/implementations/discord-notification.ts",
      "/.claude/hooks/implementation/discord-notification.ts",
    );
    assert.strictEqual(nonCanonicalRefs(m).length, 1);
  });

  it("相対パス化を assert 3 が捕捉する", () => {
    const m = mutate(
      CANON,
      ".claude/hooks/implementations/discord-notification.ts",
    );
    assert.strictEqual(nonCanonicalRefs(m).length, 1);
  });

  it("chezmoi 変数名の破壊 (homeDir→homedir) を assert 3 が捕捉する", () => {
    const m = mutate(
      CANON,
      "{{ .chezmoi.homedir }}/.claude/hooks/implementations/discord-notification.ts",
    );
    assert.strictEqual(nonCanonicalRefs(m).length, 1);
  });

  it("lookahead 脱落を招く編集 (.ts;) を assert 2b が捕捉する", () => {
    const { matched, total } = tsRefCoverage(
      mutate(`${CANON}"`, `${CANON}; true"`),
    );
    assert.notStrictEqual(matched, total);
  });
});

describe("失敗メッセージの要件（spec ISO 25010 保守性）", () => {
  it("assert 1 のヒントは検査の限界・移設先・allowlist の所在を含む", () => {
    assert.match(ASSERT1_HINT, /文字列として現れるかのみ/);
    assert.match(ASSERT1_HINT, /hooks\/lib\//);
    assert.match(ASSERT1_HINT, /ALLOWLIST/);
  });

  it("assert 3 のヒントは R8 の意図と K7 への誘導を含む", () => {
    assert.match(ASSERT3_HINT, /意図的に落とす/);
    assert.match(ASSERT3_HINT, /spec R8/);
    assert.match(ASSERT3_HINT, /spec K7/);
  });
});

describe("変異テスト: 検出してはならない状態", () => {
  it("現状のツリーは違反ゼロ", () => {
    assert.deepStrictEqual(nonCanonicalRefs(raw), []);
    const { matched, total } = tsRefCoverage(raw);
    assert.strictEqual(matched, total);
  });

  it("tmpl と実体が揃ったリネームは違反にならない", () => {
    const m = raw.replaceAll(
      "implementations/session.ts",
      "implementations/session-start.ts",
    );
    assert.deepStrictEqual(nonCanonicalRefs(m), []);
    assert.ok(referencedNames(m).has("session-start"));
    assert.ok(!referencedNames(m).has("session"));
  });

  it("未 git add の新規実装は --others により実体集合へ入る", () => {
    assert.deepStrictEqual(
      [...namesFromLsFiles(`${IMPL_PREFIX}brand-new.ts`, () => true)],
      ["brand-new"],
    );
  });
});
