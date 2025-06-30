---
title: "Worktree PR"
description: "Create worktree branch and PR from given task"
---

# Worktree PR Command

Creates a new branch with worktree, executes the given task, and creates a PR.

## Usage

```
/worktree-pr <task-description>
```

## Examples

```
/worktree-pr "Add dark mode support to settings page"
/worktree-pr "Fix memory leak in data processing module"
/worktree-pr "Update dependencies and fix vulnerabilities"
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

4. **PR Creation**
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
- PR creation failure: Check push status and retry

## Cleanup

Manual worktree cleanup after completion:
```bash
git worktree remove .git/worktree/<branch-name>
git branch -d <branch-name>
```

## Requirements

- git worktree support
- gh CLI installed and authenticated
- Write permissions to repository