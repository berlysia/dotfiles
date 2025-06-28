# Config

## Lang: 日本語/English code

## Workflow: Explore→Plan→Code→Commit

## Dev Rules
- Format, clear names, idioms, "why" comments
- Dev time priority, patterns, scripts
- Error handling, parallelization
- Minimal libs, reflect arch, ADRs
- Actions, TDD (t-wada)

## TypeScript: pnpm, biome, oxlint, no `any`, async/await, Vitest

## Security
- **Never**: hardcode secrets, unvalidated input, suppress errors
- **Must**: validate, env vars, logging, lint/test

## Pre-commit: test/lint pass, clear messages

## Tools: similarity-ts, tsg

## Git Workflow
- **Create worktree**: Use `git-worktree-create <branch-name>`
  - Creates worktrees in `.worktrees/` directory at repository root
  - Auto-creates branch if it doesn't exist (from current branch)
  - Uses existing local/remote branches when available
- **Cleanup worktrees**: Use `git-worktree-cleanup`
  - Safely removes finished worktrees with safety checks
  - Skips worktrees with uncommitted changes, unpushed commits, or stashes
  - Automatically prunes after deletion

## Memory: .claude/memory記録