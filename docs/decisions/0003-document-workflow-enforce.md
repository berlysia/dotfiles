# ADR-0003: Document Workflow Guard enforce mode migration

## Status

accepted

## Context

Document Workflow Guard was introduced in ADR-0001 with `DOCUMENT_WORKFLOW_WARN_ONLY=1` for a staged rollout. The guard prevents implementation before plan approval by intercepting Write/Edit/Bash tool calls.

Migration criteria were: no false positives observed during warn-only period.

## Analysis

- The guard has been in warn-only mode since initial deployment (session 2b557062, 2026-03-09)
- `[would-block]` messages were output to stderr via `console.error()` but were not persisted to any log file, making retrospective analysis impossible
- Unit tests (19 cases) pass fully, covering: pending/approved plans, auto-review marker validation, hash verification, Bash write detection, session-specific workflow directories, and warn-only mode
- A test environment issue was discovered: `DOCUMENT_WORKFLOW_DIR` env var leaks from Claude Code sessions into `node --test`, causing 8 test failures. Fixed by clearing the env var in `beforeEach`
- The guard logic is well-tested and the implementation is sound

## Decision

Migrate to enforce mode by removing `DOCUMENT_WORKFLOW_WARN_ONLY=1` from the hook command in `.settings.hooks.json.tmpl`.

Keep the `DOCUMENT_WORKFLOW_WARN_ONLY` code path in the implementation for future staged rollouts of other projects.

## Consequences

- Plan-unapproved implementations will be blocked (deny response) instead of warned
- The `DOCUMENT_WORKFLOW_WARN_ONLY` env var can still be used for temporary debugging
- New sessions will pick up enforce mode after `chezmoi apply`
