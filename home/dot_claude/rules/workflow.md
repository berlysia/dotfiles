# Workflow Rules

## Session Scoping

- One focused goal per session (investigate OR implement, not both)
- For multi-phase work: separate investigation, planning, and implementation into distinct sessions
- Use sub-agents (Task tool with Explore agent) for codebase investigation to preserve main context
- Track cross-session progress with TaskCreate when work spans multiple sessions

## Task Management

- **Simple tasks** (1-2 steps): Execute directly without task tracking
- **Medium tasks** (3-5 steps): Use TodoWrite for lightweight progress tracking
- **Complex tasks** (6+ steps or multi-session): Use TaskCreate/TaskUpdate for full tracking
- Avoid creating tasks for trivial operations — the overhead should not exceed the work itself

## Task Intake Routing

タスク受付時に実行モードを判定してから着手する:

| 条件                                                                         | 実行モード                                      |
| ---------------------------------------------------------------------------- | ----------------------------------------------- |
| 1-2 ステップ、1-2 ファイル                                                   | 直接実行                                        |
| 3-5 ステップ、明確な方針                                                     | `/approach-check`                               |
| 3+ ステップ、または設計判断を伴う（API・データモデル・アーキテクチャ変更等） | **Document Workflow（必須）**                   |
| Scope Guard 検知                                                             | `/scope-guard` → 戦略に応じて Document Workflow |

**Document Workflow 必須トリガー（いずれか1つで発動）**:

- ADR の planning phase に該当する作業
- アーキテクチャ・API設計・データモデルの変更
- 探索と実装が混在するタスク（「調べてから実装」）
- ユーザーが計画を要求した場合

**禁止**: 上記トリガーに該当するタスクで `$DOCUMENT_WORKFLOW_DIR/plan.md` 承認前に実装へ着手すること

**Note**: ステップ数が少なくても設計判断を伴う場合は Document Workflow 必須。Scope Guard が検知した場合は `/scope-guard` の推奨戦略に従う。

## Document Workflow Protocol (MANDATORY)

セッション開始時に `DOCUMENT_WORKFLOW_DIR` 環境変数が設定される（例: `.tmp/sessions/abcd1234/`）。
ワークフロー成果物はすべてこのディレクトリ配下に作成する。未設定時はワークフローガードが無効になる。

```
1. 調査: 対象コードを深く読み `$DOCUMENT_WORKFLOW_DIR/research.md` を作成
2. 計画: `$DOCUMENT_WORKFLOW_DIR/plan.md` に方針・対象ファイル・TODO・リスクを書く
3. 注釈反復: ユーザー注釈を反映し、都度「don't implement yet」を明示
4. 完成: `$DOCUMENT_WORKFLOW_DIR/plan.md` の `## Approval` で `Plan Status: complete` にする
5. 自動レビュー: `plan-review-automation` が plan.md の内容を分析し、`logic-validator`（必須）+ コンテンツベースで選定した追加レビュアー（最大3つ）を並列実行推奨。`Review Status` と `<!-- auto-review: verdict=...; hash=...; reviewers=... -->` を更新する
6. 承認: 人間が `Approval Status: approved` にする
7. 実装: `Plan Status: complete` + `Review Status: pass` + `Approval Status: approved` + hash 一致を満たした後に着手し、タスク完了ごとに `$DOCUMENT_WORKFLOW_DIR/plan.md` を更新
```

**CRITICAL: 承認は人間のみが行う。** ユーザーが明示的に「approve」「承認」と発言するか、`/execute-plan` を指示しない限り、Claudeは `Approval Status: approved` に変更したり、実装へ着手してはならない。

- `$DOCUMENT_WORKFLOW_DIR/research.md` と `$DOCUMENT_WORKFLOW_DIR/plan.md` への編集は承認前でも許可される
- `Write/Edit/MultiEdit/NotebookEdit` で `plan.md` を更新すると `plan-review-automation` が自動実行される
- `Write/Edit/MultiEdit/NotebookEdit/Bash` の実装系書き込みは `document-workflow-guard` が制御する
- `document-workflow-guard` は enforce モードで動作し、plan 未承認の実装をブロックする

### Executive Summary (MANDATORY on Review Request)

`$DOCUMENT_WORKFLOW_DIR/plan.md` を完成させてユーザーに承認レビューを依頼する時点（step 4 完了後、step 5 の自動レビュー結果が揃った段階）で、**エグゼクティブサマリー** をユーザーへの応答の冒頭に必ず提示する。目的は、ユーザーが plan.md 全文や会話ログを辿らずに、承認可否を判断するための要点を一発で把握できるようにすること。

**提示タイミング**:

- plan.md の `Plan Status: complete` にした直後
- `plan-review-automation` が完了し、`Review Status` と `<!-- auto-review: verdict=...; reviewers=... -->` が plan.md に反映された後
- ユーザーに `Approval Status: approved` を依頼する応答の先頭

**必須フィールド**（欠落させず、該当なしは `N/A` と明記）:

```
## Executive Summary (Review Request)

- **Goal**: <plan.md の目的を 1 行で>
- **Proposed Approach**: <採用する方針の本質を 1-3 行で>
- **Scope**: <変更予定ファイル/モジュールを最大5件>
- **Key Decisions**: <採用した設計判断と、却下した代替案を1-2行ずつ>
- **Risks / Unknowns**: <既知リスク・未検証の前提・影響範囲の広い箇所>
- **Review Status**: verdict=<pass/fail/needs-revision> / reviewers=<agent名カンマ区切り> / hash=<auto-review の hash>
- **Open Questions**: <ユーザー判断を仰ぎたい点（なければ N/A）>
- **Next Action**: `Approval Status: approved` にしてください / 追加修正を依頼してください
```

**原則**:

- **判断材料に絞る**: 実装詳細の羅列ではなく、承認判断に必要な情報（方針・リスク・未解決点）を優先
- **plan.md との一貫性**: サマリー内容は plan.md から投影する。plan.md にない主張は書かない
- **事実のみ**: 自動レビューを通さずに `verdict=pass` と書かない（`code-quality.md` の Communication Accuracy 準拠）
- **簡潔性**: 各フィールド1-3行まで。詳細は plan.md 本文に委ねる
- **更新時**: plan.md を改訂して再レビューを依頼する場合は、変更点を明示した新サマリーを再提示する

## Scope Guard

タスク受付時に以下の兆候が **複数** 該当する場合、スコープ過大の疑いありと判定する:

- **広範囲キーワード**: 「すべて」「全体」「一通り」「各コンポーネント」
- **複合動詞**: 「調査して実装」「設計して構築」（探索 + 実装の混在）
- **終了条件の曖昧さ**: 「良い感じに」「きれいに」「最適化」（定量基準なし）
- **複数モジュール列挙**: 3つ以上の独立コンポーネントへの言及
- **推定ステップ数**: 10ステップ以上の見積もり
- **段階的決定の必要性**: 「Xを調べてからYを決める」

**検知時の行動**:

1. ユーザーにスコープの大きさについて簡潔に伝える
2. `/scope-guard` を実行する（提案ではなく実行）
3. 推奨戦略を提示し、ユーザー承認を得てから着手する

**例外**: ユーザーが明示的に不要と指示した場合のみスキップ可能

## Task Completion Protocol

作業停止前の必須チェック：

- 元のタスクが完全に達成されたか
- テスト・ビルドが成功しているか
- 明示的に依頼されたコミットが完了しているか

**継続すべきケース**:

- Tests/build failing → Fix and retry
- Clear next steps → Execute them
- Explicit commit request → Complete it
- Ambiguous requirements → Ask clarification

**Critical**: Never unilaterally lower user expectations or disable steering.
