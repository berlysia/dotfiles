# zsh 設定を bash にも適用するタスク概要

## 現状の構造

現在の dotfiles リポジトリは、主に zsh 向けの設定が含まれています：

```
├── dot_zshenv                  # .zshenv - ZDOTDIRを設定
├── dot_zsh/                    # .zsh/ - zsh設定ディレクトリ
│   ├── dot_zshrc.tmpl          # .zshrc - メイン設定ファイル（テンプレート）
│   ├── path.zsh                # パス設定
│   ├── prompt.zsh              # プロンプト設定
│   ├── darwin.zsh              # macOS固有設定
│   └── windows.zsh             # Windows固有設定
└── (その他のファイル)
```

## zsh と bash の主な違い

1. **環境設定**:

   - zsh は`ZDOTDIR`を使用して設定ファイルの場所を指定（bash には存在しない）
   - 設定ファイルの読み込み順序が異なる

2. **シェル固有機能**:

   - zsh は`autoload`, `zstyle`, `setopt`などの機能を使用（bash には存在しない）
   - 配列構文が異なる（zsh: `path=(...)` vs bash: `PATH=...`）
   - プロンプトのカスタマイズ方法が異なる（zsh: 複雑な変数展開 vs bash: PS1 変数）

3. **関数定義**:
   - 一部の関数が zsh 固有の機能を使用

## 計画する構造

既存の zsh 設定を維持しながら、bash 向けの設定を追加します：

```
├── dot_bashrc                  # .bashrc (新規)
├── dot_bash_profile            # .bash_profile (新規)
├── dot_bash/                   # .bash/ ディレクトリ (新規)
│   ├── path.bash               # パス設定
│   ├── prompt.bash             # プロンプト設定
│   ├── darwin.bash             # macOS固有設定
│   └── windows.bash            # Windows固有設定
└── (既存のzsh設定ファイル)
```

## 実装タスク

### 1. 環境設定ファイルの作成

- `.bash_profile` の作成
- `.bashrc` の作成
- `.bash/` ディレクトリの作成

### 2. パス設定の変換

- `path.zsh` の bash 互換版 (`path.bash`) の作成
- zsh の配列構文を bash の PATH 環境変数形式に変換

### 3. プロンプト設定の変換

- `prompt.zsh` の bash 互換版 (`prompt.bash`) の作成
- Git ステータス表示機能の bash 互換実装
- zsh 固有の機能を bash で実現可能な形に簡略化

### 4. プラットフォーム固有設定の変換

- `darwin.zsh` の bash 互換版 (`darwin.bash`) の作成
- `windows.zsh` の bash 互換版 (`windows.bash`) の作成
- Linux 向け設定の bash 互換版の作成

### 5. シェル固有機能の対応

- 履歴設定の bash 互換実装
- キーバインディングの bash 互換実装
- 補完機能の基本設定

### 6. テンプレート処理の対応

- chezmoi テンプレート構文の bash 設定ファイルへの適用

### 7. 追加機能の対応

- fzf 統合の bash 互換実装
- エディタ設定の bash 互換実装
- その他ツール (mise, opam, gcloud) の bash 互換実装

### 8. テストと検証

- bash での動作確認
- 既存の zsh 設定に影響がないことの確認

## 実装アプローチ

1. zsh 設定の各コンポーネントを分析し、bash 互換の同等機能を特定
2. bash 向けの設定ファイルを作成し、可能な限り zsh 設定と共通の要素を共有
3. zsh 固有の機能に対しては bash 互換の代替手段を実装
4. テンプレート処理を両方のシェルで一貫して動作するように設定

このアプローチにより：

- zsh ユーザーは既存の設定を引き続き使用可能
- bash ユーザーは互換性のある設定を使用可能
- 両方の設定は可能な限り共通要素を共有
