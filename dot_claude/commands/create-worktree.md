---
title: "Create Worktree"
description: "Create worktree branch and optionally create PR from given task"
---

# Create Worktree Command

Creates a new branch with worktree, executes the given task, and optionally creates a PR.

## Usage

```
/create-worktree [--pr] <task-description>
```

## Examples

```
# Create worktree only
/create-worktree "Add dark mode support to settings page"

# Create worktree and PR
/create-worktree --pr "Fix memory leak in data processing module"
/create-worktree --pr "Update dependencies and fix vulnerabilities"
```

## Process

1. **Git Verification**
   - Identify repository root
   - Confirm git repository
   - Get current branch

2. **Worktree Setup**
   - Create `.git/worktree` directory (if not exists)
   - Create new branch from current branch
   - Create new worktree under `.git/worktree`

3. **Task Execution**
   - Move to worktree directory
   - Execute the given task
   - Create commits as needed

4. **PR Creation (Optional)**
   - If `--pr` flag is provided:
     - Push changes
     - Create PR using gh command
     - Display PR URL

## Branch Naming

Branch names are auto-generated in the format:
- `feature/<task-summary>-<timestamp>`
- Example: `feature/dark-mode-settings-20240626`

## Worktree Structure

```
<repo-root>/
├── .git/worktree/
│   ├── feature-dark-mode-settings-20240626/
│   ├── feature-fix-memory-leak-20240627/
│   └── ...
└── (main working tree)
```

## Error Handling

- Non-git repository: Display error message and exit
- Worktree creation failure: Check existing worktrees
- PR creation failure (if `--pr` used): Check push status and retry

## Cleanup

Manual worktree cleanup after completion:
```bash
git worktree remove .git/worktree/<branch-name>
git branch -d <branch-name>
```

## Requirements

- git worktree support
- gh CLI installed and authenticated (only if using `--pr` flag)
- Write permissions to repository