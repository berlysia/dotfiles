# git-worktree-cleanup

Interactively clean up git worktrees

## 概要

`git-worktree-cleanup` は、完了したgit worktreeを安全にクリーンアップするインタラクティブなコマンドです。作業中のworktreeを誤って削除しないよう、複数の安全チェックを実行します。

## 使用方法

```bash
git-worktree-cleanup
git-worktree-cleanup --help
```

## オプション

- `--help`, `-h`: ヘルプメッセージを表示

## 動作

コマンドは各worktreeに対して以下のチェックを実行します：

### 自動スキップ（安全チェック）

以下の条件に該当するworktreeは自動的にスキップされます：

- **未コミットの変更がある**: `git status --porcelain` が空でない
- **プッシュされていないコミットがある**: ローカルブランチがリモートよりも先行している
- **メインworktree**: リポジトリのルートディレクトリ

### インタラクティブ確認

以下の条件では削除前にユーザーに確認を求めます：

- **mainブランチにマージされていない**: `git merge-base --is-ancestor` でマージ済みかチェック
- **stashがある**: `git stash list` が空でない

### 削除条件

以下の条件を満たすworktreeが自動削除されます：

- 未コミットの変更がない
- プッシュされていないコミットがない
- mainブランチにマージ済み、またはユーザーが削除を確認
- stashがない、またはユーザーが削除を確認

## 使用例

### 基本的な使用方法

```bash
git-worktree-cleanup
```

### 実行例

```bash
$ git-worktree-cleanup
🔍 Checking git worktrees...

📁 Checking worktree: /path/to/repo/.git/worktree/feature-a
✓ Branch not on remote
✓ Branch is merged into master
✓ Removing worktree: /path/to/repo/.git/worktree/feature-a

📁 Checking worktree: /path/to/repo/.git/worktree/feature-b
✗ Has uncommitted changes - skipping

📁 Checking worktree: /path/to/repo/.git/worktree/feature-c
⚠️  Branch is not merged into master
Delete anyway? (y/N) n

🧹 Pruning worktree list...
✓ Done!
```

## 注意事項

- メインworktreeは常にスキップされます
- 削除成功後、`git worktree prune` が自動実行されます
- デフォルトで安全側に倒し、作業中のworktreeを保護します
- リモート追跡ブランチとの同期状態を確認します

## セーフティ機能

### 未コミット変更の保護

コミットされていない変更を含むworktreeは自動的にスキップされ、削除されません。

### プッシュ済みコミットの確認

ローカルにのみ存在するコミットがある場合、そのworktreeは削除されません。

### マージ状態の確認

mainブランチにマージされていないブランチの削除には、明示的な確認が必要です。

### Stashの保護

stashがある場合、削除前に確認を求めます。

## 関連コマンド

- `git-worktree-create`: 新しいworktreeを作成
- `git worktree list`: 既存のworktreeを一覧表示
- `git worktree prune`: worktreeリストをクリーンアップ

## 実装

スクリプトの場所: `~/.local/bin/git-worktree-cleanup`

ソースコード: `dot_local/bin/executable_git-worktree-cleanup`
