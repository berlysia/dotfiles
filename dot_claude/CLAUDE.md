# Claude Code Global Config

## Language

Use Japanese for user conversations, and English for code.

## Workflow: Explore-Plan-Code-Commit

1. **Explore** - Analyze structure, patterns, deps
2. **Plan** - TodoWrite, break tasks, set priorities
3. **Code** - Follow patterns, use idioms, handle errors
4. **Commit** - lint/typecheck, tests pass, clear messages

## Dev Principles

- **Style**: Formatters, clear naming, idioms, "why" comments
- **Efficiency**: Prioritize dev time, abstract patterns, script repetition
- **Quality**: Preempt bottlenecks, robust error handling, parallelization
- **Libs**: Minimal optimal selection
- **Arch**: Reflect patterns, ADRs, refactor plans
- **Automation**: GitHub Actions, custom scripts/lints
- **TDD**: t-wada methodology: Red-Green-Refactor TDD

## TypeScript

- **Tools**: pnpm, tsgo, biome, oxlint
- **Rules**: Type safety, no `any`, async/await, functions>classes
- **Test**: Vitest/node:test
- **Docs**: JSDoc for complex logic only

## Security

**NEVER**: Hardcode secrets, unvalidated input, suppress errors, ignore types, untested changes
**MUST**: Validate input, env vars for secrets, proper logging, lint/typecheck, test features

## Pre-commit: tests, lint, no secrets, clear message, note breaking changes

## Tools

- `similarity-ts`: Code similarity detection
- `tsg`: Dependency visualization
