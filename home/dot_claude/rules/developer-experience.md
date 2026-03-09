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

## Git Commit Standards

- Conventional Commit format: `<type>(<scope>): <description>`
- Types: feat, fix, refactor, test, docs, chore, perf, style, build, ci
- Present tense imperative, lowercase, no trailing period
- Use `/commit` for complex multi-type changes
