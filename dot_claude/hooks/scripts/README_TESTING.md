# Auto-Approve Commands Testing

このディレクトリには、auto-approve-commands機能の包括的なテストスイートが含まれています。

## テストファイル構成

### メインテストスイート
- **`test_auto_approve.sh`** - 基本機能の包括的テスト（20テストケース）
- **`test_edge_cases.sh`** - エッジケースとアドバンス機能のテスト（20テストケース）
- **`run_all_tests.sh`** - 全テストの実行とレポート生成

### CI/CD関連
- **`ci_test.sh`** - CI/CD環境での実行用スクリプト
- **`pre-commit`** - Gitのpre-commitフック（`.git/hooks/`に配置済み）

## テスト実行方法

### 基本実行
```bash
# 全テストを実行
./run_all_tests.sh

# 基本テストのみ実行
./test_auto_approve.sh

# エッジケーステストのみ実行
./test_edge_cases.sh
```

### CI/CD環境での実行
```bash
# CI環境での実行
./ci_test.sh
```

### Pre-commitフック
フック関連ファイルが変更された場合、コミット前に自動でテストが実行されます：

```bash
# 通常のコミット（テストが自動実行される）
git commit -m "フック機能を更新"

# テストをスキップしてコミット
git commit --no-verify -m "テストスキップ"
# または
SKIP_HOOK_TESTS=1 git commit -m "テストスキップ"
```

## テスト対象機能

### 基本パターンマッチング
- ✅ Allow/Denyパターンの基本動作
- ✅ 単一コマンドのマッチング
- ✅ パターンなしの場合の処理

### 複合コマンド処理
- ✅ `&&` (AND) 演算子での連結
- ✅ `||` (OR) 演算子での連結  
- ✅ `;` (sequential) 演算子での連結
- ✅ `|` (pipe) 演算子での連結

### ラッパーコマンド検出
- ✅ `timeout` コマンド内の子コマンド検出
- ✅ `time` コマンド内の子コマンド検出
- ✅ `npx/pnpx/bunx` コマンド内の子コマンド検出
- ✅ `xargs` コマンド内の子コマンド検出
- ✅ `find -exec` 内の子コマンド検出

### セキュリティ機能
- ✅ 全コマンド明示的許可の要求
- ✅ 1つでもDenyされた場合のブロック
- ✅ 許可されていないコマンドのパススルー

### エッジケース
- ✅ ネストしたラッパーコマンド
- ✅ 長いパイプチェーン
- ✅ 特殊文字を含むコマンド
- ✅ Unicode文字の処理
- ✅ 複雑なリダイレクション

## テスト環境変数

### フック制御
- `SKIP_HOOK_TESTS=1` - pre-commitテストをスキップ
- `FORCE_HOOK_TESTS=1` - フック関連ファイル未変更でもテスト実行
- `CI_MODE=1` - CI環境モード（詳細出力）

### 実行例
```bash
# フックテストを強制実行
FORCE_HOOK_TESTS=1 git commit -m "強制テスト実行"

# CI環境でのテスト
CI_MODE=1 ./run_all_tests.sh
```

## テスト結果の読み方

### 成功時
```
🎉 ALL TESTS PASSED! 🎉
The auto-approve system is working correctly.
```

### 警告付き成功
```
⚠ TESTS PASSED WITH WARNINGS ⚠
The auto-approve system is functional but may need optimization.
```

### 失敗時
```
❌ TESTS FAILED ❌
The auto-approve system has issues that need to be addressed.
```

## パフォーマンス基準

- **実行時間**: 50回評価で5秒以内
- **メモリ使用量**: 100回評価で1MB増加以内
- **個別評価**: 平均100ms以内

## トラブルシューティング

### テストが失敗する場合
1. 構文エラーのチェック
2. 設定ファイルの確認
3. パーミッションの確認
4. ログファイルの確認

### デバッグ方法
```bash
# 詳細デバッグ出力
bash -x ./test_auto_approve.sh

# 設定ファイル確認
cat ~/.claude/settings.local.json
```

## 新しいテストの追加

新しいテストケースを追加する場合：

1. `test_auto_approve.sh`または`test_edge_cases.sh`に追加
2. `run_test`関数を使用してテストケースを記述
3. 期待される結果を明確に指定
4. エラーケースも含めて網羅的にテスト

### テストケース例
```bash
run_test \
    "新機能のテスト" \
    "新しいコマンド" \
    "期待される結果(approve/block/no_match)" \
    "許可パターンのJSON配列" \
    "拒否パターンのJSON配列(オプション)"
```