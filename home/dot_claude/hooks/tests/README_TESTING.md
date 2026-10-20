# Claude Code Hooks Testing

Claude Code の TypeScript Hook 実装のテスト。`node:test` と `node:assert` で書き、リポジトリルートから実行する。パスはリポジトリルート相対で書く。

## テストファイル構成

- `home/dot_claude/hooks/tests/unit/` - 単体テスト（`*.test.ts`）
- `home/dot_claude/hooks/tests/perf/` - 実時間・線形時間のテスト（`*.test.ts`）
- `home/dot_claude/hooks/tests/support/` - unit と perf が共有する helper（`*.test.ts` にしない）
- `home/dot_claude/hooks/tests/__fixtures__/` - テストが読む固定データ
- `home/dot_claude/hooks/tests/preload-test-env.mjs` - 全テストプロセスの前に読み込む環境の準備

## node:test のスイート（unit / perf）

- `bun run test`: `home/dot_claude/hooks/tests/unit/*.test.ts` を並列に実行する。completion gate と pre-commit が実行するのはこれだけで、経過時間を assert するテストは置かない（`home/dot_claude/hooks/tests/unit/test-layout.test.ts` が検査する）
- `bun run test:perf`: `home/dot_claude/hooks/tests/perf/*.test.ts` をファイルごとに直列で実行する。ReDoS などの線形時間ガードと、ラッパーの実時間の検証を置く。CI（`ci-typescript.yml`）と `bun run check` が実行する
- unit と perf が共有する helper は `home/dot_claude/hooks/tests/support/` に置く（`*.test.ts` にしない）
- テストのプロセスでは bash-parser の解析予算が 10 秒になる（`preload-test-env.mjs`）。本番の 100 ms で測るテストは `home/dot_claude/hooks/tests/perf/parse-budget.test.ts` に置く

`preload-test-env.mjs` は、テストファイルごとに `CLAUDE_LOGS_DIR` を使い捨てのディレクトリへ向ける（hook のログが開発者の `~/.claude/logs/` に書かれないようにするため）。また git が hook に渡す `GIT_DIR` などの変数を消す（pre-commit から実行したとき、テストが起動する `git` がコミット中のリポジトリを書き換えないようにするため）。

## テスト実行方法

```bash
# unit テスト
bun run test

# perf テスト
bun run test:perf

# 型チェック
bun run typecheck

# unit・perf・型チェック・lint をまとめて
bun run check

# 個別のテストファイル
node --import ./home/dot_claude/hooks/tests/preload-test-env.mjs --test home/dot_claude/hooks/tests/unit/session.test.ts
```

### 個別 Hook の手動実行

```bash
echo '{"tool_name": "Bash", "tool_input": {"command": "git status"}}' | bun home/dot_claude/hooks/implementations/auto-approve.ts
```

## 新しいテストの追加

1. 既存のテストで似た形のものを探して、構成を合わせる
2. `home/dot_claude/hooks/tests/unit/<対象>.test.ts` に書く。経過時間を測るものは `home/dot_claude/hooks/tests/perf/` に置く
3. unit と perf で共有する helper は `home/dot_claude/hooks/tests/support/` に置く
4. 構成の書き方は `home/dot_claude/hooks/tests/unit/README.md` を参照
