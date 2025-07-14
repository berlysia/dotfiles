# Commit Command

Create a git commit following project conventions with comprehensive pre-commit checks.

## Workflow

1. **Pre-commit checks**: Run lint, format, and typecheck
2. **Staging strategy**: Use staged files if any exist, otherwise stage all unstaged changes
3. **Commit message**: Follow Angular-style prefixes with project-specific conventions
4. **Post-commit verification**: Confirm commit success and check for additional changes

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
# If no staged files, stage all changes
git add .
# If staged files exist, ask user for confirmation
```

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