---
name: Codex Review MCP
description: Use this skill when completing a plan in Plan mode, when stuck on a complex problem, when needing a second opinion on architecture decisions, when facing difficult debugging, or when the user explicitly asks for Codex review. Invokes OpenAI Codex MCP for external perspective and validation through conversational interface.
context: fork
---

# Codex Review MCP Skill

このスキルはOpenAI Codex MCPを使用して、計画やアーキテクチャ決定に対する外部視点からのレビューを継続的な会話形式で取得します。

## 使用タイミング

### 自動的に使用すべき場面
1. **Planモード完了時**: ExitPlanMode実行前に、`logic-validator`での論理検証後、必要に応じて外部視点のレビューを取得
2. **行き詰まり時**: 問題解決の糸口が見つからないとき
3. **アーキテクチャ決定**: 複数の選択肢で迷っているとき
4. **デバッグ困難時**: 根本原因の特定が難しいとき

### ユーザーから明示的に呼ばれる場面
- `/codex-review-mcp` コマンドの実行
- 「Codexに聞いて」「セカンドオピニオンが欲しい」などのリクエスト
- 継続的な議論や深い分析が必要なとき

## 使用方法

### 基本的な呼び出し

```
mcp__codex__codex ツールを使用:
- prompt: レビューしたい内容（計画、コード、問題の説明）
- cwd: 対象プロジェクトのディレクトリ（必要に応じて）
```

### 会話の継続

初回のレビュー後、さらに詳細を聞きたい場合：

```
mcp__codex__codex-reply ツールを使用:
- conversationId: 前回のレスポンスから取得
- prompt: 追加の質問や詳細の依頼
```

## レビュー依頼のベストプラクティス

### 計画レビューの場合

```markdown
以下の実装計画をレビューしてください：

## 背景
[解決したい問題や要件]

## 提案する計画
[ステップバイステップの計画]

## 懸念点
[自分で認識している潜在的な問題]

以下の観点からフィードバックをお願いします：
1. 計画に見落としはないか
2. よりシンプルなアプローチはあるか
3. 潜在的なリスクや落とし穴
```

### デバッグ相談の場合

```markdown
以下の問題で行き詰まっています：

## 症状
[発生している問題]

## 試したこと
[これまでに試したアプローチ]

## 仮説
[考えている原因の候補]

新しい視点からのアドバイスをお願いします。
```

### アーキテクチャ決定の場合

```markdown
以下のアーキテクチャ決定で迷っています：

## 選択肢A
[説明、メリット、デメリット]

## 選択肢B
[説明、メリット、デメリット]

## コンテキスト
[プロジェクトの制約や要件]

どちらを選ぶべきか、または別のアプローチがあれば教えてください。
```

## 注意事項

1. **機密情報の取り扱い**: 機密性の高いコードやデータはCodexに送信しない
2. **レスポンスの検証**: Codexの提案は参考意見として扱い、最終判断は自分で行う
3. **コンテキストの提供**: 十分な背景情報を提供することで、より有用なフィードバックが得られる

## 統合ワークフロー

このスキルは以下のワークフローで使用されます：

```
1. Planモードで計画を作成
2. ExitPlanMode前に:
   a. logic-validatorで論理的整合性を検証（必須）
   b. 複雑な判断の場合:
      - codex-review-cli で即座の意見取得（クイック相談）
      - codex-review-mcp で継続的な議論（深い分析が必要な場合）
3. フィードバックを元に計画を改善
4. 改善後の計画でExitPlanModeを実行
5. ユーザーに最終承認を求める
```

**Note**: ExitPlanModeのPreToolUse hookにより、この手順は自動的にプロンプトされます。

## 他のCodexスキルとの使い分け

### codex-review-cli との違い

| 特徴 | codex-review-cli | codex-review-mcp (このスキル) |
|------|------------------|------------------------------|
| 実行方法 | Shell CLIコマンド | MCPツール |
| 会話継続 | 不可（1回限り） | 可能（conversationId使用） |
| 速度 | 高速 | やや遅い（MCP経由） |
| 適用場面 | クイック相談 | 深い議論・継続的レビュー |

### 使い分けガイドライン

- **codex-review-cli を使う**:
  - 即座のフィードバックが欲しい
  - 1つの明確な質問がある
  - MCPサーバーが利用できない環境

- **このスキル（codex-review-mcp）を使う**:
  - 複数回のやりとりが必要
  - 段階的な議論を深めたい
  - より構造化されたレビューフロー
  - 計画の包括的なレビュー
