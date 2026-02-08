# /issue-pr

Fetches a GitHub issue and starts development to resolve it.

## Description
This command uses gh command to fetch a specified GitHub issue, analyzes it, and sets up a dedicated development environment to resolve the issue.

## Implementation
1. Prompt user for issue number/URL
2. Fetch issue details using `gh issue view`
3. Analyze issue requirements and scope
4. Create dedicated branch using `git-worktree-create`
5. Set up development environment
6. Plan implementation steps
7. Begin development work

## Usage
```
/issue-pr [issue-number]
```

The command will:
- Fetch issue details from GitHub
- Create dedicated worktree/branch for the issue
- Analyze requirements and create development plan
- Set up proper branch naming (e.g., `issue-123-description`)
- Begin implementation work
- Track progress and provide updates