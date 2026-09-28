# Research: Document Workflow 検証フェーズのコスト緩和

## オーダー

「Document Workflow の手順はいいが、検証フェーズが長く高コストすぎる。うまいバランスに緩和したい」。
方向確認の回答: **A（ラウンド数を減らす。1 回のレビューの厚みは保つ）** + 「コーディングでない時に不要なレビュアーを呼んでいるのも気になる」。

制約: 手順（round / stamp / triage / Executive Summary / 人間承認）は残す。緩めるのは強度。

## 観測データ（N=7 セッション、9 文書。reviewer-runs.log + subagent meta.json + 各文書の Reviewer Outputs）

詳細は集計レポート（`evidence/review-cost-report.md`、他プロジェクト名は匿名化済み）。要点:

### R1. ラウンド歩留まり

| Round | 新規の実質指摘あり |
|---|---|
| R1 | 8/8 |
| R2 | 5/8 |
| R3 | 3/7 |
| R4 | 0/3 |
| R5 | 0/1 |

R4 以降は新規指摘ゼロ。R4 の唯一の needs-work（project-B B2 plan-1）は編集が生んだ記述不整合の手直しで、レビューが新たに見つけたものではない。N は小さい。

### R2. コストの所在

- reviewer は全員 `model: sonnet`（`home/dot_claude/agents/*.md` frontmatter で確認）。reviewer subagent の入力トークンはセッション総コストの概ね 12〜27%（output は transcript 記録欠落で帰属不能）
- 残りの大半はメインループ（Opus）がラウンドごとに reviewer 報告 4〜7 本を読み、文書を直し、`round` / `stamp` / triage を回す部分と推定（直接計測はしていない）。よってコストの支配変数は「ラウンド数」

### R3. ラウンド上限は prompt 統制のみ

- `workflow-review-core.ts` `buildRecommendation` は `roundCount >= 3 && verdict !== pass` で「Do NOT start Round 4 without being told to」を出す（文言のみ）
- `cli/workflow.ts` `cmdRound` にラウンド数の検査は無い（grep で確認）
- 実際に 9 文書中 3 文書が R4 以降に進んだ（A1 ×2 が R4、B2 plan-1 が R5）。A2 は spec が R6（内容欠落のため歩留まり評価外）
- ADR-0015 で「prompt 統制は守られないので機構へ移す」と決めた教訓が、この上限にはまだ適用されていない

### R4. 追加レビュアー（REVIEWER_CATALOG）の選定がコード非依存

- 選定は `selectReviewers`: 文書本文へのキーワード部分一致 1 つで採用、priority 順に最大 3
- 過去 plan の再生（`selectReviewers` を実際に実行）:
  - 85e77cd5（`.skills/pr-description/SKILL.md` 1 ファイルのみ編集）→ architecture[モジュール], security[permission], resilience[timeout|復旧]
  - d4443fb3（SKILL.md 新規 + rules / commands の md 編集のみ）→ architecture[モジュール|依存], security[セキュリティ|トークン]
  - 5a9f74bd（hook の TS 実装）→ architecture, security, data-integrity
- prose のみの変更でもコード品質系レビュアーが推奨される。これがユーザーの言う「コーディングじゃないときに不要なレビュアー」の実体
- 判定材料: plan.md（単層）と plan-N.md は `## Files` に変更対象パスを fenced code block で列挙する（テンプレート `home/dot_claude/templates/plan-execution.md`、guard の `parseFilesSection` が既にパース）。spec.md には Files が無い

### R5. カタログが存在しない agent を指している

- `compound-engineering:review:{architecture-strategist,security-sentinel,data-integrity-guardian,performance-oracle,code-simplicity-reviewer}` を参照
- `home/.chezmoidata/claude_plugins.yaml` に `compound-engineering@every-marketplace` は宣言されているが、`~/.claude/plugins/installed_plugins.json` と cache に無く、Agent tool の subagent 一覧にも無い（未インストール）
- 実運用ではモデルがローカル agent（`security-vulnerability-analyzer` / `architecture-boundary-analyzer`）で代用
- `reviewer-run-recorder.ts` の `REVIEWER_SLUGS` はカタログの bare slug から導出するため、代用 agent の起動は台帳に記録されない（4 セッションで meta.json 実行数 − 台帳行数 = 両 slug の実行数に厳密一致）。stamp はカタログ分を必須にしていないので実害は台帳の欠落のみ

### R6. 追加レビュアーの blocker が全員再実行を引き起こす

- `planRoundReviewers`: 前ラウンドの verdict に blocker が 1 つでもあれば `full`（必須 4 名全員再実行）
- B2 spec: security（追加）の blocker が 3 ラウンド連続 → 毎回必須 4 名が full 再実行 → 最終的に再レビューなしの再 stamp で pass（スコープ確定で解消）。ゲートが迂回された
- blocker の中身はスコープ判断で、ラウンドを重ねても解けない種類だった

### R7. 必須レビュアーの指摘率（参考、今回は変更対象外）

logic-validator 59%（実バグを複数捕捉）、greenfield 32%、scope-justification 11%、decision-quality 9%。低率の 2 名は差分再レビュー（ADR-0015 Amendment 2026-09-24）で R2 以降は carried になるため、削っても節約は小さい。ユーザー回答 A により必須構成は据え置く。

## 関連する既存設計

- ADR-0015 K6 / Amendment 2026-09-24: 差分再レビュー（`planRoundReviewers` を推奨・round 骨格・stamp の共通判定に）
- ADR-0005 / 0006: SPEC_REVIEWERS / PLAN_REVIEWERS の SSoT と drift テスト（`plan-review-automation.test.ts`）
- ADR-0001: 承認は人間のみ（本件で触らない）

## 変更候補の所在

- `home/dot_claude/hooks/lib/workflow-review-core.ts`（`REVIEWER_CATALOG` / `selectReviewers` / `planRoundReviewers` / `buildRecommendation`）
- `home/dot_claude/hooks/cli/workflow.ts`（`cmdRound`）
- `home/dot_claude/hooks/implementations/document-workflow-guard.ts`（`parseFilesSection` を lib へ移すなら）
- `home/dot_claude/rules/workflow.md`、`.skills/document-workflow-reference/SKILL.md`、`docs/decisions/0015-*.md`
- テスト: `tests/unit/workflow-review-core.test.ts` / `workflow-cli.test.ts` / `plan-review-automation.test.ts`
