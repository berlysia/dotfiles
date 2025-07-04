# Config

## Lang: 日本語/English code

## Workflow: Explore→Plan→Code→Commit

## Dev Rules
- Format, clear names, idioms, "why" comments
- Dev time priority, patterns, scripts
- Error handling, parallelization
- Minimal libs, reflect arch, ADRs
- TDD (t-wada)

## TypeScript: pnpm, biome, oxlint, no `any`, async/await, Vitest

## Security
- **Never**: hardcode secrets, unvalidated input, suppress errors
- **Must**: validate, env vars, logging, lint/test

## Pre-commit: test/lint pass, clear messages

## Commands
- **mapfile**: Read lines from stdin into array
  - `mapfile -t array < <(command)` - Read command output into array
  - `mapfile -t files < <(find . -name "*.js")` - Store file list in array
- **tee**: Write output to both file and stdout
  - `command | tee file.txt` - Save output to file while displaying
  - `command | tee -a file.txt` - Append to file while displaying
- **similarity-ts**: TypeScript code similarity analysis
  - `similarity-ts src/` - Analyze similarity in TypeScript files
  - `similarity-ts --threshold 0.8 src/` - Custom similarity threshold

## Git Workflow
- **Create worktree**: Use `git-worktree-create <branch-name>`
  - Creates worktrees in `.git/worktree/` directory at repository root
  - Auto-creates branch if it doesn't exist (from current branch)
  - Uses existing local/remote branches when available
- **Cleanup worktrees**: Use `git-worktree-cleanup`
  - Safely removes finished worktrees with safety checks
  - Skips worktrees with uncommitted changes, unpushed commits, or stashes
  - Automatically prunes after deletion

## Memory: .claude/memory記録