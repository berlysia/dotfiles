# Global Configuration

## Overview
This file defines global settings for Claude Code. It establishes development standards, workflows, and best practices applied across all projects.

## Language Settings
- Primary interaction language: Japanese
- Technical terms without established translations remain in original language

## Workflow

### Smart Explore-Plan-Code-Commit
1. **Explore**
   - Understand project structure
   - Identify existing patterns and conventions
   - Analyze dependencies and architecture

2. **Plan**
   - Create implementation plan with TodoWrite
   - Break down tasks into appropriate granularity
   - Clarify priorities and dependencies

3. **Code**
   - Follow existing patterns
   - Leverage language idioms
   - Implement robust error handling

4. **Commit**
   - Always run lint and typecheck
   - Ensure tests pass
   - Create meaningful commit messages

## Development Principles

### Coding Style
- Delegate style-level settings to formatters
- Keep naming clear and minimal
- Actively use language idioms
- Comments explain "why", not "what"
- Document technical core aspects (algorithms, design decisions, trade-offs) in detail

### Development Efficiency
- Prioritize developer time above all
- Detect repeated patterns and suggest abstractions
- Encourage scripting for repetitive tasks

### Performance & Quality
- Address performance bottlenecks preemptively
- Suggest additions when error handling is insufficient
- Actively identify opportunities for parallelization and caching

### Library Selection
- Select optimal minimal libraries that meet project requirements

### Architecture
- Reflect emerging implementation patterns in overall design
- Identify technical debt and present refactoring plans
- Create and maintain ADR (Architecture Decision Records)

### Automation
- Implement common workflows with GitHub Actions
- Create custom scripts and lint rules based on project requirements

### Documentation
- Generate comprehensive documentation
- Create README files per unit of concern
- Keep code comments minimal for obvious parts, detailed for technical core
- Auto-generate API specifications (OpenAPI/Swagger)
- Maintain changelog and migration guides

## Language-Specific Guidelines

### TypeScript/JavaScript
- **Toolchain**: npm/pnpm, tsgo (native TypeScript compiler), biome, oxlint
- **Best Practices**:
  - Prioritize type safety
  - Avoid using `any`
  - Utilize optional chaining and nullish coalescing
  - Prefer async/await over Promise chains
  - Use tsgo for fast type checking and builds
- **Testing**: Vitest, node:test (for CLI tools), or follow existing project configuration
- **Documentation**: Document only complex logic and algorithms in detail with JSDoc

## Security & Quality Standards

### NEVER Do
- Hard-code passwords or API keys
- Use user input without validation
- Suppress errors without logging
- Ignore type safety
- Make significant changes without tests

### MUST Do
- Validate all external input
- Manage sensitive information via environment variables
- Log errors appropriately and return meaningful messages to users
- Run lint/typecheck before commits
- Add tests for new features

### Pre-commit Checklist
- [ ] All tests pass
- [ ] No lint/typecheck errors
- [ ] No sensitive information included
- [ ] Meaningful commit message
- [ ] Breaking changes clearly noted

## Efficiency Metrics

### Time Savings Tracking
- Record time saved through automation
- Measure reduction rate of repetitive work
- Track reduction in boilerplate code

### Regular Improvement Analysis
- Analyze codebase improvements weekly
- Identify and resolve performance bottlenecks
- Quantify and plan technical debt reduction

### Custom Helper Suggestions
- Detect frequently used patterns
- Suggest project-specific utility functions
- Recommend scripting common tasks

## Proactive Improvement Suggestions

### Automated Code Review Checks
- Detect unused variables and functions
- Identify high-complexity functions
- Find duplicate code and suggest consolidation

### Performance Optimization
- Detect and resolve N+1 queries
- Prevent unnecessary re-rendering
- Identify potential memory leaks
- Suggest improvements for inefficient algorithms

### Refactoring Candidates
- Split oversized functions and classes
- Organize dependencies and promote loose coupling
- Identify design pattern application opportunities
- Point out test coverage improvement areas

## Error Handling & Logging Strategy

### Structured Logging
- Output logs in JSON format
- Use appropriate log levels (ERROR, WARN, INFO, DEBUG)
- Include context information (user ID, request ID, etc.)
- Record performance metrics

### Error Boundaries & Fallbacks
- Frontend: Implement Error Boundaries
- Backend: Global error handlers
- Return appropriate HTTP status codes
- Provide user-friendly error messages

### Monitoring & Alerts
- Configure immediate notifications for critical errors
- Detect performance degradation
- Identify abnormal traffic patterns
- Define and monitor SLO/SLI