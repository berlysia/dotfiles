# TypeScript Project Standards

**Note**: These are recommended standards for new TypeScript projects. For existing projects, respect the project's established tooling choices.

## Tooling

- **Package manager**: `pnpm`
  - Must use `minimalReleaseAge` with value means 1 week in minutes at least
- **Linting**: `oxlint`
- **Formatting**: `prettier`
- **Cleaning**: `knip`

## Testing

- **Browser code**: `Vitest`
- **CLI code**: `node:test` + `node:assert`
  - Run: `node --test ${testfile}`
  - No Bun built-ins allowed

## Type Safety

- **No `any` types**: Use proper type annotations
- **Prefer `async/await`**: Over callbacks and promise chains

## Claude Code Project Setup

### Recommended Hooks

Set up project-level hooks in `.claude/settings.json` to catch errors early:

- **afterEdit type-check**: Run type checker after file edits
  - Prefer project's `typecheck` script if available: `pnpm typecheck`
  - Otherwise use `tsgo` (preferred) or project's type checker (`vitest typecheck`, etc.)
  - Example: `"command": "pnpm typecheck 2>&1 | head -20"`
