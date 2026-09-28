# Research: 追加レビュアーのカタログと plugin 宣言の修正

## オーダー

前オーダー（検証フェーズの緩和、`docs/plans/workflow-review-budget/`）で別件として残した「`REVIEWER_CATALOG` が存在しない agent を指している」件を直す。ユーザー判断: plugin 宣言は「A: 宣言を直す（compound-engineering を正しい marketplace 名で入れ、存在しない clarify を外す）」。

## 観測

### O1. カタログの参照先は plugin を入れても存在しない

- `home/dot_claude/hooks/lib/workflow-review-core.ts:137-285` の `REVIEWER_CATALOG` のうち 5 件が `compound-engineering:review:{architecture-strategist,security-sentinel,data-integrity-guardian,performance-oracle,code-simplicity-reviewer}`
- compound-engineering の現行版（marketplace clone `~/.claude/plugins/marketplaces/compound-engineering-plugin`、HEAD 4fbabcd 2026-09-22）は top-level の `agents/` を持たない。上記のうち 4 件は `skills/ce-plan/references/agents/*.md` / `skills/ce-compound/references/agents/*.md`（skill 内部の参照資料で、subagent_type として登録されない）にあり、`code-simplicity-reviewer` は存在しない
- したがって plugin 宣言を直しても `compound-engineering:review:*` は Agent tool から起動できない。実運用ではモデルがローカル agent で代用し、代用 agent は `reviewer-run-recorder` の `REVIEWER_SLUGS`（カタログの bare slug から導出、`implementations/reviewer-run-recorder.ts:46-50`）に無いため台帳に記録されない（前オーダーの集計で 4 セッション分、差分が厳密一致）

### O2. ローカルに対応する agent（すべて `model: sonnet`、`home/dot_claude/agents/`）

| カタログ（現）           | ローカル候補                                                       | 対応の根拠（agent description）     |
| ------------------------ | ------------------------------------------------------------------ | ----------------------------------- |
| architecture-strategist  | `architecture-boundary-analyzer`                                   | 境界・依存方向・結合の評価          |
| security-sentinel        | `security-vulnerability-analyzer`                                  | 脆弱性・入力検証・認証              |
| data-integrity-guardian  | `data-contract-evolution-evaluator`                                | API / schema 変更の互換性と移行戦略 |
| performance-oracle       | 無し                                                               | —                                   |
| code-simplicity-reviewer | 無し（`code-complexity-analyzer` は指標計測で YAGNI 判定ではない） | —                                   |

`resilience-analyzer` / `test-quality-evaluator` / `deployment-readiness-evaluator` はすでにローカル slug。

### O3. plugin 宣言が 2 件壊れている

- `home/.chezmoidata/claude_plugins.yaml:7-8` は marketplace を `name: every-marketplace` で宣言し、plugin を `compound-engineering@every-marketplace` とする。登録済み marketplace の実名は `compound-engineering-plugin`（`claude plugin marketplace list --json`、manifest `.claude-plugin/marketplace.json` の `name`）。plugin 名は `compound-engineering`
- install script（`home/.chezmoiscripts/run_onchange_install-claude-plugins-8.sh.tmpl`）は marketplace の登録済み判定を `name` で行い、plugin の導入済み判定を id で行う。名前違いのため毎回「未登録」と判定して add を試み、plugin install は失敗して continue している
- `clarify@kuu-marketplace`: kuu-marketplace の manifest に `clarify` は無い（`deslop` / `dig` / `fix-ci` ほか）。手元の `clarify` skill は plugin 由来ではない
- 除去は script の Step 3（履歴ファイル `~/.claude/.managed-plugins-installed` との差分で uninstall、失敗は continue）で処理される。clarify は未インストールなので uninstall は失敗ログを 1 回出して続行する

### O4. 参照箇所

- コード: `lib/workflow-review-core.ts`（カタログ）、`implementations/reviewer-run-recorder.ts:42`（コメントの例）
- テスト: `tests/unit/workflow-review-core.test.ts:123-129, 295-302, 409-426, 440, 451`、`tests/unit/plan-review-automation.test.ts:192-313`、`tests/unit/reviewer-run-recorder.test.ts:25, 52, 59`。`tests/unit/workflow-cli.test.ts:120`（plugin prefix の正規化テスト）と `:477`（任意の非必須 slug の verdict 解析）は slug 名に依存しない汎用テストで変更不要
- 文書: `home/dot_claude/rules/external-review.md:77`（追加レビュアー一覧）、`.skills/decision-quality-review/SKILL.md:90`、`.skills/document-workflow-reference/SKILL.md:144`（例示）、ADR-0015 の 2026-09-28 Amendment（別件の記述）
- 過去の ADR（0004 / 0006 / 0010 / 0012 / 0015 本文）の言及は当時の記録なので書き換えない
