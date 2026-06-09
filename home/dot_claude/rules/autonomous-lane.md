# Autonomous Lane Charter（自律 push レーン憲章）

## 位置づけ

起動軸（`@~/.claude/rules/workflow.md` の「起動軸（initiation: pull / push）」小節）における **push レーンの安全境界** を定義する。push レーンの住所は **CI/cron のみ**。ローカル対話 session 内の自律実行は恒久的に非提供（`document-workflow-guard` の盲点増幅を避ける）。出力は必ず PR であり、無人実行・有人（または auto-merge）ゲートを課す。

設計記録: `docs/decisions/0011-autonomous-lane-charter.md`

## Charter 不変条件（全 AND）

- **C1 型ホワイトリスト**: 実行対象は事前宣言したタスク**型**のみ。汎用 triviality 判定器（「これは trivial だから自律してよい」を実行時に判定する機構）は禁止。誤分類リスクが非対称（false-autonomous = 設計判断の無人実行で高コスト / false-gated = ただの摩擦で安い）であり、CI レーンには `document-workflow-guard` のバックストップが無いため。
- **C2 可逆性**: 出力は必ず PR への push。force-push・無人 merge は禁止。人間または auto-merge が最終ゲート。
- **C3 設計面非接触**: 以下のいずれかに触れる兆候を検出したら実行を中断し、エスカレーション（PR コメントまたは Issue 化）して人間 pull に戻す:
  - `docs/decisions/` 配下の変更
  - 公開 API シグネチャの変更
  - データモデル型の変更
  - `rules/workflow.md` 自身（routing 表を含む）の変更

  判定不能の場合は fail-safe で「実行しない側」に倒す。

## Phase 1 の限界（accepted limitation）

C2「無人 merge 禁止」/ C3「設計面非接触」は、現状 **CI プロンプト内の指示（honor-system prompt control）** であって機構的強制ではない。`auto-fix-dependencies.yml` の `permissions:`（`contents: write` / `pull-requests: write`）と `claude_args` の `--allowed-tools`（`Bash(gh *)` 等）の範囲では `gh pr merge` は技術的に実行可能であり、設計面接触の検出は agent の自己判定に依存する。この限界を Phase 1 の accepted limitation として記録し、mechanical gate 化を Phase 2 hardening（下記）とする。

## 防御層（charter メンバーが備えるべき層）

既存 `.github/workflows/auto-fix-dependencies.yml` を reference 実例とする。参照は stable identifier（step 名 / YAML キー名）で行う:

| 防御層             | 既存 workflow の対応                                                                      | 何を防ぐか                                         | 何を防がないか                                                            |
| ------------------ | ----------------------------------------------------------------------------------------- | -------------------------------------------------- | ------------------------------------------------------------------------- |
| author provenance  | `pr-info` step の `isBot` 判定 + `sameRepo && !isFork` 除外、`allowed_bots` キー          | 信頼できない第三者 / fork が起動者になること       | **PR の diff / lockfile / README 内容経由の prompt injection は防がない** |
| credential hygiene | `persist-credentials: false` + `environment: claude-autofix`（environment-scoped secret） | checkout への credential 混入、secret スコープ越境 | agent が tool 経由で secret を能動的に持ち出すこと（exfiltration）        |
| supply-chain       | action の `@<SHA>` pin（改変禁止）                                                        | action 供給チェーン汚染                            | 依存 install 時の postinstall script 実行                                 |
| concurrency        | `concurrency` キー（`head_sha` 単位）                                                     | 重複実行                                           | —                                                                         |

## Named invariant: allowlist は injection を防がない（最重要）

防御層表の「何を防がないか」列が示す通り、author allowlist は「**誰が PR を開いたか**」しか証明せず、agent が処理する**コンテンツの安全性は保証しない**。auto-fix 型（bot PR の CI 修正）で injection 面が実質的に閉じているのは**型の狭さ**によるのであって、allowlist の効果ではない。

- 現 Phase 1 メンバーですら content は完全には信頼できない: Renovate/Dependabot PR の lockfile・changelog・README は**上流パッケージ経由で部分的に攻撃者影響下**にあり、agent が CI 失敗調査でそれらを読む経路がある。型の狭さは injection 面を縮小するが content-safe を意味しない。
- **型拡張時の義務**: 新しい型が untrusted content を agent に読ませるなら、injection・exfiltration・supply-chain を **CI-side の非 prompt gate**（プロンプト指示ではない機構）で別途閉じること。

## Charter メンバー（Phase 1）

| 型                     | workflow                                      | 説明                                                                                                                                           |
| ---------------------- | --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| 依存 bot PR の CI 修正 | `.github/workflows/auto-fix-dependencies.yml` | `workflow_run`（CI Status Check failure）反応型。bot author（`allowed_bots`）の PR のみ対象。修正を commit/push し、merge は auto-merge に委譲 |

Phase 1 はこの 1 型のみ。新規自律型の追加・能動 discovery 心臓（cron triage）は Phase 2 以降。

**Phase 2 移行トリガー**: format 自動修正 / knip dead-code 削除 等の新規自律型候補が実際に発生した時点。型ごとに C1/C2/C3 適合 + injection 面評価（上記 named invariant）をして個別追加する。

## Phase 2 hardening（記録のみ、Phase 1 では実装しない）

- **C2 の mechanical gate 化**: branch protection / required review による merge 阻止。**design constraint**: 自律 identity は自身の PR の required review を満たせない（別 identity / 人間のみが approve 可）構成にする。現 workflow の `pull-requests: write` + `Bash(gh *)` は `gh pr review --approve` を許すため、この constraint なしでは self-approve で bypass される。
- **C3 の mechanical gate 化**: `git diff --name-only` を設計面パス blocklist と突合して push 前に fail させる CI step。blocklist には `docs/decisions/`・公開 API シグネチャ該当パスと同列で、**永続データ/状態ファイルのパス**（`lessons-learned.md` / `off-plan-writes.log` / `plan-review.cache.json` 等）を明示列挙する。C3 の汎称「データモデル型変更」だけではこれらへの破壊的変更を捕捉する粒度が不足するため。

## エスカレーション経路

C3 トリガー検出時: 実行を中断 → 当該 PR にコメントまたは Issue を作成して検出内容を記録 → 人間 pull（`@~/.claude/rules/workflow.md` の routing 表）に戻す。自律レーン内での「続行判断」は行わない。
