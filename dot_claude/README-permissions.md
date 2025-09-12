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

## 設定のベストプラクティス

1. **最小権限の原則**: 必要最小限の権限のみを許可
2. **明示的設定**: 暗黙的な許可より明示的な設定を優先
3. **プロジェクト固有**: グローバル設定よりプロジェクト固有設定を活用
4. **定期的見直し**: 不要になった権限は削除

## トラブルシューティング

- アクセス拒否される場合: permissions.allowに適切なパターンが設定されているか確認
- additionalDirectoriesが効かない場合: パスの解決が正しく行われているか確認
- 予期しない許可: システムディレクトリ以外は明示的拒否ルールがないことを確認