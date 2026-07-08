# TypeScript Project Standards

**Note**: These are recommended standards for new TypeScript projects. For existing projects, respect the project's established tooling choices.

## Tooling

- **TypeScript**: TypeScript 7 (native). `npm install -D typescript` installs the Go-based native compiler; the command remains `tsc`.
  - Programmatic-API-dependent tools (typescript-eslint, Vue/Svelte/Astro/MDX, Angular template checking, etc.) need the JS implementation until 7.1's API ships. Bridge with `npm install -D typescript@npm:@typescript/typescript6` (exposes `tsc6`) and keep it alongside 7.
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
- **`types` defaults to `[]`**: Declare needed ambient type packages explicitly in `tsconfig.json`
- **Avoid removed options**: Do not use `target: es5`, `downlevelIteration`, `moduleResolution: node`/`node10`/`classic`, or `module: amd/umd/system` — they are hard errors in 7. Set `rootDir` explicitly.

## Claude Code Project Setup

### Recommended Hooks

Set up project-level hooks in `.claude/settings.json` to catch errors early:

- **afterEdit type-check**: Run type checker after file edits
  - Prefer project's `typecheck` script if available: `pnpm typecheck`
  - Otherwise use `tsc --noEmit` (TypeScript 7 native) or project's type checker (`vitest typecheck`, etc.)
  - Example: `"command": "pnpm typecheck 2>&1 | head -20"`
