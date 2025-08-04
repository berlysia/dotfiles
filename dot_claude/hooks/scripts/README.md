# Claude Code Hook Scripts

このディレクトリには、Claude Codeのフックスクリプトが含まれています。

## ディレクトリ構造

```
scripts/
├── lib/                          # 共通ライブラリ
│   ├── hook-common.sh           # フック共通機能
│   ├── pattern-matcher.sh       # パターンマッチング
│   ├── dangerous-commands.sh    # 危険なコマンドの検出
│   ├── decision-maker.sh        # 判定ロジック
│   └── logging.sh              # ロギング機能
├── auto-approve-commands.sh     # 自動承認スクリプト
├── deny-repository-outside-access.sh  # リポジトリ外アクセス制限
└── other hook scripts...
```

## auto-approve-commands.sh

権限設定に基づいてコマンドを自動承認/拒否するスクリプトです。

### 機能

1. **危険なコマンドの検出**
   - `git push -f`: 強制プッシュをブロック
   - `git commit --no-verify`: 検証スキップを手動レビュー
   - `git config` の書き込み操作: 手動レビュー
   - `rm -rf`: 強制削除をブロック
   - `.git` ディレクトリへの操作: 保護

2. **パターンマッチング**
   - GitIgnore形式のパターンサポート
   - 複合コマンド（&&, ||, ;）の個別検証
   - Allow/Denyリストによる柔軟な制御

3. **ログ記録**
   - `~/.claude/auto_approve_commands.log` に詳細な分析結果を記録

### アーキテクチャ

モジュール化された設計により、保守性と拡張性を向上：

- **hook-common.sh**: JSON入力の解析、設定ファイルの読み込み
- **pattern-matcher.sh**: コマンドとパターンのマッチング処理
- **dangerous-commands.sh**: 危険なコマンドパターンの定義と検出
- **decision-maker.sh**: 判定結果のJSON出力
- **logging.sh**: 分析結果のロギング

### 設定例

`.claude/settings.json`:
```json
{
  "permissions": {
    "allow": [
      "Bash(git:*)",
      "Bash(npm:*)",
      "Edit(src/**)",
      "Read(**)"
    ],
    "deny": [
      "Bash(rm:*)",
      "Edit(.git/**)"
    ]
  }
}
```

## テスト

```bash
# パターンマッチングのテスト
./test_pattern-matcher.sh

# 危険なコマンド検出のテスト
./test_dangerous_commands.sh
```