# ADR-0001: Document Workflow (Plan Mode非依存)

## Status

Accepted

## Date

2026-02-18

## Context

Claude CodeのPlan ModeはExitPlanMode時に一度しか検証できず、iterative annotationが困難だった。また、Plan Modeは読み取り専用の制約がありDocument Workflow成果物の作成自体ができなかった。

## Decision

Plan Mode に依存しない Document Workflow を採用する。

- セッション開始時に `DOCUMENT_WORKFLOW_DIR` を自動設定（`session.ts` hook）
- `research.md` → `plan.md` → annotation → approval → implementation の流れ
- `plan-review-automation` PostToolUse hookでplan.md更新を自動検知しレビュー実行
- `document-workflow-guard` PreToolUse hookで承認前の実装をブロック
- 承認は人間のみが行う（`Approval Status: approved`）

## Consequences

- セッション間の独立性が向上（各セッションが独自のworkflowディレクトリを持つ）
- Plan Modeは LEGACY として残すが、Document Workflowを推奨
- hookベースの強制により「プロンプトだけに頼る」アンチパターンを回避

## Amended by

- `docs/decisions/0013-workflow-dir-session-derivation.md` (2026-09-04) — 本 ADR が定めた「`session.ts` が `DOCUMENT_WORKFLOW_DIR` を自動設定する」機構は、値が PreToolUse hook まで届かないことが実測で判明した。ADR-0013 は workflow ディレクトリを hook 入力の `session_id` から導出する形へ移し、env を検査付きの override へ降格した。本 ADR の決定は supersede しない（env による pin は引き続き有効で、Bash 向けの `$DOCUMENT_WORKFLOW_DIR` 供給も維持される）
