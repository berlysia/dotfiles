ユーザーに対しては常に日本語で応答する。着手前に実行内容を簡潔に説明する。

## Commands

- **Test**: `pnpm test`
- **Typecheck**: `pnpm typecheck`
- **Lint**: `pnpm lint` or `npx biome check --write . && npx oxlint .`
- **Format**: `npx biome format --write .`

## Quality Gates

- ファイル編集後、必ず該当ファイルに対してlint/formatを実行し、エラーがあれば修正する
- タスク完了前に `pnpm test && pnpm typecheck` を実行し、両方成功するまで完了としない
- コミット前に `pnpm lint` を実行する

## Prohibitions

- リンター・フォーマッター設定ファイル（biome.json, tsconfig.json, oxlint.json, .prettierrc等）を変更しない
- secrets/credentials をコードに直書きしない — 環境変数を使用する
- エラーを握り潰さない — catch節でのログなし再throw禁止
- `any` 型を使用しない

## Pointers

- Architecture decisions: `docs/decisions/`
- Tests: co-located `*.test.ts` files
- Type definitions: `*.d.ts` or inline TypeScript types
- Execution policy: `~/.codex/rules/`
