# Document Workflow overhaul (2026-09-10)

Opus 5 / Fable 5.1 が Document Workflow を低コストで完走できるようにした改修の記録。設計判断は `docs/decisions/0015-document-workflow-operator-ergonomics.md`。

- `research.md` — 26 セッションの横断計測から得た失敗パターン P1〜P8 と根本原因
- `spec.md` — 設計判断 K1〜K10、Risks、レビュー 3 ラウンドの Reviewer Outputs
- `plan-1.md` / `plan-2.md` / `plan-3.md` — 実行層（lib 抽出と診断 deny / Bash 対称化と tripwire / CLI・レビュー経済・stop gate・文書分離）
- `evidence/` — hook 注入テキスト棚卸し、成果物品質監査、コードマップ

状態: 実装済み。コミットは `128e08f` / `2801abb` / `4065170` / `3d599a4`。

注記: ここに置いた spec / plan は `.tmp/sessions/0e299d39` からの凍結コピーで、`## Approval` と `<!-- auto-review -->` marker は承認時点の値である。移送時に冒頭の証拠パス表記を書き換えたため、marker の hash は現在の本文とは一致しない。ゲート判定に使われる文書ではない（wfDir 外）。

受入確認: `node docs/scripts/workflow-session-audit.mjs .tmp/sessions/<id>` を変更後 5 セッションで回し、Reviewer Outputs / intent-triage の欠落 0 を確認する（spec K8）。
