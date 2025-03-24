# シェル設定共通化の実装

## 実装内容

zsh と bash の設定を共通化するために、以下の構造を実装しました：

### 1. 共通設定ディレクトリ

`dot_shell_common` ディレクトリを作成し、共通設定ファイルを配置しました：

#### 1.1 共通エントリーポイント

`dot_shell_common/init.sh` - 共通設定の読み込みを一元管理するエントリーポイント：

```bash
# 現在のシェルを検出
if [ -n "$ZSH_VERSION" ]; then
  CURRENT_SHELL="zsh"
elif [ -n "$BASH_VERSION" ]; then
  CURRENT_SHELL="bash"
else
  CURRENT_SHELL="sh"  # フォールバック
fi

# 共通設定を読み込み
[ -f "$SHELL_COMMON/env.sh" ] && source "$SHELL_COMMON/env.sh"
[ -f "$SHELL_COMMON/path.sh" ] && source "$SHELL_COMMON/path.sh"
# シェルタイプに応じたPATH設定の適用
# OS固有設定の読み込み
# ツール統合の適用
```

#### 1.2 共通設定ファイル

- `path.sh` - PATH 設定の共通ロジック
- `aliases.sh` - 共通エイリアス
- `functions.sh` - 共通関数
- `env.sh` - 共通環境変数
- `tools.sh` - 外部ツール統合（mise, fzf など）
- `darwin.sh` - macOS 向け共通設定
- `linux.sh` - Linux 向け共通設定
- `windows.sh` - Windows 向け共通設定

### 2. シェル固有設定ファイルの更新

#### 2.1 zsh 設定

`dot_zsh/dot_zshrc.tmpl` を更新して共通設定を読み込むようにしました：

```bash
# zsh固有の基本設定
setopt IGNOREEOF
autoload -Uz colors
colors
autoload -Uz compinit
compinit

# 共通設定の読み込み
[ -f "$HOME/.shell_common/init.sh" ] && source "$HOME/.shell_common/init.sh"

# zsh固有のプロンプト設定
source $ZDOTDIR/prompt.zsh

# zsh固有の追加設定
# ...
```

#### 2.2 bash 設定

`dot_bash/dot_bashrc` を更新して共通設定を読み込むようにしました：

```bash
# bash固有の基本設定
HISTCONTROL=ignoreboth:erasedups
HISTSIZE=2000
HISTFILESIZE=2000
shopt -s histappend
shopt -s checkwinsize

# 共通設定の読み込み
[ -f "$HOME/.shell_common/init.sh" ] && source "$HOME/.shell_common/init.sh"

# bash固有のプロンプト設定
[ -f "$BASH_DIR/prompt.bash" ] && source "$BASH_DIR/prompt.bash"

# bash固有の追加設定
# ...
```

## 主な変換ポイント

### 1. PATH 設定

共通の PATH 設定を `path.sh` に抽出し、シェルタイプに応じて適用：

```bash
# 共通のパス定義
_common_paths=(
  "$HOME/.local/bin"
  "$HOME/.local/.bin"
  "$HOME/.deno/bin"
  "$HOME/google-cloud-sdk/bin"
  "$HOME/workspace/depot_tools"
)

# シェルタイプに応じた適用は init.sh で実行
```

### 2. プロンプト設定

プロンプト設定は複雑なため、各シェル固有のファイルに残しました：

- `dot_zsh/prompt.zsh` - zsh 用プロンプト
- `dot_bash/prompt.bash` - bash 用プロンプト

### 3. OS 固有設定

OS 固有の共通設定を抽出し、シェルに依存しない形で実装：

```bash
# macOS向け共通設定 (darwin.sh)
if [ -f /opt/homebrew/bin/brew ]; then
  eval "$(/opt/homebrew/bin/brew shellenv)"
elif [ -f /usr/local/bin/brew ]; then
  eval "$(/usr/local/bin/brew shellenv)"
fi
```

### 4. ツール統合

外部ツールの統合設定を共通化し、シェルタイプに応じて適用：

```bash
# mise統合の共通設定 (tools.sh)
if [ -f "$HOME/.local/bin/mise" ]; then
  export HAS_MISE=1
fi

# シェルタイプに応じた適用は init.sh で実行
```

## 使用方法

1. **テスト方法**

   ```bash
   # zshを起動して設定を読み込む
   zsh

   # bashを起動して設定を読み込む
   bash --login
   ```

2. **インストール方法**
   - chezmoi を使用している場合は、通常の dotfiles と同様に適用されます
   - 手動でインストールする場合は、各ファイルを適切な場所にコピーしてください

## 注意点

1. シェル固有の高度な機能は各シェルの設定ファイルに残し、共通化を無理に進めない
2. 共通設定ファイルは両方のシェルで動作することを確認する
3. 設定読み込み時のパフォーマンスに注意する
