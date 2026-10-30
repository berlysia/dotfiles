---
name: document-workflow-operator
description: Document Workflow の成果物を調査・計画・レビュー・承認・実装するときに使う。短い直接作業には使わない。
---

# Workflow — Operator Guide

モデルが Document Workflow を実行するための操作ガイド。機構の詳細は `/document-workflow-reference` skill にある。判断に迷ったらそれを読む。

成果物の置き場は workflow dir（`<開始時の root>/.tmp/sessions/<session-id 先頭8桁>`。絶対パスは `workflow-cli dir` の `wfDir=`）。

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
   - **5.3 予算**: pass 後 3 round で素の `round` は拒否される。3〜5 周目の延長は人間に聞かず `--self-extend --cause <値>` で行う。`ask-approval` の延長行を Executive Summary に写し、Round 7 以降は Risks にも書く。詳細は reference skill「ラウンド予算」。
   - **5.4 委譲先**: 起動前に round ごとに `delegation route --kind review --size <S|M|L>` を 1 回引き、推奨が codex なら `executor: codex`（Agent は `model: "haiku"`）で起動する。規模と記録は `/document-workflow-reference`「reviewer の委譲先を route で決める」。
6. **インテント整合性トリアージ（必須）**: `/intent-alignment-triage` で、元のオーダーの本義を歪めてスコープを縮める指摘（divergent）を除外する。結果は `workflow-cli triage <doc> --adopted N --excluded M` で記録する。トリアージ前にレビュー結果をユーザーへ提示しない。
   - triage の後、各レビュアーを `delegation record <id> --kind review --size <S|M|L> --verdict <…> --triage-excluded <N>` で記録する（5.4 の skill 節）。
7. **承認**: Executive Summary の直後に `workflow-cli ask-approval` の出力をそのまま AskUserQuestion に渡し、人間が文書を選ぶ。キャンセルされたら議論し、済んだら人間が `approve` と打つ（下記 CRITICAL）。
8. **実装**: 三状態 + hash 一致がそろってから着手する。**着手前にオフロード判定を 1 行宣言する**（`model-offloading` skill）。

## 二層モード（spec + plan-N）

- `spec.md` = 設計承認単位。`plan-N.md` = 実行承認単位（`parent-spec-hash` で spec.md に連鎖）。
- 承認順: spec.md を complete → pass → 承認してから、各 plan-N.md を同じ手順で独立に承認する。
- 委任: spec.md の承認の質問に 2 問目が出たら、利用者が委任を選べる。選ぶと、spec の `## Scope` に収まる plan-N.md は承認を待たずに通る（`workflow-cli status` の `✓ (delegated)`）。条件は reference skill「委任」。
- spec.md の hash が動くと全 plan-N.md の `parent-spec-hash` が不一致になり、実装がブロックされる。plan-N.md を再レビュー・再承認する。
- **ワークフロー成果物は Edit / Write で書く**。インタプリタの heredoc（`python3 - <<…` など）は guard が書き込みと判定しうる。Edit / Write なら `plan-review-automation` も発火する。

## 常時必須レビュアー（層別、並列実行）

**spec 層（plan.md 単層も同じ 4 名）**:

- `logic-validator`
- `scope-justification-reviewer`
- `decision-quality-reviewer`
- `greenfield-perspective-reviewer`

**plan 層（二層モードの plan-N.md、+ コンテンツベースで最大 3 名）**:

- `logic-validator`
- `scope-justification-reviewer`

## Executive Summary（レビュー依頼時 MANDATORY）

自動レビュー + トリアージが済んだら `workflow-cli ask-approval` の注記を読み、承認依頼の冒頭に `## Executive Summary (Review Request)` を置く。読み手は自分の最後の発言さえ覚えていないと仮定する。事実は文書・オーダー・利用者の発言・レビューの出力から写して足さず、無ければ `N/A`。前提は毎回どの作業かから書き、ID に中身を、決定に理由と除外した指摘を添える。先頭の 5 項目は、この順に前を受けて書く（前提以外は 1-2 行）。

- **前提**: plan-N.md は親 spec の K-id / Scope、spec.md と単層 plan.md は元のオーダーの引用
- **目指す状態**: Goal（plan-N.md は担う K の完了像）
- **今の状態**: research.md で観察した現状
- **やり方**: 方針と Tasks の順、途中の確認点
- **確かめ方**: テスト計画の「入力 → 期待結果」の主なもの（spec.md は選んだ品質特性）

続けて各 1-3 行（Key Decisions は決定ごとに 1-2 行で最大 5 件）:

- **Scope**（最大 5 件）/ **Key Decisions**（採用と却下した代替案）/ **Risks / Unknowns**
- **Review Status**: verdict / reviewers / hash（auto-review marker から）
- **Open Questions**
- **Next Action**: 続けて出す承認の質問で文書を選ぶ / 議論したいときは Esc でキャンセルしてチャットし、済んだら `approve` / 追加修正を依頼する

確かめ方の各行が目指す状態のどれを確かめるかを自己検証する。自動レビューを通さずに `verdict=pass` と書かない。

## Task Completion Protocol

停止前に確認する: 元のタスクが完全に達成されたか / テスト・ビルドが成功しているか / 完了の範囲（`delivery-policy` skill）まで進んだか / 応答に出た残件を保存したか。テスト失敗・明確な次手順・範囲までの残りがあれば継続する。残件は、自分が書いたものも利用者が挙げたものも、応答を閉じる前に `docs/plans/`（承認前は workflow dir の `followups/`）へ書き、書いた先を知らせる（`/document-workflow-reference`「記録の移し方」）。

## 届く経路

description が Document Workflow の作業時を案内する。hook からの案内はまだ無い。
