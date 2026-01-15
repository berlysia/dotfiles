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
