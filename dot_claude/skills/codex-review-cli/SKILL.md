---
name: Codex Review CLI
description: Use this skill when you need external perspective for code analysis, architecture advice, debugging guidance, or when stuck on complex problems. Executes Codex CLI in read-only mode for rapid consultation and second opinion. Note that Codex analyzes and suggests improvements but does not implement changes.
context: fork
---

# Codex Review CLI Skill

Codex CLIを直接実行して、外部視点からの即座のフィードバックを取得します。miseで管理されているCodex CLIバイナリを使用します。

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

### コマンドフォーマット

```bash
codex exec --full-auto --sandbox read-only --cd <project_directory> "<prompt>"
```

### パラメータ説明

- `--full-auto`: 自動実行モード（インタラクティブプロンプトなし）
- `--sandbox read-only`: 読み取り専用サンドボックス（安全性確保）
- `--cd <project_directory>`: プロジェクトのルートディレクトリを指定
- `"<prompt>"`: Codexに送信するプロンプト

### プロジェクトディレクトリの決定

1. **明示的な指定がある場合**: ユーザーが指定したディレクトリを使用
2. **現在のプロジェクト**: カレントディレクトリ（`pwd`で取得）を使用
3. **chezmoi管理下**: `/home/berlysia/.local/share/chezmoi` が対象

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

## プロンプト設計のベストプラクティス

### 効果的なプロンプトの構造

```markdown
[明確な依頼内容]

## コンテキスト
[背景情報や制約条件]

## 具体的な質問
1. [質問1]
2. [質問2]

## 期待する回答形式
[箇条書き、コード例、比較表など]
```

### 良いプロンプトの例

```bash
codex exec --full-auto --sandbox read-only --cd $(pwd) \
  "src/stream/processor.tsのストリーム処理実装をレビューしてください。

## コンテキスト
大容量ファイル（1GB以上）を処理する必要があり、メモリ効率を重視しています。

## 確認ポイント
1. バックプレッシャー制御は適切か
2. エラーハンドリングに漏れはないか
3. メモリリークのリスクはあるか

## 期待する回答
問題点を指摘し、改善案を具体的なコード例とともに提案してください。"
```

### 避けるべきプロンプト

❌ **曖昧すぎる**:
```
"このコードを見てください"
```

❌ **コンテキスト不足**:
```
"エラーが出ます。原因を教えてください"
```

❌ **範囲が広すぎる**:
```
"プロジェクト全体をレビューしてください"
```

❌ **実装を依頼（read-onlyモードでは不可）**:
```
"このバグを修正してください"
"新しい機能を実装してください"
```

✅ **正しい依頼方法**:
```
"このバグの原因を分析し、どのように修正すべきか提案してください"
"この機能をどのように実装すべきか、設計案を提示してください"
```

## 実装パターン

### Bashツール経由での実行

```typescript
// Claude Code内での使用例
Bash({
  command: `codex exec --full-auto --sandbox read-only --cd "${projectDir}" "${prompt}"`,
  description: "Codex CLIでコードレビューを依頼"
})
```

### プロンプトのエスケープ処理

```bash
# シングルクォートとダブルクォートを適切にエスケープ
prompt="プロジェクトの'認証'機能を\"レビュー\"してください"
codex exec --full-auto --sandbox read-only --cd $(pwd) "${prompt}"
```

### 長いプロンプトの扱い

```bash
# ヒアドキュメントを使用
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

### セキュリティ

1. **機密情報**: API キー、パスワード、個人情報を含むコードは送信しない
2. **read-onlyサンドボックス**: 常に `--sandbox read-only` を使用してファイル変更を防止
3. **プロジェクト範囲**: `--cd` で適切なディレクトリに制限

### 応答の取り扱い

1. **read-onlyモードの制限**: Codexはファイルの読み取りと分析のみ可能。実装やファイル変更は行えないため、提案された改善案は自分で実装する必要がある
2. **検証必須**: Codexの提案は参考意見として扱い、盲目的に適用しない
3. **コンテキスト依存**: Codexはプロジェクト全体のコンテキストを持たないため、提案を実装前に検証
4. **ベストプラクティス**: 一般的なベストプラクティスには従うが、プロジェクト固有の制約を優先

### パフォーマンス

1. **応答時間**: Codex実行には数秒〜数十秒かかる可能性がある
2. **並列実行**: 複数の独立した質問がある場合は、並列実行を検討
3. **タイムアウト**: 必要に応じてBashツールのtimeoutパラメータを設定

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

### codex コマンドが見つからない

```bash
# mise でインストールされているか確認
mise list | grep codex

# インストールされていなければ追加
mise use -g codex@latest
```

### タイムアウトエラー

```bash
# Bashツールのtimeoutを延長（デフォルト120秒→300秒）
Bash({
  command: "codex exec ...",
  timeout: 300000  # ミリ秒単位
})
```

### エンコーディングエラー

```bash
# UTF-8環境変数を設定
export LANG=ja_JP.UTF-8
codex exec --full-auto --sandbox read-only --cd $(pwd) "プロンプト"
```

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
