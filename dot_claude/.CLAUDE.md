# Development Guidelines

## Language
- Japanese for discussion, English for code

## Workflow
1. **Explore** - Understand codebase and requirements
2. **Plan** - Design solution with clear steps
3. **Code** - Implement following best practices
4. **Commit** - Clean, meaningful commits

## Development Principles

### Code Quality
- Clean formatting, descriptive names, idiomatic patterns
- Comments explain why code exists (its purpose), not what changed
- Comprehensive error handling and parallelization

### Developer Experience
- Minimize developer friction
- Thorough planning before implementation
- Root cause analysis for bug fixes
- Create scripts for repetitive tasks

### Architecture
- **Libraries**: Minimal dependencies, prefer built-ins
- **Design**: Respect existing architecture, maintain unidirectional dependency graph
- **Documentation**: Record significant decisions in ADRs (Architecture Decision Records)
- **Patterns**: Abstract repeated patterns, use tools like `similarity-ts` for detection

### Testing
- Follow t-wada's TDD style
- Strict Red-Green-Refactor cycle
- Tests must pass before commits

## TypeScript Standards
- Package manager: `pnpm`
- Linting: `biome`
- Testing for browser: `Vitest`
- Testing for CLI: `node:test`
- No `any` types
- Prefer `async/await`

## Security Requirements
- **Prohibited**: Hardcoded secrets, unvalidated inputs, suppressed errors
- **Required**: Input validation, environment variables, comprehensive logging, passing lint/test

## Git Workflow

### Worktree Management
- **Create**: `git-worktree-create <branch-name>`
  - Location: `.git/worktree/` directory
  - Auto-creates branch from current if needed
  - Uses existing local/remote branches when available
  
- **Cleanup**: `git-worktree-cleanup`
  - Safely removes completed worktrees
  - Preserves worktrees with uncommitted changes or unpushed commits
  - Auto-prunes after deletion

### Commit Standards
- All tests and lints must pass
- Clear, descriptive commit messages

## Useful Commands

### File Processing
- **mapfile**: Read lines into array
  - `mapfile -t array < <(command)`
  - `mapfile -t files < <(find . -name "*.js")`

- **tee**: Output to file and stdout
  - `command | tee file.txt`
  - `command | tee -a file.txt` (append)

### Code Analysis
- **similarity-ts**: Detect code duplication
  - `similarity-ts src/`
  - `similarity-ts --threshold 0.8 src/`

## Knowledge Management
- Record learnings in `.claude/memory/<timestamp>-<summary>.md`

## MCP (Model Context Protocol) Tools

### Available MCP Servers
- **readability**: Web content extraction
  - `mcp__readability__read_url_content_as_markdown` - Extract content from URLs as Markdown
  - Useful for reading documentation and blog articles

- **playwright**: Browser automation
  - Web page manipulation and screenshot capture
  - Visual verification of CSS implementation results

- **context7**: Context management
  - Up-to-date documentation for any library

### MCP Best Practices
1. **Web Information Gathering**: Prefer readability MCP tool over WebFetch
2. **Browser Operations**: Use playwright for dynamic content instead of simple HTTP requests
3. **Resource Discovery**: Check available resources with `ListMcpResourcesTool`
4. **Error Handling**: Consider fallback strategies when MCP tools fail