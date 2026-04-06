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

## Documentation Content

- **コンセプト優先**: 目的・設計意図・使い方を書く。実装詳細は最小限に
- **陳腐化しやすい情報を避ける**: ファイルツリー、タスクリスト、バージョン番号一覧などハードコードしない。`tree`コマンド、`git ls-files`、各ディレクトリのREADME/CLAUDE.mdで動的に得られる情報はドキュメントに複製しない
- **自動導出可能な情報は書かない**: コードや設定ファイルから機械的に得られる情報（関数一覧、設定キー一覧等）はドキュメントに転記しない

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

- **関数型ドメインモデリング優先**: TypeScriptではクラスベースより関数型アプローチを選ぶ
  - Plain objects + discriminated unions で状態を表現（クラスの内部状態は型システムで追跡困難）
  - 純粋関数でドメインロジックを記述し、副作用を境界に押し出す
  - 状態遷移は型で表現する（例: `Draft → Published` を別の型として定義）
  - クラスは外部ライブラリとの統合やフレームワーク要求がある場合のみ使用
- Minimal dependencies, prefer built-ins
- Respect existing architecture, maintain unidirectional dependency graph
- Record significant decisions in ADRs (`docs/decisions/`)
- Abstract repeated patterns, use `similarity-ts` for detection, `knip` for cleaning

## Testing

- Follow t-wada's TDD style (strict Red-Green-Refactor)
- Grep existing tests for similar patterns before writing new ones
- Tests must pass before commits
