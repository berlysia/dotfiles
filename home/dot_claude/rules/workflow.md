# Workflow — Operator Guide

モデルが Document Workflow を実行するための操作ガイド。機構の詳細は `/document-workflow-reference` skill にある。判断に迷ったらそれを読む。

成果物の置き場は workflow dir（`<開始時の root>/.tmp/sessions/<session-id 先頭8桁>`。絶対パスは `workflow-cli dir` の `wfDir=`）。

## Task Intake Routing

タスク受付時に実行モードを決めてから着手する。

- 1-2 ステップ、1-2 ファイル → 直接実行
- 3-5 ステップ、明確な方針 → `/approach-check`
- 3-5 ステップ + 単一の設計判断 → Document Workflow（plan.md のみ）
- mechanical-lane 4 条件 AND 成立（`/document-workflow-reference` 参照） → Document Workflow（plan.md のみ）
- 3-5 ステップ + 複数判断 / 6+ ステップ / 複数サブシステム → Document Workflow（spec + plan-N）
- Scope Guard 検知 → `/scope-guard` → spec + plan-N に分解

**Document Workflow 必須トリガー**（いずれか 1 つ）: ADR planning phase / アーキテクチャ・API 設計・データモデルの変更 / 探索と実装が混在するタスク / ユーザーが計画を要求。

**禁止**: これらに該当するタスクで、承認前に実装へ着手すること。設計判断を伴うならステップ数が少なくても Document Workflow を使う。

**誤入時**: 直接実行相当なのに research/plan を書いたら自分で消さず、`/document-workflow-reference` の「誤って入った場合の脱出」どおり削除コマンドをユーザーに提示し実行を依頼する。

## 共通フロー（8 ステップ）

1. **調査**: 対象コードを深く読み `<wfDir>/research.md` を書く。
2. **計画**: モードに応じ `plan.md`（単層）または `spec.md` + `plan-1.md`…（二層）を書く。テンプレートは `~/.claude/templates/spec.md` / `plan-execution.md`。
3. **注釈反復**: ユーザー注釈を反映し、都度「まだ実装しない」を明示する。
   - **コードベース探索ゲート**: コードを読めば分かる不明点は質問せず自力で解消し、事実と推奨を出す。聞くのはコードだけでは決められない点のみ。
   - **依存質問の逐次化**: 前の回答に依存する質問は次ラウンドに回す。
   - 選択肢には推奨とその理由を 1 行で添える。
4. **完成**: 各成果物の `## Approval` を `Plan Status: complete` にする。
5. **自動レビュー**: `plan-review-automation` が推奨するレビュアーを Agent tool で並列実行する。
   - **5.1 Reviewer Outputs（必須）**: 各 reviewer の verdict + 主指摘 1-2 文を `## Reviewer Outputs (Round N)` に書く。長文の逐語引用はしない。
   - **帳簿は `workflow-cli` が書く**: `round <doc>`（骨格挿入）→ reviewer 実行 → `stamp <doc> --verdict <pass|needs-work|blocker> --reviewers a+b`。hash は stamp が計算する（**手で転記しない**）。
   - **5.2 Round 2 以降は差分**: 前 round の非 pass reviewer + `logic-validator` だけ再実行。Key Decisions / 白紙案を変えたら `round <doc> --full`。全員 pass で軽微指摘のみなら反映後に `stamp --verdict pass`、新 round は起こさない。
   - **5.3 予算**: pass 後 3 round で素の `round` は拒否される。延長は拒否時の案内に従う。延長した周は Executive Summary に承認者別の延長回数と reframer 記録の要約を書き、Round 7 以降は Risks にも書く。詳細は `/document-workflow-reference`「ラウンド予算」。
6. **インテント整合性トリアージ（必須）**: `/intent-alignment-triage` で、元のオーダーの本義を歪めてスコープを縮める指摘（divergent）を除外する。結果は `workflow-cli triage <doc> --adopted N --excluded M` で記録する。トリアージ前にレビュー結果をユーザーへ提示しない。
7. **承認**: Executive Summary の直後に `workflow-cli ask-approval` の出力をそのまま AskUserQuestion に渡し、人間が文書を選ぶ。キャンセルされたら議論し、済んだら人間が `approve` と打つ（下記 CRITICAL）。
8. **実装**: 三状態 + hash 一致がそろってから着手する。**着手前にオフロード判定を 1 行宣言する**（`@~/.claude/rules/model-offloading.md`）。

### ターン終端規則（重要）

「〜します」「走らせます」と宣言したら、そのターン内で実際に実行する。**宣言だけしてツールを呼ばずにターンを閉じない**。レビュアーの結果が全部届いたら、報告して止まらず次の step に進む。人間の入力を待つ場合は、最終行に「何を待っているか」を書く。判断を求める点が複数あるときは、文章で並べず AskUserQuestion でまとめて聞く。承認の依頼は同じターンで質問まで出し、回答の後に `[approval-answer-recorder]` の返答が無ければ `workflow-cli status` で確かめる。

## 二層モード（spec + plan-N）

- `spec.md` = 設計承認単位。`plan-N.md` = 実行承認単位（`parent-spec-hash` で spec.md に連鎖）。
- 承認順: spec.md を complete → pass → 承認してから、各 plan-N.md を同じ手順で独立に承認する。
- 委任: spec.md の承認の質問に 2 問目が出たら、利用者が委任を選べる。選ぶと、spec の `## Scope` に収まる plan-N.md は承認を待たずに通る（`workflow-cli status` の `✓ (delegated)`）。条件は reference skill「委任」。
- spec.md の hash が動くと全 plan-N.md の `parent-spec-hash` が不一致になり、実装がブロックされる。plan-N.md を再レビュー・再承認する。
- **ワークフロー成果物は Edit / Write で書く**。インタプリタの heredoc（`python3 - <<…` など）は guard が書き込みと判定しうる。Edit / Write なら `plan-review-automation` も発火する。

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

## Alternative Approaches (Greenfield View) — 設計層 MANDATORY

設計層（単層は plan.md、二層は spec.md）に差分最小案 / 白紙設計案 / 採用案と理由を必ず書く。白紙案には「ゼロから設計したらこの選択になった理由（起源）」を書く。採用理由は具体的根拠（既存テスト・外部契約・計測コスト）に基づかせ、評価語のみ（「シンプル」「安全」「リスクが低い」）にしない。差分最小が妥当なバグ修正でも両案を比較した形跡を残す。

## No Placeholders 禁則

実装フェーズ前に全て解消する: "TBD" / "TODO" / "後で実装" / "適切に〜" / "バリデーションを追加" / "エッジケース対応" / "上記と同様" / "Task N と類似" / 他タスクで未定義の型・関数への参照 / 評価語のみの根拠。判定基準に曖昧語（「正しく」「適切に」「問題なく」）を使わず、具体的な期待値・状態で書く。境界値・異常値は具体値を明記する。

## テスト計画（ISO 25010）

plan に `## テスト計画 (ISO 25010)` を設け、関連する品質特性（最低 1 つ）ごとにテスト方法と判定基準を「入力/操作 → 期待結果」形式で書く。対象外にした特性は理由を添える。特性選択ガイドは `/document-workflow-reference`。

## CRITICAL: 承認は人間のみ

人間が承認の質問で文書を選ぶか、会話で `approve` / `承認` と書くと、hook がその版の hash を `approvals.log` に記録し、gate はこの hash と現在の hash の一致を求める。Claude は AskUserQuestion の `answers` を入れない。承認行と `approvals.log` を書かない（guard が deny）。`/execute-plan` は承認ではない。

- hash が動く改訂は再承認が要る。取り消しは承認行を pending に戻す（詳細: reference skill「承認の記録」）。
- research/spec/plan/plan-N への編集は承認前でも許可される。
- 承認前の使い捨て作業は session の scratchpad か `mktemp -d` の出力先に、リテラルの絶対パスで書く（`.tmp/` も guard の対象。他 repo・`$HOME`・dotfiles には書かない）。
- 実装フェーズでは、承認済みの三状態 + hash 一致がそろっていれば、どの plan の Files にも無いファイルへの書き込みは deny でなく warn + `off-plan-writes.log` になる。hash drift / parent-spec-hash 不一致 / 未承認は依然 deny。
- 委任を記録するのは利用者の回答だけ。Claude は 2 問目の `answers` も入れない。

## Executive Summary（レビュー依頼時 MANDATORY）

自動レビュー + トリアージが済んだら、承認を依頼する応答の冒頭に `## Executive Summary (Review Request)` を置く。各フィールド 1-3 行、該当なしは `N/A`。

- **Goal** / **Proposed Approach** / **Experience Delta**（変更前→変更後）/ **Scope**（最大 5 件）
- **Key Decisions**（採用と却下した代替案）/ **Risks / Unknowns**
- **Review Status**: verdict / reviewers / hash（auto-review marker から）
- **Open Questions**
- **Next Action**: 続けて出す承認の質問で文書を選ぶ / 議論したいときは Esc でキャンセルしてチャットし、済んだら `approve` / 追加修正を依頼する

Experience Delta が Goal の達成に直結しているか自己検証する。自動レビューを通さずに `verdict=pass` と書かない。

## Scope Guard

次の兆候が複数該当したらスコープ過大を疑う: 広範囲キーワード（すべて/全体/一通り）/ 複合動詞（調査して実装）/ 終了条件の曖昧さ（良い感じに/最適化）/ 3 つ以上の独立コンポーネント / 10 ステップ以上 / 段階的決定の必要性。検知したら簡潔に伝え、`/scope-guard` を実行し、推奨戦略の承認を得てから着手する。

## Session Artifact Retention

`.tmp/sessions/` は 7 日超で GC される。残す成果物はセッション終了前に再配置する: 設計判断 → `docs/decisions/` の ADR、実装計画 → `docs/plans/`、調査結果 → `docs/` 配下。`.tmp/docs/` は GC 対象外（永続）。

## Task Completion Protocol

停止前に確認する: 元のタスクが完全に達成されたか / テスト・ビルドが成功しているか / 依頼されたコミットが完了したか。テスト失敗・明確な次手順・明示的なコミット依頼があれば継続する。

## 起動軸（pull / push）

上の全フローは人間が起動する pull レーン。system が発見・起動する push レーン（CI/cron 専用、出力は必ず PR）は `@~/.claude/rules/autonomous-lane.md` の charter に従う。設計判断を push に乗せることは禁止。
