---
name: codex-review-cli
description: Use this skill when you need external perspective for code analysis, architecture advice, debugging guidance, or when stuck on complex problems. Executes Codex CLI in read-only mode for rapid consultation and second opinion. Note that Codex analyzes and suggests improvements but does not implement changes.
context: fork
---

# Codex Review CLI Skill

Codex CLIを直接実行して、外部視点からの即座のフィードバックを取得します。

**重要**: read-onlyモードで実行するため、Codexはコード分析と改善提案のみを行い、実装やファイル変更は行いません。

## 使用タイミング

### 自動的に使用を検討すべき場面
1. **コード分析・レビュー**: 実装した内容の品質確認、問題点の指摘、ベストプラクティスとの整合性チェック
2. **アーキテクチャアドバイス**: 複数の設計選択肢で迷っているとき、トレードオフの分析
3. **行き詰まり**: 問題解決の糸口が見つからないとき、新しい視点が必要なとき
4. **デバッグガイダンス**: 根本原因の特定が難しいエラー調査、解決策の提案

### ユーザーから明示的に呼ばれる場面
- "Codexに聞いて"、"セカンドオピニオンが欲しい"
- 技術的な判断に自信が持てないとき
- 業界標準との整合性を確認したいとき
- "この実装方法で良いか分析して"

## 基本的な使用方法

```bash
codex exec --full-auto --sandbox read-only --cd <project_directory> "<prompt>"
```

プロジェクトディレクトリには `$(pwd)` または明示的なパスを指定します。

## 使用例

### ケース1: コードレビュー依頼

```bash
codex exec --full-auto --sandbox read-only --cd /home/berlysia/project \
  "src/auth/login.tsのコードをレビューしてください。パフォーマンス、セキュリティ、保守性の観点から問題点を指摘し、改善案を提案してください。"
```

### ケース2: アーキテクチャ相談

```bash
codex exec --full-auto --sandbox read-only --cd $(pwd) \
  "認証機能の実装で、JWTトークンをLocalStorageとCookieのどちらに保存すべきか迷っています。セキュリティとUXの観点から、それぞれの利点と欠点、推奨される実装方法を教えてください。"
```

### ケース3: デバッグ支援

```bash
codex exec --full-auto --sandbox read-only --cd /path/to/project \
  "TypeScriptのビルドエラー 'TS2307: Cannot find module' が発生しています。tsconfig.jsonの設定とimport文を分析して、考えられる原因と具体的な解決策を提案してください。"
```

### ケース4: ベストプラクティス確認

```bash
codex exec --full-auto --sandbox read-only --cd $(pwd) \
  "src/hooks/useAuth.tsのカスタムフックをレビューしてください。React Hooksのベストプラクティスに従っているか、useMemoやuseCallbackの使い方が適切か分析し、改善提案があれば具体例とともに教えてください。"
```

## プロンプト設計のガイドライン

効果的なプロンプトには：
- 明確な依頼内容と対象ファイル
- 背景情報や制約条件
- 具体的な確認ポイント

**重要**: read-onlyモードのため、実装依頼ではなく分析・提案を依頼してください。
- ❌ "このバグを修正してください"
- ✅ "このバグの原因を分析し、修正方法を提案してください"

## 実装パターン

長いプロンプトにはヒアドキュメントを使用：

```bash
read -r -d '' PROMPT <<'EOF'
以下の実装計画をレビューしてください：

## 背景
[詳細な背景説明]

## 提案する設計
[ステップバイステップの計画]

## 懸念点
[自分で認識している問題点]
EOF

codex exec --full-auto --sandbox read-only --cd $(pwd) "${PROMPT}"
```

## 注意事項

- **機密情報**: API キー、パスワード、個人情報を含むコードは送信しない
- **検証必須**: Codexの提案は参考意見として扱い、実装前に検証する
- **タイムアウト**: 必要に応じてBashツールのtimeoutパラメータを設定（デフォルト120秒）

## 既存スキルとの使い分け

### codex-review-mcp との違い

| 特徴 | codex-review-cli (このスキル) | codex-review-mcp |
|------|------------------------------|------------------|
| 実行方法 | Shell CLIコマンド | MCPツール |
| 会話継続 | 不可（1回限り） | 可能（conversationId使用） |
| 速度 | 高速 | やや遅い（MCP経由） |
| 適用場面 | クイック相談 | 深い議論・継続的レビュー |

### 使い分けガイドライン

- **このスキル（codex-review-cli）を使う**:
  - 即座のフィードバックが欲しい
  - 1つの明確な質問がある
  - MCPサーバーが利用できない環境

- **codex-review-mcp を使う**:
  - 複数回のやりとりが必要
  - 段階的な議論を深めたい
  - より構造化されたレビューフロー

## トラブルシューティング

- **codex コマンドが見つからない**: `mise list | grep codex` で確認し、未インストールなら `mise use -g codex@latest` の許可を利用者に求める
- **タイムアウトエラー**: Bashツールのtimeoutパラメータを延長（例: 300000ミリ秒）

## ワークフロー統合

### Planモード完了前の検証フロー

```
1. logic-validatorで論理的整合性を検証（必須）
2. 複雑な判断が必要な場合:
   a. codex-review-cli で即座のセカンドオピニオン取得
   b. より深い議論が必要なら codex-review-mcp を使用
3. フィードバックを元に計画を改善
4. ExitPlanMode実行
```

### デバッグワークフロー

```
1. エラーメッセージと症状を収集
2. 自分で仮説を立てる（5 Whys分析）
3. 行き詰まったら codex-review-cli で外部視点を取得
4. 提案された解決策を検証
5. 根本原因を修正
```

## 関連リソース

- CLAUDE.md: Codex活用ガイドライン全般
- `/codex-review-cli` skill: このスキル（Shell経由、1回限り）
- `/codex-review-mcp` skill: MCP版Codexレビュー（継続的な議論向け）
- mise documentation: Codexバイナリ管理
