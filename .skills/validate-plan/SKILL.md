---
name: validate-plan
description: Required when ExitPlanMode is blocked by hook. Reviews implementation plan for logical consistency using logic-validator. Adds <!-- validated --> marker after successful validation. Trigger keywords:"validate plan", "review plan", "check plan quality", "plan validation".
context: fork
agent: general-purpose
allowed-tools: Read, Bash, Task, Edit
disable-model-invocation: true
model: opus
---

# Plan Validation Skill

Planモードで作成した実装計画を、ExitPlanMode実行後にサブエージェントを使ってレビューし、必要に応じて改善する。

## 重要な前提

**使用タイミング**: ExitPlanMode が**ブロックされた時**

ExitPlanMode を実行すると、hook によって計画ファイルの検証マーカー（`<!-- validated -->`）がチェックされます。マーカーがない場合は ExitPlanMode がブロックされ、このスキルの実行を促されます。

## 基本ワークフロー

```
1. Plan Mode で計画作成
2. ExitPlanMode 実行 → hook によりブロック
3. /validate-plan 実行（このスキル）
   ├─ logic-validator で論理検証
   └─ 必要なら外部レビュー
4. 検証結果に応じた判定:
   ├─ 問題なし/軽微 → 5へ
   ├─ 中程度（修正可能） → 修正して再検証（最大2回）
   └─ 決定的な欠落 → 実装停止、計画再作成
5. 計画ファイルに <!-- validated --> マーカーを追加
6. ExitPlanMode を再実行 → 成功
7. 実装開始
```

**重要な原則**:
- 決定的な欠落がある状態では、絶対に実装を開始しません
- `<!-- validated -->` マーカーがないと ExitPlanMode は hook によりブロックされます

## Validation Steps

### Step 1: 計画ファイルの確認

前回のPlan Modeセッションで作成された計画ファイルを特定：

```bash
# settings.jsonの plansDirectory 設定に応じた場所を確認
# デフォルト: ~/.claude/plans/ またはプロジェクトの .claude/plans/

ls -lt ~/.claude/plans/*.md 2>/dev/null | head -5
# または
ls -lt .claude/plans/*.md 2>/dev/null | head -5
```

**計画ファイルの場所**:
- グローバル: `~/.claude/plans/`
- プロジェクト: `.claude/plans/`
- settings.jsonの `plansDirectory` で設定変更可能

**見つからない場合**:
- Plan Modeで明示的に保存していない可能性があります
- 会話履歴から計画内容をコピーして新規ファイルに保存してください
- 詳細は [troubleshooting.md](troubleshooting.md#計画ファイルが見つからない) を参照

計画ファイルを読み取り：

```typescript
Read({ file_path: "~/.claude/plans/plan-name.md" })
```

### Step 2: 論理的整合性検証（必須）

logic-validatorで計画の論理的整合性を検証：

```typescript
Task({
  subagent_type: "logic-validator",
  description: "Validate plan logic",
  prompt: `
# 実装計画の論理的整合性検証

[計画ファイルの内容をここに貼り付け]

## 検証ポイント
1. 各ステップの目的と依存関係は明確か
2. 検証なしに成功を仮定していないか
3. エッジケース・失敗シナリオは考慮されているか
4. 必要なファイル確認ステップが含まれているか
5. 根本原因分析なしに症状的修正を提案していないか

## 参考ルール
CLAUDE.md のデバッグガイドライン、タスク完了プロトコルに照らして評価してください。
`
})
```

### Step 3: 外部レビュー（オプション）

計画の複雑さに応じて外部レビューを追加：

| 計画の種類 | 推奨レビュー | 理由 |
|-----------|------------|------|
| 複雑なアーキテクチャ | `/codex-review` | 設計トレードオフ評価 |
| セキュリティ機能 | `/self-review` | 多角的評価 |
| 新技術スタック | codex-review-mcp | ベストプラクティス確認 |
| 単純な修正 | 不要 | logic-validatorのみで十分 |

**使用例:**

```bash
# codex-review使用
/codex-review

# 相談内容
「以下の実装計画について、アーキテクチャの観点からレビューしてください。
特に、[具体的な懸念点]について評価をお願いします。

[計画の要約]」
```

### Step 4: フィードバック評価と改善判断

検証結果を評価し、必要な改善を実施。

**重要**: このスキルは最大2回の検証サイクルで完了してください。
- **1回目**: 初回検証 → 重大な問題を修正
- **2回目**: 再検証 → OK/軽微な問題のみ → 実装開始

3回目以降の検証は避け、70-85点の計画で実装を開始してください。完璧を求めすぎないことが重要です。

#### 優先度の判断

| 指摘タイプ | 重大度 | 判断 | 対応例 |
|---------|------|------|--------|
| 論理矛盾（実行不可能） | 🚫 決定的 | 実装停止 | 「ステップAの前提条件がステップBで破壊される」→ 計画再作成 |
| 必須検証の完全欠落 | 🚫 決定的 | 実装停止 | 「データベース変更後の検証ステップがない」→ 計画再作成 |
| セキュリティ脆弱性 | 🚫 決定的 | 実装停止 | 「認証なしでデータアクセス」→ 計画再作成 |
| 根本原因分析なしの症状的修正 | 🚫 決定的 | 実装停止 | 「エラーの原因不明だが設定変更」→ 原因調査から再計画 |
| 検証漏れ（追加可能） | ⚠️ 中程度 | 修正して対応 | 「テストが不足」→ テストケース追加 |
| 軽微な論理矛盾 | ⚠️ 中程度 | 修正して対応 | 「ステップ順序が非効率」→ 順序変更 |
| 代替案提示 | ✅ 軽微 | 検討 | より単純な実装 → 既存計画と比較 |
| 追加機能提案 | ✅ 軽微 | 検討 | スコープ外 → 除外の判断は自分で |
| 過度に保守的 | ✅ 軽微 | 無視可 | プロジェクト制約と矛盾する場合 |

#### 計画の更新

問題の重大度に応じて対応：

**軽微～中程度の問題**:
```typescript
Edit({
  file_path: "/path/to/plan.md",
  old_string: "元のステップ記述",
  new_string: "改善されたステップ記述（検証ポイント追加等）"
})
```

修正後、Step 2に戻って再検証（ただし最大2回まで）。

**決定的な欠落・重大な論理矛盾**:
- 計画ファイルの部分的な修正では不十分
- **実装を停止**し、Step 5の「決定的な欠落」の指示に従ってください
- 新しいPlan Modeセッションでの計画再作成を推奨

### Step 5: 判定と次のアクション

検証結果に基づいて、次のアクションを決定：

#### ✅ 問題なし、または軽微な問題のみ

**検証完了マーカーを追加してから実装を開始**

計画ファイルに検証完了マーカーを追加してください：

```typescript
// 計画ファイルの末尾に追加
Edit({
  file_path: "/path/to/plan.md",
  old_string: "[計画ファイルの最後の行]",
  new_string: "[計画ファイルの最後の行]\n\n<!-- validated -->"
})
```

**重要**: このマーカーがないと、ExitPlanMode が hook によってブロックされます。

マーカー追加後、ExitPlanMode を再実行して実装を開始してください。

#### ⚠️ 中程度の問題（2回目の検証後も残る）

**判断が必要**
- 問題を受容して実装開始するか
- 計画を再作成するか

ユーザーに相談して決定してください。

#### 🚫 決定的な欠落・重大な論理矛盾

**実装を停止してください**

以下のいずれかを実行：
1. **計画を全面的に再検討**: 新しいPlan Modeセッションで計画を作り直す
2. **ユーザーに報告**: 重大な問題を説明し、方針を相談

**決定的な欠落の例**:
- 必須の検証ステップが完全に欠けている
- 論理的に実行不可能な順序
- セキュリティ上の重大な脆弱性
- 根本原因分析なしに症状的修正を提案
- データ損失のリスクがある設計

**重要**: 決定的な欠落がある状態では、絶対に実装を開始しないでください。

## 効率化のヒント

### 並列実行

logic-validatorと外部レビューは独立しているため、同一メッセージ内で順序立てて実行可能：

```typescript
// 1つのメッセージで複数Taskを呼び出し
Task({
  subagent_type: "logic-validator",
  description: "Validate plan logic",
  prompt: "..."
})

// 続けて外部レビュー（必要な場合）
/codex-review
```

### 段階的検証

計画の複雑さに応じて検証レベルを選択：

- **シンプル**: logic-validator のみ
- **中程度**: logic-validator + codex-review
- **複雑**: logic-validator + self-review + codex-review-mcp

## 実装例

### シナリオ: JWT認証システムの実装計画検証

```markdown
# 1. 計画ファイル確認
ls -lt ~/.claude/plans/*.md | head -1
# 出力: ~/.claude/plans/jwt-auth-plan.md

Read({ file_path: "~/.claude/plans/jwt-auth-plan.md" })

# 2. 論理検証
Task({
  subagent_type: "logic-validator",
  description: "Validate JWT auth plan",
  prompt: `
# JWT認証実装計画の検証

[計画内容]

## 検証ポイント
1. JWT生成・検証ロジックの完全性
2. トークン保存・リフレッシュ戦略
3. エラーハンドリングの網羅性
4. セキュリティベストプラクティスの考慮
5. テストステップの妥当性
`
})

# 3. セキュリティ視点でレビュー（認証なので重要）
/codex-review

「JWTベースの認証実装計画について、セキュリティの観点からレビューしてください。
特に以下の点を評価してください：
- トークンの保存方法（httpOnly cookie vs localStorage）
- リフレッシュトークン戦略
- XSS/CSRF対策
- トークン有効期限設定

[計画の要約]」

# 4. 重大な指摘があれば計画を改善
# （例：CSRF対策が不足していた場合）
Edit({
  file_path: "~/.claude/plans/jwt-auth-plan.md",
  old_string: "ステップ5: JWTトークンを生成して返す",
  new_string: `ステップ5: JWTトークンを生成
- トークン生成にはRS256アルゴリズムを使用
- httpOnly, secure, sameSite=strict cookieとして設定
- CSRF対策: ダブルサブミットクッキーパターンを実装
- 検証: トークン生成後、デコードして内容確認`
})

# 5. 問題なしと判定されたら実装開始
# （計画はすでに ~/.claude/plans/ に保存されている）
```

## Validation Checklist

詳細なチェックリストは [validation-checklist.md](validation-checklist.md) を参照。

**最重要項目:**

### 論理的整合性
- [ ] 各ステップの目的が明確
- [ ] ステップ間の依存関係が正しい
- [ ] 検証なしの成功仮定がない

### 完全性
- [ ] 必要なファイル読み取りが含まれる
- [ ] テスト・ビルド確認が含まれる
- [ ] エッジケースが考慮されている

### 実行可能性
- [ ] 各ステップが具体的
- [ ] 必要なツール・コマンドが明記
- [ ] 実装順序が論理的

## Anti-Patterns

| Anti-Pattern | 問題 | 対策 |
|--------------|------|------|
| 形式的検証 | レビューしたが何も考えない | 実際に改善点を見つける |
| 過剰検証 | 単純計画で複数エージェント起動 | 複雑さに応じて選択 |
| 指摘無視 | 重大な指摘を無視 | 論理的矛盾は必ず解決 |
| スコープ拡大 | レビューで追加機能を盛り込む | 元のタスクに集中 |
| 無限ループ | レビュー→修正→レビュー繰り返し | 2回まで |

## Troubleshooting

詳細は [troubleshooting.md](troubleshooting.md) を参照。

**よくある問題:**

### 計画ファイルが見つからない

```bash
# 複数の場所を確認
ls -lt ~/.claude/plans/*.md 2>/dev/null
ls -lt .claude/plans/*.md 2>/dev/null
```

Plan Modeで計画を保存していなかった場合、会話履歴から計画を抽出して新規ファイルに保存。

### logic-validatorが起動しない

```typescript
// ❌ Wrong subagent_type
Task({ subagent_type: "logic-validation", ... })

// ✅ Correct
Task({ subagent_type: "logic-validator", ... })
```

### レビュー結果が矛盾

各エージェントの専門性を考慮：
- logic-validator: 論理整合性、証拠の有無
- codex-review: 実装アプローチ、設計判断
- self-review: 多角的視点（セキュリティ、UI/UX等）

最終判断は自分で行う。

## Related Resources

- [validation-checklist.md](validation-checklist.md): 詳細チェックリスト
- [troubleshooting.md](troubleshooting.md): トラブルシューティング詳細
- `~/.claude/rules/external-review.md`: 外部レビューガイドライン
- `/logic-validation` skill: 論理的整合性検証
- `/codex-review` skill: 外部視点レビュー
- `/self-review` skill: 多面的レビュー

## Quick Reference

```bash
# 基本フロー（ExitPlanMode がブロックされた後）
1. 計画ファイル確認: ls -lt ~/.claude/plans/*.md
2. 読み取り: Read({ file_path: "~/.claude/plans/plan.md" })
3. 論理検証: Task(logic-validator)
4. 外部レビュー（必要なら）: /codex-review
5. 判定:
   - 🚫 決定的な欠落 → 実装停止、計画再作成
   - ⚠️ 中程度 → 改善: Edit({ ... }) → 再検証（最大2回）
   - ✅ 問題なし → 6へ
6. 検証完了マーカーを追加:
   Edit({ file_path: "plan.md", old_string: "[last line]", new_string: "[last line]\n\n<!-- validated -->" })
7. ExitPlanMode を再実行 → 実装開始

# 検証レベルの選択
- Simple plan → logic-validator のみ
- Medium complexity → + codex-review
- Complex/security-critical → + self-review

# 重要原則
- 決定的な欠落がある状態では、絶対に実装を開始しない
- <!-- validated --> マーカーがないと ExitPlanMode はブロックされる
```
