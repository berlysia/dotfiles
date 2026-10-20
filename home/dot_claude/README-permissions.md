# Claude Code 権限設定ガイド

## ファイル構成

- `.settings.permissions.json` - グローバル権限設定（chezmoi管理。`~/.claude/settings.json` の `permissions` に統合される）
- `.claude/settings.json` - プロジェクト固有設定（各プロジェクトの`.claude/`ディレクトリ内）

## セキュリティモデル

ファイルアクセスは `hooks/implementations/file-access-guard.ts`（PreToolUse）が、次の順に判定する。上から最初に決着した結果が採用される。

1. **リポジトリ内** → 常に許可
2. **OS の一時ディレクトリ・セッションの workflow dir** → 許可（システムディレクトリの拒否より先に判定する）
3. **システムディレクトリ** (`/etc`, `/usr`, `/var` 等) → 常に拒否（allow パターンでも覆せない）
4. **安全なパス** (`~/.claude`, `/var/tmp`) → 常に許可
5. **additionalDirectories内**:
   - 読み取り系（Read/LS/Glob/Grep/NotebookRead） → 自動許可
   - 書き込み系（Edit/Write/MultiEdit/NotebookEdit） → permissions.allowが必要
6. **明示的許可** → permissions.allowにマッチする場合許可
7. **dotfiles リポジトリ** → chezmoi 管理下のファイルへの書き込みは source への編集に誘導して拒否、読み取りは許可
8. 上のどれにも当たらなければ拒否

シンボリックリンクは、書かれたままの形と物理パスの両方で判定する。allow パターンは物理パスに解決しない。

別に `hooks/implementations/permission-auto-approve.ts`（PermissionRequest）が、読み取り専用ツールとプロジェクト内の編集などを静的規則で自動承認する。規則は `hooks/README.md` を参照。

### 設定例

#### プロジェクト設定 (`.claude/settings.json`)

```json
{
  "additionalDirectories": ["../shared-lib", "~/workspace/docs"],
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

### フック独自のパス解決

フックは `Tool(...)` の括弧内を次のように解決してから、対象パスと比較する（`hooks/lib/path-utils.ts` の `resolvePathPattern`）。

| 括弧内の書き方           | 基準                                                                  |
| ------------------------ | --------------------------------------------------------------------- |
| `//path`                 | ファイルシステムのルート                                              |
| `/path`                  | そのルールを定義した settings ファイルのあるディレクトリ              |
| `~/path`                 | ホームディレクトリ                                                    |
| `./path` またはその他    | cwd                                                                   |
| 名前だけ（`*.env` など） | cwd 以下の任意の深さ                                                  |
| `..` を含む              | allow は何も許可しない。deny は畳んだパスを文字どおりのパスとして守る |

比較は対象パスも同じ形に正規化してから、セグメント単位で行う。`..` や `//` で allow の範囲を広げることや deny を避けることはできない。`!` で始まるパターンは何も許可しない。

### パターンのスコープ制御

| パターン例             | 基準                      | マッチング動作                     | 用途                     |
| ---------------------- | ------------------------- | ---------------------------------- | ------------------------ |
| `Read(./**)`           | `/current/cwd/**`         | **現在のプロジェクト内のみ**マッチ | プロジェクトスコープ制限 |
| `Read(~/workspace/**)` | `/home/user/workspace/**` | workspace配下のみマッチ            | workspace全体許可        |
| `Read(//tmp/**)`       | `/tmp/**`                 | `/tmp` 配下のみマッチ              | 絶対パスでの指定         |

### ツールごとの違い

Claude Code の権限はツール単位でなくカテゴリ単位で解決される。フックもこれに合わせ、次のルールがカバーするツールを同じ扱いにする。

| ルールの書き方 | カバーするツール                        |
| -------------- | --------------------------------------- |
| `Edit(...)`    | Edit / Write / MultiEdit / NotebookEdit |
| `Read(...)`    | Read / Glob / Grep / LS / NotebookRead  |

ツール名固有のパスルール（`Write(...)` や `Glob(...)`）はClaude Code本体側で無視されるため、書いても効かない。Grep のパスパラメータは `path`（検索スコープ）で、ファイルパスではない。

```json
{
  "allow": [
    "Read(./**)", // 現在のプロジェクト内の読み取り・検索
    "Edit(./**)", // 現在のプロジェクト内のファイル編集
    "Edit(~/workspace/**)" // workspace内のファイル編集
  ]
}
```

### 注意事項

⚠️ **フック独自の記法**: `./` プレフィックスの扱いはフックの解決規則（上の表）に従う。

❌ **非推奨**: `Read` や `Read(**)` のようなツール名のみ/ワイルドカードのみのパターンは、全パス許可となり危険です。

### 設計原則：最小権限

1. **デフォルトはプロジェクトスコープ**: `./**`
2. **必要に応じてworkspaceスコープ**: `~/workspace/**`
3. **特定ディレクトリのみ**: 個別に指定
4. **全域許可は禁止**: セキュリティリスクが高い

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
