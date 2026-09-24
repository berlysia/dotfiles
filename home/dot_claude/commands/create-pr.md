# /create-pr

Creates a pull request from current changes using gh command.

## Description

This command pushes current changes and creates a pull request with proper quality checks and user interaction.

## Implementation

1. Check git status and current branch
2. Verify changes are ready for PR
3. Push changes to remote
4. Write the PR title and description with the `pr-description` skill
5. Follow the repository's commit message style

## Usage

```
/create-pr
```

The command will:

- Analyze current changes
- Ask for PR title and description if needed
- Push to remote branch
- Create PR using gh command
- Follow best practices for PR quality
