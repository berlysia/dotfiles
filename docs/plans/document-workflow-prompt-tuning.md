# Document Workflow Empirical Prompt Tuning Plan

## Overview

Document Workflow を構成するスキル群・フック・ワークフロー定義に `/empirical-prompt-tuning` を適用し、指示品質を体系的に改善する取り組み。

**方法論**: 各コンポーネントに対してバイアスフリーの実行者（サブエージェント）にスキルを実行させ、二面評価（実行者自己申告 + 指示側メトリクス）を反復し、改善が収束するまでイテレーションを回す。

**戦略**: B+C ハイブリッド（マルチセッション分割 + 優先度スコープカット）

## Component Inventory

### Priority 1 — Core Path (every Document Workflow session)

| ID | Component | Type | Path (source) | Status |
|----|-----------|------|---------------|--------|
| C01 | `intent-alignment-triage` | skill | `.skills/intent-alignment-triage/SKILL.md` | **converged** (Session 1, 2026-05-01) |
| C02 | `logic-validation` | skill | `.skills/logic-validation/SKILL.md` | **converged** (Session 1, 2026-05-01) |
| C03 | `plan-review-automation` | hook | `home/dot_claude/hooks/implementations/plan-review-automation.ts` | not started |
| C04 | `workflow.md` | rule | `home/dot_claude/rules/workflow.md` | not started |

### Priority 2 — Frequent Skills (most sessions)

| ID | Component | Type | Path (source) | Status |
|----|-----------|------|---------------|--------|
| C05 | `execute-plan` | skill | `.skills/execute-plan/SKILL.md` | not started |
| C06 | `clarify` | skill | `.skills/clarify/SKILL.md` | not started |

### Priority 3 — Conditional Use

| ID | Component | Type | Path (source) | Status |
|----|-----------|------|---------------|--------|
| C07 | `scope-guard` | skill | external (installed) | not started |
| C08 | `decompose` | skill | `.skills/decompose/SKILL.md` | not started |
| C09 | `verify-doc` | skill | `.skills/verify-doc/SKILL.md` | not started |
| C10 | `task-enrich` | skill | `.skills/task-enrich/SKILL.md` | not started |
| C11 | `task-handoff` | skill | `.skills/task-handoff/SKILL.md` | not started |
| C12 | `document-workflow-guard` | hook | `home/dot_claude/hooks/implementations/document-workflow-guard.ts` | not started |

## Session Plan

| Session | Target | Rationale | Dependencies |
|---------|--------|-----------|--------------|
| 1 | C01 `intent-alignment-triage` + C02 `logic-validation` | レビュー品質の根幹。独立してチューニング可能 | none |
| 2 | C06 `clarify` + C05 `execute-plan` | 計画詳細化と実装実行のコアペア | none |
| 3 | C03 `plan-review-automation` | レビュアー選定ロジック。C01/C02のチューニング結果を前提とする | C01, C02 |
| 4 | C04 `workflow.md` | 全スキルの協調を定義する上位レイヤー。個別スキルの改善後に最適化 | C01-C03, C05-C06 |
| 5+ | C07-C12 (必要に応じて) | 使用頻度が低いため、問題が顕在化した時点で着手 | varies |

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
| ID | Description | Type |
|----|-------------|------|
| S1 | 混合指摘（aligned + divergent）のトリアージ | median |
| S2 | 全指摘 aligned — false positive テスト | edge |
| S3 | 「段階的実装」推奨 vs 一括実装意図 — mixed divergent | edge |

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
| ID | Description | Type |
|----|-------------|------|
| S1 | 症状的修正の検出（TS build error → tsconfig 変更） | median |
| S2 | 根拠の薄い仮説の検証（SRP による class 分割） | median |
| S3 | 不要な呼び出しのリダイレクト（ファイル確認 → Read 推奨） | edge |

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

## Cross-Cutting Failure Patterns

Document Workflow 全体で横断的に観察される失敗パターンをここに集約する。個別コンポーネントの ledger で同じ General Fix Rule が複数コンポーネントに出現した場合、ここに昇格させる。

| Pattern | Components | General Fix Rule | First Seen |
|---------|-----------|-----------------|------------|
| (none yet) | | | |

## Decision Log

| Date | Decision | Rationale |
|------|----------|-----------|
| 2026-05-01 | B+C ハイブリッド戦略を採用 | 全13コンポーネントの一括チューニングはコンテキスト枯渇。優先度付き分割で段階的改善 |
| 2026-05-01 | workflow.md のチューニングは Session 4 に後回し | 個別スキルのチューニング結果を反映してから上位レイヤーを最適化する方が効率的 |
| 2026-05-01 | フック(C03, C12)はスキルと異なりコード実装なので、チューニング対象は「フックが出力するガイダンスメッセージ」と「レビュアー選定ロジック」に限定 | empirical-prompt-tuning はプロンプト/指示の改善手法であり、ロジックのリファクタリングは別の手法が適切 |
| 2026-05-01 | C01・C02 はベースラインで収束、diff 不要 | 3シナリオ×2イテレーションで全 [critical] 達成、不明点0。スキルの指示品質が既に十分であることを実証 |
| 2026-05-01 | メタガイド型スキルの empirical-prompt-tuning は「判断プロセス記録」形式が有効 | C02 を手続的スキルと同じプロトコルで評価すると methodological contradiction が生じる。判断のプロセスを成果物とすることで解決 |

## Methodology Extensions

### メタガイド型スキルの Empirical Prompt Tuning

**背景**: empirical-prompt-tuning は手続的スキル（入力→処理→出力）を前提に設計されている。しかしスキルの中には「いつ・どう使うか」を指南するメタガイド型がある（例: logic-validation, scope-guard）。メタガイド型に同じプロトコルを適用すると、「何を実行するか」が不明確になる。

**識別基準 — 手続的 vs メタガイド**:

| 特徴 | 手続的スキル | メタガイド型スキル |
|------|-------------|-------------------|
| 主な内容 | 実行手順（Step 1, 2, 3...） | 判断フロー、使用場面分類、呼び出し例 |
| 成果物 | 具体的な出力物（レポート、変更結果） | 判断とそれに基づく行動 |
| 例 | intent-alignment-triage, execute-plan | logic-validation, scope-guard |

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

## Notes

- **セッション開始時**: このドキュメントを読み、対象コンポーネントの Status を `in progress` に更新
- **セッション終了時**: イテレーション結果を記録し、Status を更新（`converged` / `in progress` / `deferred`）
- **横断パターン発見時**: Cross-Cutting Failure Patterns セクションに追記
- **戦略変更時**: Decision Log に記録
- **Priority 3 着手判断**: Priority 1-2 が converged した時点で、実際の使用で問題が出ているコンポーネントのみ着手
