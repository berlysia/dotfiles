# sed -i コマンドの自動承認機能

## 概要

`sed -i` コマンドの対象ファイルが `Edit` または `MultiEdit` ツールの許可パターンにマッチする場合、自動的に承認する機能を実装しました。

## 動機

Claude Codeの使用中、`sed -i` コマンドは毎回手動承認が必要でした。しかし、Editツールで編集が許可されているファイルに対しては、同等の操作である `sed -i` も自動承認して良いはずです。

## 設計方針

### 厳格な検証（偽陽性を許容）

セキュリティを重視し、疑わしい場合は手動レビューに回します。

- **対象コマンド**: `sed -i` のみ（in-place編集のみ）
- **グロブパターン**: 自動承認対象外（手動レビュー必須）
- **複数ファイル**: 全てのファイルが許可パターンにマッチする場合のみ承認

## アーキテクチャ

### コンポーネント

1. **sed-parser.ts**: `sed -i` コマンドの構文解析
2. **file-permission-inference.ts**: ファイル権限の推論ロジック
3. **auto-approve.ts**: メインの自動承認ロジックとの統合

### 処理フロー

```
Bashコマンド受信
  ↓
危険コマンドチェック
  ↓
Denyパターンチェック
  ↓
sed -i 推論チェック ←【新機能】
  ├─ sedパーサー: コマンドを解析
  ├─ グロブ検出: *.txt などを除外
  ├─ ファイルパス抽出: 対象ファイルを取得
  └─ 権限推論: Edit/MultiEditパターンとマッチング
      ├─ 全てマッチ → allow
      └─ 一部マッチしない → pass（Claude Codeに委譲）
  ↓
Allowパターンチェック
  ↓
Pass（Claude Codeに委譲）
```

## 実装詳細

### 1. sed-parser.ts

#### 主要機能

- `parseSedInPlace(command: string): SedInPlaceParseResult`
  - `sed -i` コマンドの構文を解析
  - 対象ファイルパスを抽出
  - グロブパターン（`*`, `?`, `[...]`, `{...}`）を検出
  - バックアップ拡張子（`-i.bak`）の処理

#### サポートする構文

```bash
sed -i 's/pattern/replacement/' file.txt          # 基本形
sed -i.bak 's/pattern/replacement/' file.txt      # バックアップ付き
sed -i '' 's/pattern/replacement/' file.txt       # macOS形式
sed -i -e 'cmd1' -e 'cmd2' file1.txt file2.txt   # 複数コマンド、複数ファイル
```

#### 除外される構文

```bash
sed -i 's/foo/bar/' *.txt            # グロブパターン（手動レビュー）
sed 's/foo/bar/' file.txt            # -iなし（対象外）
```

### 2. file-permission-inference.ts

#### 主要機能

- `checkFilePermissions(filePaths: string[], allowPatterns: string[]): FilePermissionCheckResult`
  - ファイルパスリストと許可パターンリストを受け取る
  - 各ファイルが `Edit(...)` または `MultiEdit(...)` パターンにマッチするかチェック
  - 全ファイルが許可されているか判定

#### パターンマッチング

既存の `matchGitignorePattern()` を使用して、Gitignoreスタイルのパターンマッチングを実現:

- `./**`: カレントディレクトリ配下すべて
- `src/**`: srcディレクトリ配下すべて
- `/absolute/path/**`: 絶対パスパターン

### 3. auto-approve.ts の拡張

#### 追加ロジック

`processBashCommand()` 関数内に、Denyパターンチェックの後、Allowパターンチェックの前に挿入:

```typescript
// sed -i コマンドの権限推論チェック
if (cmd.includes("sed") && cmd.includes("-i")) {
  const sedResult = parseSedInPlace(cmd);

  if (sedResult.isSedInPlace &&
      !sedResult.containsGlob &&
      !sedResult.parseError &&
      sedResult.targetFiles.length > 0) {

    // Edit/MultiEditパターンを取得
    const editPermissions = getPermissionLists("Edit");
    const multiEditPermissions = getPermissionLists("MultiEdit");
    const editAllowList = [...editPermissions.allowList, ...multiEditPermissions.allowList];

    // ファイル権限チェック
    const permResult = checkFilePermissions(sedResult.targetFiles, editAllowList);

    if (permResult.allFilesPermitted) {
      return {
        type: "allow",
        command: cmd,
        pattern: `sed -i inferred from Edit permissions (files: ${sedResult.targetFiles.join(", ")})`,
      };
    }
  }
}
```

## 使用例

### 自動承認される例

```bash
# Edit(src/**) が許可されている場合
sed -i 's/foo/bar/' src/utils.ts          # ✅ 自動承認
sed -i 's/foo/bar/' src/a.ts src/b.ts     # ✅ 自動承認（全てマッチ）
sed -i.bak 's/foo/bar/' src/utils.ts      # ✅ 自動承認（バックアップ付き）
```

### 手動レビューに回される例

```bash
# Edit(src/**) が許可されている場合
sed -i 's/foo/bar/' src/*.ts              # ❌ グロブパターン
sed -i 's/foo/bar/' config.json           # ❌ 許可外のファイル
sed -i 's/foo/bar/' src/a.ts config.json  # ❌ 混在（一部許可外）
```

## テスト

### テストカバレッジ

- **sed-parser.test.ts**: 23テスト（全てパス）
  - 基本構文、バックアップ拡張子、複数ファイル、グロブ検出など

- **file-permission-inference.test.ts**: 17テスト（全てパス）
  - パターンマッチング、複数ファイル、エッジケースなど

- **auto-approve.test.ts**: 10テスト（sed -i関連、全てパス）
  - 統合テスト、Edit/MultiEditパターン、優先順位など

### テスト実行

```bash
# 個別テスト
node --test tests/unit/sed-parser.test.ts
node --test tests/unit/file-permission-inference.test.ts

# 統合テスト
CLAUDE_TEST_MODE=1 node --test tests/unit/auto-approve.test.ts
```

## 設定例

### グローバル設定（~/.claude/settings.json）

```json
{
  "permissions": {
    "allow": [
      "Edit(./**)",
      "MultiEdit(src/**)",
      "Bash(git *)",
      "Bash(pnpm *)"
    ],
    "deny": [
      "Edit(~/.claude/**)",
      "Bash(rm *)"
    ]
  }
}
```

### プロジェクト設定（.claude/settings.json）

```json
{
  "permissions": {
    "allow": [
      "Edit(src/**)",
      "Edit(tests/**)",
      "MultiEdit(**/*.test.ts)"
    ]
  }
}
```

## セキュリティ考慮事項

### 手動レビューに回すケース

- グロブパターンを含む（`*.txt`, `file?.txt` など）
- 一つでも許可外のファイルを含む
- `sed -i` の構文解析に失敗
- ファイルパスの抽出に失敗

### リスク軽減策

- 厳密な構文解析（失敗時は手動レビュー）
- 既存の危険コマンドチェックとの併用
- 決定ログへの記録（`~/.claude/logs/decisions.jsonl`）
- 包括的なテストカバレッジ

## トラブルシューティング

### sed -i が自動承認されない場合

1. **Editパターンの確認**
   ```bash
   cat ~/.claude/settings.json | jq '.permissions.allow'
   ```

2. **ファイルパスの確認**
   - 相対パスと絶対パスの違いに注意
   - `./**` はカレントディレクトリ配下すべてにマッチ
   - `src/**` はsrcディレクトリ配下すべてにマッチ

3. **デバッグログの確認**
   ```bash
   tail -f ~/.claude/logs/decisions.jsonl
   ```

## 今後の拡張可能性

- 他のファイル編集コマンド（`awk -i`, `perl -i`）への拡張
- より高度なグロブパターンのサポート（安全性の検証後）
- ファイルパスの正規化改善

## 関連リンク

- [auto-approve.ts](../implementations/auto-approve.ts)
- [sed-parser.ts](../lib/sed-parser.ts)
- [file-permission-inference.ts](../lib/file-permission-inference.ts)
- [Claude Code Documentation](https://docs.claude.com/en/docs/claude-code)
