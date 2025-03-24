# シェル設定共通化タスク概要

## 現状の構造

現在の dotfiles リポジトリは、zsh と bash の設定が並列に管理されています：

```
├── dot_zshenv                  # .zshenv - ZDOTDIRを設定
├── dot_zsh/                    # .zsh/ - zsh設定ディレクトリ
│   ├── dot_zshrc.tmpl          # .zshrc - メイン設定ファイル（テンプレート）
│   ├── path.zsh                # パス設定
│   ├── prompt.zsh              # プロンプト設定
│   ├── darwin.zsh              # macOS固有設定
│   └── windows.zsh             # Windows固有設定
├── dot_bash_profile            # .bash_profile - ログインシェル用
├── dot_bash/                   # .bash/ - bash設定ディレクトリ
│   ├── dot_bashrc              # .bashrc - メイン設定ファイル
│   ├── path.bash               # パス設定
│   ├── prompt.bash             # プロンプト設定
│   ├── darwin.bash             # macOS固有設定
│   └── windows.bash            # Windows固有設定
└── (その他のファイル)
```

## 課題

1. **コードの重複**:

   - 同じ機能を実現するコードが zsh と bash で重複している
   - 設定変更時に複数のファイルを編集する必要がある

2. **メンテナンス性**:

   - 新機能追加時に両方のシェル用に実装が必要
   - バグ修正も両方に適用する必要がある

3. **一貫性の維持**:
   - 両方のシェルで同じ機能を維持するのが難しい
   - 片方だけ更新されるリスクがある

## 実装した新構造

共通設定を抽出し、シェル固有の設定と分離しました：

```
├── dot_zshenv                  # .zshenv - ZDOTDIRを設定
├── dot_bash_profile            # .bash_profile - .bashrcを読み込む
├── dot_shell_common/           # 共通設定ディレクトリ（新規）
│   ├── init.sh                 # 共通エントリーポイント
│   ├── path.sh                 # PATH設定の共通ロジック
│   ├── aliases.sh              # 共通エイリアス
│   ├── functions.sh            # 共通関数
│   ├── env.sh                  # 共通環境変数
│   ├── tools.sh                # 外部ツール統合（mise, fzf など）
│   ├── darwin.sh               # macOS向け共通設定
│   ├── linux.sh                # Linux向け共通設定
│   └── windows.sh              # Windows向け共通設定
├── dot_zsh/                    # zsh固有設定ディレクトリ
│   ├── dot_zshrc.tmpl          # .zshrc - 共通設定を読み込み、zsh固有設定を適用
│   └── prompt.zsh              # zsh固有のプロンプト設定
└── dot_bash/                   # bash固有設定ディレクトリ
    ├── dot_bashrc              # .bashrc - 共通設定を読み込み、bash固有設定を適用
    └── prompt.bash             # bash固有のプロンプト設定
```

## 実装アプローチ

「共通ロジックの抽出とインクルード」アプローチを採用し、さらに「共通エントリーポイント」を導入して重複を最小化しました。

### 主な特徴

1. **共通エントリーポイント**:

   - `dot_shell_common/init.sh` が共通設定の読み込みを一元管理
   - シェルタイプを自動検出し、適切な処理を実行

2. **シェル固有コードの分離**:

   - 共通化できない機能はシェル固有の設定ファイルに残す
   - プロンプト設定など、シェルの特性を活かした実装を維持

3. **段階的な導入**:
   - 既存の設定を大きく変更せずに、徐々に共通化を進められる
   - 一部の設定から始めて、徐々に範囲を広げることが可能

## 実装完了項目

1. **共通設定ディレクトリの作成**

   - `dot_shell_common` ディレクトリの作成
   - 共通エントリーポイント `init.sh` の作成

2. **共通設定ファイルの作成**

   - `path.sh` - PATH 設定の共通ロジック
   - `aliases.sh` - 共通エイリアス
   - `functions.sh` - 共通関数
   - `env.sh` - 共通環境変数
   - `tools.sh` - 外部ツール統合（mise, fzf など）

3. **OS 固有の共通設定ファイルの作成**

   - `darwin.sh` - macOS 向け共通設定
   - `linux.sh` - Linux 向け共通設定
   - `windows.sh` - Windows 向け共通設定

4. **シェル固有設定ファイルの更新**
   - `dot_zsh/dot_zshrc.tmpl` の更新
   - `dot_bash/dot_bashrc` の更新
   - シェル固有の機能のみを残す

## 期待される効果

1. **コード重複の削減**:

   - 共通設定は 1 箇所で管理
   - 設定変更時の作業量が減少

2. **メンテナンス性の向上**:

   - 新機能追加が容易に
   - バグ修正の適用範囲が明確

3. **一貫性の向上**:

   - 両方のシェルで同じ機能を確実に維持
   - 設定の同期ずれを防止

4. **拡張性の向上**:
   - 将来的に他のシェルへの対応も容易
   - 新しい設定カテゴリの追加が簡単
