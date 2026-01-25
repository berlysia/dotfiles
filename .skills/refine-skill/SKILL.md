---
name: refine-skill
description: Analyze and refine existing Claude Code Skills for conciseness and effectiveness. Use when asked to "review", "refine", "improve", "optimize" Skills, or when the user mentions "skill quality", "skill refinement", or wants to make a Skill more concise.
context: fork
---

# Skill Refinement

既存のClaude Code Skillを分析し、より簡潔で効果的なものに洗練する。

## Core Principle

品質 = AIの消費しやすさ。Claude既知の情報は削除。

## Workflow

1. **読込**: 全ファイル読み込み、行数・文字数測定
2. **分析**: CHECKLIST.mdと照合、問題特定
3. **修正**: 削除・追加・書き換え適用
4. **検証**: 行数減少、機能維持、トリガー明確化確認

## Actions

- **削除**: 「〜とは」説明、背景説明、自明なステップ、重複
- **追加**: 具体例、トリガー、失敗対処
- **書き換え**: 曖昧→具体的、複雑→シンプル

## Patterns

| Pattern | Action |
|---------|--------|
| Description | 曖昧→具体的、トリガー追加 |
| 説明 | 教育的散文→実行可能コード |
| ワークフロー | 10+ステップ→3-5ステップ |
| Progressive | 500行超→分割+参照 |

詳細例はCHECKLIST.md参照。

## Quality Targets

- Description: what + when + triggers (≤1024文字)
- Lines: ≤500
- References: 1階層
- Examples: 具体的・実行可能

詳細: [CHECKLIST.md](CHECKLIST.md)

## 問題パターン

| 問題 | 対策 |
|------|------|
| 過剰な説明 | 削除 |
| 曖昧な記述 | 具体例に置換 |
| 深い参照 | フラット化 |
| 冗長なワークフロー | 3-5ステップに統合 |
| トリガー不足 | キーワード追加 |

## Anti-Patterns

| Anti-Pattern | 代替 |
|--------------|------|
| 教育的散文 | 直接的な指示 |
| 無限の選択肢 | デフォルト + escape hatch |
| Windowsパス | 常に `/` |
| 時間依存情報 | バージョン非依存 |
| 深い参照 | フラット構造 |
