# Development Guidelines

## Language

- Japanese for discussion, English for code

## Workflow

1. Explore → 2. Research (`$DOCUMENT_WORKFLOW_DIR/research.md`) → 3. Plan (`$DOCUMENT_WORKFLOW_DIR/plan.md`) → 4. Review (auto) → 5. Approve (human only) → 6. Implement → 7. Commit

Design decisions (API/architecture/data model changes) or 3+ step tasks **require Document Workflow**. See `@~/.claude/rules/workflow.md`.

## Key Commands

- **Test**: `pnpm test`
- **Typecheck**: `pnpm typecheck`
- **Lint**: `pnpm lint`
- **Worktree**: `git-worktree-create <branch>`, `git-worktree-cleanup`
- **Temp files**: `${projectRoot}/.tmp` (gitignored)

## Rules (auto-loaded by path match)

- `@~/.claude/rules/workflow.md` — Task routing, Document Workflow, Scope Guard, completion protocol
- `@~/.claude/rules/code-quality.md` — Naming, comments, error handling, testing, security, architecture
- `@~/.claude/rules/developer-experience.md` — Tool selection, decisions, knowledge management, commit standards
- `@~/.claude/rules/debugging.md` — Emergency checklist, root cause analysis, 5 Whys
- `@~/.claude/rules/typescript-new-project.md` — New TS project tooling standards
- `@~/.claude/rules/external-review.md` — Logic validation, external review, claude-code-guide usage

## Prohibitions

- Never implement before plan approval (enforced by `document-workflow-guard` hook)
- Never hardcode secrets or suppress errors
- Never lower user expectations or disable steering unilaterally
- Never change approach mid-task without logic-validator verification
