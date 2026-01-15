# CLAUDE.md Best Practices

Comprehensive guidelines for writing effective CLAUDE.md files based on Claude Code official documentation.

## Table of Contents

1. [Writing Style Principles](#writing-style-principles)
2. [Memory Hierarchy](#memory-hierarchy)
3. [Modularity with .claude/rules/](#modularity-with-clauderules)
4. [Import System](#import-system)
5. [Periodic Review Checklist](#periodic-review-checklist)
6. [Anti-Patterns to Avoid](#anti-patterns-to-avoid)

## Writing Style Principles

### 1. Be Specific

**Replace vague instructions with concrete examples.**

❌ Bad:
```markdown
- Format code properly
- Use good naming conventions
- Handle errors appropriately
```

✅ Good:
```markdown
- Use 2-space indentation for JavaScript
- Name functions with verb prefix: `fetchUserData()`, `validateEmail()`
- Wrap async operations in try-catch with specific error messages
```

**Guideline:** Every instruction should be actionable without interpretation.

### 2. Use Structure to Organize

**Group related information under descriptive headings.**

❌ Bad:
```markdown
Instructions:
- Use TypeScript
- Run tests before commit
- Follow REST conventions
- Document all functions
- Use semantic versioning
- No console.logs in production
```

✅ Good:
```markdown
## Language Standards
- Use TypeScript with strict mode enabled
- Document all public functions with JSDoc

## Development Workflow
- Run `npm test` before every commit
- Follow semantic versioning (semver)

## API Design
- Follow REST conventions for endpoints
- No console.logs in production code
```

**Guideline:** Hierarchical structure makes instructions easier to scan and reference.

### 3. Include Concrete Examples

**Show, don't just tell.**

❌ Bad:
```markdown
Use async/await for asynchronous operations
```

✅ Good:
```markdown
Use async/await for asynchronous operations:
```typescript
async function fetchUser(id: string) {
  try {
    const response = await fetch(`/api/users/${id}`);
    return await response.json();
  } catch (error) {
    logger.error('Failed to fetch user', { id, error });
    throw error;
  }
}
```
```

**Guideline:** Examples reduce ambiguity and show the expected pattern.

### 4. Avoid Unnecessary Context

**Assume Claude is smart; don't explain common knowledge.**

❌ Bad:
```markdown
Git is a distributed version control system that tracks changes
in source code during software development. When you want to
save your changes, you need to commit them. A commit is a
snapshot of your code at a specific point in time...
```

✅ Good:
```markdown
## Git Workflow
- Use conventional commits: `feat:`, `fix:`, `refactor:`
- Squash WIP commits before merging
- Run `git rebase -i main` to clean up branch history
```

**Guideline:** Only include information Claude doesn't already have.

### 5. Keep Instructions Evergreen

**Avoid time-sensitive information that will become outdated.**

❌ Bad:
```markdown
- Use React 18 features
- Target Node.js 16 LTS
- Use the latest TypeScript 4.9 syntax
```

✅ Good:
```markdown
- Prefer React hooks over class components
- Use ES modules (import/export) over CommonJS
- Enable strict TypeScript compiler options
```

**Guideline:** Focus on principles and patterns, not version numbers.

## Memory Hierarchy

Claude Code loads memory files in a specific order, with higher priority files loaded first.

### Memory Types

| Type | Location | Purpose | Shared With |
|------|----------|---------|-------------|
| **Enterprise** | `/Library/Application Support/ClaudeCode/` (macOS)<br>`/etc/claude-code/` (Linux)<br>`C:\Program Files\ClaudeCode\` (Windows) | Organization-wide policies | All users |
| **Project** | `./CLAUDE.md` or `./.claude/CLAUDE.md` | Team-shared instructions | Team via git |
| **Project Rules** | `./.claude/rules/*.md` | Modular project instructions | Team via git |
| **User** | `~/.claude/CLAUDE.md` | Personal preferences (all projects) | Just you |
| **Project Local** | `./CLAUDE.local.md` | Personal project preferences | Just you (gitignored) |

### When to Use Each Location

**Enterprise Policy:**
- Security requirements
- Compliance standards
- Approved technology stack

**Project Memory (`./CLAUDE.md` or `./.claude/CLAUDE.md`):**
- Project architecture patterns
- Team coding standards
- Common commands (build, test, deploy)
- Git workflow conventions

**Project Rules (`./.claude/rules/*.md`):**
- Language-specific guidelines
- Framework conventions
- Path-specific rules (e.g., only for `src/api/**/*.ts`)

**User Memory (`~/.claude/CLAUDE.md`):**
- Your personal code style preferences
- Shortcuts you frequently use
- Tooling you prefer across all projects

**Project Local (`./CLAUDE.local.md`):**
- Your local dev environment specifics
- Personal test data or credentials
- Temporary notes (not committed to git)

### Hierarchy Resolution

Claude Code reads CLAUDE.md files recursively:

1. **Starting directory:** Current working directory
2. **Upward recursion:** Walks up to (but not including) root `/`
3. **Subtree discovery:** Nested CLAUDE.md loaded when reading those files

**Example directory structure:**
```
/workspace/
├── CLAUDE.md              # Loaded at launch (workspace-wide)
└── my-project/
    ├── CLAUDE.md          # Loaded at launch (project-specific)
    └── src/
        ├── CLAUDE.md      # Loaded when reading src/ files
        └── api/
            └── CLAUDE.md  # Loaded when reading src/api/ files
```

**Use `/memory` command to see which files are currently loaded.**

## Modularity with .claude/rules/

For large projects, split instructions into focused rule files.

### Basic Structure

```
your-project/
├── .claude/
│   ├── CLAUDE.md           # Core project instructions
│   └── rules/
│       ├── typescript.md   # TypeScript guidelines
│       ├── testing.md      # Testing conventions
│       ├── api-design.md   # API standards
│       └── frontend/
│           ├── react.md    # React patterns
│           └── styling.md  # CSS/styling rules
```

**All `.md` files in `.claude/rules/` are automatically loaded as project memory.**

### When to Split into Rules

Consider splitting when:
- CLAUDE.md exceeds 500 lines
- You have distinct topics (frontend, backend, testing, etc.)
- Different file types need different guidelines
- Team members maintain different rule areas

### Path-Specific Rules

Scope rules to specific files using YAML frontmatter.

**Example: API-specific rules**
```markdown
---
paths:
  - "src/api/**/*.ts"
  - "lib/api/**/*.ts"
---

# API Development Standards

- All endpoints must validate input with Zod schemas
- Use standard error response format:
  ```typescript
  { error: string; code: string; details?: unknown }
  ```
- Include OpenAPI documentation comments
```

**Example: Test-specific rules**
```markdown
---
paths:
  - "**/*.test.ts"
  - "**/*.spec.ts"
---

# Testing Standards

- Use AAA pattern (Arrange, Act, Assert)
- Mock external dependencies with vi.mock()
- Test edge cases and error conditions
```

**Glob Pattern Support:**
- `**/*.ts` - All TypeScript files
- `src/**/*` - All files under src/
- `*.{ts,tsx}` - TypeScript and TSX files
- `{src,lib}/**/*.ts` - Multiple directories

**Rules without `paths` are loaded unconditionally.**

### Subdirectories and Organization

```
.claude/rules/
├── backend/
│   ├── api.md
│   ├── database.md
│   └── auth.md
├── frontend/
│   ├── react.md
│   ├── styling.md
│   └── state-management.md
├── testing/
│   ├── unit-tests.md
│   └── integration-tests.md
└── general.md
```

### Symlinks for Shared Rules

Share common rules across projects:

```bash
# Link to shared company standards
ln -s ~/company-standards/security.md .claude/rules/security.md

# Link to personal conventions
ln -s ~/.claude/rules/my-style.md .claude/rules/personal.md
```

## Import System

Use `@path/to/file` syntax to import additional context.

### Basic Import Syntax

```markdown
See @README.md for project overview
See @package.json for available npm commands

# Architecture
Refer to @docs/architecture.md for system design
```

### Relative and Absolute Paths

```markdown
# Relative to current file
@../docs/api-spec.md
@./examples/authentication.md

# Absolute paths
@/workspace/docs/deployment.md

# Home directory
@~/.claude/my-conventions.md
```

### Import Best Practices

1. **Import from stable locations:**
   - ✅ `@README.md` (project root)
   - ✅ `@docs/architecture.md` (versioned docs)
   - ❌ `@/tmp/notes.txt` (temporary files)

2. **Use imports for large reference docs:**
   ```markdown
   For API reference, see @docs/api-reference.md
   For examples, see @examples/usage-patterns.md
   ```

3. **Import personal preferences from home:**
   ```markdown
   # Team members can add personal conventions
   @~/.claude/my-project-preferences.md
   ```

4. **Recursive imports (max 5 hops):**
   ```markdown
   # File A
   @file-b.md

   # File B
   @file-c.md  # Still works

   # File C
   @file-d.md  # 3 hops deep, OK
   ```

### Imports vs .claude/rules/

**Use imports when:**
- Content is large but rarely needed
- Documentation lives outside `.claude/`
- Personal preferences in home directory

**Use .claude/rules/ when:**
- Instructions are always relevant
- Team should see rules in version control
- You want path-specific scoping

## Periodic Review Checklist

Review CLAUDE.md regularly to keep instructions fresh and relevant.

### Quarterly Review (Every 3 Months)

- [ ] **Remove outdated instructions**
  - Check for deprecated libraries or patterns
  - Remove references to old tools or versions

- [ ] **Add new patterns**
  - Document new conventions adopted by team
  - Add examples of recently solved problems

- [ ] **Check for redundancy**
  - Consolidate duplicate instructions
  - Remove instructions that are now obvious

- [ ] **Update examples**
  - Ensure code examples use current syntax
  - Verify examples still work with current dependencies

- [ ] **Review organization**
  - Is structure still logical?
  - Would splitting/merging sections help?

### After Major Changes

- [ ] **New team member joins**
  - Are onboarding instructions clear?
  - Do we document all non-obvious conventions?

- [ ] **Technology stack changes**
  - Update language/framework guidelines
  - Add migration patterns if applicable

- [ ] **Project architecture evolves**
  - Document new architectural patterns
  - Update examples to match new structure

### Signs CLAUDE.md Needs Attention

🚩 Claude frequently asks questions answered in CLAUDE.md
🚩 Team members aren't following documented conventions
🚩 Instructions contradict actual codebase patterns
🚩 File exceeds 1000 lines without modularity
🚩 Instructions reference deprecated tools or patterns

## Anti-Patterns to Avoid

### 1. Tutorial-Style Explanations

❌ Bad:
```markdown
TypeScript is a superset of JavaScript that adds static typing.
It was developed by Microsoft and released in 2012. TypeScript
compiles to JavaScript, which means...
```

✅ Good:
```markdown
## TypeScript Standards
- Enable `strict: true` in tsconfig.json
- No `any` types; use `unknown` for truly dynamic values
- Prefer interfaces for object shapes, types for unions
```

### 2. Vague Quality Statements

❌ Bad:
```markdown
- Write clean code
- Use best practices
- Follow good design patterns
- Make it maintainable
```

✅ Good:
```markdown
- Functions should do one thing (single responsibility)
- Extract magic numbers to named constants
- Keep files under 300 lines; split larger files
- Add JSDoc for all exported functions
```

### 3. Copying Framework Documentation

❌ Bad:
```markdown
React hooks are functions that let you "hook into" React state
and lifecycle features from function components. Here's how
useState works...

[Copies entire React docs]
```

✅ Good:
```markdown
## React Conventions
- Prefer function components with hooks
- Extract custom hooks for reusable logic
- Use `useCallback` for event handlers in memoized components
- Colocate hooks with components (don't create separate hooks/ dir)
```

### 4. Overly Generic Instructions

❌ Bad:
```markdown
- Follow project conventions
- Use the same style as existing code
- Ask before making architectural changes
```

✅ Good:
```markdown
- Match indentation (2 spaces for JS/TS, 4 spaces for Python)
- Place utilities in `src/lib/`, components in `src/components/`
- For architectural changes, document decision in docs/decisions/
```

### 5. Instruction Pollution

❌ Bad:
```markdown
When you commit code, first you need to stage your changes with
git add, then you write a commit message. The commit message should
be descriptive. Then you push to the remote repository. Before pushing,
you should pull to get the latest changes...
```

✅ Good:
```markdown
## Commit Standards
- Use conventional commits: `feat:`, `fix:`, `refactor:`
- Run `npm test` before committing
- Squash WIP commits before merging to main
```

### 6. Inconsistent Terminology

❌ Bad:
```markdown
- Place helpers in utils/ directory
- Add utility functions to lib/ folder
- Store shared code in common/ directory
```

✅ Good:
```markdown
- Place all utility functions in src/lib/
- Examples: src/lib/date-utils.ts, src/lib/string-utils.ts
```

### 7. Missing Context Boundaries

❌ Bad:
```markdown
# Instructions apply to everything
Use functional programming style
Avoid mutations
Prefer immutability
```

✅ Good:
```markdown
---
paths:
  - "src/**/*.ts"
---
# TypeScript Code Standards
Use functional programming style where practical:
- Prefer `map/filter/reduce` over loops
- Use `const` by default
- Treat data structures as immutable

Note: Performance-critical code (src/engine/) may use mutations
```

## Measuring Effectiveness

**Good CLAUDE.md results in:**
- Claude follows conventions without repeated reminders
- New team members onboard faster
- Consistent code style across contributors
- Fewer "how should I do X?" questions

**Warning signs:**
- Claude ignores documented patterns
- Team members don't reference CLAUDE.md
- Instructions contradict actual codebase
- Frequently needs updates to fix Claude's behavior

**Use `/memory` command to verify which instructions are loaded.**

## Additional Resources

- Official docs: https://code.claude.com/docs/en/memory
- Common workflows: https://code.claude.com/docs/en/common-workflows
- Skill builder patterns: skill-builder/PATTERNS.md

---

**Last updated:** 2026-01 (Review periodically as Claude Code evolves)
