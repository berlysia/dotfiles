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

| 条件 | 実行モード |
|------|-----------|
| 1-2 ステップ、1-2 ファイル | 直接実行 |
| 3-5 ステップ、明確な方針 | `/approach-check` |
| 3+ ステップ、または設計判断を伴う（API・データモデル・アーキテクチャ変更等） | **Document Workflow（必須）** |
| Scope Guard 検知 | `/scope-guard` → 戦略に応じて Document Workflow |

**Document Workflow 必須トリガー（いずれか1つで発動）**:
- ADR の planning phase に該当する作業
- アーキテクチャ・API設計・データモデルの変更
- 探索と実装が混在するタスク（「調べてから実装」）
- ユーザーが計画を要求した場合

**禁止**: 上記トリガーに該当するタスクで `$DOCUMENT_WORKFLOW_DIR/plan.md` 承認前に実装へ着手すること

**Note**: ステップ数が少なくても設計判断を伴う場合は Document Workflow 必須。Scope Guard が検知した場合は `/scope-guard` の推奨戦略に従う。

## Document Workflow Protocol (MANDATORY)

セッション開始時に `DOCUMENT_WORKFLOW_DIR` 環境変数が設定される（例: `.tmp/sessions/abcd1234/`）。
ワークフロー成果物はすべてこのディレクトリ配下に作成する。未設定時は `.tmp/` をフォールバックとする。

```
1. 調査: 対象コードを深く読み `$DOCUMENT_WORKFLOW_DIR/research.md` を作成
2. 計画: `$DOCUMENT_WORKFLOW_DIR/plan.md` に方針・対象ファイル・TODO・リスクを書く
3. 注釈反復: ユーザー注釈を反映し、都度「don't implement yet」を明示
4. 完成: `$DOCUMENT_WORKFLOW_DIR/plan.md` の `## Approval` で `Plan Status: complete` にする
5. 自動レビュー: `plan-review-automation` が `logic-validator` + 設計系レビュアで評価し、`Review Status` と `<!-- auto-review: verdict=...; hash=... -->` を更新する
6. 承認: 人間が `Approval Status: approved` にする
7. 実装: `Plan Status: complete` + `Review Status: pass` + `Approval Status: approved` + hash 一致を満たした後に着手し、タスク完了ごとに `$DOCUMENT_WORKFLOW_DIR/plan.md` を更新
```

**CRITICAL: 承認は人間のみが行う。** ユーザーが明示的に「approve」「承認」と発言するか、`/execute-plan` を指示しない限り、Claudeは `Approval Status: approved` に変更したり、実装へ着手してはならない。

- `$DOCUMENT_WORKFLOW_DIR/research.md` と `$DOCUMENT_WORKFLOW_DIR/plan.md` への編集は承認前でも許可される
- `Write/Edit/MultiEdit/NotebookEdit` で `plan.md` を更新すると `plan-review-automation` が自動実行される
- `Write/Edit/MultiEdit/NotebookEdit/Bash` の実装系書き込みは `document-workflow-guard` が制御する
- ロールアウト初期は `DOCUMENT_WORKFLOW_WARN_ONLY=1` で観測し、安定後に enforce へ移行する

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

## Plan Mode Completion Protocol (LEGACY)

**重要**: 既存ワークフロー互換のために維持。通常は Document Workflow を優先する。

```
1. Plan Mode で計画作成
2. ExitPlanMode 実行 → hook でブロック（<!-- validated --> マーカーがない場合）
3. logic-validator agent で検証
4. 計画ファイルに <!-- validated --> マーカーを追加
5. ExitPlanMode 再実行 → 成功
6. 実装開始
```

詳細は `@~/.claude/rules/external-review.md` を参照。
