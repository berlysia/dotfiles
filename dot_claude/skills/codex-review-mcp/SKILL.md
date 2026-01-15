---
name: codex-review-mcp
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

効果的なレビュー依頼には以下を含める：

```markdown
[明確な依頼内容]

## 背景/コンテキスト
[問題や要件、制約条件]

## 提案/試したこと
[現在の計画や実施したアプローチ]

## 懸念点/質問
[自分で認識している問題点や知りたいこと]
```

## 注意事項

- **機密情報**: 機密性の高いコードやデータは送信しない
- **検証必須**: Codexの提案は参考意見として扱い、最終判断は自分で行う

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
