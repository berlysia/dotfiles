# Dotfiles Project - Development Context

## 🚧 ACTIVE DEVELOPMENT PROJECT

**このプロジェクトは現在、dotfiles統合テストスイートの大規模統合作業中です。**

### 現在の状況（Phase 2 - Core Integration）
- **作業場所**: `/home/berlysia/.local/share/chezmoi/dot_shell_common/`
- **現在のフェーズ**: Phase 2.1 - check_command関数の統合
- **進捗**: 基盤アーキテクチャ完了 ✅ → 120+テスト統合中 🚧

### 🎯 「続けて」と言われた場合の動作

1. **作業ディレクトリに移動**:
   ```bash
   cd /home/berlysia/.local/share/chezmoi/dot_shell_common
   ```

2. **現状確認**:
   ```bash
   cat CURRENT_STATUS.md
   ```

3. **TodoWrite開始**して進捗管理

4. **Phase 2.1実行**: dotfiles_doctor.shの`check_command()`関数をcore/test_engine.shに統合

### 重要なファイル
- `CURRENT_STATUS.md` - リアルタイム状況
- `INTEGRATION_PLAN.md` - 全体計画
- `START_HERE.md` - 作業再開指示
- `dotfiles_doctor.sh` - 統合元（120+チェック項目）
- `core/test_engine.sh` - 統合先

### 作業コンテキスト
統合テストスイートのアダプターパターン実装済み。現在は既存のdotfiles_doctor.shの包括的な機能（重要度分類、重み付けスコア、インストールヒント）を新しいtest_suite.sh に完全統合中。

---

## Development Guidelines

### Language
- Japanese for discussion, English for code

### Current Task Priority
**Phase 2.1 が最優先**: dotfiles_doctor.shの統合がメインタスクです。他の作業よりも優先してください。

### Working Directory
常に `/home/berlysia/.local/share/chezmoi/dot_shell_common/` で作業してください。

## Project Structure Context
このプロジェクトはchezmoi管理のdotfiles設定です。主要な開発作業は`dot_shell_common/`ディレクトリで行われています。