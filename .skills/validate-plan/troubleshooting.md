# Troubleshooting - Plan Validation Skill

validate-planスキル実行時のトラブルシューティングガイド。

## 計画ファイル関連

### 計画ファイルが見つからない

**症状:**
```bash
ls -lt ~/.claude/plans/*.md
# ls: cannot access '~/.claude/plans/*.md': No such file or directory
```

**原因:**
- Plan Modeで計画を明示的に保存していない
- plansDirectoryの設定が異なる
- プロジェクトローカルの .claude/plans/ を使用している

**対処:**

1. 複数の場所を確認:
```bash
# グローバルとプロジェクトローカルの両方を確認
ls -lt ~/.claude/plans/*.md 2>/dev/null
ls -lt .claude/plans/*.md 2>/dev/null

# settings.jsonで設定されたディレクトリ確認
jq '.plansDirectory' ~/.claude/settings.json
```

2. 会話履歴から計画を抽出:
```bash
# 直近の会話から計画部分をコピーして新規ファイルに保存
mkdir -p ~/.claude/plans
echo "# Implementation Plan
[会話履歴からコピーした計画内容]
" > ~/.claude/plans/recovered-plan.md
```

3. 今後の対策:
```bash
# settings.jsonでplansDirectoryを明示的に設定
jq '.plansDirectory = "~/.claude/plans"' ~/.claude/settings.json > /tmp/settings.json && \
mv /tmp/settings.json ~/.claude/settings.json
```

### 計画ファイルのパスがわからない

**対処:**

Plan Modeのsystem messageを確認（会話履歴の最初）:
```
You are now in plan mode. Write your plan to: /tmp/plan-abc123.md
```

または、最近作成されたファイルを確認:
```bash
find ~/.claude/plans -name "*.md" -mtime -1 -ls 2>/dev/null
find .claude/plans -name "*.md" -mtime -1 -ls 2>/dev/null
```

## logic-validator関連

### logic-validatorが起動しない

**症状:**
```
Error: Unknown subagent type: logic-validation
```

**原因:**
subagent_typeのタイプミス

**対処:**
```typescript
// ❌ Wrong
Task({ subagent_type: "logic-validation", ... })
Task({ subagent_type: "logic-verify", ... })

// ✅ Correct
Task({ subagent_type: "logic-validator", ... })
```

### logic-validatorのプロンプトが長すぎる

**症状:**
計画が非常に長い（1000行以上）場合、コンテキスト制限に達する可能性

**対処:**

1. 計画の要約版を作成:
```typescript
Task({
  subagent_type: "logic-validator",
  prompt: `
# 実装計画の検証（要約版）

## ステップ概要
1. [ステップ1の要約]
2. [ステップ2の要約]
...

## 重点検証ポイント
[特に確認してほしい部分のみ詳細記載]
`
})
```

2. 段階的に検証:
```typescript
// ステップ1-3を検証
Task({ subagent_type: "logic-validator", prompt: "..." })

// ステップ4-6を検証
Task({ subagent_type: "logic-validator", prompt: "..." })
```

## 外部レビュー関連

### codex-reviewが使えない

**症状:**
```
/codex-review
# Error: Skill not found
```

**原因:**
- スキルがインストールされていない
- スキル名のタイプミス

**対処:**

1. スキルの存在確認:
```bash
ls ~/.claude/skills/ | grep codex
ls ~/.codex/skills/ | grep codex
```

2. スキルが無い場合、スキルリストから確認:
```bash
# CLAUDE.mdに記載されているスキル一覧を参照
```

3. 代替手段:
```typescript
// codex-review-mcp（MCP経由）を使用
Task({
  subagent_type: "general-purpose",
  prompt: "Codex MCPを使って、以下の計画をレビューしてください..."
})
```

### 複数のレビューエージェントの結果が矛盾

**症状:**
- logic-validator: 「問題なし」
- codex-review: 「この実装は推奨されない」

**原因:**
各エージェントの専門性が異なる

**対処:**

1. 各エージェントの役割を理解:
   - logic-validator: 論理整合性、証拠の有無
   - codex-review: 実装アプローチ、ベストプラクティス
   - self-review: 多角的視点（セキュリティ、UI/UX等）

2. 矛盾の内容を分析:
```markdown
## 矛盾の分析

### logic-validator の評価
- 論理的に整合している
- 検証ステップが含まれている

### codex-review の評価
- より良い実装パターンがある
- パフォーマンス上の懸念

### 判断
logic-validatorは「計画が論理的か」を評価
codex-reviewは「より良い方法があるか」を評価

→ 両方正しい。codex-reviewの提案を採用して計画改善
```

3. 最終判断は自分で行う

## 検証プロセス関連

### 検証に時間がかかりすぎる

**症状:**
logic-validator + codex-review + self-review で5分以上かかる

**対処:**

1. 計画の複雑さに応じて検証レベルを調整:
```markdown
# シンプルな計画（5ステップ以下、1-2ファイル変更）
→ logic-validator のみ（1-2分）

# 中程度の計画（10ステップ程度、複数ファイル）
→ logic-validator + codex-review（2-3分）

# 複雑な計画（15ステップ以上、アーキテクチャ変更）
→ logic-validator + self-review（3-5分）
```

2. 並列実行を活用:
```typescript
// 同一メッセージで実行
Task({ subagent_type: "logic-validator", ... })
/codex-review
```

3. プロンプトを簡潔に:
```typescript
// ❌ 長すぎる
prompt: `
[計画全文 1000行]

検証ポイント:
1. [詳細な説明]
2. [詳細な説明]
...
`

// ✅ 簡潔
prompt: `
[計画の要約 100行]

重点検証: 論理整合性、エッジケース、セキュリティ
`
```

### 無限ループ（レビュー→修正→レビュー...）

**症状:**
何度検証しても新しい指摘が出続ける

**対処:**

1. 検証回数を制限（最大2回）:
```markdown
1回目: 初回検証 → 重大な問題を修正
2回目: 再検証 → 軽微な問題のみ → OK として進める
```

2. 指摘の優先度を明確化:
```markdown
## 必ず対応
- 論理矛盾
- セキュリティリスク
- 検証ステップの欠落

## 検討
- 代替実装案
- パフォーマンス最適化

## 無視可
- スコープ外の提案
- 過度に保守的な提案
```

3. 「完璧」を求めない:
```markdown
目標: 70点 → 85点
× 目標: 100点（永遠に終わらない）
```

## 計画の改善関連

### 計画が大幅に変更され、元の意図と異なる

**症状:**
レビュー後、計画が複雑化・スコープが拡大

**原因:**
外部レビューの提案をすべて取り入れている

**対処:**

1. スコープを明確化:
```markdown
## 元のタスク
[ユーザーが依頼した内容]

## レビューでの提案
- [提案1] → スコープ内 ✅
- [提案2] → スコープ外 ❌（別タスクとして記録）
- [提案3] → 過度に複雑 ❌
```

2. CLAUDE.mdの原則に従う:
```markdown
> Avoid over-engineering. Only make changes that are directly requested
> or clearly necessary.
```

3. 判断基準:
   - 元のタスク達成に必須か？
   - より単純な代替案はないか？
   - 将来の拡張性より、今の要求を満たすことを優先

### 改善後の計画が複雑化

**対処:**

1. 検証ステップは追加してよい:
```markdown
# Before
ステップ3: データベースに保存

# After（OK）
ステップ3: データベースに保存
- 検証: SELECT文で保存されたデータを確認
- エラー時: ロールバックして再試行
```

2. 実装の複雑化は避ける:
```markdown
# Before
ステップ3: JWTトークンを生成

# After（❌ 過度に複雑化）
ステップ3: JWTトークンを生成
- JWTライブラリの評価（jsonwebtoken vs jose）
- トークンのバージョニング戦略
- トークンローテーション機能の実装
- トークン監査ログの設計
→ スコープ外の提案が混入
```

## パフォーマンス関連

### validate-planスキル自体が重い

**対処:**

1. 不要なファイル読み取りを削減:
```typescript
// ❌ 全計画ファイルを読む
Read({ file_path: "/tmp/plan-old1.md" })
Read({ file_path: "/tmp/plan-old2.md" })
Read({ file_path: "/tmp/plan-current.md" })

// ✅ 最新の計画のみ
Read({ file_path: "/tmp/plan-current.md" })
```

2. model指定を調整:
```yaml
# 高精度が必要な場合のみ
model: opus

# 通常は
model: sonnet
```

3. disable-model-invocationが設定されているか確認:
```yaml
---
disable-model-invocation: true  # これがないとモデル呼び出しが多発
---
```

## エラーメッセージ解読

### "Subagents cannot spawn other subagents"

**原因:**
Plan Mode中にこのスキルを実行しようとした

**対処:**
1. ExitPlanMode を実行
2. Normal Modeに戻ってから /validate-plan を実行

### "Task tool not allowed"

**原因:**
allowed-toolsにTaskが含まれていない

**対処:**
```yaml
# SKILL.mdのfrontmatterを確認
---
allowed-tools: Read, Bash, Task  # Task が必要
---
```

### "Plan file is too large"

**原因:**
計画ファイルが大きすぎてReadツールで読み取れない

**対処:**
```bash
# ファイルサイズ確認
wc -l /tmp/plan-*.md

# 大きすぎる場合（2000行超）、要約版を作成
head -100 /tmp/plan-large.md > /tmp/plan-summary.md
echo "..." >> /tmp/plan-summary.md
tail -100 /tmp/plan-large.md >> /tmp/plan-summary.md
```

## よくある質問

### Q: 毎回validate-planを実行する必要がありますか？

A: いいえ。以下の場合は推奨：
- 複雑な計画（10ステップ以上）
- アーキテクチャ変更を含む
- セキュリティ機能の実装
- 外部視点が欲しい場合

単純な計画（1-2ファイル変更、明確な修正）は不要です。

### Q: logic-validatorの指摘は必ず従うべき？

A: いいえ。参考意見として扱い、最終判断は自分で行ってください。
特に以下の場合は無視してよい：
- プロジェクト固有の制約と矛盾
- 過度に保守的な提案
- スコープ外の指摘

### Q: 検証後に計画を変更しなくてもよい？

A: はい。検証の結果「問題なし」と判断できれば、変更せずに実装開始してOKです。
形式的に検証するだけでなく、実際に改善点を見つけることが重要です。

### Q: Plan Modeを使わずに直接実装した場合は？

A: このスキルは不要です。Plan Modeで作成した計画のみが対象です。

## 関連リソース

- [SKILL.md](SKILL.md): メインドキュメント
- [validation-checklist.md](validation-checklist.md): 詳細チェックリスト
- `~/.claude/rules/external-review.md`: 外部レビューガイドライン
- `~/.claude/CLAUDE.md`: タスク完了プロトコル
