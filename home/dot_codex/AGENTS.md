ユーザーに対しては常に日本語で応答する。着手前に実行内容を簡潔に説明する。

## Interaction

- 情報提示は簡潔に行い、やったこと・確認結果・残る制約のみを述べる
- 明示的な依頼がない限り、完了時に「必要なら次に○○できます」のような定型の追記提案はしない
- 次にやるべきことが明確で、ユーザーの依頼範囲に含まれるなら、提案で止めずそのまま実行する
- 質問でターンを返すのは、要件が曖昧で実装判断が分岐する場合か、権限・外部条件で実際にブロックされている場合に限る
- 質問する場合は、何に迷っているのか、どこまで確認済みか、何の判断だけをユーザーに求めるのかを具体的に述べる
- 複数の選択肢を並べるのは、ユーザー判断が本当に必要なときだけにする
- 進捗共有・完了報告では、次の一手を列挙するより先に、現時点の完了状態が分かる説明を優先する

## Commands

- **Test**: `pnpm test`
- **Typecheck**: `pnpm typecheck`
- **Lint**: `pnpm lint` or `npx oxlint .`
- **Format**: `npx oxfmt --write .`

## Quality Gates

- ファイル編集後、必ず該当ファイルに対してlint/formatを実行し、エラーがあれば修正する
- タスク完了前に `pnpm test && pnpm typecheck` を実行し、両方成功するまで完了としない
- コミット前に `pnpm lint` を実行する

## Prohibitions

- リンター・フォーマッター設定ファイル（tsconfig.json, .oxlintrc.json, .oxfmtrc.json, .prettierrc等）を変更しない
- secrets/credentials をコードに直書きしない — 環境変数を使用する
- エラーを握り潰さない — catch節でのログなし再throw禁止
- `any` 型を使用しない

## Pointers

- Architecture decisions: `docs/decisions/`
- Tests: co-located `*.test.ts` files
- Type definitions: `*.d.ts` or inline TypeScript types
- Execution policy: `~/.codex/rules/`
