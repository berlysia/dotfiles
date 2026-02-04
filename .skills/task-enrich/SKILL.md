---
name: task-enrich
description: Verify and enrich task descriptions to ensure each is independently executable with sufficient context. Use when "enriching tasks", "preparing handoff", "verifying task quality", or before running /task-handoff.
context: inherit
---

# Task Enrichment

タスクリストの各タスクが、会話コンテキストなしでも独立に実行可能な十分な文脈を持つことを論理的に検証し、不足があれば拡充します。

## コア原則

**タスク説明は「別のClaudeセッションがこの説明だけを読んで実行できる」レベルの自己完結性を持つべき。**

会話の中で暗黙に共有されている文脈（「先ほどの議論」「上記のファイル」等）は、次のセッションには引き継がれない。

## 品質基準

各タスクの description は以下の5要素を含むべき:

| 要素 | 説明 | 例 |
|------|------|-----|
| **What** | 何をするか（具体的な動作） | 「ログインAPIにレート制限を追加する」 |
| **Where** | 対象ファイル/場所 | 「src/routes/auth.ts の loginHandler 関数」 |
| **How** | 実装方法の手がかり | 「既存の src/middleware/rateLimit.ts パターンを参照」 |
| **Why** | 目的・背景・このタスクが全体の中でどこに位置するか | 「ブルートフォース攻撃対策、Task#2のユーザー認証の前提」 |
| **Verify** | 完了確認方法 | 「`pnpm test -- --grep rateLimit` でテスト通過」 |

## ワークフロー

### Step 1: タスクリスト取得

TaskList ツールでタスク一覧を取得する。

タスクがない場合は「タスクリストが空です」と通知して終了する。

### Step 2: 各タスクの品質評価

各 pending / in_progress タスクについて TaskGet で詳細を取得し、5要素の充足度を評価する。

**評価基準**:
- ✅ **十分**: 5要素のうち4つ以上が明確に記述されている
- ⚠️ **要改善**: 2-3要素のみ。拡充すれば実行可能
- ❌ **不十分**: 1要素以下。大幅な拡充が必要

評価結果を一覧表示する:

```markdown
## タスク品質評価

| # | Subject | What | Where | How | Why | Verify | 判定 |
|---|---------|------|-------|-----|-----|--------|------|
| 1 | タスク名 | ✅ | ✅ | ⚠️ | ✅ | ❌ | ⚠️ 要改善 |
| 2 | タスク名 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ 十分 |
```

### Step 3: 文脈収集（不足タスクのみ）

⚠️ または ❌ のタスクについて、不足要素を補うための文脈を収集する。

**収集方法**:
1. **会話コンテキストから**: inherit モードなので、今回の会話で議論された内容を参照可能
2. **コードベースから**: Glob, Grep, Read で関連ファイルを探索
   - タスクに言及されているファイルパスやキーワードを手がかりにする
   - 既存のコードパターンを確認する
3. **タスク間の依存関係**: blocks/blockedBy の関係から、前提条件や後続作業を把握

**重要**: 推測で補完しない。確認できた事実のみを description に追加する。不明な点は `[要確認: ...]` として明示する。

### Step 4: description の拡充

不足要素を補った新しい description を構成する。

**拡充テンプレート**:

```markdown
## 概要
[What: 具体的な実行内容]

## 対象
[Where: ファイルパス、関数名、コンポーネント名]

## 実装方針
[How: 参照すべき既存パターン、使用するライブラリ、アプローチ]

## 背景・目的
[Why: なぜこのタスクが必要か、全体のどこに位置するか]

## 依存関係
- blocks: [このタスクが完了しないと開始できないタスク]
- blockedBy: [このタスク開始前に完了が必要なタスク]

## 完了確認
[Verify: テストコマンド、期待される出力、手動確認手順]
```

**拡充ルール**:
- 既存の description が良質な場合は不足要素のみ追加する（全面書き換えしない）
- 会話コンテキストへの参照（「先ほどの議論」「上記の通り」等）を具体的な内容に展開する
- ファイルパスは実在を確認してから記載する

### Step 5: TaskUpdate で反映

拡充した description を TaskUpdate ツールで各タスクに反映する。

**変更前後の差分を表示**:
```markdown
### Task #N: [subject]

**変更前**: [元の description の要約]
**追加された要素**: What / Where / How / Why / Verify
**変更後の判定**: ✅ 十分
```

### Step 6: 論理的整合性の検証

すべてのタスクの拡充が完了したら、logic-validator エージェントでタスクリスト全体の整合性を検証する。

```typescript
Task({
  subagent_type: "logic-validator",
  description: "Validate enriched task list consistency",
  prompt: `
以下のタスクリストの論理的整合性を検証してください：

[全タスクの subject + description を列挙]

検証ポイント：
1. 各タスクの description は独立に実行可能な情報を持つか
2. タスク間の依存関係に矛盾はないか
3. 全タスクを合わせて元の目標を達成できるか
4. 暗黙の前提や曖昧な記述が残っていないか
`
})
```

検証結果に問題があれば Step 4 に戻って修正する（最大2回）。

### Step 7: 最終サマリー

```markdown
## タスク拡充完了

**処理結果**:
- ✅ 十分（変更なし）: N タスク
- 📝 拡充済み: N タスク
- ⚠️ 要確認事項あり: N タスク

**ハンドオフ準備状況**: ✅ Ready / ⚠️ 要確認事項あり

> `/task-handoff` で次セッションへの引き継ぎコマンドを生成できます。
```

## 連携スキル

| スキル | 役割 | タイミング |
|--------|------|-----------|
| `/decomposition` | 複雑タスクの分解 | タスク作成時 |
| `/task-enrich` (このスキル) | タスク説明の検証・拡充 | タスク作成後、ハンドオフ前 |
| `/task-handoff` | 次セッション引き継ぎ | task-enrich 完了後 |

## 推奨ワークフロー

```
/decomposition → タスク分解
     ↓
/task-enrich → 説明拡充・検証
     ↓
/task-handoff → 引き継ぎコマンド生成
```
