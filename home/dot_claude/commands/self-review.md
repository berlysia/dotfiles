# /self-review

Reviews recent changes or pull requests from multiple stakeholder perspectives using specialized agents.

## Description
This command orchestrates comprehensive code reviews by coordinating multiple specialized agents to provide stakeholder-specific analysis. Results are saved to `.claude/review-result` directory.

## Core Principle
**"The future is now"** - All potential improvements must be addressed immediately. No deferral of enhancements or fixes.

## Implementation

### 1. Review Target Determination
- **If PR number provided**:
  - Fetch PR using `gh pr view <pr-number> --json title,body,files`
  - Checkout PR branch locally with `gh pr checkout <pr-number>`
- **Otherwise**:
  - Analyze recent git changes with `git diff HEAD` and `git status`
  - Run dependency analysis with tools like `dpdm` or `madge`

### 2. Six-Phase Multi-Agent Review

Execute specialized agents across 6 sequential phases:

**Phase 1: Technical Foundation** (並列実行)
```markdown
Task(architecture-boundary-analyzer): アーキテクチャ境界と依存関係分析
Task(code-complexity-analyzer): 複雑度メトリクスと保守性評価
Task(code-duplication-analyzer): コード重複検出と統合推奨
Task(resilience-analyzer): 耐障害性とエラー処理評価
```

**Phase 2: Interface & Design** (並列実行)
```markdown
Task(interface-ergonomics-reviewer): インターフェース設計と使いやすさ評価
Task(ui-ux-consistency-reviewer): UI一貫性とアクセシビリティ評価
Task(documentation-consistency-reviewer): ドキュメント整合性検証
Task(data-contract-evolution-evaluator): API/スキーマ互換性評価
```

**Phase 3: Security & Safety** (並列実行)
```markdown
Task(security-vulnerability-analyzer): セキュリティ脆弱性とコンプライアンス検証
Task(test-quality-evaluator): テストカバレッジと品質評価
Task(logic-validator): 実装ロジックと要件整合性検証
```

**Phase 4: Operational Readiness** (並列実行)
```markdown
Task(deployment-readiness-evaluator): CI/CDとインフラ準備度評価
Task(release-safety-evaluator): デプロイリスクと安全性評価
Task(observability-evaluator): 監視・ログ・トレースカバレッジ評価
```

**Phase 5: Business Impact** (順次実行)
```markdown
Task(product-value-evaluator): ビジネス価値と戦略整合性評価
```

**Phase 6: Integration & Synthesis**
- 各フェーズ結果の収集と統合
- 優先度の統合（P0/P1/P2分類）
- 矛盾の解決と改善ロードマップ生成

### 3. Comprehensive Report Generation

統合レポートを生成:
- Root-relative paths for file references (`src/module/file.ts:123`)
- PR metadata (when reviewing pull requests)
- Phase-by-phase findings with dependency mapping
- Unified priority classification
- Implementation roadmap

### 4. Save Results

Save to `.claude/review-result/`:
- PR review: `pr<number>-<timestamp>.md`
- Local changes: `<branch>-<HEAD>.md`

## Review Perspectives

このコマンドは14の専門エージェントを直接呼び出し、全ステークホルダー観点からの包括的レビューを実施:

### Product Manager Review (`product-value-evaluator`)
- Business value and strategic alignment
- User experience and feature completeness
- Product roadmap consistency
- Market positioning and competitive advantage
- ROI assessment and resource allocation impact

### Developer Reviews (Multiple Specialized Agents)

#### Technical Architecture (`architecture-boundary-analyzer`)
- Architectural boundaries and dependency analysis
- Boundary violations and coupling issues
- Layer compliance and unidirectional dependency
- Circular dependency detection

#### Code Quality Analysis (`code-complexity-analyzer`, `code-duplication-analyzer`)
- Cyclomatic and cognitive complexity metrics
- Code duplication detection and consolidation opportunities
- Maintainability indices and technical debt hotspots
- Refactoring recommendations and complexity reduction strategies

#### Resilience & Fault Tolerance (`resilience-analyzer`)
- Error handling and recovery mechanisms
- Timeout and retry patterns
- Circuit breaker implementation
- Graceful degradation strategies

#### Interface Design (`interface-ergonomics-reviewer`)
- API design and ergonomics evaluation
- Interface usability and developer experience
- Method signatures and parameter design
- Internal module interface consistency
- Public API backward compatibility

#### Data Contract Evolution (`data-contract-evolution-evaluator`)
- API/Schema backward compatibility
- Breaking change detection
- Versioning strategy evaluation
- Migration path validation

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

## Multi-Agent Execution Strategy

### Phase-Based Direct Execution

6つのフェーズで14の専門エージェントを直接呼び出し:

1. **Phase 1: Technical Foundation** (4 agents, 並列実行)
   - `architecture-boundary-analyzer`: アーキテクチャ境界分析
   - `code-complexity-analyzer`: 複雑度メトリクス評価
   - `code-duplication-analyzer`: コード重複検出
   - `resilience-analyzer`: 耐障害性評価
   - **目的**: コード品質ベースライン確立

2. **Phase 2: Interface & Design** (4 agents, 並列実行)
   - `interface-ergonomics-reviewer`: インターフェース設計評価
   - `ui-ux-consistency-reviewer`: UI一貫性とアクセシビリティ
   - `documentation-consistency-reviewer`: ドキュメント整合性
   - `data-contract-evolution-evaluator`: API/スキーマ互換性
   - **依存**: Phase 1のアーキテクチャ知見を活用
   - **目的**: ユーザー・開発者体験評価

3. **Phase 3: Security & Safety** (3 agents, 並列実行)
   - `security-vulnerability-analyzer`: セキュリティ脆弱性分析
   - `test-quality-evaluator`: テスト品質評価
   - `logic-validator`: ロジック整合性検証
   - **依存**: Phase 1の複雑度、Phase 2のインターフェース知見を活用
   - **目的**: 正確性とセキュリティ検証

4. **Phase 4: Operational Readiness** (3 agents, 並列実行)
   - `deployment-readiness-evaluator`: デプロイ準備度評価
   - `release-safety-evaluator`: リリース安全性評価
   - `observability-evaluator`: 監視カバレッジ評価
   - **依存**: Phase 3の安全性分析結果を基に評価
   - **目的**: 本番環境準備度評価

5. **Phase 5: Business Impact** (1 agent, 順次実行)
   - `product-value-evaluator`: ビジネス価値評価
   - **依存**: 全フェーズの技術知見を統合
   - **目的**: 戦略的ビジネス価値評価

6. **Phase 6: Integration & Synthesis** (コマンド内処理)
   - 全フェーズ結果の統合
   - 優先度統合（P0/P1/P2）
   - 矛盾解決と改善ロードマップ生成

### Execution Benefits
- **Manageable Complexity**: 6フェーズの順次実行で明確な依存関係
- **Quality Focus**: 各フェーズが前フェーズの知見を活用
- **Efficient Resource Usage**: フェーズ内並列実行で効率化
- **Better Integration**: 技術からビジネスへの自然な流れ
- **Clearer Reporting**: フェーズ構造化結果で理解と行動が容易

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
1. Fetch PR metadata using `gh pr view <pr-number> --json title,body,files`
2. Checkout PR branch locally using `gh pr checkout <pr-number>`
3. **Execute 6-phase multi-agent review** directly:
   - Phase 1-5: 各フェーズの専門エージェントを並列/順次実行
   - Phase 6: 統合処理でレポート生成
4. Include PR context (title, description, comments) in review
5. Generate comprehensive review covering all changed files

### Local Changes Review
When no PR number is provided:

**Step 1: Change Context Analysis**
```bash
git status
git diff HEAD
# Optionally: dpdm src/ or madge src/
```

**Step 2: Execute 6-Phase Review**

*Phase 1: Technical Foundation (並列実行)*
```markdown
Task(architecture-boundary-analyzer)
Task(code-complexity-analyzer)
Task(code-duplication-analyzer)
Task(resilience-analyzer)
```
→ Technical quality baseline確立

*Phase 2: Interface & Design (並列実行)*
```markdown
Task(interface-ergonomics-reviewer)
Task(ui-ux-consistency-reviewer)
Task(documentation-consistency-reviewer)
Task(data-contract-evolution-evaluator)
```
→ User/Developer experience評価（Phase 1の知見を活用）

*Phase 3: Security & Safety (並列実行)*
```markdown
Task(security-vulnerability-analyzer)
Task(test-quality-evaluator)
Task(logic-validator)
```
→ セキュリティと正確性検証（Phase 1-2の知見を活用）

*Phase 4: Operational Readiness (並列実行)*
```markdown
Task(deployment-readiness-evaluator)
Task(release-safety-evaluator)
Task(observability-evaluator)
```
→ 本番環境準備度評価（Phase 3の安全性評価を基に）

*Phase 5: Business Impact (順次実行)*
```markdown
Task(product-value-evaluator)
```
→ 戦略的ビジネス価値評価（全フェーズの知見を統合）

*Phase 6: Integration & Synthesis*
- 全フェーズ結果の統合
- 優先度統合（P0/P1/P2分類）
- 矛盾解決
- 統一改善ロードマップ生成

**Step 3: Tool Integration**
各フェーズで専門ツールを活用:
- Phase 1: `similarity-ts`, `dpdm`, `madge`, complexity analyzers
- Phase 2: Interface analyzers, documentation checkers
- Phase 3: Security scanners, test coverage tools
- Phase 4: Deployment analyzers, monitoring coverage tools
- Phase 5: Business impact frameworks
- Phase 6: Reporting and integration tools

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