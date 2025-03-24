# zsh 設定の bash 互換実装

## 実装内容

zsh 向けの設定を bash でも使えるように、以下のファイルを作成しました：

### 基本設定ファイル

1. **`dot_bash_profile`**

   - ログインシェル用の設定ファイル
   - `.bashrc`を読み込む

2. **`dot_bashrc`**
   - 対話的非ログインシェル用の設定ファイル
   - 履歴設定、補完機能などの基本設定
   - プラットフォーム固有の設定ファイルを読み込む
   - 共通設定ファイルを読み込む

### 共通設定ファイル

1. **`dot_bash/path.bash`**

   - zsh の`path=(...)`配列構文を bash の PATH 環境変数形式に変換
   - 元の zsh 設定と同じパスを設定

2. **`dot_bash/prompt.bash`**
   - zsh のプロンプト設定を bash 用に再実装
   - Git ステータス表示機能
   - JavaScript プロジェクト情報表示機能
   - 終了ステータス、ユーザー情報、ホスト名、日時表示

### プラットフォーム固有設定

1. **`dot_bash/darwin.bash`**

   - macOS 向けの設定
   - Homebrew の設定

2. **`dot_bash/windows.bash`**

   - Windows 向けの設定
   - SSH コマンドのエイリアス

3. **`dot_bash/linux.bash`**
   - Linux 向けの設定（将来の拡張用）

## 主な変換ポイント

1. **配列構文**

   - zsh: `path=($HOME/.local/bin $path)`
   - bash: `PATH="$HOME/.local/bin:$PATH"`

2. **プロンプト設定**

   - zsh: `setopt prompt_subst`と複雑な変数展開
   - bash: `PROMPT_COMMAND`関数と`PS1`変数

3. **フック機能**

   - zsh: `add-zsh-hook precmd __function__`
   - bash: `PROMPT_COMMAND="function; $PROMPT_COMMAND"`

4. **補完機能**
   - zsh: `autoload -Uz compinit`と`zstyle`
   - bash: `/etc/bash_completion`と基本的な補完設定

## 使用方法

1. **テスト方法**

   ```bash
   # bashを起動して設定を読み込む
   bash --login
   ```

2. **インストール方法**
   - chezmoi を使用している場合は、通常の dotfiles と同様に適用されます
   - 手動でインストールする場合は、各ファイルを適切な場所にコピーしてください

## 注意点

1. zsh の高度な機能の一部は bash では完全に再現できないため、一部機能は簡略化されています
2. bash の設定は zsh の設定と並行して存在し、互いに干渉しません
3. 両方の設定は可能な限り共通の要素を共有しています
