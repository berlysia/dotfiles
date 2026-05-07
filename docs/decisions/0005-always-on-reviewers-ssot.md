# ADR-0005: Single source of truth for the always-on reviewer set

## Status

accepted

## Context

ADR-0004 で常時必須レビュアーを 4 名に拡張した際、リストが以下の 4 箇所に重複している事実が顕在化した:

1. `home/dot_claude/rules/workflow.md` Step 5 の散文（slug 4 件）
2. `home/dot_claude/rules/external-review.md` の責務マップ（slug 4 件 + 日本語責務文）
3. `home/dot_claude/hooks/implementations/plan-review-automation.ts` の `allReviewerNames` 配列（slug 4 件）
4. 同 `alwaysOnLines` 配列（slug 4 件 + 英語責務 1 行）

ADR-0004 Consequences で「次回追加/差し替え時に drift する懸念がある」と記録され、SSoT 化を別 ADR で扱う方針が示された。本 ADR はその follow-up。

drift 抑制の判断軸:

- code 1 箇所更新で他が追随すること
- 個人 dotfiles の軽さを保ち、過剰な generation pipeline を避けること
- doc 側の責務マップ（自由文の説明）を磨ける表現自由度を保つこと
- 削除 drift（doc に取り残された slug）も検知すること

## Analysis

検討した 7 つの案（research に詳細）:

- **A**: hook を SSoT、doc 生成スクリプトで自動生成
- **B**: chezmoidata YAML を SSoT、hook も doc も読む
- **C**: doc を SSoT、hook テストで parse 検証
- **D**: 重複放置 + checklist 運用カバー
- **E**: B の variant（build 時 codegen）
- **G**: hook を SSoT、doc は手書き、マーカー + drift 検知テスト

YAML SSoT (B/E) は既存の `claude_skills.yaml` / `claude_plugins.yaml` パターンと整合するが、本ケースの reviewer は 4 件と少数で YAML 規模メリットが出ない。さらに doc 側の責務マップは日本語自由文（読み手向け説明）であり、YAML 化すると表現の自由度が痩せる。chezmoi apply のサイクルを伴う編集ループも保守性で劣後する。

A (生成スクリプト) は doc に「触ってはいけない」領域を作り、責務マップの表現を磨くたびに code 編集が必要になる。

C (doc SSoT) は依存方向が逆転（実際に動く code が doc に従属）し、doc parser の脆さも問題。

D (放置) は ADR-0004 で問題視した drift がそのまま残る。

## Decision

**Option G** を採用:

- **SSoT**: `home/dot_claude/hooks/implementations/plan-review-automation.ts` の `ALWAYS_ON_REVIEWERS` 定数（`{ slug, responsibility }` 配列を `as const satisfies` で宣言）
- **派生**: `allReviewerNames` と `alwaysOnLines` を `ALWAYS_ON_REVIEWERS.map(...)` で生成
- **doc 側**: `workflow.md` および `external-review.md` の常時必須リスト記述箇所に `<!-- ssot:always-on-reviewers:start -->` 〜 `<!-- ssot:always-on-reviewers:end -->` マーカーを挿入（doc は手書きを保つ）
- **drift 検知**: `plan-review-automation.test.ts` の新規 describe block `doc drift detection (integration boundary)` で、両 doc のマーカー区間内 slug 集合と `ALWAYS_ON_REVIEWERS` slug 集合が完全一致することを assert
- **派生の逐字一致**: 新規 describe block `ALWAYS_ON_REVIEWERS derivation` で、`alwaysOnLines` 派生結果と hardcode 配列が `deepStrictEqual` で完全一致することを assert（em-dash・空白・番号フォーマットの drift 検知）

### マーカー規約のスコープ

`<!-- ssot:*:start/end -->` マーカーは **コードが消費する slug 識別子** の SSoT 区間にのみ使用する。prose（責務文の自由記述、説明本文）の同期には使わない。これにより、マーカーが doc 全体に蔓延する pattern overuse を予防する。

責務マップの表現粒度:

- code 内 `responsibility`: 英語、agent への instruction（`buildRecommendation()` 出力に使う agent-tool contract）
- doc 内責務文: 日本語、人間向け解説。表現は手書きで磨いて良い

両者は SSoT 化対象外。slug 集合のみが drift 検知対象。

### 運用フロー（reviewer 追加/削除/差し替え時）

1. `ALWAYS_ON_REVIEWERS` 定数に変更を加える（追加/削除/責務文修正）
2. `bun run test` を実行 → drift detection テストが doc 側の不一致で fail
3. fail メッセージに従って `workflow.md` および `external-review.md` のマーカー区間内 slug を更新
4. テスト pass を再確認
5. 必要なら doc 側の責務文（日本語）を併せて手書きで磨く（drift test は感知しない）

`bun run test` の失敗を doc 更新の trigger として明示的に活用する。これにより、code 変更が doc 変更を強制する依存方向が確立する。

## Rejected alternatives

- **Option B/E (YAML SSoT)**: reviewer の少数性 (4 件) で YAML 規模メリットが出ず、責務マップ自由文の表現自由度が落ちる。chezmoi apply サイクルを伴う編集ループが Option G より保守性で劣後
- **Option A (生成スクリプト)**: doc に「触ってはいけない」領域ができ、責務マップの表現を磨くたびに code 編集が必要
- **Option C (doc SSoT)**: 依存方向が runtime code → doc になり権威性が逆転。doc parser の脆さも問題
- **Option D (放置 + checklist)**: ADR-0004 で問題視した drift がそのまま残る
- **責務文も SSoT 化**: 表現粒度（英語 instruction vs 日本語解説）が異なるため、一致を強制すると両方の表現が痩せる

## Consequences

- **drift 抑制**: reviewer 追加/削除時の編集箇所は `ALWAYS_ON_REVIEWERS` 1 箇所。doc 2 箇所への漏れは drift detection テストが loud failure として検知（silent passing なし）
- **削除 drift も検知**: マーカー区間内 slug 集合と定数 slug 集合の **双方向 deepStrictEqual** により、追加・削除・差し替えのすべてが test fail で表面化
- **責務マップの表現自由度**: doc 側日本語責務文と code 側英語 responsibility は独立に磨ける。drift detection は slug のみを assert
- **テストの architectural boundary 越境**: `plan-review-automation.test.ts` が初めて `home/dot_claude/rules/*.md` を読む integration test 性質を持つ。doc が移動/リネームされるとテスト fail。専用 describe block で boundary を明示し、doc パスを describe 内定数 `RULES_DIR` で単一編集点化
- **マーカーの pattern overuse 予防**: 本 ADR でマーカー規約を「コード消費される slug 識別子の SSoT 区間に限定」と明示。将来別箇所で SSoT 化したい場合は本 ADR の規約を参照
- **chezmoi 既存パターンとの divergence**: `chezmoidata` YAML は deployment installation manifest としての位置づけで、runtime constants の SSoT には適さない。本選択は規模 (4 件) と責務文表現自由度の判断に基づく将来 reviewer が大幅に増えた場合や rules/\*.md 全体の template 化が独立に進んだ場合は再検討の余地あり

## References

- ADR-0004 (`docs/decisions/0004-greenfield-perspective-reviewer.md`) Consequences: 本 ADR のトリガー
- 関連 ADR: ADR-0001 (Document Workflow), ADR-0003 (Document Workflow Guard enforce)
- 実装ファイル:
  - `home/dot_claude/hooks/implementations/plan-review-automation.ts` (`ALWAYS_ON_REVIEWERS` 定数、派生関数化)
  - `home/dot_claude/hooks/tests/unit/plan-review-automation.test.ts` (`ALWAYS_ON_REVIEWERS derivation`, `doc drift detection (integration boundary)` describe block)
  - `home/dot_claude/rules/workflow.md` (Step 5 SSoT 区間)
  - `home/dot_claude/rules/external-review.md` (常時必須レビュアー責務マップ SSoT 区間)
