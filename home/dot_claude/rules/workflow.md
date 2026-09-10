# Workflow — Operator Guide

これはモデルが Document Workflow を実行するための操作ガイド。行動する順に読む。機構の詳細（hash 3 種の意味、DOCUMENT_WORKFLOW_DIR 引き継ぎ、S3 移行手順、carry-forward の責務分離、mechanical-lane の全条件、起動軸）は `/document-workflow-reference` skill に分離してある。判断に迷ったらそれを読む。

成果物の置き場は `$DOCUMENT_WORKFLOW_DIR`（= `.tmp/sessions/<session-id 先頭8桁>`）。hook はこのパスを hook 入力から自力で導出するため、環境変数が無くても enforce は効く。

## Task Intake Routing

タスク受付時に実行モードを決めてから着手する。

| 条件                                                                   | モード                                |
| ---------------------------------------------------------------------- | ------------------------------------- |
| 1-2 ステップ、1-2 ファイル                                             | 直接実行                              |
| 3-5 ステップ、明確な方針                                               | `/approach-check`                     |
| 3-5 ステップ + 単一の設計判断                                          | Document Workflow（plan.md のみ）     |
| mechanical-lane 4 条件 AND 成立（`/document-workflow-reference` 参照） | Document Workflow（plan.md のみ）     |
| 3-5 ステップ + 複数判断 / 6+ ステップ / 複数サブシステム               | Document Workflow（spec + plan-N）    |
| Scope Guard 検知                                                       | `/scope-guard` → spec + plan-N に分解 |

**Document Workflow 必須トリガー**（いずれか 1 つ）: ADR planning phase / アーキテクチャ・API 設計・データモデルの変更 / 探索と実装が混在するタスク / ユーザーが計画を要求。

**禁止**: これらに該当するタスクで、承認前に実装へ着手すること。設計判断を伴うならステップ数が少なくても Document Workflow を使う。

## 共通フロー（8 ステップ）

1. **調査**: 対象コードを深く読み `$DOCUMENT_WORKFLOW_DIR/research.md` を書く。
2. **計画**: モードに応じ `plan.md`（単層）または `spec.md` + `plan-1.md`…（二層）を書く。テンプレートは `~/.claude/templates/spec.md` / `plan-execution.md`。
3. **注釈反復**: ユーザー注釈を反映し、都度「まだ実装しない」を明示する。
   - **コードベース探索ゲート**: 質問の前に、コードを読めば分かる不明点は自力で解消し、事実と推奨を出す。聞くのはコードだけでは決められない点のみ。
   - **依存質問の逐次化**: 前の回答に依存する質問は次ラウンドに回す。
   - 選択肢を出すときは推奨とその理由を 1 行で添える。
4. **完成**: 各成果物の `## Approval` を `Plan Status: complete` にする。
5. **自動レビュー**: `plan-review-automation` が編集を検知して層別のレビュアー集合を推奨する。**推奨された全レビュアーを Agent tool で並列実行する**。
   - **5.1 Reviewer Outputs 追記（必須）**: 各 reviewer の verdict + 主指摘 1-2 文を、auto-review marker の直前に `## Reviewer Outputs (Round N)` として書く。骨格は `workflow-cli round <doc>` が作る。このセクションが無いと lessons 抽出が skip される。長文の逐語引用はしない。
   - **marker と Review Status は `workflow-cli` が書く**: レビュー後に `workflow-cli round <doc>`（骨格挿入）→ reviewer 実行 → `workflow-cli stamp <doc> --verdict <pass|needs-work|blocker> --reviewers a+b`。stamp は hash / design-hash / parent-spec-hash を自分で計算して marker を書く。**hash を手で転記しない**。stamp は reviewer が実際に起動された証跡（`reviewer-runs.log`）が無いと通らない。
6. **インテント整合性トリアージ（必須）**: `/intent-alignment-triage` を実行し、元のオーダーの本義を歪めてスコープを縮める指摘（divergent）を除外する。結果は `workflow-cli triage <doc> --adopted N --excluded M` で marker に記録する。トリアージ前にレビュー結果をユーザーへ提示しない。
7. **承認**: 人間が `Approval Status: approved` にする（下記 CRITICAL）。
8. **実装**: 三状態 + hash 一致がそろってから着手する。**着手前にオフロード判定を 1 行宣言する**（`@~/.claude/rules/model-offloading.md`）。

### ターン終端規則（重要）

「〜します」「走らせます」と宣言したら、そのターン内で実際に実行する。**宣言だけしてツールを呼ばずにターンを閉じない**。レビュアーの結果が全部届いたら、報告して止まらず、その場で次の step に進む。人間の入力を待つ場合は、最終行に「何を待っているか」を書く。

## 二層モード（spec + plan-N）

- `spec.md` = 設計承認単位（独立 hash）。`plan-N.md` = 実行承認単位（独立 hash + `parent-spec-hash` 連鎖）。
- 承認順: spec.md を complete → pass → approved にしてから、各 plan-N.md を独立に同手順で承認する。
- `document-workflow-guard` は実装系書き込み時に、(a) spec.md 三状態 + hash 一致、(b) 対象ファイルが属する plan-N.md 三状態 + hash 一致、(c) plan-N.md の `parent-spec-hash` = 現 spec.md hash、を検証する。いずれか欠けると deny。
- spec.md を編集して hash が動いたら plan-N.md の `parent-spec-hash` が不一致になり自動で実装ブロックされる。plan-N.md の Approval を pending に戻し、再レビュー・再承認する。
- deny された場合、guard は「どの条件が不成立か・見つかった status 行・次の 1 手」を診断で示す。`workflow-cli status` で同じ診断を確認できる。文書を Bash の heredoc で書いても検知される。承認前のインタプリタ書き込みは保守的に deny される。

## 常時必須レビュアー（層別、並列実行）

**spec 層（plan.md 単層も同じ 4 名）**:

<!-- ssot:spec-reviewers:start -->

- `logic-validator`
- `scope-justification-reviewer`
- `decision-quality-reviewer`
- `greenfield-perspective-reviewer`

<!-- ssot:spec-reviewers:end -->

**plan 層（二層モードの plan-N.md、+ コンテンツベースで最大 3 名）**:

<!-- ssot:plan-reviewers:start -->

- `logic-validator`
- `scope-justification-reviewer`

<!-- ssot:plan-reviewers:end -->

これらは Agent tool の subagent_type であって Skill ではない。SSoT はコード定数（`plan-review-automation.ts` の `SPEC_REVIEWERS` / `PLAN_REVIEWERS`、実体は `lib/workflow-review-core.ts`）で、上の区間と CI で同期される。

## Alternative Approaches (Greenfield View) — 設計層 MANDATORY

設計層（単層は plan.md、二層は spec.md）に必ず設ける。差分最小案 / 白紙設計案 / 採用案と理由。白紙案には「ゼロから設計したらこの選択になった理由（起源）」を書く。採用理由は具体的根拠（既存テスト・外部契約・計測コスト）に基づく。評価語のみ（「シンプル」「安全」「リスクが低い」）は不可。バグ修正等で差分最小が妥当な場合も両案を比較した形跡を残す。

## No Placeholders 禁則

実装フェーズ前に全て解消する: "TBD" / "TODO" / "後で実装" / "適切に〜" / "上記と同様" / "Task N と類似" / 他タスクで未定義の型・関数への参照 / 評価語のみの根拠。判定基準に曖昧語（「正しく」「適切に」「問題なく」）を使わず、具体的な期待値・状態で書く。境界値・異常値は具体値を明記する。

## テスト計画（ISO 25010）

plan に `## テスト計画 (ISO 25010)` を設け、変更に関連する品質特性を選び、各特性のテスト方法と判定基準を「入力/操作 → 期待結果」形式で書く。最低 1 特性。対象外にした特性は理由を添える。特性選択ガイドは `/document-workflow-reference`。

## CRITICAL: 承認は人間のみ

ユーザーが明示的に「approve」「承認」と発言するか `/execute-plan` を指示しない限り、Claude は `Approval Status: approved` に変更してはならず、実装へ着手してはならない。`workflow-cli` は Approval 行に触れる変更を拒否する。

- research/spec/plan/plan-N への編集は承認前でも許可される。
- 実装系書き込み（Write/Edit/NotebookEdit/Bash）は `document-workflow-guard` が enforce で制御する。
- 実装フェーズでは、承認済み spec + plan の三状態 + hash 一致がそろっていれば、どの plan-N.md の Files にも無いファイルへの書き込みは deny でなく warn + `off-plan-writes.log` に降格する。hash drift / parent-spec-hash 不一致 / 未承認は依然 deny。

## Executive Summary（レビュー依頼時 MANDATORY）

plan/spec を complete にし、自動レビュー + トリアージが済んだら、承認を依頼する応答の冒頭に必ず提示する。各フィールドは 1-3 行、該当なしは `N/A`。

```
## Executive Summary (Review Request)
- **Goal**: <目的を 1 行>
- **Proposed Approach**: <採用方針の本質 1-3 行>
- **Experience Delta**: <変更前→変更後の体験差 1-2 行>
- **Scope**: <変更予定ファイル/モジュール 最大5件>
- **Key Decisions**: <採用した判断と却下した代替案 各1-2行>
- **Risks / Unknowns**: <既知リスク・未検証の前提>
- **Review Status**: verdict / reviewers / hash（auto-review marker から）
- **Open Questions**: <ユーザー判断を仰ぐ点、なければ N/A>
- **Next Action**: `Approval Status: approved` にしてください / 追加修正を依頼してください
```

Experience Delta が Goal の達成に直結しているか自己検証する。自動レビューを通さずに `verdict=pass` と書かない。

## Scope Guard

次の兆候が複数該当したらスコープ過大を疑う: 広範囲キーワード（すべて/全体/一通り）/ 複合動詞（調査して実装）/ 終了条件の曖昧さ（良い感じに/最適化）/ 3 つ以上の独立コンポーネント / 10 ステップ以上 / 段階的決定の必要性。検知したら簡潔に伝え、`/scope-guard` を実行し、推奨戦略の承認を得てから着手する。

## Session Artifact Retention

`.tmp/sessions/` は 7 日超で GC される。残す成果物はセッション終了前に再配置する: 設計判断 → `docs/decisions/` の ADR、実装計画 → `docs/plans/`、調査結果 → `docs/` 配下。`.tmp/docs/` は GC 対象外（永続）。

## Task Completion Protocol

停止前に確認する: 元のタスクが完全に達成されたか / テスト・ビルドが成功しているか / 依頼されたコミットが完了したか。テスト失敗・明確な次手順・明示的なコミット依頼があれば継続する。ユーザーの期待を勝手に下げたり steering を無効化しない。

## 起動軸（pull / push）

上の全フローは人間が起動する pull レーン。system が発見・起動する push レーン（CI/cron 専用、出力は必ず PR）は `@~/.claude/rules/autonomous-lane.md` の charter に従う。設計判断を push に乗せることは禁止。
