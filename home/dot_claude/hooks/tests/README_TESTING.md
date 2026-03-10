# Claude Code Hooks Testing

このディレクトリには、Claude Code TypeScript Hook実装の包括的なテストスイートが含まれています。

## テストファイル構成

### メインテストスイート

- **`integration/run-ts-hook-tests.sh`** - TypeScript Hook統合テスト
- **`integration/test-data/`** - テストデータファイル（JSON）
- **`unit/`** - 単体テスト（未実装）
- **`precommit/test_fast.sh`** - Pre-commitテスト

### CI/CD関連

- **`../scripts/ci_test.sh`** - CI/CD環境での実行用スクリプト
- **`../scripts/all_tests.sh`** - 全テスト実行スクリプト
- **`../scripts/test-with-types.sh`** - 型チェック付きテスト

## テスト実行方法

### 基本実行

```bash
# 型チェック付き全テスト実行（推奨）
../scripts/test-with-types.sh

# 統合テストのみ実行
./integration/run-ts-hook-tests.sh

# CI環境での実行
../scripts/ci_test.sh
```

### 個別Hook実行テスト

```bash
# auto-approve.tsのテスト
echo '{"tool_name": "Bash", "tool_input": {"command": "git status"}}' | bun ../implementations/auto-approve.ts

# block-tsx.tsのテスト
echo '{"tool_name": "Bash", "tool_input": {"command": "npx tsx script.ts"}}' | bun ../implementations/block-tsx.ts
```

## テスト対象Hook実装

### TypeScript化済みHook

- ✅ **auto-approve.ts** - コマンド自動承認/拒否
- ✅ **block-tsx.ts** - tsx/ts-node実行制限
- ✅ **deny-node-modules.ts** - node_modules書き込み制限
- ✅ **block-package-json-tsx.ts** - package.json tsx制限
- ✅ **deny-repository-outside.ts** - リポジトリ外アクセス制限
- ✅ **web-fetch-guardian.ts** - WebFetch制限
- ✅ **command-logger.ts** - コマンド実行ログ
- ✅ **auto-format.ts** - ファイル自動フォーマット
- ✅ **session.ts** - セッション管理
- ✅ **notification.ts** - 通知処理
- ✅ **speak-notification.ts** - 音声通知
- ✅ **user-prompt-logger.ts** - プロンプトログ

## テスト機能

### パターンマッチングテスト

- ✅ Allow/Denyパターンの基本動作
- ✅ 単一コマンドのマッチング
- ✅ GitIgnore形式パターン
- ✅ 複合コマンド処理（&&, ||, ;, |）

### ラッパーコマンド検出テスト

- ✅ `timeout` コマンド内の子コマンド検出
- ✅ `time` コマンド内の子コマンド検出
- ✅ `npx/pnpx/bunx` コマンド内の子コマンド検出
- ✅ `xargs` コマンド内の子コマンド検出
- ✅ `find -exec` 内の子コマンド検出

### セキュリティ機能テスト

- ✅ 危険なコマンドの検出とブロック
- ✅ 全コマンド明示的許可の要求
- ✅ 1つでもDenyされた場合のブロック
- ✅ 許可されていないコマンドのパススルー

### TypeScript型安全性テスト

- ✅ cc-hooks-ts framework統合
- ✅ 型推論の正確性
- ✅ コンパイル時エラーチェック
- ✅ 実行時型検証

## テスト環境

### 技術仕様

- **Runtime**: Bun (主), Node.js (互換)
- **型チェッカー**: tsgo
- **テストフレームワーク**: Bash + JSON test data
- **設定管理**: chezmoi template system

### 環境変数

- `HOOKS_DIR` - テスト対象Hook実装ディレクトリ
- `TEST_DATA_DIR` - テストデータディレクトリ
- `CI_MODE=1` - CI環境モード（詳細出力）

## テストデータファイル

### integration/test-data/

```
test-data/
├── auto-approve-allow.json          # 承認パターンテストデータ
├── block-tsx-package-json-*.json    # package.json tsx制限テスト
├── block-tsx-tsnode-*.json          # tsx/tsnode制限テスト
├── deny-node-modules-*.json         # node_modules制限テスト
└── [hook-name]-[scenario].json      # 各Hookのテストシナリオ
```

### テストデータ形式

```json
{
  "tool_name": "Bash",
  "tool_input": {
    "command": "git status"
  },
  "session_id": "test-session",
  "expected_behavior": "allow|deny|ask"
}
```

## テスト結果の読み方

### 成功時

```
✅ Testing auto-approve.ts...
✅ All TypeScript Hook tests passed!
🎉 Hook system is working correctly.
```

### 型チェック成功

```
🔍 Phase 1: Type Checking
==========================
Type checking: Hook type definitions... PASS
Type checking: Common hook utilities... PASS
```

### 失敗時

```
❌ Testing block-tsx.ts...
FAIL (expected allow, got deny)
❌ Some TypeScript Hook tests failed!
```

## パフォーマンス基準

- **型チェック**: 全ファイル3秒以内
- **統合テスト**: 全Hook実行10秒以内
- **個別テスト**: Hook単体100ms以内
- **メモリ使用量**: テストスイート実行で50MB以内

## トラブルシューティング

### よくある問題

1. **型エラー**

   ```bash
   # 型チェック実行
   npx tsgo --noEmit ../implementations/*.ts
   ```

2. **依存関係エラー**

   ```bash
   # プロジェクトルートから実行
   cd /home/berlysia/.local/share/chezmoi
   echo '{}' | bun dot_claude/hooks/implementations/auto-approve.ts
   ```

3. **テストデータ不正**
   ```bash
   # JSONファイルの検証
   jq . integration/test-data/auto-approve-allow.json
   ```

### デバッグ方法

```bash
# 詳細デバッグ出力
bash -x ./integration/run-ts-hook-tests.sh

# 個別Hookデバッグ
DEBUG=1 echo '{"tool_name": "Bash", "tool_input": {"command": "ls"}}' | bun ../implementations/auto-approve.ts
```

## 新しいテストの追加

### 統合テストケース追加

1. `integration/test-data/` に JSONテストデータを作成
2. `integration/run-ts-hook-tests.sh` にテストケースを追加
3. 期待される動作を明確に指定

### テストデータ例

```json
{
  "description": "新機能のテスト",
  "tool_name": "Bash",
  "tool_input": {
    "command": "new-command --option"
  },
  "session_id": "test-new-feature",
  "expected_exit_code": 0,
  "expected_output_contains": "success"
}
```

### 単体テストの追加

```bash
# tests/unit/ 配下に新しいテストスクリプトを作成
# 例: tests/unit/test_pattern_matching.sh
```

## CI/CD統合

### GitHub Actions例

```yaml
- name: Run TypeScript Hook Tests
  run: |
    cd dot_claude/hooks
    ./scripts/test-with-types.sh
```

### Pre-commit統合

```bash
# .git/hooks/pre-commit に設定
./dot_claude/hooks/tests/precommit/test_fast.sh
```

## パフォーマンス監視

テスト実行時間とメモリ使用量を定期的に監視し、回帰防止を行います。

```bash
# パフォーマンステスト実行
time ./scripts/test-with-types.sh
```
