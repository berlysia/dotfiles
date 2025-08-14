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

The `code-review-orchestrator` agent coordinates 13 specialized agents for comprehensive review across all stakeholder dimensions:

### Product Manager Review (`product-value-evaluator`)
- Business value and strategic alignment
- User experience and feature completeness
- Product roadmap consistency
- Market positioning and competitive advantage
- ROI assessment and resource allocation impact

### Developer Reviews (Multiple Specialized Agents)

#### Technical Architecture (`architecture-integration-orchestrator`)
- Code quality and architectural patterns
- Performance and scalability considerations
- Design patterns and maintainability
- Coupling/cohesion analysis
- Technical debt assessment

#### Code Quality Analysis (`code-complexity-analyzer`, `code-duplication-analyzer`)
- Cyclomatic and cognitive complexity metrics
- Code duplication detection and consolidation opportunities
- Maintainability indices and technical debt hotspots
- Refactoring recommendations and complexity reduction strategies

#### Interface Design (`interface-ergonomics-reviewer`)
- API design and ergonomics evaluation
- Interface usability and developer experience
- Method signatures and parameter design
- Internal module interface consistency
- Public API backward compatibility

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

### DevOps Reviews (Multiple Specialized Agents)

#### Deployment Infrastructure (`deployment-readiness-evaluator`)
- CI/CD pipeline integration and optimization
- Infrastructure requirements and capacity
- Build and deployment automation
- Environment configuration management

#### Release Safety (`release-safety-evaluator`)
- Deployment risk assessment and mitigation
- Rollback strategies and safety measures
- Feature flag integration and gradual rollout
- Production readiness validation

#### Observability (`observability-evaluator`)
- Logging coverage and structured logging
- Metrics and monitoring instrumentation
- Distributed tracing implementation
- Alerting and incident response coverage
- Performance monitoring and SLA compliance

### UI/UX Designer Review (`ui-ux-consistency-reviewer`, `interface-ergonomics-reviewer`)
- Visual consistency and design system adherence
- Usability and user experience patterns
- Accessibility standards (WCAG compliance)
- Responsive design and cross-device experience
- Component architecture and reusability
- User interface ergonomics and interaction design

### Cross-Cutting Reviews

#### Documentation Quality (`documentation-consistency-reviewer`)
- Code documentation accuracy and completeness
- API documentation consistency
- Architecture decision record updates
- User guide and tutorial alignment
- Comment quality and maintenance burden

#### Logic Validation (`logic-validator`)
- Implementation logic consistency
- Requirement alignment verification
- Edge case handling completeness
- Error condition coverage
- Business rule implementation accuracy

## Agent Orchestration

The command delegates comprehensive review coordination to the `code-review-orchestrator` agent, which executes a 6-phase review process with 13 specialized agents:

### Phase-Based Execution Strategy

1. **Phase 1: Technical Foundation** (3 agents)
   - Establishes code quality baseline with architecture, complexity, and duplication analysis
   - Creates foundation for subsequent analysis phases

2. **Phase 2: Interface & Design** (3 agents) 
   - Evaluates user and developer experience using Phase 1 architectural insights
   - Assesses interface ergonomics, UI consistency, and documentation quality

3. **Phase 3: Security & Safety** (3 agents)
   - Validates correctness and security using complexity and interface findings
   - Performs vulnerability analysis, test evaluation, and logic validation

4. **Phase 4: Operational Readiness** (3 agents)
   - Assesses deployment and monitoring preparedness based on safety analysis
   - Evaluates infrastructure, release safety, and observability coverage

5. **Phase 5: Business Impact** (1 agent)
   - Synthesizes technical findings into strategic business assessment
   - Provides ROI analysis and business value evaluation

6. **Phase 6: Integration & Synthesis**
   - Cross-phase contradiction resolution and priority consolidation
   - Generates unified improvement roadmap with clear dependencies

### Orchestration Benefits
- **Manageable Complexity**: Sequential phase execution with clear dependencies
- **Quality Focus**: Each phase builds on previous findings for deeper analysis
- **Efficient Resource Usage**: Smaller agent groups with focused objectives
- **Better Integration**: Natural flow from technical to business concerns
- **Clearer Reporting**: Phase-structured results easier to understand and act upon

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
1. **Change Context Analysis**: Recent git changes (staged and unstaged) with impact assessment
2. **Phase-Based Review Execution**: `code-review-orchestrator` coordinates sequential analysis:

   **Phase 1: Technical Foundation**
   - Architecture assessment, complexity analysis, duplication detection
   - Establishes technical quality baseline for subsequent phases

   **Phase 2: Interface & Design Quality**  
   - Interface ergonomics, UI consistency, documentation alignment
   - Uses Phase 1 architectural findings to inform design evaluation

   **Phase 3: Security & Safety Assessment**
   - Vulnerability analysis, test coverage, logic validation
   - Informed by complexity and interface findings from previous phases

   **Phase 4: Operational Readiness**
   - Deployment safety, observability coverage, release strategy
   - Builds on security assessment to evaluate production readiness

   **Phase 5: Business Impact Analysis**
   - Strategic value assessment using all technical findings
   - ROI evaluation and business alignment validation

   **Phase 6: Cross-Phase Integration**
   - Synthesis of all findings with dependency-aware prioritization
   - Unified improvement roadmap with clear implementation sequence

3. **Tool Integration Per Phase**: Agents leverage specialized analysis tools:
   - Phase 1: `similarity-ts`, complexity analyzers, `dpdm`/`madge` for architectural analysis
   - Phase 2: Interface analyzers, documentation consistency checkers
   - Phase 3: Security scanners, test coverage tools, logic validators
   - Phase 4: Deployment analyzers, monitoring coverage tools
   - Phase 5: Business impact assessment frameworks
   - Phase 6: Integration and reporting tools

## Output

### Comprehensive Multi-Dimensional Review Report
- **Executive Summary**: High-level assessment across all 13 specialized analysis dimensions
- **Stakeholder-Specific Findings**: Detailed results organized by Product, Developer, QA, Security, DevOps, and UX perspectives
- **Technical Quality Assessment**: Complexity metrics, duplication analysis, architectural evaluation, interface design quality
- **Operational Readiness**: Deployment safety, observability coverage, release risk assessment, monitoring compliance
- **Cross-Perspective Integration**: Contradiction resolution, priority consolidation, unified improvement roadmap

### Analysis Artifacts
- **Priority Classification**: P0 Critical, P1 Important, P2 Enhancement with clear rationale
- **Implementation Guidance**: Specific refactoring approaches, consolidation strategies, safety measures
- **Quality Metrics**: Complexity scores, duplication percentages, test coverage gaps, security risk levels
- **Tool Integration Results**: similarity-ts analysis, dependency graphs, complexity reports, security scans

### File Management
- Save results to `.claude/review-result` directory with timestamp-based naming
- Include file references in `${filepath}:${lines}` format for easy navigation
- Preserve PR metadata and change context for audit trails
- Generate both technical implementation details and executive summaries

### Quality Assurance
- **Comprehensive Coverage**: No issues deferred - all findings must be addressed according to "The future is now" principle
- **Multi-Agent Validation**: Cross-validation between agents to ensure consistency and completeness
- **Actionable Recommendations**: Every finding includes specific implementation steps and success criteria
- **Risk Assessment**: Clear evaluation of change impact and mitigation strategies across all dimensions