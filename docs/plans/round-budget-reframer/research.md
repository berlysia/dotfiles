# Research: ラウンド予算の自己延長（3 → 最大 6）とハードキャップ時の問題変形検討

## オーダー

- 現行: pass 後 3 round で `workflow-cli round` が拒否し、続行は人間の許可制（`--extend --reason`）
- 変更: 延長すれば着地する見込みがあるなら、モデルが 6 round まで自分の判断で延長してよい
- 6 round でも着地しなければ「問題の変形」を選択肢に入れ、サブエージェントに検討させる（ユーザー追記）

## 現行実装（事実）

- `home/dot_claude/hooks/lib/workflow-review-core.ts:65` `ROUND_BUDGET = 3`。コメントで「CLI の拒否と `buildRecommendation` の通知が同じ数を引くため共有」と明記
- `workflow-review-core.ts:584-593` `buildRecommendation`: `roundCount - lastPassMarkerRound >= ROUND_BUDGET && marker.verdict !== "pass"` で "Round budget reached (3) ... Only if the human tells you to continue, run `--extend --reason`" を出す
- `home/dot_claude/hooks/cli/workflow.ts:109` `BOOLEAN_FLAGS = {"full","extend"}`
- `workflow.ts:293-303`: `roundsInCycle = currentRound - lastPassMarkerRound`。`--extend` に `--reason` が無ければ拒否。`roundsInCycle >= ROUND_BUDGET && !extending` なら拒否
- `workflow.ts:345-351`: 予算超過かつ `--extend` のとき `round-extensions.log` に `<ISO>\t<doc>\t<round>\t<reason>` を追記し、stdout に `extended beyond round budget (3)`
- `round-extensions.log` の読み手は `workflow-cli.test.ts:307` のテストと SKILL.md の記述だけ（`git grep` で確認）。列を増やしても壊れるコードは無い
- stamp の台帳照合（`workflow.ts:414-529` `readLedgerSlugsAtOrAfter`）は必須 slug の存在だけを見る。変形検討用に追加の Agent を起動しても stamp は影響を受けない
- テスト: `workflow-cli.test.ts:225-310`（4 本目拒否 / round 3 許可 / pass 後リセット / `--extend` に reason 必須 / `--extend --reason` の log と `--full` 併用）、`workflow-review-core.test.ts:452-475`（通知文言）
- 文書: `rules/workflow.md:39`（5.3 予算）、`.skills/document-workflow-reference/SKILL.md:134, 152-157`（round コマンド説明・ラウンド予算節）、`docs/decisions/0015-...md` Amendment (2026-09-28)

## 既存判断との関係

ADR-0015 Amendment (2026-09-28) は、新しい実質指摘のあった文書の割合が Round 1: 8/8、2: 5/8、3: 3/7、4 以降: 0/4 だったことを根拠に予算 3 を機構化した。受容した限界として「`--extend` の指示元は機械検証しない。log に人間の指示に対応しない reason が 1 件出たら再評価」がある。

- 4 以降の標本は 4 文書と小さい。今回はユーザー判断として自己延長を導入する。この観測は把握したうえで変える、と Amendment に書く
- 既存の再評価トリガーは「`--extend` = 人間の指示」という意味に依存している。自己延長に同じフラグを使うと、このトリガーが雑音になる → フラグと log 上の区別が要る

## 関連する既存機構（問題変形の受け皿）

- `/scope-guard` skill: スコープ過大の分解
- 二層モード（spec + plan-N）への分割
- `round --full`: Key Decisions / 白紙案を変えたときの全員再レビュー
- `rules/model-offloading.md`: Opus メインループでは「高難度の委譲」はメインループで直接、が既定。ただしユーザーはサブエージェントでの検討を明示している
