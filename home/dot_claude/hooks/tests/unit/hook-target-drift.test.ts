import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import {
  IMPL_PREFIX,
  PREFIX,
  ASSERT1_HINT,
  ASSERT3_HINT,
  referencedNames,
  namesFromLsFiles,
  symmetricDiff,
  tsRefCoverage,
  nonCanonicalRefs,
  raw,
  CANON,
  mutate,
  lsLines,
} from "../support/hook-target-drift-fixture.ts";

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
