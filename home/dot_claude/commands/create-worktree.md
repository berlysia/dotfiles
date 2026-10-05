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
   - Use `git-worktree-create <branch-name>` command
   - Create new worktree under `.git/worktree`
   - `git-worktree-create` also installs dependencies. Read its output with the table below. Check the lines from the top; the first row that matches decides what to do. Search `dependencies are not installed` case-insensitively.

     | Line in the output                                                               | Meaning                                                                | Action                                                                                                                                                    |
     | -------------------------------------------------------------------------------- | ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
     | `✓ Dependencies installed`                                                       | The install at the root exited with status 0                           | Start working                                                                                                                                             |
     | `do not install there until this succeeds`                                       | The VM-local `node_modules` swap is not done                           | Do not install. Run the recovery step in that warning (`agent-vm-node-modules attach <wt>`); once it succeeds, install with the project's package manager |
     | `agent-vm-node-modules is missing`                                               | The VM has no helper, so `node_modules` is shared with the host        | Do not install. Tell the user the machine must be recreated from the host                                                                                 |
     | `dependencies are not installed`, with the reason `the branch comes from origin` | The branch comes from origin, so the install was not run automatically | As the line says, review the branch's `package.json` `scripts` (and `.pnpmfile.cjs`), then run the command shown. Ask the user if unsure                  |
     | `dependencies are not installed` (anything else)                                 | Nothing was installed                                                  | Follow the line. If it has no command (two kinds of lockfile), ask the user which package manager to use                                                  |
     | `📦 Installing dependencies` and none of the above                               | The install was cut off partway                                        | Move to the path in the `💡 To switch` line, and run the command from the `📦` line with a longer timeout                                                 |
     | None of the above                                                                | The script did not start an install                                    | Do not install (not a Node project, or nothing says which package manager)                                                                                |
     - `✓ Dependencies installed` covers only the install at the root. It does not cover independent packages outside the root, or the VM-side install after creating on the host.
     - The exit status 0 of `git-worktree-create` means the worktree was created, not that dependencies are installed.
     - To use the path programmatically, read the (unquoted) value on the `✓ Worktree created:` line. The `💡 To switch` line is for pasting into a shell, so its path is quoted.
     - If the install is likely to exceed the Bash timeout, create with `git-worktree-create --no-install <branch-name>`, then run the command it shows with a longer timeout.

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

Cleanup after completion, run from the main worktree:

```bash
git-worktree-cleanup <branch-name>
```

Exit code 2 means the worktree was kept; the reason is in the output. To tidy up several at once, run `git-worktree-cleanup` from the main worktree.

Or manually (the branch is not deleted by `git-worktree-cleanup`, so delete it by hand):

```bash
git worktree remove .git/worktree/<branch-name>
git branch -d <branch-name>
```

## Requirements

- git worktree support
- git-worktree-create command (available via dotfiles)
- git-worktree-cleanup command (available via dotfiles)
- gh CLI installed and authenticated (only if using `--pr` flag)
- Write permissions to repository
