<!-- spec-ref: spec.md -->

# Plan: <feature/change name> (Execution layer)

> **Template usage**: 二層モード (spec.md + plan-N.md) の実行層テンプレート。1 spec から N plan を切り出せる。各 plan-N.md は独立に承認・実装される。
> ファイル名は `plan-1.md` / `plan-2.md` ... (連番形式、欠番許容)。

## Files

実装で触るファイルを **fenced code block + 1 行 1 パス（プロジェクトルート相対）** で列挙する。`document-workflow-guard` はこの code block を `realpath` 完全一致でパースする。`#` 始まりの行と空行は無視、それ以外の非パス行（インデント・タブ混入・複数パス連結等）は形式違反として実装ブロック。

```
# 新規作成
home/dot_claude/agents/example-agent.md
home/dot_claude/templates/example.md

# 編集
home/dot_claude/rules/workflow.md
home/dot_claude/hooks/implementations/example-hook.ts

# テスト
home/dot_claude/hooks/tests/unit/example-hook.test.ts
```

## Tasks

各タスクは 2-5 分のバイトサイズステップに分解する。コード変更タスクは TDD scaffold を含む。

### T1: <タスク名>

**Files:**

- 編集: `home/dot_claude/path/to/file.ts:123-145`
- テスト: `home/dot_claude/hooks/tests/unit/file.test.ts`
- 参照: `home/dot_claude/lib/dependency.ts:50-65` (再利用する既存関数 / 設計判断の根拠) — P1: 各 Task に最低 1 件の参照行を必須化

- [ ] **Step 1: 失敗するテストを書く**

前置: 依存 fixture (例: `silentLogger`, `fakeAdapter`) は以下のいずれかで明示する (P3: test fixture 共通化規約)。

- (a) `home/dot_claude/hooks/tests/__fixtures__/<name>.ts` に集約済の場合は `import { silentLogger } from "../__fixtures__/silentLogger.ts"`
- (b) 共通化していない場合はテストファイル冒頭に inline 定義式を完全に含める (関数本体まで省略しない)

```ts
import { strict as assert } from "node:assert";
// fixture は (a) import / (b) inline 定義のいずれか
const silentLogger = { log: () => {}, error: () => {} }; // (b) inline 定義例

test("specific behavior", () => {
  const result = func(input);
  assert.deepStrictEqual(result, expected);
});
```

- [ ] **Step 2: テストを実行して失敗を確認**

実行: `bun run test home/dot_claude/hooks/tests/unit/file.test.ts`
期待: FAIL with "func is not defined"

- [ ] **Step 3: 最小実装を書く**

```ts
export function func(input: Input): Output {
  return expected;
}
```

- [ ] **Step 4: テストを実行して通過を確認**

実行: `bun run test home/dot_claude/hooks/tests/unit/file.test.ts`
期待: PASS

- [ ] **Step 5: コミット**

```bash
git add home/dot_claude/path/to/file.ts home/dot_claude/hooks/tests/unit/file.test.ts
git commit -m "feat(scope): description"
```

## ISO 25010 具体テストケース

spec.md で選択した品質特性について、具体的なテストケースを「入力/操作 → 期待される結果」形式で記述する。曖昧語（「正しく」「適切に」「問題なく」）は使わない。境界値・異常値は具体的な値を明記する。

### <品質特性名>

- **入力**: <具体的な入力> → **期待**: <具体的な期待結果>
- **入力**: <具体的な入力> → **期待**: <具体的な期待結果>

## Approval

- Plan Status: draft
- Review Status: pending
- Approval Status: pending

<!-- auto-review: pending -->
<!-- intent-triage: pending -->

---

<!--
No Placeholders 禁則（spec.md / plan-N.md / 単層 plan.md 共通）

以下を本テンプレート内に残してはならない（実装フェーズ前に全て解消する）:
- "TBD" / "TODO" / "後で実装" / "fill in details"
- "適切にエラー処理" / "バリデーションを追加" / "エッジケース対応"
- "上記と同様" / "Task N と類似"
- 他タスクで未定義の型・関数・メソッドへの参照
- 評価語のみの根拠（"シンプル" / "安全" / "リスクが低い" のみで具体的根拠なし）

parent-spec-hash フィールドは plan-review-automation hook が auto-review marker 生成時に挿入する。
人間が直接編集する必要はない。

コード参照宣言フィールド (P1):
各 Task の Files 直下に「参照: <file>:<lines>」を最低 1 つ含めること。再利用する既存関数 / 設計判断の根拠を明示する。引用無しは想像補完扱い。

Test fixture 共通化規約 (P3):
TDD Step 1 の依存 fixture は (a) `home/dot_claude/hooks/tests/__fixtures__/<name>.ts` 集約 or (b) inline 定義式を完全に含める。fixture 名のみ書いて定義を省略すると ReferenceError 再発リスク。
-->
