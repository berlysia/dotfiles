# シェル設定共通化のテスト手順

## テスト環境の準備

1. **zsh でのテスト**

   ```bash
   zsh
   ```

2. **bash でのテスト**

   ```bash
   bash --login
   ```

## 基本機能のテスト

### 1. 共通設定の読み込み確認

```bash
# 共通設定が正しく読み込まれているか確認
echo $SHELL_COMMON
```

期待される結果: `$HOME/.shell_common` が表示される

### 2. PATH 設定の確認

```bash
echo $PATH
```

以下のディレクトリが PATH に含まれていることを確認：

- `$HOME/.local/bin`
- `$HOME/.local/.bin`
- `$HOME/.deno/bin`
- `$HOME/google-cloud-sdk/bin`
- `$HOME/workspace/depot_tools`

### 3. プロンプト表示の確認

- カレントディレクトリが表示されていること
- ユーザー名とホスト名が表示されていること
- 終了ステータスが表示されていること（コマンド成功時は ✅、失敗時は ❌ と終了コード）
- 日時が表示されていること

### 4. エイリアスの確認

```bash
# エイリアスが設定されていることを確認
alias
```

共通エイリアスが表示されることを確認：

- `..='cd ..'`
- `...='cd ../..'`
- `ll='ls -la'`
- `gs='git status'`
- その他

### 5. 共通関数の確認

```bash
# 共通関数が利用可能か確認
type mkcd
type extract
```

## OS 固有機能のテスト

### macOS

1. **Homebrew 設定の確認**

   ```bash
   # Homebrewのパスが設定されていることを確認
   which brew
   ```

2. **macOS 固有エイリアスの確認**
   ```bash
   # エイリアスが設定されていることを確認
   alias showfiles
   alias hidefiles
   ```

### Linux

1. **Linux 固有エイリアスの確認**
   ```bash
   # エイリアスが設定されていることを確認
   alias ls
   alias grep
   ```

### Windows (WSL/MSYS/Cygwin)

1. **Windows 固有エイリアスの確認**
   ```bash
   # エイリアスが設定されていることを確認
   alias explorer
   alias cmd
   ```

## ツール統合のテスト

1. **mise 統合の確認**

   ```bash
   # miseが有効化されていることを確認
   mise --version
   ```

2. **fzf 統合の確認**

   ```bash
   # Ctrl+Rで履歴検索が起動することを確認
   # （キーボードでCtrl+Rを押す）
   ```

3. **エディタ設定の確認**

   ```bash
   echo $EDITOR
   ```

## シェル固有機能のテスト

### zsh

1. **zsh 固有の機能確認**

   ```zsh
   # 補完機能
   ls -<TAB>

   # プロンプトのzsh固有表示
   # Git情報などが正しく表示されるか確認
   ```

### bash

1. **bash 固有の機能確認**

   ```bash
   # 補完機能
   ls -<TAB>

   # プロンプトのbash固有表示
   # Git情報などが正しく表示されるか確認
   ```

## 問題が発生した場合

1. **デバッグ情報の収集**

   ```bash
   # 環境変数の確認
   env | sort

   # シェルの種類確認
   echo $CURRENT_SHELL

   # 共通設定ファイルの存在確認
   ls -la $HOME/.shell_common/
   ```

2. **設定ファイルの読み込み確認**
   ```bash
   # 共通設定を明示的に読み込み
   source $HOME/.shell_common/init.sh
   ```

## 注意点

1. 一部の機能はインストールされているツールに依存します（fzf, mise, jq など）
2. プロンプトの表示は端末エミュレータの設定によって異なる場合があります
3. 絵文字の表示はフォントとロケール設定に依存します
