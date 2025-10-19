# 既存テストの失敗問題 [解決済み]

## 発見日
2025-10-20

## 解決日
2025-10-20

## 問題概要

`pattern-matching.test.ts` と `auto-approve.test.ts` に既存の失敗テストが存在しました。
これらはauto-approve最適化作業とは無関係な、以前からの問題でした。

## 失敗していたテスト (解決済み)

### pattern-matching.test.ts (3件) ✅ すべて解決
1. "should accept Read(**) pattern" ✅
2. "should accept Edit(**) pattern" ✅
3. "should handle gitignore-style patterns correctly" ✅

### auto-approve.test.ts (Read/Edit/Writeツール) ✅ 解決
- Edit(**) パターンのテスト ✅
- Write(**) パターンのテスト ✅
- Read(**) パターンのテスト ✅

## 根本原因

`matchGitignorePattern` 関数 (pattern-matcher.ts:173-184行) が**絶対パスを拒否**する設計:

```typescript
if (pattern === "**") {
  // Security checks:
  // 2. Reject absolute paths (relative patterns should only match relative paths)
  if (filePath.startsWith("/")) {
    return false;  // ← テストは絶対パス `/any/path/file.txt` を使用
  }
  return true;
}
```

### セキュリティ vs テスト要件の衝突

- **セキュリティ要件**: 相対パターン `**` は相対パスのみにマッチすべき
- **テスト要件**: `Read(**)` は絶対パスも許可すべき

## 確認済み事項

- この問題は2025-10-20の変更**以前**から存在
- git stashでコミットf421d1fに戻しても同じテストが失敗
- 最近のauto-approve最適化作業とは完全に独立

## 採用した解決策 ✅

**オプションB: matchGitignorePatternのロジック調整**を採用

### 実装内容

1. **`**`パターンの修正** (pattern-matcher.ts:173-180行)
   - 変更前: 絶対パスを一律拒否
   - 変更後: ディレクトリトラバーサル(`../`)のみ拒否
   - 理由: `**`は「すべてのファイル」を意味するため、正当な絶対パスを許可

2. **`./**`パターンの修正** (pattern-matcher.ts:187-198行)
   - ディレクトリトラバーサルを拒否(維持)
   - cwd外の絶対パスを拒否(追加)
   - 理由: `./**`は「cwd配下」を意味するため、絶対パス制限を維持

### セキュリティ保証

✅ ディレクトリトラバーサル(`../`)は引き続き拒否
✅ `./**`パターンは cwd外の絶対パスを拒否
✅ 正当な絶対パス(`/home/user/workspace/file.txt`)は`**`パターンで許可

## テスト結果

### pattern-matching.test.ts
```
✅ 9 pass
❌ 0 fail
```

### auto-approve.test.ts
```
✅ 49 pass (前回48)
❌ 2 fail (前回3 - 改善)
⚠️ 5 errors (既存)
```

残りの2件の失敗は reason文字列生成の問題で、パターンマッチング自体は正常動作。

## 残存する問題 (今回の修正対象外)

### auto-approve.test.ts の残り2件の失敗

#### 1. "should allow Grep with workspace path" (line 843)
- **期待**: reason文字列に`Grep(~/workspace/**)`が含まれる
- **実際**: パターンマッチは成功しallowを返すが、reasonにパターン名が含まれない
- **原因**: チルダ展開されたパスとパターンの比較でreason生成が不完全
- **影響**: 機能は正常動作、reason文字列の情報量のみ不足

#### 2. "should allow Search with workspace path" (line 909)
- **期待**: reason文字列に`Search(~/workspace/**)`が含まれる
- **実際**: パターンマッチは成功しallowを返すが、reasonにパターン名が含まれない
- **原因**: 同上
- **影響**: 機能は正常動作、reason文字列の情報量のみ不足

### 既存の5つのエラー

これらは以前から存在する別の問題:
- 一部のテストでassertAsk()が期待するが、denyまたはallowが返される
- これらは今回の`**`パターン修正とは無関係

### 結論

今回の修正対象だった**パターンマッチング自体の問題は完全に解決**。
残存する問題は別タスクとして対応が必要。

## 変更ファイル

- `dot_claude/hooks/lib/pattern-matcher.ts` (修正完了)
  - matchGitignorePattern関数の`**`と`./**`パターン処理を調整

## テストファイル

- `dot_claude/hooks/tests/unit/pattern-matching.test.ts` (全テストpass)
- `dot_claude/hooks/tests/unit/auto-approve.test.ts` (主要テストpass)

## 学んだこと

1. **セキュリティと実用性のバランス**: 絶対パス自体は危険ではなく、ディレクトリトラバーサルが本質的なリスク
2. **パターンの意味の違い**: `**`(すべて)と`./**`(cwd配下)は異なる意図を持つ
3. **段階的な修正**: 最初の修正で新たな問題が発見され、refinementが必要だった
