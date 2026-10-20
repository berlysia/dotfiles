# ADR-0005: Single source of truth for the always-on reviewer set

## Status

accepted

## Context

ADR-0004 で常時必須レビュアーを 4 名に拡張した際、リスト（slug 4 件）が 4 箇所に重複している事実が顕在化した。`workflow.md` の Step 5 の散文、`external-review.md` の責務マップ（slug と日本語責務文）、`plan-review-automation.ts` の reviewer 名の配列と推奨文の配列である。

ADR-0004 は、次回の追加で drift する懸念を Consequences に記録し、SSoT 化を別 ADR で扱う方針を示した。本 ADR はその follow-up。

drift 抑制の判断軸:

- code 1 箇所更新で他が追随すること
- 個人 dotfiles の軽さを保ち、過剰な generation pipeline を避けること
- doc 側の責務マップ（自由文の説明）を磨ける表現自由度を保つこと
- 削除 drift（doc に取り残された slug）も検知すること

## Decision

**Option G**（hook を SSoT、doc は手書き + マーカー + drift 検知テスト）を採用:

- **SSoT**: `plan-review-automation.ts` の `ALWAYS_ON_REVIEWERS` 定数（`{ slug, responsibility }` の配列）。reviewer 名の配列と推奨文の配列はこの定数から派生させる
- **doc 側**: `workflow.md` と `external-review.md` の常時必須リスト記述箇所に `<!-- ssot:always-on-reviewers:start -->` 〜 `<!-- ssot:always-on-reviewers:end -->` マーカーを挿入する。doc は手書きを保つ
- **drift 検知**: 両 doc のマーカー区間内の slug 集合が、定数の slug 集合と完全一致することをテストで検査する（追加・削除・差し替えのすべてが fail になる）。派生した推奨文が元の配列と逐字で一致することも検査し、em-dash・空白・番号書式の drift を拾う
- **運用**: reviewer を足す・外す・替えるときは定数だけを変える。doc 側の不一致はテストの失敗が知らせるので、それを doc 更新の trigger にする。これで、code の変更が doc の変更を強制する依存方向になる

### マーカー規約のスコープ

`<!-- ssot:*:start/end -->` マーカーは **コードが消費する slug 識別子** の SSoT 区間にのみ使用する。prose（責務文の自由記述、説明本文）の同期には使わない。これにより、マーカーが doc 全体に蔓延する pattern overuse を予防する。

責務マップの表現粒度:

- code 内 `responsibility`: 英語、agent への instruction（推奨文の出力に使う agent-tool contract）
- doc 内責務文: 日本語、人間向け解説。表現は手書きで磨いて良い

両者は SSoT 化対象外。slug 集合のみが drift 検知対象。

## 却下した代替案

- **Option B/E (YAML SSoT、E は build 時 codegen の variant)**: reviewer の少数性 (4 件) で YAML 規模メリットが出ず、責務マップ自由文の表現自由度が落ちる。chezmoi apply サイクルを伴う編集ループが Option G より保守性で劣後。既存の `claude_skills.yaml` / `claude_plugins.yaml` とは整合する
- **Option A (生成スクリプト)**: doc に「触ってはいけない」領域ができ、責務マップの表現を磨くたびに code 編集が必要
- **Option C (doc SSoT)**: 依存方向が runtime code → doc になり権威性が逆転。doc parser の脆さも問題
- **Option D (放置 + checklist)**: ADR-0004 で問題視した drift がそのまま残る
- **責務文も SSoT 化**: 表現粒度（英語 instruction vs 日本語解説）が異なるため、一致を強制すると両方の表現が痩せる

## Consequences

- **drift 抑制**: reviewer 追加/削除時の編集箇所は `ALWAYS_ON_REVIEWERS` 1 箇所。doc 2 箇所への漏れは drift detection テストが loud failure として検知（silent passing なし）
- **責務マップの表現自由度**: doc 側日本語責務文と code 側英語 responsibility は独立に磨ける。drift detection は slug のみを assert
- **テストの architectural boundary 越境**: `plan-review-automation.test.ts` が初めて `home/dot_claude/rules/*.md` を読む integration test 性質を持つ。doc が移動/リネームされるとテスト fail。専用 describe block で boundary を明示し、doc パスを describe 内定数 `RULES_DIR` で単一編集点化
- **マーカーの pattern overuse 予防**: 本 ADR でマーカー規約を「コード消費される slug 識別子の SSoT 区間に限定」と明示。将来別箇所で SSoT 化したい場合は本 ADR の規約を参照
- **chezmoi 既存パターンとの divergence**: `chezmoidata` YAML は deployment installation manifest としての位置づけで、runtime constants の SSoT には適さない。本選択は規模 (4 件) と責務文表現自由度の判断に基づく。将来 reviewer が大幅に増えた場合や rules/\*.md 全体の template 化が独立に進んだ場合は再検討の余地あり

## References

- ADR-0004 Consequences: 本 ADR のトリガー
- 関連 ADR: ADR-0001 (Document Workflow), ADR-0003 (Document Workflow Guard enforce)
