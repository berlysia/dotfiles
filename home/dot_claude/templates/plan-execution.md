<!-- spec-ref: spec.md -->

# Plan: <feature/change name> (Execution layer)

> **Template usage**: 二層モードの実行層。1 spec から N plan を切り出し、各 plan-N.md を独立に承認・実装する。ファイル名は `plan-1.md` / `plan-2.md` …（連番、欠番可）。

## Files

実装で触るファイルを **fenced code block + 1 行 1 パス（プロジェクトルート相対）** で列挙する。`document-workflow-guard` はこの code block を `realpath` 完全一致でパースする。`#` 始まりの行と空行は無視、それ以外の非パス行（インデント・タブ混入・複数パス連結等）は形式違反として実装ブロック。

```
# 新規作成
src/feature/example.ts

# 編集
src/feature/existing.ts
docs/feature.md

# テスト
tests/feature/example.test.ts
```

## Tasks

各タスクは 2-5 分のバイトサイズステップに分解する。コード変更タスクは TDD scaffold を含む。

### T1: <タスク名>

**Files:**

- 編集: `src/path/to/file.ts:123-145`
- テスト: `tests/path/to/file.test.ts`
- 参照: `src/lib/dependency.ts:50-65` (再利用する既存関数 / 設計判断の根拠) — P1: 各 Task に最低 1 件の参照行を必須化。引用が無ければ想像補完とみなす

- [ ] **Step 1: 失敗するテストを書く**

前置: 依存 fixture (例: `silentLogger`, `fakeAdapter`) は以下のいずれかで明示する (P3: fixture 名だけ書いて定義を省くと ReferenceError が再発する)。

- (a) プロジェクトの共通 fixture ディレクトリに集約済の場合は、その import 文を書く
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

実行: `pnpm run test tests/path/to/file.test.ts`（bun プロジェクトでは `bun run test ...`）
期待: FAIL with "func is not defined"

- [ ] **Step 3: 最小実装を書く**

```ts
export function func(input: Input): Output {
  return expected;
}
```

- [ ] **Step 4: テストを実行して通過を確認**

実行: `pnpm run test tests/path/to/file.test.ts`（bun プロジェクトでは `bun run test ...`）
期待: PASS

- [ ] **Step 5: コミット**

```bash
git add src/path/to/file.ts tests/path/to/file.test.ts
git commit -m "feat(scope): description"
```

### T<最後>: 記録を移す

計画の最後に置く。二層モードでは、最後に実行する plan-N.md にだけ置く。節と行き先の表は `/document-workflow-reference` の「記録の移し方」にある。プロジェクトに記録の慣習があれば、それに合わせて書き換える。

**Files:**

- 編集または新規作成: <移す先の文書（ADR など）。この計画の Files にも載せる>
- 参照: <wfDir の spec.md / research.md / plan-N.md>

- [ ] **Step 1: 決まった節を移す**

表の 1〜5 行目に当たる節を、移す先の文書へ書く。当たる内容が無い行は「該当なし」とする。

- [ ] **Step 2: 行き先を commit の本文に書いてコミットする**

commit の本文に、原本の `##` 見出しの一覧と、表の 1〜5 行目それぞれの「移した先の文書と節」または「該当なし」を書く。この作業の出発点だったファイルが `docs/plans/` にあれば、同じ commit で消す。

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

<!-- parent-spec-hash は plan-review-automation hook が auto-review marker 生成時に挿入する。手で編集しない。 -->
