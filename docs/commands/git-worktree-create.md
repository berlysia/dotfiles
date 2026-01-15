# git-worktree-create

Create a new git worktree in `.git/worktree` directory

## 概要

`git-worktree-create` は、gitリポジトリ内で複数のブランチを同時に作業できるworktreeを簡単に作成するコマンドです。worktreeは`.git/worktree/<branch-name>`ディレクトリに作成され、一貫した場所に配置されます。

## 使用方法

```bash
git-worktree-create <branch-name>
git-worktree-create --help
```

## 引数

- `<branch-name>`: worktreeで使用するブランチ名

## オプション

- `--help`, `-h`: ヘルプメッセージを表示

## 動作

コマンドは以下の優先順位でブランチを処理します：

1. **ローカルブランチが存在する場合**: 既存のローカルブランチからworktreeを作成
2. **リモートブランチが存在する場合**: リモートブランチをトラッキングするローカルブランチを作成し、worktreeを作成
3. **ブランチが存在しない場合**: 現在のHEADから新しいブランチを作成し、worktreeを作成

## 使用例

### 既存ブランチのworktreeを作成

```bash
git-worktree-create feature-login
```

### 新規ブランチのworktreeを作成

```bash
git-worktree-create new-feature
```

### リモートブランチからworktreeを作成

```bash
git-worktree-create origin-feature
```

## worktreeの場所

Worktreeは以下の場所に作成されます：

```
<repo-root>/.git/worktree/<branch-name>
```

例：
```
/home/user/myproject/.git/worktree/feature-login
```

## 注意事項

- worktreeは既にディレクトリが存在する場合は作成されません
- リポジトリのルートディレクトリ内でgitコマンドが実行可能である必要があります

## 関連コマンド

- `git-worktree-cleanup`: 不要なworktreeを削除
- `git worktree list`: 既存のworktreeを一覧表示
- `git worktree remove`: 特定のworktreeを削除

## 実装

スクリプトの場所: `~/.local/bin/git-worktree-create`

ソースコード: `dot_local/bin/executable_git-worktree-create`
