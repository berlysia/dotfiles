# /semantic-commit

Creates semantically meaningful git commits with intelligent change analysis, automated grouping, and comprehensive workflow management. Use this command when changes need to be split into multiple atomic commits.

## When to Use

This command is typically invoked by `/commit` when it detects complex changes that need splitting. You can also invoke it directly when you know you have mixed change types.

## Description
This command orchestrates the complete commit workflow by coordinating specialized agents to analyze changes, group them semantically, generate conventional commit messages, and execute atomic commits following best practices.

## Core Principles

### Semantic Commits
- **Atomic**: Each commit represents a single, coherent change
- **Meaningful**: Commit messages clearly explain the "why" behind changes
- **Self-contained**: The codebase works after each commit
- **Conventional**: Follow Angular-style commit prefixes (feat, fix, refactor, etc.)

### Atomic Commits Best Practices
- **Single Purpose**: Each commit addresses one specific change or feature
- **Independent**: Commits work independently and don't break the build
- **Reviewable**: Small enough to be understood in code review
- **Logical Progression**: Commit order tells a coherent story

## Implementation

### 1. Four-Phase Workflow

**Phase 1: Preparation**
- Move to repository root using `git rev-parse --show-toplevel`
- Verify repository state with `git status`
- Generate comprehensive diff patch to `.claude/tmp/current_changes.patch`:
  ```bash
  git diff HEAD > .claude/tmp/current_changes.patch
  ```
- Set up working directory

**Phase 2: Analysis**
Execute `change-semantic-analyzer` agent using Task tool:
```
Task(change-semantic-analyzer):
  - Parse git diff and identify all hunks
  - Group changes by semantic purpose
  - Classify change types (feat/fix/refactor/etc.)
  - Propose logical commit boundaries
  - Generate git-sequential-stage commands
```

**Phase 3: Execution** (Iterative)
For each proposed commit group:

1. **Selective Staging**: Execute git-sequential-stage command from analyzer
   ```bash
   git-sequential-stage -patch=".claude/tmp/current_changes.patch" \
     -hunk="file1.ts:1,3,5" -hunk="file2.ts:2"
   ```

2. **Message Generation**: Execute `commit-message-generator` agent using Task tool:
   ```
   Task(commit-message-generator):
     - Analyze staged changes
     - Generate conventional commit message
     - Include type, scope, description
     - Add optional body and attribution
   ```

3. **Commit Execution**: Execute git commit with generated message
   ```bash
   git commit -m "$(cat <<'EOF'
   type(scope): description

   [optional body]

   🤖 Generated with [Claude Code](https://claude.com/claude-code)

   Co-Authored-By: Claude <noreply@anthropic.com>
   EOF
   )"
   ```

4. **Hook Handling**: Handle pre-commit hook modifications if needed

5. **Diff Update**: Regenerate patch for next iteration

**Phase 4: Verification**
- Confirm all changes are committed with `git status`
- Validate commit history with `git log --oneline -n <count>`
- Report completion status

### 2. User Interaction
- **Automatic**: Simple changesets are processed automatically
- **Confirmation**: Complex groupings may request user confirmation
- **Intervention**: User can override proposals or handle failures

### 3. Error Handling
- **Staging failures**: Automatic retry with updated hunk numbers
- **Hook failures**: Display errors and stop for manual intervention
- **Analysis issues**: Request clarification or use conservative grouping

## Workflow Overview

```
/semantic-commit invoked
    ↓
    ├─ Phase 1: Preparation
    │   ├─ cd $(git rev-parse --show-toplevel)
    │   ├─ git status (verify clean state)
    │   └─ git diff HEAD > .claude/tmp/current_changes.patch
    │
    ├─ Phase 2: Analysis
    │   └─ Task(change-semantic-analyzer)
    │       ├─ Parse patch hunks
    │       ├─ Group by semantic purpose
    │       ├─ Classify change types
    │       └─ Output staging commands
    │
    ├─ Phase 3: Execution (repeat for each commit)
    │   ├─ git-sequential-stage (selective staging)
    │   ├─ Task(commit-message-generator)
    │   │   └─ Generate conventional commit message
    │   ├─ git commit (execution)
    │   └─ git diff HEAD > .claude/tmp/current_changes.patch (update)
    │
    └─ Phase 4: Verification
        ├─ git status (confirm clean)
        ├─ git log --oneline -n N
        └─ Report success
```

## Agent Responsibilities

### `change-semantic-analyzer`
**Role**: Intelligent change analysis and semantic grouping

**Responsibilities**:
- Parse git diff patches and identify hunks
- Understand semantic purpose of modifications
- Group related changes across multiple files
- Classify change types (feat/fix/refactor/test/docs/chore)
- Generate git-sequential-stage commands for selective staging
- Propose logical commit boundaries and order

**Output**: Detailed commit proposals with:
- Commit type, scope, and description
- List of affected files and specific hunks
- Rationale for grouping
- Ready-to-execute staging commands

**When**: Invoked during Phase 2 (Analysis)

### `commit-message-generator`
**Role**: Semantic commit message generation following conventions

**Responsibilities**:
- Analyze staged changes
- Follow Angular-style conventional commit format
- Generate appropriate type (feat/fix/refactor/etc.)
- Determine relevant scope (module/component/area)
- Write clear, specific descriptions in present tense
- Add explanatory body when needed
- Include Claude attribution footer

**Output**: Complete commit message ready for `git commit`:
```
type(scope): description

[optional body explaining why]

🤖 Generated with [Claude Code](https://claude.com/claude-code)

Co-Authored-By: Claude <noreply@anthropic.com>
```

**When**: Invoked during Phase 3 (Execution) for each commit

## Conventional Commit Types

- **feat**: New feature or functionality
- **fix**: Bug fixes and error corrections
- **refactor**: Code restructuring without behavior change
- **test**: Test additions or modifications
- **docs**: Documentation updates
- **chore**: Maintenance tasks (dependencies, config, etc.)
- **perf**: Performance improvements
- **style**: Code formatting changes (no logic change)
- **build**: Build system modifications
- **ci**: CI/CD pipeline changes
- **revert**: Reverting previous commits

## Advanced Scenarios

### Large Changesets
When dealing with many changes:
- Automatically grouped by semantic purpose
- Progress updates provided
- Multiple commits created in logical order

### Mixed Change Types
When changes span different types:
- Automatically separated into appropriate commits
- Maintains logical progression (setup → implementation → tests)
- Each commit remains atomic and meaningful

### Complex Dependencies
When changes depend on each other:
- Commits ordered to maintain working state
- Dependencies respected in commit sequence
- Each intermediate commit leaves codebase functional

## Technical Details

### Hunk-Based Staging
Uses `git-sequential-stage` for precise control:
- Enables semantic division within single files
- Supports multi-file atomic commits
- Maintains hunk identity during staging operations

**Example**:
```bash
# Stage specific hunks from multiple files
git-sequential-stage -patch=".claude/tmp/current_changes.patch" \
  -hunk="src/auth.py:1,3,5" \
  -hunk="src/models.py:2"
```

### Pre-commit Hook Handling
- Respects project hooks (linting, formatting, tests)
- Automatically handles hook modifications
- Amends commits when safe (not pushed, correct author)
- Stops workflow on hook failures

### Project Detection
Automatically adapts to project conventions:
- Analyzes recent commit history for patterns
- Follows established type and scope naming
- Matches project-specific message style
- Respects existing commit conventions

## Success Indicators

A successful workflow produces:
- ✅ All changes committed in atomic units
- ✅ Semantic commit messages following conventions
- ✅ Clean working directory (no uncommitted changes)
- ✅ Logical commit history
- ✅ Each commit maintains working state
- ✅ Meaningful progression of changes

## Example Output

```markdown
# Commit Workflow Report

## Phase 1: Preparation ✅
- Repository: /home/user/project
- Total changes: 5 files, 23 hunks
- Patch: .claude/tmp/current_changes.patch

## Phase 2: Analysis ✅
- Proposed commits: 3
- Change types: feat(1), fix(1), test(1)

## Phase 3: Execution ✅

### Commit 1/3: fix(auth): handle token expiration gracefully
- Staged: src/auth.py (hunks 1,3), src/middleware.py (hunk 2)
- Committed: a1b2c3d
- Status: ✅ Success

### Commit 2/3: feat(auth): add refresh token rotation
- Staged: src/auth.py (hunks 2,4,5), src/models.py (hunks 1,2)
- Committed: e4f5g6h
- Status: ✅ Success

### Commit 3/3: test(auth): add token lifecycle tests
- Staged: tests/test_auth.py (all hunks)
- Committed: i7j8k9l
- Status: ✅ Success

## Phase 4: Verification ✅
- Remaining changes: None
- Working directory: Clean
- Total commits: 3

## Summary
✅ Successfully created 3 semantic commits
✅ All changes committed
✅ Repository ready for push
```

## Troubleshooting

### No Changes Detected
- Check `git status` to verify changes exist
- Verify files aren't excluded by `.gitignore`
- Check global gitignore configuration

### Staging Failures
- Patch file will be regenerated automatically
- Hunk numbers recalculated on retry
- Manual intervention requested if persistent

### Hook Failures
- Hook output displayed for debugging
- Workflow stops for manual resolution
- Staged changes preserved for inspection

### Semantic Ambiguity
- Analyzer requests clarification when needed
- Conservative grouping used as fallback
- User can override automated proposals

## Notes

### Commands Handled Automatically
- **DO NOT USE MANUALLY**: `git add`, `git restore`, `git reset`, `git stash`
- **Automated Tools**: `git-sequential-stage` for selective staging
- **Focus**: Review proposals and confirm groupings

### Best Practices
- Trust the semantic analysis
- Provide feedback on grouping if needed
- Review generated commit messages
- Ensure each commit tells a clear story

## Requirements

### Tools
- `git` (standard git installation)
- `git-sequential-stage` (for hunk-based staging)
  - Installation: See [GitHub README](https://github.com/syou6162/git-sequential-stage)
- `filterdiff` (patchutils package)
  - macOS: `brew install patchutils`
  - Ubuntu/Debian: `apt-get install patchutils`

### Environment
- Git repository (initialized and clean of merge conflicts)
- Working directory with changes (staged or unstaged)
- Write access to `.claude/tmp/` directory
