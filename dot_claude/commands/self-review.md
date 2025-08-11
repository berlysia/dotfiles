# /self-review

Reviews recent changes or pull requests from multiple stakeholder perspectives using specialized agents.

## Description
This command orchestrates comprehensive code reviews by coordinating multiple specialized agents to provide stakeholder-specific analysis. Results are saved to `.claude/review-result` directory.

## Core Principle
**"The future is now"** - All potential improvements must be addressed immediately. No deferral of enhancements or fixes.

## Implementation
1. **Determine review target**:
   - If PR number provided: Fetch PR using `gh pr view` and checkout PR branch locally
   - Otherwise: Analyze recent git changes (staged and unstaged) with dependency analysis

2. **Orchestrate multi-agent review** using `code-review-orchestrator` agent

3. **Generate comprehensive report** with:
   - Root-relative paths for file references
   - `${filepath}:${lines}` format for line references
   - PR metadata (when reviewing pull requests)
   - Dependency analysis results (when reviewing local changes)

4. **Save results** to `.claude/review-result/pr<number>-<timestamp>.md` or `.claude/review-result/<branch>-<HEAD>.md`

## Review Perspectives

The `code-review-orchestrator` agent coordinates the following specialized agents for comprehensive review:

### Product Manager Review (`product-value-evaluator`)
- Business value and strategic alignment
- User experience and feature completeness
- Product roadmap consistency
- Market positioning and competitive advantage
- ROI assessment and resource allocation impact

### Developer Review (`architecture-integration-orchestrator`)
- Code quality and architectural patterns
- Performance and scalability considerations
- Design patterns and maintainability
- Coupling/cohesion analysis
- Technical debt assessment

### Quality Engineer Review (`test-quality-evaluator`)
- Test coverage and effectiveness
- Edge cases and error handling
- Regression risks and prevention
- Integration points validation
- Quality gate compliance

### Security Engineer Review (`security-vulnerability-analyzer`)
- Security vulnerabilities and threats
- Data protection and encryption
- Access control and authentication
- Compliance requirements (OWASP, GDPR, etc.)
- Audit trails and logging

### DevOps Review (`deployment-readiness-evaluator`)
- CI/CD pipeline integration and optimization
- Infrastructure requirements and capacity
- Monitoring and alerting coverage
- Deployment strategies and safety
- Performance metrics and scalability

### UI/UX Designer Review (`ui-ux-consistency-reviewer`)
- Visual consistency and design system adherence
- Usability and user experience patterns
- Accessibility standards (WCAG compliance)
- Responsive design and cross-device experience
- Component architecture and reusability

## Agent Orchestration

The command delegates comprehensive review coordination to the `code-review-orchestrator` agent, which:

1. **Coordinates Multiple Agents**: Manages parallel execution of specialized review agents
2. **Integrates Results**: Synthesizes findings from all perspectives into unified assessment
3. **Resolves Conflicts**: Identifies and resolves contradictions between agent recommendations
4. **Prioritizes Actions**: Consolidates priorities across stakeholder perspectives
5. **Generates Reports**: Creates stakeholder-specific and integrated review reports

## Usage
```
/self-review [pr-number]
```

### Examples
```
# Review recent local changes with agent orchestration
/self-review

# Review specific pull request using orchestrated agents
/self-review 123
```

## Review Process

### Pull Request Review
When PR number is provided:
1. Fetch PR metadata using `gh pr view <pr-number>`
2. Checkout PR branch locally using `gh pr checkout <pr-number>`
3. **Delegate to `code-review-orchestrator`** for multi-agent analysis
4. Include PR context (title, description, comments) in review
5. Generate comprehensive orchestrated review covering all changed files

### Local Changes Review
When no PR number is provided:
1. **Code Analysis**: Recent git changes (staged and unstaged)
2. **Agent Orchestration**: `code-review-orchestrator` coordinates:
   - Dependency analysis via specialized agents
   - Multi-perspective quality assessment
   - Integrated priority recommendations
3. **Tool Integration**: Agents use `similarity-ts`, `dpdm`, `madge` for analysis

## Output
- Orchestrated multi-stakeholder review report
- Save results to `.claude/review-result` directory with appropriate naming
- Prioritized actionable improvements across all perspectives
- Cross-perspective analysis and conflict resolution
- Integrated improvement roadmap with clear priorities
- Ensures comprehensive coverage with no issues deferred