# bash 設定のテスト手順

## テスト環境の準備

1. **bash を起動**

   ```bash
   bash --login
   ```

   これにより、新しく作成した`.bash_profile`と`.bashrc`が読み込まれます。

## 基本機能のテスト

1. **PATH 設定の確認**

   ```bash
   echo $PATH
   ```

   以下のディレクトリが PATH に含まれていることを確認：

   - `$HOME/.local/bin`
   - `$HOME/.local/.bin`
   - `$HOME/.deno/bin`
   - `$HOME/google-cloud-sdk/bin`
   - `$HOME/workspace/depot_tools`

2. **プロンプト表示の確認**

   - カレントディレクトリが表示されていること
   - ユーザー名とホスト名が表示されていること
   - 終了ステータスが表示されていること（コマンド成功時は ✅、失敗時は ❌ と終了コード）
   - 日時が表示されていること

3. **履歴機能の確認**

   ```bash
   # いくつかのコマンドを実行
   ls
   pwd
   echo "test"

   # 履歴を確認
   history
   ```

## Git 機能のテスト

1. **Git リポジトリでの表示確認**

   ```bash
   # Gitリポジトリに移動
   cd /path/to/git/repo

   # プロンプトにGit情報が表示されることを確認
   # - ブランチ名
   # - ステージングされたファイル数
   # - 変更されたファイル数
   # - 未追跡のファイル数
   ```

2. **Git 操作による表示変化の確認**

   ```bash
   # ファイルを変更
   echo "test" > test.txt

   # 未追跡ファイルの表示を確認

   # ファイルをステージング
   git add test.txt

   # ステージングされたファイルの表示を確認

   # コミット
   git commit -m "Test commit"

   # クリーン状態の表示を確認
   ```

## JavaScript 環境のテスト

1. **Node.js プロジェクトでの表示確認**

   ```bash
   # Node.jsプロジェクトに移動
   cd /path/to/nodejs/project

   # プロンプトにパッケージ情報が表示されることを確認
   # - パッケージ名とバージョン
   # - Node.jsのバージョン
   # - パッケージマネージャー（npm/yarn/pnpm）のバージョン
   ```

## プラットフォーム固有機能のテスト

### macOS

1. **Homebrew 設定の確認**
   ```bash
   # Homebrewのパスが設定されていることを確認
   which brew
   ```

### Windows (WSL/MSYS/Cygwin)

1. **SSH エイリアスの確認**
   ```bash
   # エイリアスが設定されていることを確認
   type ssh
   type ssh-add
   ```

## 追加機能のテスト

1. **fzf 統合の確認**

   ```bash
   # Ctrl+Rで履歴検索が起動することを確認
   # （キーボードでCtrl+Rを押す）
   ```

2. **エディタ設定の確認**

   ```bash
   echo $EDITOR
   ```

3. **mise 統合の確認**（インストールされている場合）
   ```bash
   mise --version
   ```

## 問題が発生した場合

1. **デバッグ情報の収集**

   ```bash
   # 環境変数の確認
   env | sort

   # シェルオプションの確認
   shopt

   # bashのバージョン確認
   bash --version
   ```

2. **設定ファイルの読み込み確認**
   ```bash
   # 設定ファイルを明示的に読み込み
   source ~/.bashrc
   ```

## 注意点

1. 一部の機能はインストールされているツールに依存します（fzf, mise, jq など）
2. プロンプトの表示は端末エミュレータの設定によって異なる場合があります
3. 絵文字の表示はフォントとロケール設定に依存します
