# Claude Code 権限設定ガイド

## ファイル構成

- `permissions.json` - グローバル権限設定（chezmoi管理）
- `settings.json` - プロジェクト固有設定（各プロジェクトの`.claude/`ディレクトリ内）
- `settings.example.json` - プロジェクト設定のサンプル

## セキュリティモデル

### ハイブリッドアプローチ

1. **リポジトリ内** → 常に許可
2. **システムディレクトリ** (`/etc`, `/usr`等) → 常に拒否
3. **安全なパス** (`~/.claude`, `/tmp`) → 常に許可
4. **additionalDirectories内**:
   - Read/LS → 自動許可
   - Edit/Write → permissions.allowが必要
5. **明示的許可** → permissions.allowにマッチする場合許可

### 設定例

#### プロジェクト設定 (`.claude/settings.json`)

```json
{
  "additionalDirectories": [
    "../shared-lib",
    "~/workspace/docs"
  ],
  "permissions": {
    "allow": [
      "Edit(../shared-lib/**)",
      "Write(../shared-lib/**)",
      "Read(~/.config/myapp/**)"
    ]
  }
}
```

#### 動作例

- `Read(../shared-lib/file.txt)` → ✅ additionalDirectories内のReadは自動許可
- `Edit(../shared-lib/file.txt)` → ✅ permissions.allowにマッチ
- `Edit(~/workspace/docs/file.md)` → ❌ additionalDirectories内だが明示的許可なし
- `Read(/etc/passwd)` → ❌ システムディレクトリは常に拒否

## パターン記法の詳細

### 重要：フック独自の正規化処理

このプロジェクトのフックは**Claude Codeの標準動作と異なる独自のパス正規化**を行っています。

#### Claude Codeの実際の動作
- 絶対パス: `/home/user/workspace/project/file.ts`
- 相対パス: `package.json`, `.github/workflows/ci.yml` (`./**` 形式ではない)

#### フックの正規化処理
パターンマッチング時に以下の変換を行います：

```typescript
// パターン側の正規化
"./pattern" → join(process.cwd(), "pattern")  // cwd基準の絶対パスに展開
"~/pattern" → join(homedir(), "pattern")      // ホームディレクトリ基準に展開

// ファイルパス側の正規化
相対パス → join(process.cwd(), filePath)     // 絶対パスに変換
```

### パターンのスコープ制御

| パターン例 | 正規化後 | マッチング動作 | 用途 |
|-----------|---------|-------------|------|
| `Read(./**)` | `/current/cwd/**` | **現在のプロジェクト内のみ**マッチ（Anchored） | プロジェクトスコープ制限 |
| `Read(~/workspace/**)` | `/home/user/workspace/**` | workspace配下のみマッチ | workspace全体許可 |
| `Read(**)` | `**` | **すべてのパスにマッチ** | 制限なし（非推奨） |
| `Read` | N/A | **すべてのパスにマッチ**（ツール名のみ） | 制限なし（非推奨） |

### ツールごとの違い

#### ファイル操作ツール（Read/Write/Edit）
- パスパラメータ: `file_path`（操作対象ファイル）
- 正規化: **適用される**
- 推奨パターン: `Read(./**)` または `Read(~/workspace/**)`

```json
{
  "allow": [
    "Read(./**)",           // 現在のプロジェクト内のファイル読み取り
    "Edit(./**)",           // 現在のプロジェクト内のファイル編集
    "Write(~/workspace/**)" // workspace内のファイル書き込み
  ]
}
```

#### Grep ツール
- パスパラメータ: `path`（**検索スコープ**、ファイルパスではない）
- 正規化: **適用されない**（意味が異なるため）
- 推奨パターン: `Grep`（ツール名のみ）

```json
{
  "allow": [
    "Grep"  // すべてのGrepを許可（読み取り専用なので安全）
  ]
}
```

**なぜGrepだけ違うのか**:
- Claudeが `Grep(pattern="foo", path="src/")` のように呼び出す
- `path` は「どこを検索するか」であり、「どのファイルを操作するか」ではない
- 正規化すると意図しないマッチングになるため、ツール名のみで制御

### 注意事項

⚠️ **非標準な記法**: `./` プレフィックスはClaude Codeが実際に使用する形式ではなく、フック独自の正規化処理のための記法です。

✅ **推奨**: この記法により、プロジェクトスコープの制限が実現できるため、セキュリティ上有用です。

❌ **非推奨**: `Read` や `Read(**)` のようなツール名のみ/ワイルドカードのみのパターンは、全パス許可となり危険です（Grepは例外）。

## 設定のベストプラクティス

1. **最小権限の原則**: 必要最小限の権限のみを許可
2. **明示的設定**: 暗黙的な許可より明示的な設定を優先
3. **プロジェクト固有**: グローバル設定よりプロジェクト固有設定を活用
4. **定期的見直し**: 不要になった権限は削除
5. **スコープ制限**: `./` や `~/workspace/` を活用してスコープを制限

## トラブルシューティング

- アクセス拒否される場合: permissions.allowに適切なパターンが設定されているか確認
- additionalDirectoriesが効かない場合: パスの解決が正しく行われているか確認
- 予期しない許可: システムディレクトリ以外は明示的拒否ルールがないことを確認