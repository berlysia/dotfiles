# Document Workflow Empirical Prompt Tuning Plan

## Overview

Document Workflow を構成するスキル群・フック・ワークフロー定義に `/empirical-prompt-tuning` を適用し、指示品質を体系的に改善する取り組み。

**方法論**: 各コンポーネントに対してバイアスフリーの実行者（サブエージェント）にスキルを実行させ、二面評価（実行者自己申告 + 指示側メトリクス）を反復し、改善が収束するまでイテレーションを回す。

**戦略**: B+C ハイブリッド（マルチセッション分割 + 優先度スコープカット）

## Component Inventory

### Priority 1 — Core Path (every Document Workflow session)

| ID  | Component                 | Type  | Path (source)                                                     | Status                                |
| --- | ------------------------- | ----- | ----------------------------------------------------------------- | ------------------------------------- |
| C01 | `intent-alignment-triage` | skill | `.skills/intent-alignment-triage/SKILL.md`                        | **converged** (Session 1, 2026-05-01) |
| C02 | `logic-validation`        | skill | `.skills/logic-validation/SKILL.md`                               | **converged** (Session 1, 2026-05-01) |
| C03 | `plan-review-automation`  | hook  | `home/dot_claude/hooks/implementations/plan-review-automation.ts` | **converged** (Session 3, 2026-05-01) |
| C04 | `workflow.md`             | rule  | `home/dot_claude/rules/workflow.md`                               | **converged** (Session 4, 2026-05-01) |

### Priority 2 — Frequent Skills (most sessions)

| ID  | Component      | Type  | Path (source)                   | Status                                |
| --- | -------------- | ----- | ------------------------------- | ------------------------------------- |
| C05 | `execute-plan` | skill | `.skills/execute-plan/SKILL.md` | **converged** (Session 2, 2026-05-01) |
| C06 | `clarify`      | skill | `.skills/clarify/SKILL.md`      | **converged** (Session 2, 2026-05-01) |

### Priority 3 — Conditional Use

| ID  | Component                 | Type  | Path (source)                                                      | Status      |
| --- | ------------------------- | ----- | ------------------------------------------------------------------ | ----------- |
| C07 | `scope-guard`             | skill | external (installed)                                               | not started |
| C08 | `decompose`               | skill | `.skills/decompose/SKILL.md`                                       | not started |
| C09 | `verify-doc`              | skill | `.skills/verify-doc/SKILL.md`                                      | not started |
| C10 | `task-enrich`             | skill | `.skills/task-enrich/SKILL.md`                                     | not started |
| C11 | `task-handoff`            | skill | `.skills/task-handoff/SKILL.md`                                    | not started |
| C12 | `document-workflow-guard` | hook  | `home/dot_claude/hooks/implementations/document-workflow-guard.ts` | not started |

## Session Plan

| Session | Target                                                 | Rationale                                                        | Dependencies     |
| ------- | ------------------------------------------------------ | ---------------------------------------------------------------- | ---------------- |
| 1       | C01 `intent-alignment-triage` + C02 `logic-validation` | レビュー品質の根幹。独立してチューニング可能                     | none             |
| 2       | C06 `clarify` + C05 `execute-plan`                     | 計画詳細化と実装実行のコアペア                                   | none             |
| 3       | C03 `plan-review-automation`                           | レビュアー選定ロジック。C01/C02のチューニング結果を前提とする    | C01, C02         |
| 4       | C04 `workflow.md`                                      | 全スキルの協調を定義する上位レイヤー。個別スキルの改善後に最適化 | C01-C03, C05-C06 |
| 5+      | C07-C12 (必要に応じて)                                 | 使用頻度が低いため、問題が顕在化した時点で着手                   | varies           |

## Per-Component Tracking Template

各コンポーネントのチューニング開始時に以下のセクションを追加する:

```
### C{XX}: {component name}

**Session**: {session ID} / **Date**: {date}
**Tuning status**: not started | in progress | converged | diverged | deferred

#### Iteration 0 — Description/Body Consistency
- Description claims: ...
- Body covers: ...
- Gap: ...
- Action: ...

#### Evaluation Scenarios
| ID | Description | Type |
|----|-------------|------|
| S1 | ... | median |
| S2 | ... | edge |
| S3 | ... | edge (optional) |

#### Requirements Checklist
- S1:
  1. [critical] ...
  2. ...
- S2:
  1. [critical] ...
  2. ...

#### Iteration Log
(Use empirical-prompt-tuning presentation format per iteration)

#### Failure Pattern Ledger
(Per-component cumulative failure modes)

#### Convergence Record
- Consecutive clears: 0 / 2 (or 3 for high-importance)
- Final accuracy: —
- Final step count baseline: —
```

## Session 1 Results (2026-05-01): C01 + C02

### C01: intent-alignment-triage

**Tuning status**: converged (baseline — no diff required)

#### Iteration 0 — Description/Body Consistency

- Description claims: auto-review 指摘を元のオーダーの意図と突き合わせてトリアージ
- Body covers: 4ステップの手順（入力収集→トリアージ→報告→plan.md反映）、分類基準、設計判断
- Gap: なし
- Action: なし

#### Evaluation Scenarios

| ID  | Description                                          | Type   |
| --- | ---------------------------------------------------- | ------ |
| S1  | 混合指摘（aligned + divergent）のトリアージ          | median |
| S2  | 全指摘 aligned — false positive テスト               | edge   |
| S3  | 「段階的実装」推奨 vs 一括実装意図 — mixed divergent | edge   |

#### Iteration Log

**Iter 1 (Baseline)**:
| Scenario | Success | Accuracy | steps | duration | retries |
|---|---|---|---|---|---|
| S1 | ○ | 100% | 1 | 58s | 0 |
| S2 | ○ | 100% | 1 | 43s | 0 |
| S3 | ○ | 100% | 1 | 56s | 0 |

Unclear points: 0. Discretionary fill-ins: ISO8601 timezone, verdict 未指定時の推定, aligned/neutral 境界.

**Iter 2 (Verification — S1 only)**:
| Scenario | Success | Accuracy | steps | duration | retries |
|---|---|---|---|---|---|
| S1 | ○ | 100% | 1 | 53s | 0 |

#### Failure Pattern Ledger

なし（failure pattern 未発生）

#### Convergence Record

- Consecutive clears: 2 / 2
- Final accuracy: 100% (all scenarios)
- Final step count baseline: 1

---

### C02: logic-validation

**Tuning status**: converged (baseline — no diff required)

#### Iteration 0 — Description/Body Consistency

- Description claims: 判断・主張の論理的整合性をコンテキストフォークで検証。判断の妥当性が不明確な時にプロアクティブに使用
- Body covers: 判断フローチャート、使用場面分類、Task呼び出し例、ワークフロー統合、注意事項
- Gap: なし（body は 342 行と長いが、具体例が判断の anchor として有効に機能）
- Action: なし

#### Execution Protocol (Meta-Guide Adaptation)

C02 はメタガイド型スキル。実行者には「アシスタントとしてシナリオに臨み、スキルの指示に従って判断」と指示。成果物は「判断プロセス記録」。

#### Evaluation Scenarios

| ID  | Description                                              | Type   |
| --- | -------------------------------------------------------- | ------ |
| S1  | 症状的修正の検出（TS build error → tsconfig 変更）       | median |
| S2  | 根拠の薄い仮説の検証（SRP による class 分割）            | median |
| S3  | 不要な呼び出しのリダイレクト（ファイル確認 → Read 推奨） | edge   |

#### Iteration Log

**Iter 1 (Baseline)**:
| Scenario | Success | Accuracy | steps | duration | retries |
|---|---|---|---|---|---|
| S1 | ○ | 100% | 1 | 52s | 0 |
| S2 | ○ | 100% | 2 | 62s | 0 |
| S3 | ○ | 100% | 1 | 26s | 0 |

Unclear points: 0 (S2 の Task tool 未使用は環境制約、スキルレベルの問題ではない).

**Iter 2 (Verification — S1 only)**:
| Scenario | Success | Accuracy | steps | duration | retries |
|---|---|---|---|---|---|
| S1 | ○ | 100% | 1 | 55s | 0 |

#### Failure Pattern Ledger

なし（failure pattern 未発生）

#### Convergence Record

- Consecutive clears: 2 / 2
- Final accuracy: 100% (all scenarios)
- Final step count baseline: 1 (S3), 1-2 (S1/S2)

---

### Session 1 Summary

**結論**: C01・C02 ともにベースラインで収束。スキル指示の修正は不要だった。
**意味**: 両スキルは既に十分な品質を持ち、バイアスフリーの実行者が迷わず正しい結果を生成できる。
**観察**:

- C01（97行）: 簡潔な 4 ステップ構成が効果的。divergent パターンの具体例が分類判断の anchor として機能
- C02（342行）: 長さにもかかわらず、判断フローチャートと具体例（特にアンチパターン）が実行者を正しい箇所に導いた
- メタガイド型スキル（C02）の empirical-prompt-tuning には「判断プロセス記録」形式の deliverable 定義が有効

## Session 2 Results (2026-05-01): C06 + C05

### C06: clarify

**Session**: 2 / **Date**: 2026-05-01
**Tuning status**: converged (baseline — no diff required)

#### Iteration 0 — Description/Body Consistency

- Description claims: 計画完了後の仕様明確化。反復的に不明点を解消し、Plan mode 向けの詳細仕様を作成
- Body covers: Task tool サブエージェントへの委任構造（methodology.md 参照）、後続処理（サマリー提示、後続指示対応）
- Gap: description の "for Plan mode" は context: fork（Plan mode）ではなく context: inherit + Task tool を使用する設計。ただし「計画フェーズ向け」の意味で実質的に正確
- Action: なし

#### Evaluation Scenarios

| ID  | Description                                                         | Type   |
| --- | ------------------------------------------------------------------- | ------ |
| S1  | CLI ツールに --format フラグ追加の plan 明確化 — 標準的な委任フロー | median |
| S2  | plan ファイル不在 — 会話コンテキストのみから明確化対象を構成        | edge   |

#### Requirements Checklist

- S1:
  1. [critical] Task tool (general-purpose agent) に委任する構成を明示
  2. [critical] delegation prompt に methodology.md パスを含める（主パス + Glob fallback）
  3. delegation prompt に明確化対象を含める
  4. 「重要」セクションの4指示事項を含める
  5. 後続処理の計画を示す
- S2:
  1. [critical] Task tool サブエージェントに委任（自身で直接質問しない）
  2. [critical] methodology.md パスを含める（主パス + Glob fallback）
  3. 会話コンテキストから明確化対象を構成
  4. 「重要」セクション指示を含める

#### Iteration Log

**Iter 1 (Baseline)**:
| Scenario | Success | Accuracy | steps | duration | retries |
|---|---|---|---|---|---|
| S1 | ○ | 100% | 3 | 56s | 0 |
| S2 | ○ | 100% | 3 | 59s | 0 |

Unclear points: S2 でテンプレート「明確化対象」欄の粒度指針が plan 不在時に不明確。ただし実行者は正しく対処（intentional flexibility）。
Discretionary fill-ins: 会話コンテキストの4セクション構造化、plan.md 読み取り指示追加、後続アクション候補。

**Iter 2 (Verification — S1 only)**:
| Scenario | Success | Accuracy | steps | duration | retries |
|---|---|---|---|---|---|
| S1 | ○ | 100% | 3 | 59s | 0 |

New SKILL.md-level unclear points: 0.

**Iter 3 (Verification — S1 only)**:
| Scenario | Success | Accuracy | steps | duration | retries |
|---|---|---|---|---|---|
| S1 | ○ | 100% | 4 | 76s | 0 |

New SKILL.md-level unclear points: 0. Steps 3→4 はエージェント探索パス差異によるノイズ（追加 Read/Glob 1回）。

#### Failure Pattern Ledger

なし（failure pattern 未発生）

#### Convergence Record

- Consecutive clears: 2 / 2 (Iter 2, Iter 3)
- Final accuracy: 100% (all scenarios)
- Final step count baseline: 3-4 (minor variability from agent exploration)
- Note: Iter 1 S2 の unclear point（template granularity without plan file）はテンプレートの意図的柔軟性と判断。Iter 2-3 で再発なし

---

### C05: execute-plan

**Session**: 2 / **Date**: 2026-05-01
**Tuning status**: converged (baseline — no diff required)

#### Iteration 0 — Description/Body Consistency

- Description claims: 既存の計画ファイルを入力として順次実装・テスト検証。タスク分解済みの計画向け
- Body covers: 前提条件、3フェーズワークフロー（計画読み込み→順次実装ループ→完了検証）、Wiring Checklist/Verification、制約事項（継続性、コード品質、逸脱禁止、コミット制御）
- Gap: なし
- Action: なし

#### Evaluation Scenarios

| ID  | Description                                                              | Type   |
| --- | ------------------------------------------------------------------------ | ------ |
| S1  | ユーティリティ関数追加の3タスク計画 — 標準的な順次実装フロー             | median |
| S2  | --verbose フラグ追加の5タスク計画 — Wiring Checklist/Verification テスト | edge   |

#### Requirements Checklist

- S1:
  1. [critical] 計画ファイルを Read で読み込む
  2. [critical] 各タスクを順次実装（TaskUpdate → 実装 → ビルド/テスト → completed）
  3. [critical] 全タスク完了後にテストスイート再実行
  4. リトライロジック（最大3回）を認識
  5. 計画からの逸脱禁止
  6. コミットはユーザー指示待ち
  7. 不要なコメント・JSDoc 禁止を認識
- S2:
  1. [critical] Wiring Checklist の存在確認・それに従う
  2. [critical] 全タスク完了後に Wiring Verification を実行（dead wire 検出）
  3. [critical] 各タスクを順次実行（テスト未通過で次に進まない）
  4. verbose フィールドの定義→最終利用の接続検証
  5. 変更内容サマリー提示
  6. typecheck 継続実行を認識

#### Iteration Log

**Iter 1 (Baseline)**:
| Scenario | Success | Accuracy | steps | duration | retries |
|---|---|---|---|---|---|
| S1 | ○ | 100% | 1 | 68s | 0 |
| S2 | ○ | 100% | 1 | 102s | 0 |

Unclear points: S2 で中間 typecheck エラーの扱いが不明確（「typecheck継続実行」vs「計画逸脱禁止」の緊張）。実行者は「blocking は tests 対象、intermediate typecheck failures は後続タスクで解消予定のため許容」と正しく解釈。
Discretionary fill-ins: Wiring Checklist 自作（S1）、中間 typecheck 許容判断（S2）、dead wire 検出のデフォルト値チェック追加（S2）。

**Iter 2 (Verification — S1 only)**:
| Scenario | Success | Accuracy | steps | duration | retries |
|---|---|---|---|---|---|
| S1 | ○ | 100% | 1 | 65s | 0 |

New SKILL.md-level unclear points: 0.

**Iter 3 (Verification — S1 only)**:
| Scenario | Success | Accuracy | steps | duration | retries |
|---|---|---|---|---|---|
| S1 | ○ | 100% | 1 | 68s | 0 |

New SKILL.md-level unclear points: 0.

#### Failure Pattern Ledger

なし（failure pattern 未発生）

#### Convergence Record

- Consecutive clears: 2 / 2 (Iter 2, Iter 3)
- Final accuracy: 100% (all scenarios)
- Final step count baseline: 1
- Note: Iter 1 S2 の unclear point（intermediate typecheck failures in multi-file plans）は「タスク間の依存」がテスト対象であり typecheck はブロック対象外と正しく解釈された。実運用で問題が顕在化した場合に制約セクションへの clarification を検討

---

### Session 2 Summary

**結論**: C06・C05 ともにベースラインで収束。スキル指示の修正は不要だった。
**意味**: Priority 1-2 の全6コンポーネント（C01-C06）がベースラインで収束。Document Workflow のスキル群は全体的に高い指示品質を持つ。
**観察**:

- C06（46行 SKILL.md + 155行 methodology.md）: 委任オーケストレーター型。SKILL.md テンプレートの明確さと methodology.md への委任構造が効果的。plan 不在時もテンプレートの柔軟性で対処可能
- C05（75行）: Wiring Checklist/Verification という独自概念を初見の実行者が正確に理解・実行。制約セクションの明確な列挙が判断を安定化
- Session 1-2 を通じた傾向: すべてのコンポーネントがベースラインで収束し、diff が不要だった。これは事後的な品質確認としての empirical-prompt-tuning の価値を示す

## Session 3 Results (2026-05-01): C03

### C03: plan-review-automation

**Session**: 3 / **Date**: 2026-05-01
**Tuning status**: converged (1 diff applied — Experience Delta field addition)

#### Iteration 0 — Output Consistency Check

- `buildRecommendation()` claims: plan.md 更新時にサブエージェントレビューを並列ディスパッチ
- `buildRecommendation()` covers: レビュアーリスト（always-on 2 + additional 最大3）、post-review 手順、intent-alignment-triage 指示
- `buildSummaryReminder()` claims: Executive Summary を必ず提示
- `buildSummaryReminder()` covers: 8フィールドのテンプレート
- `selectReviewers()` covers: 7カテゴリ×バイリンガルキーワード、priority ソート、最大3件
- **Gap**: `buildSummaryReminder()` に `Experience Delta` フィールドが欠落（workflow.md では必須フィールド）
- Action: Iteration 1 でベースライン取得後に修正判断

#### Execution Protocol (Hook Adaptation)

C03 はフック（TypeScript 実装）。サブエージェントには「フックの出力メッセージを受け取ったアシスタントとして行動し、指示に従って適切なアクションを取れ」と指示。成果物は「アクション計画記録」。

#### Evaluation Scenarios

| ID  | Description                                                      | Type   | Focus                                |
| --- | ---------------------------------------------------------------- | ------ | ------------------------------------ |
| S1  | Architecture+Auth plan → buildRecommendation (4 reviewers)       | median | レビュアー並列ディスパッチの正確性   |
| S2  | Documentation-only plan → buildRecommendation (2 reviewers only) | edge   | 追加レビュアーなし時の正しい振る舞い |
| S3  | Review complete → buildSummaryReminder                           | edge   | Executive Summary 提示の完全性       |

#### Requirements Checklist

- S1:
  1. [critical] ALL 4 listed reviewers を並列ディスパッチ（Agent tool 使用）
  2. [critical] 各レビュアーに plan.md の内容を含むプロンプトを構成
  3. research.md がリストされていれば含める
  4. レビュー後に Review Status を plan.md に設定
  5. auto-review marker を正しいフォーマットで追記
  6. /intent-alignment-triage を実行
  7. トリアージ前にユーザーに結果を提示しない
- S2:
  1. [critical] exactly 2 reviewers のみディスパッチ（logic-validator + scope-justification-reviewer）
  2. [critical] リストにない追加レビュアーをハルシネーションしない
  3. post-review 手順は S1 と同一
- S3:
  1. [critical] Executive Summary をユーザーへの次の応答で提示
  2. [critical] フックテンプレートの全フィールドを含める
  3. plan.md の内容からフィールドを充填
  4. 該当なしは N/A を使用

#### Iteration Log

**Iter 1 (Baseline)**:
| Scenario | Success | Accuracy | steps | duration | retries |
|---|---|---|---|---|---|
| S1 | ○ | 100% | 1 | 32s | 0 |
| S2 | ○ | 100% | 1 | 26s | 0 |
| S3 | ○ | 100% | 1 | 24s | 0 |

Hook-output-level unclear points: 1 (Experience Delta field missing from `buildSummaryReminder()` template).
Non-hook-level discretionary fill-ins: hash computation method, verdict aggregation criteria, research.md prompt inclusion, sub-agent prompt wording, /intent-alignment-triage arguments (all handled by assistant general capability or intentional flexibility).
S3 sub-agent compensated by adding Experience Delta from workflow.md knowledge, but hook-only reliant assistants would miss it.

**Diff applied**: Added `Experience Delta` field to `buildSummaryReminder()` template (1 line, matching workflow.md spec).

**Iter 2 (Verification — S3 updated + S1 stability)**:
| Scenario | Success | Accuracy | steps | duration | retries |
|---|---|---|---|---|---|
| S3 (updated) | ○ | 100% | 1 | 26s | 0 |
| S1 (stability) | ○ | 100% | 1 | 34s | 0 |

New hook-output-level unclear points: 0. S3 sub-agent reported "特に欠落しているフィールドはない" — Experience Delta gap resolved.

**Iter 3 (Convergence — S2 + S3 new plan)**:
| Scenario | Success | Accuracy | steps | duration | retries |
|---|---|---|---|---|---|
| S2 | ○ | 100% | 1 | 27s | 0 |
| S3 (new plan) | ○ | 100% | 1 | 23s | 0 |

New hook-output-level unclear points: 0.

#### Failure Pattern Ledger

| Pattern                                                         | General Fix Rule                                                                             |
| --------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Hook output template deviates from canonical spec (workflow.md) | Verify hook output templates against their source-of-truth specifications during Iteration 0 |

#### Convergence Record

- Consecutive clears: 2 / 2 (Iter 2, Iter 3)
- Final accuracy: 100% (all scenarios, all iterations)
- Final step count baseline: 1
- Diff: 1 line added to `buildSummaryReminder()` (Experience Delta field)
- Test: 1 assertion added to existing test

---

### Session 3 Summary

**結論**: C03 は 1 行の diff で収束。buildSummaryReminder() に Experience Delta フィールドが欠落していた（workflow.md との仕様不一致）。
**意味**: Session 1-2 の全コンポーネントがベースライン収束だったのに対し、C03 は初めて実際の修正が必要だった。empirical-prompt-tuning が事後確認だけでなく仕様バグ発見にも有効であることを実証。
**観察**:

- フック型コンポーネントの評価は「フック出力を受け取ったアシスタントが正しく行動するか」をテスト。スキル型と同等の手法が適用可能
- 非フック出力レベルの discretionary fill-ins（hash, verdict 集約, プロンプト構成等）はアシスタントの汎用能力で正しく対処された。フックが全てを指定する必要はない
- Failure Pattern "hook output template vs canonical spec divergence" を ledger に記録。C12 (document-workflow-guard) 評価時にも適用可能

## Session 4 Results (2026-05-01): C04

### C04: workflow.md

**Session**: 4 / **Date**: 2026-05-01
**Tuning status**: converged (baseline — no diff required)

#### Iteration 0 — Internal Consistency Check

- workflow.md internal sections (Task Intake Routing, Document Workflow Protocol, Scope Guard, Executive Summary, Task Completion Protocol): 矛盾なし
- workflow.md ↔ CLAUDE.md: 8ステップ概要は適切な簡略化。Step 3（注釈反復）、Step 4（完成）は高レベル概要から省略されているが妥当
- workflow.md ↔ plan-review-automation (C03): 2つの軽微な文書化ギャップ
  - scope-justification-reviewer が always-on レビュアーとしてフックに含まれるが workflow.md step 5 に未記載
  - auto-review マーカーの `at` フィールドがフック出力に含まれるが workflow.md のフォーマット仕様に未記載
  - いずれもフック出力がより具体的な指示を提供するため機能的影響なし
- workflow.md ↔ intent-alignment-triage (C01): トリアージマーカー形式一致
- workflow.md ↔ document-workflow-guard (C12): ゲート条件完全一致
- Gap: なし（actionable）
- Action: ベースライン評価に進む

#### Execution Protocol (Rule File Adaptation)

C04 はルールファイル（常時コンテキストに存在するマークダウン）。サブエージェントには「このルールを読み、与えられたシナリオでアシスタントとして行動し、ルールに従って適切な判断を下せ」と指示。成果物は「アクション計画記録」— ルーティング判断、ステップ順序、禁止事項の認識を含む判断記録。

#### Evaluation Scenarios

| ID  | Description                                                   | Type   | Focus                                                              |
| --- | ------------------------------------------------------------- | ------ | ------------------------------------------------------------------ |
| S1  | API エンドポイント追加タスク → Document Workflow ルーティング | median | Task Intake Routing + Protocol 初期ステップ                        |
| S2  | plan 完成 + フック出力受領 → ポストレビューフロー             | edge   | Steps 5-7 の協調（レビュー→トリアージ→Executive Summary→承認待ち） |
| S3  | スコープ過大タスク → Scope Guard 検知                         | edge   | Scope Guard 基準 + /scope-guard 実行                               |

#### Requirements Checklist

- S1:
  1. [critical] Document Workflow の必要性を認識（API 設計 + 3 ステップ以上）
  2. [critical] `$DOCUMENT_WORKFLOW_DIR/research.md` を作成する意図を表明
  3. [critical] `$DOCUMENT_WORKFLOW_DIR/plan.md` を作成し、承認前に実装しないことを認識
  4. 「コードベース探索ゲート」への言及
  5. 承認フロー全体（plan complete → auto-review → intent triage → human approval）を認識
- S2:
  1. [critical] フック出力にリストされた全 4 レビュアーを並列ディスパッチ
  2. [critical] レビュー完了後に /intent-alignment-triage を実行
  3. [critical] トリアージ完了前にユーザーにレビュー結果を提示しない
  4. [critical] Executive Summary を全 9 フィールドで提示
  5. [critical] ユーザーに Approval Status: approved を依頼
  6. Review Status と auto-review マーカーを plan.md に設定
- S3:
  1. [critical] スコープ過大の兆候を複数検知（具体的な基準をリスト）
  2. [critical] /scope-guard を実行する（提案ではなく実行）
  3. ユーザー承認を得てから着手することを表明
  4. Document Workflow への移行可能性を認識

#### Iteration Log

**Iter 1 (Baseline)**:
| Scenario | Success | Accuracy | steps | duration | retries |
|---|---|---|---|---|---|
| S1 | ○ | 100% | 1 | 100s | 0 |
| S2 | ○ | 100% | 1 | 79s | 0 |
| S3 | ○ | 100% | 1 | 57s | 0 |

Unclear points: 0 (actionable). Non-actionable observations: Scope Guard + Document Workflow routing priority (correctly resolved via routing table arrow notation + Note L47), TaskCreate overlap with Document Workflow (intentional flexibility), plan.md template structure (intentional flexibility), hash computation method (cross-component: handled by hooks), triage results placement in Executive Summary (Review Status field への統合が自然), Scope Guard exception scope (natural reading: entire process).

**Iter 2 (Verification — S1 + S2)**:
| Scenario | Success | Accuracy | steps | duration | retries |
|---|---|---|---|---|---|
| S1 | ○ | 100% | 1 | 83s | 0 |
| S2 | ○ | 100% | 1 | 78s | 0 |

New rule-level unclear points: 0. S2 sub-agent independently detected the auto-review marker `at` field discrepancy (same as Iteration 0 finding), correctly resolved by following hook output.

#### Failure Pattern Ledger

| Pattern                                                                                  | General Fix Rule                                                                                                           |
| ---------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Rule spec omits fields present in hook output (scope-justification-reviewer, `at` field) | Cross-reference rule specs against hook implementations during Iteration 0; non-blocking when hook output takes precedence |

#### Convergence Record

- Consecutive clears: 2 / 2
- Final accuracy: 100% (all scenarios, all iterations)
- Final step count baseline: 1
- Diff: none (baseline converged)

---

### Session 4 Summary

**結論**: C04 はベースラインで収束。workflow.md の修正は不要だった。
**意味**: Priority 1 の全4コンポーネント（C01-C04）と Priority 2 の全2コンポーネント（C05-C06）が全て収束。Document Workflow のコアパス全体が検証済み。
**観察**:

- ルールファイル型コンポーネントの評価は「ルールを読んだアシスタントの判断品質」をテスト。スキル型の「手順通りの成果物生成」やフック型の「出力に従ったアクション」とは異なるが、同じ要件チェックリスト手法が有効
- workflow.md の強み: (1) Task Intake Routing 表の明確な条件→モード対応、(2) Document Workflow Protocol の番号付きステップとゲート条件、(3) 「CRITICAL」「禁止」「MANDATORY」による判断 anchor
- Iteration 0 で検出した 2 つの文書化ギャップ（scope-justification-reviewer 未記載、`at` フィールド未記載）はフック出力が優先されるため機能的影響なし。修正は不要と判断
- Session 1-4 を通じた傾向: 6 コンポーネント中 5 つがベースラインで収束、1 つ（C03）が 1 行 diff で収束。Document Workflow の指示品質は全体的に高い

## Cross-Cutting Failure Patterns

Document Workflow 全体で横断的に観察される失敗パターンをここに集約する。個別コンポーネントの ledger で同じ General Fix Rule が複数コンポーネントに出現した場合、ここに昇格させる。

| Pattern                                           | Components | General Fix Rule                                                                                                           | First Seen |
| ------------------------------------------------- | ---------- | -------------------------------------------------------------------------------------------------------------------------- | ---------- |
| Hook output template deviates from canonical spec | C03        | Verify hook output templates against source-of-truth specs during Iteration 0                                              | Session 3  |
| Rule spec omits fields present in hook output     | C04        | Cross-reference rule specs against hook implementations during Iteration 0; non-blocking when hook output takes precedence | Session 4  |

## Decision Log

| Date       | Decision                                                                                                                                       | Rationale                                                                                                                                                                |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 2026-05-01 | B+C ハイブリッド戦略を採用                                                                                                                     | 全13コンポーネントの一括チューニングはコンテキスト枯渇。優先度付き分割で段階的改善                                                                                       |
| 2026-05-01 | workflow.md のチューニングは Session 4 に後回し                                                                                                | 個別スキルのチューニング結果を反映してから上位レイヤーを最適化する方が効率的                                                                                             |
| 2026-05-01 | フック(C03, C12)はスキルと異なりコード実装なので、チューニング対象は「フックが出力するガイダンスメッセージ」と「レビュアー選定ロジック」に限定 | empirical-prompt-tuning はプロンプト/指示の改善手法であり、ロジックのリファクタリングは別の手法が適切                                                                    |
| 2026-05-01 | C01・C02 はベースラインで収束、diff 不要                                                                                                       | 3シナリオ×2イテレーションで全 [critical] 達成、不明点0。スキルの指示品質が既に十分であることを実証                                                                       |
| 2026-05-01 | メタガイド型スキルの empirical-prompt-tuning は「判断プロセス記録」形式が有効                                                                  | C02 を手続的スキルと同じプロトコルで評価すると methodological contradiction が生じる。判断のプロセスを成果物とすることで解決                                             |
| 2026-05-01 | C06・C05 はベースラインで収束、diff 不要                                                                                                       | 2シナリオ×3イテレーションで全 [critical] 達成。非ブロッキングの observation あり（C06: template granularity、C05: intermediate typecheck）だが実行者は正しく対処         |
| 2026-05-01 | unclear point の分類基準を明確化                                                                                                               | 環境制約（Task tool 不在）と plan 品質（lint コマンド未指定）は SKILL.md-level unclear points としてカウントしない。Session 1 C02 の先例と整合                           |
| 2026-05-01 | C03 は Experience Delta 追加の 1 行 diff で収束                                                                                                | buildSummaryReminder() が workflow.md の必須フィールドを欠落。Iter 0 で検出、Iter 1 後に修正、Iter 2-3 で収束確認                                                        |
| 2026-05-01 | フック型コンポーネントの評価プロトコル確立                                                                                                     | 「フック出力を受け取ったアシスタントが正しく行動するか」をテスト。スキル型と同等の要件チェックリスト手法が適用可能                                                       |
| 2026-05-01 | C04 はベースラインで収束、diff 不要                                                                                                            | 3シナリオ×2イテレーションで全 [critical] 達成。2つの軽微な文書化ギャップ（scope-justification-reviewer 未記載、at フィールド未記載）はフック出力が優先されるため修正不要 |
| 2026-05-01 | ルールファイル型コンポーネントの評価プロトコル確立                                                                                             | 「ルールを読んだアシスタントの判断品質」をテスト。成果物は「アクション計画記録」。スキル型・フック型と同じ要件チェックリスト手法が有効                                   |
| 2026-05-01 | Priority 1-2 全コンポーネント（C01-C06）がベースラインまたは 1 行 diff で収束                                                                  | Document Workflow のコアパス全体の指示品質が検証済み。Priority 3 は使用頻度が低いため、問題顕在化時に着手                                                                |

## Methodology Extensions

### メタガイド型スキルの Empirical Prompt Tuning

**背景**: empirical-prompt-tuning は手続的スキル（入力→処理→出力）を前提に設計されている。しかしスキルの中には「いつ・どう使うか」を指南するメタガイド型がある（例: logic-validation, scope-guard）。メタガイド型に同じプロトコルを適用すると、「何を実行するか」が不明確になる。

**識別基準 — 手続的 vs メタガイド**:

| 特徴     | 手続的スキル                          | メタガイド型スキル                   |
| -------- | ------------------------------------- | ------------------------------------ |
| 主な内容 | 実行手順（Step 1, 2, 3...）           | 判断フロー、使用場面分類、呼び出し例 |
| 成果物   | 具体的な出力物（レポート、変更結果）  | 判断とそれに基づく行動               |
| 例       | intent-alignment-triage, execute-plan | logic-validation, scope-guard        |

**実行プロトコル**:

1. **サブエージェントへの指示**: 「このスキルを読んで、与えられたシナリオで**アシスタントとして行動**し、スキルの指示に従って適切な判断を下せ」
2. **成果物の定義**: 「判断プロセス記録」— 何をすべきと判断し、どう行動したか（手続的スキルの「処理結果」に相当）
3. **要件チェックリストの設計**: 判断の正しさ（正しいツール選択、正しい行動方針）に焦点。出力フォーマットの正確性ではなく判断品質を評価

**収束基準の適合**:

- **Accuracy**: 要件チェックリストの達成率（手続的と同じ）
- **Step count**: 判断に至るまでの読み戻り・参照回数。メタガイド型では「スキル内の情報分散度」の指標として機能
- **安定の定義**: accuracy ±3pt、step count ±20% 以内（手続的の ±10% より緩和。判断のばらつきが大きいため）

**シナリオ設計の注意点**:

- 「このスキルを使うべき場面」と「使うべきでない場面」の両方を含める（C02-S3 が好例）
- メタガイド型はコンテキスト依存性が高いため、シナリオにはユーザーの会話コンテキスト・利用可能な情報・CLAUDE.md の関連ルールを明示的に含める
- サブエージェントは Task tool を dispatch できないため、「実際に logic-validator を呼ぶ」のではなく「呼ぶべきと判断し、プロンプトを構成する」ことを成果物とする

**Session 1 での検証結果**: C02 (logic-validation, 342行) に適用し、3シナリオ全てで 100% accuracy を達成。手続的スキル（C01）と同等の収束品質を確認。

### フック型コンポーネントの Empirical Prompt Tuning

**背景**: フック（TypeScript 実装）はスキル（SKILL.md）と異なり、コードとして実装されている。チューニング対象はコード自体ではなく、フックが出力するガイダンスメッセージ（`additionalContext` として注入されるテキスト）。

**識別基準 — スキル vs フック**:

| 特徴             | スキル                  | フック                                                   |
| ---------------- | ----------------------- | -------------------------------------------------------- |
| 形式             | SKILL.md (マークダウン) | TypeScript コード                                        |
| 指示の所在       | SKILL.md 本文           | コード内の文字列リテラル（`buildRecommendation()` 等）   |
| チューニング対象 | SKILL.md の指示テキスト | フックが出力するガイダンスメッセージ                     |
| 対象外           | —                       | ロジックのリファクタリング、キャッシュ機構、トリガー条件 |

**実行プロトコル**:

1. **Iteration 0**: フック出力テンプレートを、参照仕様（workflow.md 等）と突き合わせて整合性を検証
2. **サブエージェントへの指示**: 「フックの出力メッセージを受け取ったアシスタントとして行動し、指示に従ってアクションを取れ」
3. **成果物の定義**: 「アクション計画記録」— どのツールをどう使い、何をするか（スキルの「処理結果」に相当）
4. **要件チェックリスト**: アクションの正確性（正しいレビュアーの選定、正しい順序での実行）に焦点

**Unclear point の分類基準（フック特有）**:

- **Hook-output-level**: フックの出力テキストの不備（欠落フィールド、仕様不一致等）→ 修正対象
- **Assistant-capability-level**: アシスタントの汎用能力で推論可能な事項（プロンプト構成、ハッシュ計算等）→ 修正不要
- **Responsibility-boundary**: 他のスキル/ルールの責任範囲（intent-triage マーカー、Executive Summary タイミング等）→ 修正不要

**Session 3 での検証結果**: C03 (plan-review-automation, 538行) に適用。Iteration 0 で仕様不一致（Experience Delta 欠落）を検出し、1 行修正で収束。フック型でも手続的スキルと同等の手法が有効。

### ルールファイル型コンポーネントの Empirical Prompt Tuning

**背景**: ルールファイル（`.claude/rules/*.md`）はスキルやフックと異なり、常時コンテキストに存在しアシスタントの行動を暗黙的に制約する。明示的な呼び出し（スキル）やトリガー（フック）がないため、「いつ・どの部分が効くか」はアシスタントの判断に委ねられる。

**識別基準 — スキル vs フック vs ルール**:

| 特徴             | スキル                  | フック                 | ルール                                   |
| ---------------- | ----------------------- | ---------------------- | ---------------------------------------- |
| 形式             | SKILL.md                | TypeScript コード      | マークダウン（rules/\*.md）              |
| 存在形態         | 呼び出し時にロード      | トリガー時に実行       | 常時コンテキスト内                       |
| チューニング対象 | SKILL.md の指示テキスト | フック出力テキスト     | ルール本文全体                           |
| 評価の焦点       | 手順通りの成果物生成    | 出力に従ったアクション | 判断品質（ルーティング、順序、禁止事項） |

**実行プロトコル**:

1. **Iteration 0**: ルール内部セクション間の整合性を検証。さらにルールが参照するスキル/フック実装と突き合わせ、仕様乖離を検出
2. **サブエージェントへの指示**: 「このルールを読み、与えられたシナリオでアシスタントとして行動し、ルールに従って判断を下せ」
3. **成果物の定義**: 「アクション計画記録」— ルーティング判断、ステップ順序、ツール選択、ユーザーへの発話内容を含む判断記録
4. **要件チェックリスト**: 判断の正確性（正しいルーティング、正しいステップ順序、禁止事項の認識）に焦点

**Iteration 0 のスコープ拡大（ルール特有）**:

ルールは複数のスキル/フックの協調を定義するため、Iteration 0 では以下の双方向検証が重要:

- **ルール → フック**: ルールの仕様記述がフック出力テンプレートと一致するか（C03 Session 3 で確立した検証パターンの逆方向）
- **ルール → スキル**: ルールが参照するスキルの実際の振る舞いとルールの記述が一致するか
- フック出力がルール仕様より具体的な場合、アシスタントはフック出力に従うため、乖離は非ブロッキングとして分類可能

**Unclear point の分類基準（ルール特有）**:

- **Rule-level**: ルール本文の不備・曖昧さが判断ミスを誘発する可能性 → 修正対象
- **Cross-component fill-in**: 他のルール/スキル/フックで解決済みの事項 → 修正不要
- **Discretionary fill-in**: 意図的な柔軟性（テンプレート構造、初期値等）→ 修正不要
- **Environment-level**: ツール名、実行環境の詳細 → 修正不要

**Session 4 での検証結果**: C04 (workflow.md, 162行) に適用。3シナリオ（ルーティング判断、ポストレビューフロー、Scope Guard 検知）で全 [critical] 要件を達成。2つの軽微な文書化ギャップを検出したが、フック出力が優先されるため修正不要。ベースラインで収束。

## Notes

- **セッション開始時**: このドキュメントを読み、対象コンポーネントの Status を `in progress` に更新
- **セッション終了時**: イテレーション結果を記録し、Status を更新（`converged` / `in progress` / `deferred`）
- **横断パターン発見時**: Cross-Cutting Failure Patterns セクションに追記
- **戦略変更時**: Decision Log に記録
- **Priority 3 着手判断**: Priority 1-2 が converged した時点で、実際の使用で問題が出ているコンポーネントのみ着手
