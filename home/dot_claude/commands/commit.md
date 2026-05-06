# /commit

Commits current changes with semantic commit messages. Automatically handles simple and complex scenarios.

## Workflow

```
/commit
    │
    ├─ Check for changes (staged + unstaged)
    │
    ├─ Analyze change complexity
    │   │
    │   ├─ Simple (single purpose) → Direct commit
    │   │   - Generate semantic commit message
    │   │   - Stage and commit
    │   │
    │   └─ Complex (multiple types mixed) → Delegate to /semantic-commit
    │       - Automatic analysis and splitting
    │       - Multiple atomic commits
    │
    └─ Report result
```

## Complexity Detection

**Simple** (handle directly):

- Single file with one type of change
- Multiple files with same purpose (e.g., all feat, all fix)
- Related changes that form one logical unit

> A single file is **not** automatically Simple. If the file contains multiple semantically independent edits (e.g. a bug fix at one location plus an unrelated refactor elsewhere in the same file), treat it as Complex.

**Complex** (delegate to `/semantic-commit`):

- Mixed change types (feat + fix, refactor + test)
- Large refactoring spanning many files
- Changes that should be split for better git history
- **Same-file semantic division**: a single file holds two or more independent purposes (e.g. zero-division fix at L40 plus unrelated logging refactor at L80) — these should land in separate commits via hunk-level staging

## Implementation

### Step 1: Gather Information

```bash
# Check status
git status

# View changes
git diff
git diff --cached

# Check recent commit style
git log --oneline -5
```

### Step 2: Analyze Complexity

Examine the changes and determine:

1. How many distinct purposes are present?
2. Are there mixed change types (feat/fix/refactor/test/docs/chore)?
3. Would splitting improve the git history?

### Step 3: Execute

**If Simple:**

1. Stage all changes: `git add <files>`
2. Generate commit message following CLAUDE.md conventions
3. Commit with semantic message

**If Complex:**

1. Inform user: "Multiple change types detected. Using /semantic-commit for intelligent splitting (it uses git-sequential-stage to split even a single file into hunk-level commits when needed)."
2. Delegate to `/semantic-commit` command

## Commit Message Format

Follow CLAUDE.md conventions:

```
<type>(<scope>): <description>

[optional body - explain WHY, not WHAT]

🤖 Generated with [Claude Code](https://claude.com/claude-code)

Co-Authored-By: Claude <noreply@anthropic.com>
```

### Type Selection

| Type       | Usage                                   |
| ---------- | --------------------------------------- |
| `feat`     | New feature                             |
| `fix`      | Bug fix                                 |
| `refactor` | Code restructuring (no behavior change) |
| `test`     | Test additions/modifications            |
| `docs`     | Documentation                           |
| `chore`    | Maintenance (deps, config)              |
| `perf`     | Performance improvement                 |
| `style`    | Formatting (no logic change)            |
| `build`    | Build system                            |
| `ci`       | CI/CD changes                           |

## Examples

### Simple Case: Single Feature

```
Changes:
- src/auth/login.ts (new login function)
- src/auth/types.ts (new types)

→ Direct commit:
  feat(auth): add login functionality
```

### Simple Case: Bug Fix

```
Changes:
- src/utils/parser.ts (fix null check)

→ Direct commit:
  fix(utils): handle null input in parser
```

### Complex Case: Mixed Types

```
Changes:
- src/auth/login.ts (bug fix)
- src/auth/session.ts (new feature)
- tests/auth.test.ts (new tests)

→ Delegate to /semantic-commit
  "Multiple change types detected (fix, feat, test).
   Delegating to /semantic-commit for intelligent splitting."
```

### Complex Case: Same-File Semantic Division

```
Changes:
- src/parser.ts (zero-division fix near L40 + unrelated logging refactor near L80)

→ Delegate to /semantic-commit
  "Single file holds two independent purposes (fix + refactor).
   Delegating to /semantic-commit so git-sequential-stage can split it into hunk-level commits."
```

## Related

- `/semantic-commit` - Complex change analysis and multi-commit splitting (uses git-sequential-stage for hunk-level division within a single file)
- `/commit-conventions` skill - Detailed guidance for edge cases
