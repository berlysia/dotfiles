# /self-review

Reviews recent changes or pull requests from multiple stakeholder perspectives.

## Description
This command analyzes recent changes or a specific pull request and provides comprehensive code reviews from six different stakeholder perspectives. Results are saved to `.claude/review-result` directory.

## Core Principle
**"The future is now"** - All potential improvements must be addressed immediately. No deferral of enhancements or fixes.

## Implementation
1. **Determine review target**:
   - If PR number provided: Fetch PR using `gh pr view` and checkout PR branch locally
   - Otherwise: Analyze recent git changes (staged and unstaged) with dependency analysis

2. **Perform multi-perspective review** from six stakeholder perspectives

3. **Generate comprehensive report** with:
   - Root-relative paths for file references
   - `${filepath}:${lines}` format for line references
   - PR metadata (when reviewing pull requests)
   - Dependency analysis results (when reviewing local changes)

4. **Save results** to `.claude/review-result/pr<number>-<timestamp>.md` or `.claude/review-result/<branch>-<HEAD>.md`

## Review Perspectives

### Product Manager Review
- Business value and strategic alignment
- User experience and feature completeness
- Product roadmap consistency
- Market positioning and competitive advantage
- **Module Dependencies Impact**: Maintainability cost, refactoring risks, team productivity

### Developer Review
- Code quality and best practices
- Performance and scalability
- Design patterns and architecture
- Maintainability and readability
- Code reusability and modularity
- **Internal Dependencies**: Import/export patterns, coupling analysis, circular dependencies
- **Architecture Compliance**: Layer violations, dependency direction, module boundaries
- **Code Analysis**: Duplication detection, bundle impact, import structure optimization

### Quality Engineer Review
- Test coverage and effectiveness
- Edge cases and error handling
- Regression risks
- Integration points
- Data integrity and validation
- **Testability**: Module isolation, dependency injection, mock complexity

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
- **Build Performance**: Bundle size impact, build time, hot reload performance

### UI/UX Designer Review
- Visual consistency
- Usability and user flow
- Accessibility standards
- Responsive design
- Interactive elements
- **Component Architecture**: Design system consistency, component reusability, shared UI patterns

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

## Review Process

### Pull Request Review
When PR number is provided:
1. Fetch PR metadata using `gh pr view <pr-number>`
2. Checkout PR branch locally using `gh pr checkout <pr-number>`
3. Analyze all changes in the PR
4. Include PR context (title, description, comments) in review
5. Generate comprehensive review covering all changed files

### Local Changes Review
When no PR number is provided:
1. **Code Analysis**: Recent git changes (staged and unstaged)
2. **Dependency Analysis**: 
   - Import pattern analysis (deep relative imports 3+ levels)
   - Module coupling assessment and decoupling suggestions
   - Architecture layer validation and circular dependency detection
   - Path alias opportunities and barrel export recommendations
   - Bundle impact analysis
3. **Tool Integration**: Uses `similarity-ts`, `dpdm`, `madge`, `tsg`, `sonda` for analysis

## Output
- Detailed multi-stakeholder review report
- Save results to `.claude/review-result` directory with appropriate naming
- Immediate actionable improvements for each perspective
- Comprehensive dependency analysis and architectural recommendations
- Ensures no issues are deferred for future consideration