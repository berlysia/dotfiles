# plan-N の承認の委任 (2026-10-06)

人間が spec の承認時に選ぶと、spec の `## Scope` に収まる plan-N が個別の承認なしで実装へ進むようにした変更の記録。設計判断は `docs/decisions/0028-plan-delegation.md`。

- `research.md` — 承認機構の現状、直近 7 日の承認記録の集計、3 つの場面（plan-N の事前委任、改訂後の再承認、離席中の先行）の調査
- `spec.md` — 設計判断 K1 から K9、Risks、レビュー 3 ラウンドの Reviewer Outputs。K の番号は ADR-0028 のものと途中からずれる（対応は ADR の「spec からの差」）
- `plan-1.md` — 承認記録の `delegate`、`## Scope` の照合、保護対象、gate の `classifyPlan`
- `plan-2.md` — 承認の質問の 2 問目、通知、tripwire。「spec との関係」に、spec より厳しくした点と spec に無い決定がある
- `plan-3.md` — ADR-0028 と文書の更新

状態: 実装済み。ブランチは `feat/plan-delegation`。

注記: ここに置いた spec と plan は `.tmp/sessions/bf699e4a` からの凍結コピーで、`## Approval` と `<!-- auto-review -->` marker は承認時点の値である。整形で本文が変わると、marker の hash は現在の本文と一致しなくなる。ゲート判定に使われる文書ではない（workflow dir の外）。

今回着手しなかった場面（改訂後の再承認の省略、離席中の先行）の調査は `research.md` に残っている。
