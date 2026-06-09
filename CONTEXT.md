<!--
このプロジェクト (dotfiles, solo) では canonical CONTEXT.md として root の `CONTEXT.md` に commit 対象として配置し、
`.tmp/docs/CONTEXT.md` から symlink で参照する。AI の Read 経路は spec 通り `.tmp/docs/CONTEXT.md`。

他プロジェクト (team / OSS / client) で本機構を適用する場合は `.tmp/docs/CONTEXT.md` (gitignored) のみが正しい運用で、
canonical 化はしてはならない。デフォルトは personal-only、本リポジトリのみ dog-food として canonical 化している例外。

機密 path (`.env*`, `secrets/`, `~/.ssh/` 等) は本ファイル内の `@path` 参照に含めないこと。
AI が follow した際に機密が context に取り込まれるリスク (R6) を回避するため (canonical / personal 共通)。

仕様: `~/.claude/rules/context-md.md`
ADR: `docs/decisions/0010-context-md-mechanism.md`
-->

# Project CONTEXT (personal) — dotfiles

このプロジェクトは chezmoi 管理の dotfiles リポジトリ。CONTEXT.md 機構 (ADR-0010) の最初の利用者として、eat-your-own-dog-food 検証を兼ねる。

## Authoritative references

- @docs/decisions/ — 全 ADR (0001-0010)。Document Workflow / hooks 体系 / レビュアー SSoT / mechanical-lane / CONTEXT.md 機構
- @CLAUDE.md — このプロジェクト固有 CLAUDE.md (chezmoi / hooks / skills 管理規約)
- @home/dot_claude/CLAUDE.md — グローバル CLAUDE.md (デプロイ先 `~/.claude/CLAUDE.md`)
- @home/dot_claude/rules/workflow.md — Document Workflow Protocol、Task Routing、Session Artifact Retention
- @home/dot_claude/rules/context-md.md — CONTEXT.md 機構の仕様 SSoT
- @home/dot_claude/rules/code-quality.md — naming / 関数型ドメインモデリング / セキュリティ
- @home/dot_claude/rules/developer-experience.md — git worktree convention、commit standards
- @home/dot_claude/rules/external-review.md — logic-validator / Codex review の使い分け
- @home/.chezmoiscripts/run_after_gc.sh.tmpl — GC スクリプト (R3/K4 の SAFE pattern 根拠)

## Personal observations

### Document Workflow 用語

- **モード判定**: `plan.md-only` (3-5 step + 単一判断) / `spec + plan-N` (3-5 step + 複数判断 OR 6+ step OR 複数サブシステム) / `mechanical-lane` (4 条件 AND で plan.md-only に縮約、ADR-0009)
- **三状態承認**: 各成果物は `Plan Status` (draft/complete) + `Review Status` (pending/pass/needs-work/blocker) + `Approval Status` (pending/approved、人間のみ) の三状態を満たすと実装可能
- **hash 機構**:
  - `auto-review hash`: 成果物全体のハッシュ (marker と実ファイルの照合)
  - `design-hash`: Key Decisions / Files / Tasks セクションのみのハッシュ (carry-forward 判定)
  - `parent-spec-hash`: plan-N.md が指す spec.md のハッシュ (K7 連鎖検証)
- **K7 連鎖検証**: `document-workflow-guard` hook が実装系書き込み時に (a) spec.md 三状態 + hash 一致、(b) 対象ファイルが属する plan-N.md 三状態 + hash 一致、(c) plan-N.md の parent-spec-hash と現 spec.md hash 一致、を検証。いずれか欠けると conservative deny
- **off-plan-writes 緩和**: 実装フェーズで Files セクション外への書き込みが、spec + plan の三状態 + hash 一致を満たしていれば deny ではなく warn + `<wfDir>/off-plan-writes.log` に降格
- **carry-forward (prescribed-fix)**: (a) 文言精度クラスの修正 + (b) reviewer verbatim 指定 + (c) section-scoped design-hash 不変、の 3 条件 AND 成立時のみ再レビュー省略
- **Reviewer Outputs (Round N)**: workflow.md 5.1 で MANDATORY、各 reviewer の verdict + 主指摘 1-2 文を auto-review marker 直前に追記。lessons-learned-extractor の入力主経路
- **intent triage**: workflow.md step 6 で MANDATORY、divergent (本義を歪める指摘) を除外。「未実装機能のリスク対策」「dominant axis を勝手に変える」「先回り対応」が divergent の典型パターン
- **常時必須レビュアー (層別)**:
  - spec 層 4 名: logic-validator + scope-justification-reviewer + decision-quality-reviewer + greenfield-perspective-reviewer
  - plan 層 2 名 + コンテンツベース: logic-validator + scope-justification-reviewer + content-selected (architecture-strategist / security-sentinel / data-integrity-guardian / test-quality-evaluator / 等から最大 3 名)
  - SSoT は `plan-review-automation.ts` の `SPEC_REVIEWERS` / `PLAN_REVIEWERS` 定数

### Chezmoi 用語

- **`.chezmoiroot`**: リポジトリルートに `home` と記載、chezmoi source state は `${projectRoot}/home/` 配下
- **ファイル名変換**: `dot_*` → `.*` / `private_*` → permission 600 / `.tmpl` → Go template (deploy 時に拡張子 strip、e.g. `context.md.tmpl` → `~/.claude/templates/context.md`)
- **`.tmp/` 配下のスコープ**:
  - `.tmp/sessions/` — GC 対象 (7日)、Document Workflow セッション中作業領域
  - `.tmp/docs/` — GC 対象外、永続。本 CONTEXT.md と WIP docs の置き場
  - 全体 gitignored

### Hooks 体系

- `~/.claude/hooks/implementations/` 配下に約 26 個の TypeScript hook
- bun で絶対パス実行 (`bun ~/.claude/hooks/implementations/*.ts`)
- 主要依存: `cc-hooks-ts` (フック定義ヘルパー) / `@anthropic-ai/claude-agent-sdk` (LLM 評価)
- 主要 hook: `document-workflow-guard` / `plan-review-automation` / `permission-auto-approve` / `lessons-learned-extractor`

### GC スクリプト (R3/K4 根拠)

- `home/.chezmoiscripts/run_after_gc.sh.tmpl`
- 動作 3 段階: (1) `.tmp/sessions/` 7日 GC (SAFE pattern: `SESSIONS_DIR` hardcoded + `find -mindepth 1 -maxdepth 1 -type d -mtime +7`) / (2) CLAUDE.md path integrity check (`@~/`, `${projectRoot}/` パスの存在確認) / (3) knip dead code 検出
- `.tmp/docs/` は構造的に対象外 (SAFE pattern (a))

## Open questions

- **ADR-0010 Defer 節 5 項目の優先順位**: grill skill (Socratic 質問発火による未定義語検出) が次に自然な拡張だが、context-audit (R1 参照腐敗の検出) も実害が薄いわりに価値が高い。実運用で先に困る方を優先するのが筋
- **`.tmpl` 規約棚卸しの timing**: `templates/spec.md` / `plan-execution.md` は literal copy 用なのに拡張子なし、本件 `context.md.tmpl` だけ `.tmpl` を採用した理由を後日整理する必要 (architecture-strategist の F-A1 residual note 由来)
- **mechanical-lane criteria の運用実績**: ADR-0009 導入後の使用頻度と誤判定発生率を観測したい (運用ログから measurable proxy が取れるか未確認)
- **CONTEXT.md maturity の measurable proxy**: `docs/decisions/` の ADR 数 / CLAUDE.md の定義語数 / 本ファイル内の定義語数、のいずれが maturity の代理指標として適切か (会話で言及した仮説の検証)
