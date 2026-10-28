---
name: refine-skill
description: Analyze and refine existing Claude Code Skills for conciseness and effectiveness. Use when asked to "review", "refine", "improve", "optimize" Skills, or when user mentions "skill quality", "skill refinement", "too verbose", "skill doesn't trigger", "description quality", or wants to make a Skill more concise. Do NOT use for creating new skills from scratch (use skill-creator instead).
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

規則を改訂するときは、次を分析・検証に含める。

- **衝突**: 追加規則を本文・例・参照先にも当て、併用時の優先順位、除外範囲、モードごとの対象、行数上限と必須内容、出力経路ごとのエスケープ条件を照合する。例が規則に反すると、モデルは例をまねる。言い換え例には、直し先を判断できる原文も添え、推測による補完を教えない
- **移動**: 移動元の各規則が移動先でも条件ごと保たれ、残した参照先の旧規則とも矛盾しないか読み比べる。元の語句の削除だけでは、移動先での欠落は分からない
- **比較**: 改訂前の標本を先に確保し、本文の例とは別の複数題材を同じ入力で改訂前後に試す。実行者には期待結果を渡さず、評価者には改訂前後を伏せた出力と同じ評価基準をまとめて渡す。根拠の節・行を挙げさせて本文と照合し、複数試行で揺れを確認する。合否は不変条件で決め、文言差は別に並べる。ログ再生では再現できた入力だけを母数にし、除外件数と理由を記す。改善しない場合は、評価基準が目的に合うかも見直す
- **意味の確認**: 読み込み量が増えるほど規則は守られにくくなる前提で、通常の依頼から参照する場面が分かるかを読む。明示起動の指定と一般語の使用の区別、出力形式を決める節での規則の分かりやすさも確認する。測定結果の解釈では、読み込みと遵守を分け、観察用の権限制限や試験用コピーが普段の動作を変えていないかを検討する。読まれた回数だけでは、依頼に合う場面で規則が効いたかは判断できない

## Actions

- **削除**: 「〜とは」説明、背景説明、自明なステップ、重複
- **追加**: 具体例、トリガー、失敗対処
- **書き換え**: 曖昧→具体的、複雑→シンプル

## Patterns

| Pattern      | Action                    |
| ------------ | ------------------------- |
| Description  | 曖昧→具体的、トリガー追加 |
| 説明         | 教育的散文→実行可能コード |
| ワークフロー | 10+ステップ→3-5ステップ   |
| Progressive  | 500行超→分割+参照         |

詳細例はCHECKLIST.md参照。

## Quality Targets

- Description: what + when + triggers (≤1024文字)
- Lines: ≤500
- References: 1階層
- Examples: 具体的・実行可能

詳細: [CHECKLIST.md](CHECKLIST.md)

## Description Formula

description は `[What it does] + [When to use it] + [Key capabilities]` の公式に従う。

```yaml
# Good — 具体的な what/when/triggers
description: Extract text from PDFs, fill forms, merge documents. Use when working with PDF files or when user mentions "PDF", "forms", "document extraction".

# Bad — 曖昧、トリガーなし
description: Helps with documents.

# Bad — 技術的すぎ、ユーザー視点なし
description: Implements the Project entity model with hierarchical relationships.
```

negative trigger で over-triggering を防ぐ:

```yaml
description: ...Use for statistical modeling, regression. Do NOT use for simple data exploration (use data-viz skill instead).
```

## Common Issues

| Symptom                      | Cause                                 | Fix                                                        |
| ---------------------------- | ------------------------------------- | ---------------------------------------------------------- |
| スキルがロードされない       | description が曖昧/トリガー不足       | trigger phrases 追加、ユーザーが言いそうなフレーズを含める |
| 無関係なクエリでロードされる | スコープが広すぎる                    | negative trigger 追加、対象を限定                          |
| 指示が無視される             | instructions が冗長/埋もれている/曖昧 | 重要指示をトップに、箇条書き化、詳細は references/ へ      |
| 出力品質が低い               | model laziness                        | `## Performance Notes` で明示的に品質要求                  |
| 過剰な説明                   | Claude既知の情報を記載                | 「〜とは」説明・背景・自明なステップを削除                 |
| 深い参照チェーン             | A→B→C の多段参照                      | 1階層にフラット化                                          |

## Iteration Signals

- **Undertriggering**: ロードされない、手動有効化が必要、使い方の質問が来る → description にキーワード・ファイル種別を追加
- **Overtriggering**: 無関係クエリでロード、無効化される → negative trigger 追加、スコープ限定
- **Execution issues**: 一貫性なし、ユーザー修正必要 → instructions 改善、error handling 追加

## Examples

### Example 1: 冗長な description の改善

Before:

```yaml
description: Creates sophisticated multi-page documentation systems.
```

問題: What はあるが When/Triggers がない。「sophisticated」は無意味。

After:

```yaml
description: Generate multi-page documentation from source code. Use when user says "generate docs", "API documentation", or uploads code files for documentation.
```

### Example 2: Instructions not followed の診断

Symptom: スキルはロードされるが指示通りに動かない。

診断チェック:

1. **Verbose?** → 500行超なら references/ に分割
2. **Buried?** → 重要指示が下部にある → `## Critical` でトップに移動
3. **Ambiguous?** → 「適切に処理」→ 具体的な検証項目リストに置換
4. **Model laziness?** → `## Performance Notes` セクションで品質明示
