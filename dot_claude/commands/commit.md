# Commit Command

Create semantically meaningful git commits following project conventions with comprehensive pre-commit checks.

## Core Principles

### Semantic Commits
- Break large changes into logical, meaningful units
- Each commit should represent a single, coherent change
- Commits should be atomic - they work independently and don't break the build
- Use conventional commit prefixes to categorize changes

### Atomic Commits Best Practices
- **Single Purpose**: Each commit addresses one specific change or feature
- **Self-Contained**: The codebase should work after each commit
- **Meaningful**: Commit messages clearly explain the "why" behind changes
- **Reviewable**: Small enough to be understood in a code review

## Workflow

1. **Pre-commit checks**: Run lint, format, and typecheck
2. **Analyze changes**: Review git diff to identify logical units
3. **Staging strategy**: Stage semantically related changes together
4. **Commit message**: Follow Angular-style prefixes with clear descriptions
5. **Post-commit verification**: Confirm commit success and check for additional changes

### Semantic Analysis Process
When dealing with multiple changes:
1. Review all modifications with `git diff`
2. Group related changes by functionality
3. Stage and commit each group separately
4. Ensure each commit is meaningful and self-contained

## Implementation Steps

### 1. Manual checks
- **Lint**: Run project linter (biome, eslint, oxlint, etc.)
- **Format**: Apply code formatting (biome, prettier, etc.)
- **Typecheck**: Verify TypeScript compilation
- Fail fast if any check fails

### 2. Staging strategy
```bash
# Check if any files are staged
git diff --cached --name-only
# If no staged files, analyze changes for semantic grouping
git diff --name-only
# For complex changes, use git-sequential-stage tool
# Stage semantically related changes together
# If staged files exist, ask user for confirmation
```

#### Advanced Staging Tools
- **git-sequential-stage**: Helps stage specific hunks across multiple files
- **Hunk-based staging**: Stage specific code segments within files using appropriate tools

### 3. Commit message generation
- **Prefix**: Use Angular-style (feat:, fix:, docs:, refactor:, test:, chore:)
- **Language**: English primary, follow project conventions
- **Tense**: Present tense imperative ("add feature" not "added feature")
- **Format**: `type(scope): description`
- **Footer**: Add Claude attribution

### 4. Post-commit verification
```bash
# Verify commit succeeded
git log --oneline -1
# Check for additional changes (e.g., from hooks)
git status --porcelain
# If changes exist, prompt for amend
```

## Error Handling

- **Lint/format/typecheck failures**: Stop and report errors
- **Hook failures**: Stop and display hook output
- **Staging conflicts**: Prompt user for resolution
- **Post-commit changes**: Offer to amend commit

## Project Detection

- **Package.json**: Check for scripts (lint, format, typecheck, test)
- **Tsconfig.json**: Detect TypeScript project
- **Biome.json**: Use biome for lint/format
- **Eslint config**: Use eslint for linting
- **Git hooks**: Respect existing hook configuration

## Message Templates

### Standard format
```
type(scope): description

Optional body explaining the change

🤖 Generated with [Claude Code](https://claude.ai/code)

Co-Authored-By: Claude <noreply@anthropic.com>
```

### Type guidelines
- **feat**: New feature
- **fix**: Bug fix
- **docs**: Documentation changes
- **refactor**: Code refactoring
- **test**: Test additions/changes
- **chore**: Maintenance tasks
- **perf**: Performance improvements
- **style**: Code style changes

## Breaking Down Complex Changes

### Example: Feature with Multiple Components
Instead of one large commit:
```
feat: add user authentication system
```

Break into semantic commits:
```
feat(auth): add user model and database schema
feat(auth): implement JWT token generation
feat(auth): add login/logout API endpoints
feat(auth): create authentication middleware
test(auth): add unit tests for auth service
docs(auth): update API documentation
```

### Example: Bug Fix with Refactoring
Instead of mixing changes:
```
fix: fix user validation and clean up code
```

Separate concerns:
```
fix(user): validate email format before saving
refactor(user): extract validation logic to separate module
test(user): add test cases for email validation
```

## Technical Details

### git-sequential-stage Tool

`git-sequential-stage` is a Go-implemented tool that automates hunk-based partial staging ([GitHub: syou6162/git-sequential-stage](https://github.com/syou6162/git-sequential-stage)).

The tool encapsulates complex processing:
- Unique hunk identification via `git patch-id`
- Sequential staging to avoid line number shifts
- Patch ID-based matching for reliable hunk identification
- Accurate hunk extraction from multi-file patches using `filterdiff`

Usage:
```bash
# Basic usage
git-sequential-stage -patch="path/to/changes.patch" -hunk="src/main.go:1,3,5"

# Multiple files (specify multiple -hunk flags)
git-sequential-stage -patch="path/to/changes.patch" \
  -hunk="src/main.go:1,3" \
  -hunk="src/utils.go:2,4"

# Arguments:
# -patch: Path to patch file
# -hunk: file:numbers format (e.g., src/main.go:1,3)
#        Filename and comma-separated hunk numbers joined by colon
```

## Detailed Workflow Steps

### Step 0: Move to Repository Root
```bash
# Confirm repository root
REPO_ROOT=$(git rev-parse --show-toplevel)
echo "Repository root: $REPO_ROOT"

# Move to repository root
cd "$REPO_ROOT"
```

### Step 1: Get Differences
```bash
# Add new files (untracked) with intent-to-add
git ls-files --others --exclude-standard | xargs git add -N

# Get diff with context (for stable position detection)
git diff HEAD > .claude/tmp/current_changes.patch
```

### Step 2: LLM Analysis
Analyze changes by **hunk** and determine which hunks to include in the first commit:
- Read each hunk content
- Group semantically related changes
- Plan commit structure

Check total hunk count if needed:
```bash
# Total hunk count
grep -c "^@@" .claude/tmp/current_changes.patch

# Hunk count per file
git diff HEAD --name-only | xargs -I {} sh -c 'printf "%s: " "{}"; git diff HEAD {} | grep -c "^@@"'
```

### Step 3: Automated Staging
```bash
# Execute git-sequential-stage
# Single file
git-sequential-stage -patch=".claude/tmp/current_changes.patch" -hunk="src/calculator.py:1,3,5"

# Multiple files
git-sequential-stage -patch=".claude/tmp/current_changes.patch" \
  -hunk="src/calculator.py:1,3,5" \
  -hunk="src/utils.py:2"

# Commit
git commit -m "$COMMIT_MSG"
```

### Step 4: Repeat
Process remaining changes with the same workflow.

### Step 5: Final Verification
```bash
# Verify all changes are committed
if [ $(git diff HEAD | wc -l) -eq 0 ]; then
  echo "All changes committed"
else
  echo "Warning: Uncommitted changes remain"
  git status
fi
```

## Environment Requirements
```bash
# Required tools
which git-sequential-stage  # Specialized tool
which filterdiff           # patchutils package
```

Installation:
- `git-sequential-stage`: See [GitHub README](https://github.com/syou6162/git-sequential-stage)
- patchutils: `brew install patchutils` (macOS) / `apt-get install patchutils` (Ubuntu/Debian)

## Important Notes

### Commands to Avoid
- **DO NOT USE**: `git add`, `git checkout`, `git restore`, `git reset`, `git stash`
- **Avoid interactive operations**: Commands like `git add -p` that require user interaction
- **Use appropriate tools**: For complex staging, use `git-sequential-stage` instead

### Best Practices
- Always verify hunk numbers with the latest diff before specifying
- Use tools that support non-interactive operation
- Focus on creating meaningful, atomic commits
- **Hunk specification**: Use file:numbers format (e.g., "file.go:1,3,5")
- **Semantic consistency**: Group related changes in the same commit

## Usage Examples

### Semantic Division within a File (Most Important Example)

```
Changes in src/calculator.py:
- hunk 1: Line 10 - Add zero division check
- hunk 2: Lines 25-30 - Optimize calculation algorithm
- hunk 3: Line 45 - Fix another zero division error
- hunk 4: Lines 60-80 - Refactor internal structure
- hunk 5: Line 95 - Add logging for zero division

↓ Division Result

Commit 1: fix: Fix zero division errors
git-sequential-stage -patch=".claude/tmp/current_changes.patch" -hunk="src/calculator.py:1,3,5"

Commit 2: refactor: Optimize calculation logic
git-sequential-stage -patch=".claude/tmp/current_changes.patch" -hunk="src/calculator.py:2,4"
```

### Complex Change Patterns

```
Changes:
- src/auth.py: Authentication fixes (hunks 1,3,5) and refactoring (hunks 2,4)
- src/models.py: User model extension (hunks 1,2)
- tests/test_auth.py: New tests (hunks 1,2,3)

↓ Division Result

Commit 1: fix: Fix security vulnerabilities in existing auth
git-sequential-stage -patch=".claude/tmp/current_changes.patch" -hunk="src/auth.py:1,3,5"

Commit 2: feat: Implement JWT authentication
git-sequential-stage -patch=".claude/tmp/current_changes.patch" \
  -hunk="src/auth.py:2,4" \
  -hunk="src/models.py:1,2"

Commit 3: test: Add authentication tests
git-sequential-stage -patch=".claude/tmp/current_changes.patch" -hunk="tests/test_auth.py:1,2,3"
```

## Troubleshooting

### New Files Not Showing in git diff

If newly created files don't appear in `git diff`:

```bash
# Check if excluded by .gitignore
git check-ignore -v path/to/new_file.ext

# Check global gitignore config
git config --get core.excludesfile

# Check global exclusion file contents (if exists)
cat "$(git config --get core.excludesfile)"

# Check repository .git/info/exclude
cat .git/info/exclude
```

Solutions:
1. Remove or modify relevant patterns from `.gitignore`
2. Check and modify global config (`~/.config/git/ignore`, etc.)
3. Check and modify `.git/info/exclude` settings

### git-sequential-stage Failures

```bash
# Check error messages
git-sequential-stage -patch=".claude/tmp/current_changes.patch" -hunk="file.go:1,2,3" 2>&1

# Check patch file contents
cat .claude/tmp/current_changes.patch | head -50

# Check hunk count for specific file
filterdiff -i "path/to/file.go" .claude/tmp/current_changes.patch | grep -c '^@@'
```

### Handling Large Hunks

Large hunks may not be semantically divisible. In this case:
1. Commit the entire change once
2. Use `git reset HEAD~1` to undo
3. Re-implement in smaller change units