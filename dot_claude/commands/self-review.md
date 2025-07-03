# /self-review

Reviews recent changes from a reviewer's perspective.

## Description
This command analyzes recent changes and provides a comprehensive code review from a reviewer's perspective. Results are saved to `.claude/review-result` directory.

## Implementation
1. Analyze recent git changes (staged and unstaged)
2. Perform thorough code review covering:
   - Code quality and best practices
   - Security considerations
   - Performance implications
   - Maintainability and readability
   - Testing coverage
   - Documentation
3. Save review results to `.claude/review-result/<timestamp>.md`
4. Use root-relative paths for file references
5. Use `${filepath}:${lines}` format for line references

## Usage
```
/self-review
```

The command will:
- Review all recent changes
- Generate detailed review report
- Save results to `.claude/review-result` directory
- Provide actionable feedback and suggestions