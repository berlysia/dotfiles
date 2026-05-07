---
name: test-design
description: "Design test viewpoints and test cases from code changes using ISO 25010. Use when writing test plans for plan.md, reviewing PR test coverage, or when asked to 'テスト設計', 'テスト観点洗い出し', 'design test cases'. Do NOT use for writing test code or TDD workflows (use /bugfix)."
context: inherit
---

# Test Design

変更内容からテスト観点を洗い出し、検証可能なテストケースに展開する。

## スコープ

- 読み取り専用の分析スキル。ファイルの作成・変更・削除は行わない
- 対象はカレントリポジトリ内のファイルのみ

## このスキルがやらないこと

- テストコードの実装（開発者の責務）
- TDD ワークフロー（/bugfix の責務）
- 既存テストコードの品質レビュー

## 入力の取得

1. **引数あり** → そのまま使用（ファイルパス、変更概要、PR番号など）
2. **引数なし** → `git diff HEAD` で変更差分を取得
3. **Document Workflow 内** → `$DOCUMENT_WORKFLOW_DIR/plan.md` のテスト計画セクションがあれば参照（オプション）

## Phase 1: テスト観点の洗い出し

1. 変更内容を分析し、影響を受ける機能・データフロー・境界を特定する
2. `@~/.claude/rules/workflow.md` の「品質特性の選択ガイド」を参照し、変更の種類に応じた品質特性を選択する
3. 各品質特性について副特性レベルで具体的なテスト観点を列挙する

**観点の粒度**: 「この入力でこの結果が期待される」と言い換えられるレベルまで具体化する。「正しく動作する」のような抽象的な観点は禁止。

## Phase 2: テストケースの展開

各テスト観点について具体的なテストケースを設計し、以下の形式で出力する:

| 品質特性 | 副特性 | テスト/検証方法 | 判定基準 |
|---|---|---|---|

`@~/.claude/rules/workflow.md` の「テスト観点の記述品質ルール」を適用する:

- **曖昧語禁止**: 判定基準に「正しく」「適切に」「問題なく」を使用しない。具体的な期待値・状態で記述する
- **検証可能な形式**: 各テストケースは「入力/操作 → 期待される結果」の形式にする
- **境界値の明記**: 境界値・異常値が関わる場合は具体的な値を明記する

## 出力

- テスト観点リスト（Phase 1 の結果）
- テストケーステーブル（Phase 2 の結果、plan.md のテスト計画セクションにそのまま貼り付け可能な形式）
