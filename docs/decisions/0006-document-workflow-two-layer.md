# ADR-0006: Document Workflow の二層化 (spec.md + plan-N.md)

## Status

accepted

## Context

Document Workflow (ADR-0001) は plan.md 単一ファイルに「設計判断」と「実行手順」を同居させる構造を採用してきた。3-5 ステップ規模の変更ではこの構造で十分機能するが、6+ ステップや複数の設計判断を含む大規模変更では以下の問題が観測されている:

- **plan.md の肥大化**: Goal / Alternative Approaches / Key Decisions / Files / Tasks / ISO 25010 テスト計画が 1 枚に同居し、レビュアーの守備範囲が曖昧になる
- **再計画コストの非局所化**: 設計判断は変わらないのに実行手順を差し替えると plan.md 全体の hash が無効化され、全レビューが再走する
- **worktree 並列実装との不整合**: 1 plan で複数モジュールの実装計画が混在すると、各モジュールを独立にレビュー・承認・実装できない
- **incremental bias の温床**: Greenfield View が実行詳細と同居するため、設計層独立の白紙視点が薄まる

obra/superpowers の brainstorming → writing-plans → executing-plans 三層スキル構造との比較から、「設計の承認単位 (spec)」と「実行の承認単位 (plan)」を別ファイルに分離することで再レビューコストの局所化と並列実装の整合性を同時に達成できることが示唆された。

## Analysis

検討した 4 つの案:

- **A** (本 ADR 採用): spec.md (設計層) + plan-N.md (実行層) を完全分離、独立 hash・独立承認、parent-spec-hash で連鎖検証
- **B**: spec.md 承認後は plan-N.md は spec.md hash を継承し plan ごとの再承認は不要 (軽量だが plan の独立性が失われる)
- **C**: spec.md と全 plan-N.md を統合 hash で管理 (spec 変更で全 plan 再レビューとなり再計画コスト局所化が失われる)
- **差分最小案** (マーカー分離): plan.md 内に `## Spec / ## Execution` セクションマーカーを追加 (ファイル分離なし、hook 改修最小だが hash 単位を分離できず並列承認が成立しない)

差分最小案を白紙視点と比較した結果、以下の構造的理由で別ファイル化が必須と判断した:

- 1 plan の再計画で他 plan の hash が無効化される副作用を避けるには独立 hash が必要、独立 hash には別ファイル化が前提
- worktree 並列実装で各 plan を独立にレビュー・承認・実装するには guard が plan ごとに状態判定する必要があり、別ファイルが前提
- spec 層レビュアー (greenfield / decision-quality 等) と plan 層レビュアー (test-quality / code-simplicity 等) の SSoT 分離が ADR-0005 規約と整合する

しきい値判定は **ステップ数 (6+) OR 複数設計判断 OR 複数サブシステム** の OR 条件を採用。AND 条件だと「6+ ステップだが単一判断」(機械的書き換え等) が過剰 ceremony 化する。

## Decision

**Option A** を採用:

### モード判定（人間/Claude が routing 表で判定、hook は spec.md 存在で自動分岐）

| 条件                                                                  | モード                                   |
| --------------------------------------------------------------------- | ---------------------------------------- |
| 1-2 ステップ、1-2 ファイル                                            | 直接実行                                 |
| 3-5 ステップ、明確な方針                                              | `/approach-check`                        |
| 3-5 ステップ + 単一の設計判断                                         | DW (plan.md のみ)                        |
| 3-5 ステップ + 複数判断 OR 6+ ステップ + 単一判断 OR 複数サブシステム | DW (spec + plan-N)                       |
| Scope Guard 検知                                                      | `/scope-guard` → spec + 1..N plan に分解 |

### 二層モードの成果物構造

```
$DOCUMENT_WORKFLOW_DIR/
  research.md
  spec.md             # 設計層（1 つ）
  plan-1.md           # 実行層 1
  plan-2.md           # 実行層 2 (任意)
  ...
```

- spec.md: Goal / Experience Delta / Alternative Approaches (Greenfield View) / Key Decisions / Architecture / Risks / ISO 25010 次元選択 / Approval
- plan-N.md: 冒頭 `<!-- spec-ref: spec.md -->` / Files (fenced code block + 1 行 1 パス) / Tasks (バイトサイズ TDD scaffold) / ISO 25010 具体テストケース / Approval (`parent-spec-hash` フィールド必須)

### 承認連鎖

1. spec.md を `Plan Status: complete` → `Review Status: pass` → `Approval Status: approved` の順で進める
2. spec 承認後、plan-N.md を独立に同手順で承認
3. `document-workflow-guard` は実装系書き込み時に: (a) spec.md 三状態 + hash 一致、(b) 対象 plan-N.md 三状態 + hash 一致、(c) plan-N.md の `parent-spec-hash` と現 spec.md hash 一致、を read-snapshot で検証

### parent-spec-hash 連鎖（K7）

plan-N.md の `<!-- auto-review: ... -->` marker に `parent-spec-hash=<sha>` フィールドを必須化。`parent-spec-hash` の書き込み責務は `plan-review-automation` hook（spec.md の `computeDocumentHash` 出力を取得して plan-N.md marker 生成時に挿入）。`parent-spec-hash` フィールド欠落の plan-N.md は **conservative deny** (bypass 防止)。spec.md 改訂で plan-N.md が silent stale 化する整合性ホールを塞ぐ。

### Files 節フォーマット仕様（K8）

plan-N.md の `## Files` セクションは fenced code block + 1 行 1 パス（プロジェクトルート相対）形式。`#` 始まり行と空行は無視、それ以外の非パス行は形式違反として conservative deny。`document-workflow-guard` は `realpath` 完全一致で実装対象ファイルを照合。

### glob 制限（K9）

`document-workflow-guard` が enumerate する plan ファイルは正規表現 `^plan\.md$` または `^plan-[0-9]+\.md$` に完全一致するもののみ。`plan-draft.md` / `plan-rejected.md` / `plan-1.md.bak` / `.plan-1.md` 等は対象外。連番形式を要求する（欠番は許容）。

### レビュアー集合の SSoT 分離（K4）

`plan-review-automation.ts` の `ALWAYS_ON_REVIEWERS` を以下に分割:

- `SPEC_REVIEWERS`: logic-validator / scope-justification-reviewer / decision-quality-reviewer / greenfield-perspective-reviewer (現行 4 名)
- `PLAN_REVIEWERS`: logic-validator / scope-justification-reviewer + コンテンツベース選定 (test-quality-evaluator / code-simplicity-reviewer 等)

同名 slug が両配列に出現するため、drift detection は **spec/plan 各マーカー区間で独立に slug 集合 deepStrictEqual**（ADR-0005 規約踏襲）。重複 slug を許容する旨を `external-review.md` の脚注に明記。

### hash 関数の汎化（K5）

`computePlanHash` を `computeDocumentHash(content, normalizers)` に rename し、`SPEC_NORMALIZERS` / `PLAN_NORMALIZERS` 定数で文書種別ごとの正規化ルールを切り替え。spec.md は Tasks checkbox を含まないため正規化ルールが plan.md と異なる。T5.2/T5.3 と同コミットで実装することで、引数化なしで hash を 2 か所に書く不整合を避ける。

### prompt injection 防御の二層対応（K11）

レビュアーエージェントが spec.md / plan-N.md を読む際の区切りタグを ADR-0004 から拡張。spec.md 本文は `<spec>...</spec>`、plan-N.md 本文は `<plan>...</plan>` で区切り、各レビュアー prompt template に組み込む。

### 後方互換性

spec.md 不在時は単層モード（現行 plan.md ベース）に自動 fallback。進行中 plan.md は単層継続、新規セッションのみ二層モード判定を適用。進行中 plan.md → 二層モードへの昇格手順は workflow.md に文書化（軽量 spec → spec.md 抽出 → plan-N.md 切り出し → spec/plan 各々で承認再取得）。

### No Placeholders 禁則

spec.md / plan-N.md / 単層 plan.md 共通で以下を禁止: "TBD" / "TODO" / "後で実装" / "適切にエラー処理" / "バリデーションを追加" / "エッジケース対応" / "上記と同様" / "Task N と類似" / 他タスク未定義の識別子参照。`workflow.md` の Document Workflow Protocol 節に明記。

## Rejected alternatives

- **差分最小案 (マーカー分離)**: ファイル分離なしでは hash 単位が分離できず、独立承認・並列実装が不可能。
- **Option B (plan が spec hash を継承で再承認不要)**: plan の独立性が失われ、1 plan の再計画が他 plan に波及する。worktree 並列実装の前提が壊れる。
- **Option C (統合 hash)**: spec 変更で全 plan 再レビューとなり、本 ADR の主目的「再計画コスト局所化」が失われる。
- **しきい値の AND 条件採用**: 「6+ ステップだが単一判断」(機械的書き換え等) が過剰 ceremony 化し、運用コストが許容を超える。
- **K1 自動判定 (hook がモード推奨)**: hook 側にステップ数判定ロジックを持ち込むと plan 内容のパース責務が肥大化する。判定は人間/Claude (routing 表参照) に委ね、hook は spec.md 存在のみで分岐する設計が責務として軽い。
- **責務文の SSoT 化** (ADR-0005 で確認済み): 表現粒度 (英語 instruction vs 日本語解説) が異なるため一致を強制すると両方の表現が痩せる。本 ADR でも踏襲。
- **P0 規律 (Spec Self-Review ゲート / 一問一答) を本 ADR に同梱**: ファイル構造の二層化とプロセス規律は責務軸が直交し、独立に accept/reject 可能。本 ADR ではファイル構造変更 + No Placeholders 禁則のみ採用、Spec Self-Review と一問一答は ADR-0007 へ分離。

## ADR-0005 SSoT 規約の本変更における解釈

ADR-0005 は「コードが消費する slug 識別子の SSoT 区間にのみマーカーを使用、責務文 (prose) は SSoT 化対象外」と規定した。本 ADR で `SPEC_REVIEWERS` / `PLAN_REVIEWERS` に分割するに伴い:

- doc 側マーカー区間も `<!-- ssot:spec-reviewers:start/end -->` / `<!-- ssot:plan-reviewers:start/end -->` に分離する
- drift detection は **各マーカー区間 × 各定数配列の独立 deepStrictEqual** で実施。両配列に同名 slug (logic-validator / scope-justification-reviewer) が出現することを許容する
- 責務文 (英語 instruction / 日本語解説) は引き続き SSoT 化対象外。spec 層担当 vs plan 層担当の責務記述は doc 側で手書きで磨いて良い

## Consequences

- **再レビューコストの局所化**: spec を変えずに plan-N.md だけ差し替え可能。1 plan の再計画が他 plan の hash を無効化しない
- **worktree 並列実装との整合**: 各 plan-N.md を独立に承認・実装可能。1 spec → N plan の関係が成立
- **承認ゲートの二重化コスト**: spec 承認 + plan 承認で承認サイクルが伸びる。しきい値判定 (3-5 ステップ + 単一判断 → plan.md のみ) で軽量モードを残して軽減
- **hook 複雑度増**: `document-workflow-guard` に承認連鎖検証 + parent-spec-hash 検証 + Files 節パーサ + glob 厳格化が追加。テストカバレッジで吸収
- **既存進行中 workflow との互換性**: spec.md 不在時の単層 fallback で破綻なし。新規セッションのみ二層モード適用
- **chicken-and-egg の許容**: 本 ADR の起案段階では二層モードがまだ存在しないため、本 ADR 自身は単層 plan.md (軽量 spec を内包) で進めた。デプロイ後の最初のセッションから二層モードが選択肢として有効化される
- **テンプレート間の構造 drift**: 軽量 spec (plan.md-only モード) と完全 spec (二層モード) のセクション集合が drift する可能性。本 ADR ではテンプレ間構造照合 CI は導入せず、advisory として本節に記録 (将来必要なら別 ADR で対処)
- **直積状態空間の網羅性**: spec 三状態 × plan-N 三状態 = 9 セルのうち、テスト計画では 7 ケース網羅。未網羅: (a) spec=complete + plan=Review:pending、(b) hash 同時更新後の片方残存。代表性で許容、将来拡張として記録
- **hook 起動後 race の accept**: K12 read-snapshot は hook 単一実行内 TOCTOU を防ぐが、hook 完了後の編集は次回 Write 時の K7 連鎖検証で検出される設計とし、明示的な記録を残す
- **drift 検知 CI の拡張**: 本 ADR で `SPEC_REVIEWERS` / `PLAN_REVIEWERS` の両マーカー区間 × 両定数配列 = 4 通りの drift assertion が必要になる。`plan-review-automation.test.ts` の `doc drift detection (integration boundary)` describe block を拡張

## Open observation items

- **二層モード採用率**: デプロイ後の最初の N=5 セッションで、二層モード (spec + plan-N.md) と単層モード (plan.md のみ) の選択頻度を観測する。routing 表が機械的判定に十分かを評価
- **再レビュー局所化の効果**: 二層モードで spec 承認後に plan-N.md を改訂する実例が観測されたら、再レビューが plan-N.md のみに局所化されているか確認
- **parent-spec-hash 不一致の発生頻度**: spec.md 改訂で plan-N.md が invalidate されるケースの発生頻度。極端に高ければ承認サイクルが破綻、極端に低ければ K7 の必要性を再評価
- **ADR-0007 (P0 規律 follow-up) の発動条件**: ADR-0006 デプロイ後の最初の 5 セッションまたは 30 日の二層モード運用で、以下が **2 件以上**観測されたら ADR-0007 を accepted に進める:
  - (i) `plan-review-automation` の reviewer 指摘で「placeholder/曖昧語」が指摘された回数
  - (ii) brainstorming セッション 1 ラウンドあたりの質問数の中央値が 2 以上
  - (iii) spec.md に対する self-review marker の有無

## References

- ADR-0001 (`docs/decisions/0001-document-workflow.md`): Document Workflow の起源
- ADR-0003 (`docs/decisions/0003-document-workflow-enforce.md`): Guard enforce mode
- ADR-0004 (`docs/decisions/0004-greenfield-perspective-reviewer.md`): Greenfield Reviewer + plan.md MANDATORY セクション
- ADR-0005 (`docs/decisions/0005-always-on-reviewers-ssot.md`): Always-on reviewers SSoT 規約
- obra/superpowers (`https://github.com/obra/superpowers`): brainstorming / writing-plans / executing-plans skills
- 関連実装:
  - `home/dot_claude/rules/workflow.md`
  - `home/dot_claude/rules/external-review.md`
  - `home/dot_claude/hooks/implementations/plan-review-automation.ts`
  - `home/dot_claude/hooks/implementations/document-workflow-guard.ts`
  - `home/dot_claude/templates/spec.md` (新規)
  - `home/dot_claude/templates/plan-execution.md` (新規)
  - `home/dot_claude/hooks/tests/unit/plan-review-automation.test.ts`
  - `home/dot_claude/hooks/tests/unit/document-workflow-guard.test.ts`
- Followup ADR: ADR-0007 (`docs/decisions/0007-superpowers-process-discipline.md`) — Spec Self-Review ゲート + 一問一答ルール
