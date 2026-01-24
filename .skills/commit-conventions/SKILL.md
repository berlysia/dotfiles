---
name: commit-conventions
description: Use this skill when dealing with complex commits involving multiple change types, when unsure how to split changes into atomic commits, when determining appropriate scope for a commit, when writing commit body for non-trivial changes, or when the user asks about commit best practices, semantic versioning impact, or conventional commit format details.
context: fork
---

# Commit Conventions Guide

複雑なコミットシナリオや判断に迷う場面での詳細ガイダンス。単純なケースはCLAUDE.mdの基本原則で十分。

## 複雑なケースの判断基準

### いつこのスキルが必要か

| シナリオ | 複雑度 | 推奨アプローチ |
|----------|--------|----------------|
| 1ファイル、1種類の変更 | 単純 | CLAUDE.md原則で直接コミット |
| 複数ファイル、同一目的 | 単純 | CLAUDE.md原則で直接コミット |
| 複数種類の変更が混在 | **複雑** | このスキル参照 or `/semantic-commit` |
| 大規模リファクタリング | **複雑** | `/semantic-commit` で自動分割 |
| Breaking changes | **複雑** | このスキル参照 |

## 変更の分離戦略

### 混在パターンと分離方法

**パターン1: 機能追加 + バグ修正**
```
✅ 正しい分離:
  1. fix(auth): handle null user in session check
  2. feat(auth): add remember-me functionality

❌ 混在させない:
  feat(auth): add remember-me and fix null check
```

**パターン2: リファクタ + 機能変更**
```
✅ 正しい順序:
  1. refactor(api): extract validation to separate module
  2. feat(api): add email format validation

理由: リファクタを先にすることで、機能追加の差分が明確になる
```

**パターン3: テスト + 実装**
```
✅ TDDスタイル:
  1. test(auth): add tests for token refresh
  2. feat(auth): implement token refresh logic

✅ 実装後テスト:
  1. feat(auth): implement token refresh logic
  2. test(auth): add tests for token refresh

どちらでも可、プロジェクトの慣習に従う
```

### 分離できない場合

密結合した変更は無理に分離しない：
```
✅ 許容される混在:
fix(database): handle connection timeout and add retry logic

理由: リトライロジックはタイムアウト対応の一部として不可分
```

## スコープ決定ガイド

### スコープの粒度

```
プロジェクト構造例:
src/
├── auth/          → scope: auth
├── api/
│   ├── users/     → scope: api または users
│   └── products/  → scope: api または products
├── database/      → scope: database, db
└── utils/         → scope: utils (または省略)
```

### スコープ選択フロー

```
1. 影響範囲は単一モジュール？
   → Yes: そのモジュール名をスコープに
   → No: 次へ

2. 影響範囲は関連する複数モジュール？
   → Yes: 親カテゴリまたは機能名をスコープに
   → No: 次へ

3. プロジェクト全体に影響？
   → スコープ省略
```

### プロジェクト履歴からの学習

```bash
# 既存スコープの確認
git log --oneline -50 | grep -oP '(?<=\()[^)]+(?=\))' | sort | uniq -c | sort -rn

# 出力例:
#   12 auth
#    8 api
#    5 hooks
#    3 database
```

既存パターンに従うことで一貫性を保つ。

## 本文（Body）の書き方

### 本文が必要なケース

1. **WHYが自明でない場合**
   ```
   refactor(api): change error response format

   The previous format was inconsistent with REST best practices
   and caused confusion in client error handling. New format
   follows RFC 7807 Problem Details specification.
   ```

2. **複数の関連変更がある場合**
   ```
   feat(auth): implement OAuth2 PKCE flow

   Changes include:
   - Add code verifier generation
   - Implement code challenge creation
   - Update token exchange to include verifier
   - Add state parameter for CSRF protection
   ```

3. **Breaking Changesがある場合**
   ```
   feat(api)!: require authentication for all endpoints

   Previously, read-only endpoints were public. This change
   requires all API calls to include a valid JWT token.

   Migration:
   1. Generate API token in dashboard
   2. Add Authorization header to all requests
   3. Update client SDK to v2.0+

   BREAKING CHANGE: All endpoints now require authentication.
   ```

### 本文のフォーマット

```
<type>(<scope>): <description>
                                    ← 空行必須
<body - 72文字で折り返し>
                                    ← 空行
<footer>
```

## タイプ選択の詳細判断

### 境界ケース

| 変更内容 | 判断 | 理由 |
|----------|------|------|
| パフォーマンス改善のためのリファクタ | `perf` | 目的がパフォーマンス |
| バグを直しながらリファクタ | `fix` | バグ修正が主目的 |
| 新機能のためのリファクタ | `refactor` → `feat` | 2コミットに分離 |
| ドキュメント内のコード例更新 | `docs` | ドキュメントが主 |
| コメントのみの追加 | `docs` または省略 | プロジェクト慣習による |
| 依存関係のセキュリティ更新 | `chore` または `fix` | 脆弱性対応なら`fix` |

### セマンティックバージョニングへの影響

| タイプ | バージョン影響 |
|--------|----------------|
| `feat` | MINOR (0.x.0) |
| `fix` | PATCH (0.0.x) |
| `feat!`, `fix!` | MAJOR (x.0.0) |
| その他 | バージョン影響なし |

## エッジケース対処

### Pre-commit hookによる変更

```bash
# Hook実行後にファイルが変更された場合
git status  # 変更を確認

# 安全にamendできる条件:
# 1. 直前のコミットが自分のもの
# 2. まだpushしていない

git log -1 --format='%an %ae'  # 作者確認
git status | grep "Your branch is ahead"  # push状態確認

# 条件を満たせばamend
git add -u
git commit --amend --no-edit
```

### 空コミット防止

```bash
# ステージングエリアの確認
git diff --cached --name-only

# 空の場合はコミットしない
if [ $(git diff --cached --name-only | wc -l) -eq 0 ]; then
  echo "Nothing staged for commit"
fi
```

### 部分的なファイルステージング

```bash
# ファイル内の特定の変更のみステージ
git add -p <file>

# または git-sequential-stage を使用（/commit コマンド）
git-sequential-stage -patch="changes.patch" -hunk="file.py:1,3"
```

## チェックリスト

コミット前の最終確認:

- [ ] タイプは変更の主目的を反映している
- [ ] スコープは既存パターンと一致している
- [ ] 説明文は現在形・命令形
- [ ] 72文字以内に収まっている
- [ ] 複数種類の変更が混在していない
- [ ] Breaking changesは感嘆符(!)およびBREAKING CHANGE:で明示
- [ ] 本文はWHYを説明している（必要な場合）

## 関連ツール

- `/commit` - 汎用コミットコマンド（シンプルな変更を直接コミット）
- `/semantic-commit` - 複雑な変更の自動分析・分割（4フェーズワークフロー）
- `git-sequential-stage` - hunk単位の精密なステージング
- `change-semantic-analyzer` agent - 変更の意味解析とグループ化
- `commit-message-generator` agent - メッセージ生成の詳細ロジック
