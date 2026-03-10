# Code Quality Rules

## Formatting

Use project formatter (biome/prettier/oxfmt as configured). Enforced by PostToolUse hook.

## Naming

- Variables: descriptive nouns (`userData` not `data`)
- Functions: verb-object with intent clarity
  - Async/side-effects: `fetchUserData`, `createUser`, `updateProfile`
  - Synchronous/pure: `getUserName`, `calculateTotal`, `formatDate`
- Types: PascalCase interfaces (`UserProfile` not `IUserProfile`)

## Comments

- **WHYを説明**: コードの理由・背景・制約を記述する
- **型システム尊重**: TypeScript型定義から自明な情報はコメントで重複しない
- **ビジネスロジック重視**: ドメイン知識・設計決定・トレードオフの説明に集中
- **差分ではなく現状を説明する**: 変更適用後のコードが何をしているかに対して説明する

## Communication Accuracy

In GitHub Issues, PR descriptions, and documentation, clearly distinguish observed facts from speculation. Never assert unverified claims as definitive statements.

## Error Handling

- Use typed errors (Error subclasses or discriminated unions)
- Log errors with context before propagating
- Avoid silent failures or generic catch-all handlers

## Performance

Parallelize independent operations with Promise.all()

## Serialization/Transformation

When editing data conversion logic, verify edge cases for data preservation — special characters, optional fields, and nested structures are common loss points.

## No Speculative Compatibility

Do not implement backward compatibility, fallbacks, or migration shims unless explicitly requested.

## Security

- **Prohibited**: Hardcoded secrets, unvalidated inputs, suppressed errors
- **Required**: Input validation, env vars for secrets, structured logging, all tests/lints passing

## Architecture

- Minimal dependencies, prefer built-ins
- Respect existing architecture, maintain unidirectional dependency graph
- Record significant decisions in ADRs (`docs/decisions/`)
- Abstract repeated patterns, use `similarity-ts` for detection, `knip` for cleaning

## Testing

- Follow t-wada's TDD style (strict Red-Green-Refactor)
- Grep existing tests for similar patterns before writing new ones
- Tests must pass before commits
