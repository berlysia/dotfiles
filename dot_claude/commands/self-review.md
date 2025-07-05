# /self-review

Reviews recent changes or pull requests from multiple stakeholder perspectives.

## Description
This command analyzes recent changes or a specific pull request and provides comprehensive code reviews from six different stakeholder perspectives. Results are saved to `.claude/review-result` directory.

## Core Principle
**"The future is now"** - All potential improvements must be addressed immediately. No deferral of enhancements or fixes.

## Implementation
1. Determine review target:
   - If PR number provided: Fetch PR using `gh pr view` and checkout PR branch locally
   - Otherwise: Analyze recent git changes (staged and unstaged)
2. Perform multi-perspective review from:
   - **Product Manager**: Business value and user experience
   - **Developer**: Code quality and technical excellence
   - **Quality Engineer**: Testing and reliability
   - **Security Engineer**: Vulnerabilities and compliance
   - **DevOps**: Infrastructure and deployment
   - **UI/UX Designer**: User interface and accessibility
3. Save review results to `.claude/review-result/pr<number>-<timestamp>.md` or `.claude/review-result/<branch>-<HEAD>.md`
4. Use root-relative paths for file references
5. Use `${filepath}:${lines}` format for line references
6. Include PR metadata (title, description, author) when reviewing pull requests

## Review Perspectives

### Product Manager Review
- Business value and strategic alignment
- User experience and feature completeness
- Product roadmap consistency
- Market positioning and competitive advantage

### Developer Review
- Code quality and best practices
- Performance and scalability
- Design patterns and architecture
- Maintainability and readability
- Code reusability and modularity
- Code duplication detection using `similarity-ts` and deduplication necessity assessment
- Circular dependency identification using `dpdm` and `madge`, with resolution strategies
- Dependency structure verification and organization using `tsg`
- Bundle analysis and optimization using `sonda`

### Quality Engineer Review
- Test coverage and effectiveness
- Edge cases and error handling
- Regression risks
- Integration points
- Data integrity and validation

### Security Engineer Review
- Security vulnerabilities
- Data protection and encryption
- Access control and authentication
- Compliance requirements
- Audit trails and logging

### DevOps Review
- CI/CD pipeline integration
- Infrastructure requirements
- Monitoring and alerting
- Deployment strategies
- Performance metrics

### UI/UX Designer Review
- Visual consistency
- Usability and user flow
- Accessibility standards
- Responsive design
- Interactive elements

## Usage
```
/self-review [pr-number]
```

### Examples
```
# Review recent local changes
/self-review

# Review specific pull request
/self-review 123
```

The command will:
- For PR review: Fetch PR details and checkout branch locally for analysis
- Review all changes from six perspectives
- Generate detailed multi-stakeholder review report
- Save results to `.claude/review-result` directory with appropriate naming
- Provide immediate actionable improvements for each perspective
- Ensure no issues are deferred for future consideration

### Pull Request Review Process
When PR number is provided:
1. Fetch PR metadata using `gh pr view <pr-number>`
2. Checkout PR branch locally using `gh pr checkout <pr-number>`
3. Analyze all changes in the PR
4. Include PR context (title, description, comments) in review
5. Generate comprehensive review covering all changed files