# Developer Experience Rules

## Tool Selection

Prefer specialized tools over Bash for file operations (Read over `cat`, Grep over `grep`, Edit over `sed`, Glob over `find`). Reserve Bash for execution, builds, and git operations.

## File Discovery

Prefer `git ls-files` over broad Glob patterns to avoid noise from `node_modules/`, `dist/`, etc.

## Proportional Exploration

When the user's problem description already specifies the cause and location, go directly to the fix. Reserve deep exploration for genuinely unclear problems.

## Decision Transparency

When changing approach mid-task:

1. **MUST use logic-validator agent** to verify the reasoning
2. Explain validation results and new plan before proceeding
3. Document why the original approach was abandoned

## Evidence-Based Decisions

Always gather evidence (read files, run tests, check actual state) before making decisions. Use **logic-validator** proactively to catch assumption-based reasoning.

## Structured Decision Requests

```
## Decision Required: [Topic]
**Context:** [Why this decision is needed]
**Options:**
### Option A: [Name]
- Advantages / Disadvantages / Risk level
**Recommendation:** [Option X] because [rationale]
**Your Decision:** Which approach?
```

## Knowledge Management

- WIP docs: `.tmp/docs/` (gitignored)
- Final docs: `docs/` (tracked), `docs/decisions/` (ADRs)
- Use `/verify-doc` for document self-consistency checks
- MEMORY.md: record pitfalls/lessons only, not what's in CLAUDE.md
- Committed docs must only link to git-tracked files

## Git Worktree Convention

- **Path**: Always place worktrees at `<repo-root>/.git/worktree/<branch-name>` (singular `worktree`, inside `.git/` so no gitignore entry is needed)
- **Tools**: Use `git-worktree-create` / `git-worktree-cleanup` (`~/.local/bin/`). Do **not** invoke `git worktree add` directly
- **Prohibited**: Do not use `compound-engineering:git-worktree` skill or any other tool that creates worktrees at `.worktrees/` (repo root) or `.claude/worktrees/` — they conflict with this convention and pollute the repo root

## Git Commit Standards

- Conventional Commit format: `<type>(<scope>): <description>`
- Types: feat, fix, refactor, test, docs, chore, perf, style, build, ci
- Present tense imperative, lowercase, no trailing period
- Commit body follows [Contextual Commits](https://github.com/berserkdisruptors/contextual-commits) — use action lines (`intent`, `decision`, `rejected`, `constraint`, `learned`) to capture reasoning the diff cannot show
- Use `/commit` for complex multi-type changes
