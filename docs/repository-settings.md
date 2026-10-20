# このリポジトリの GitHub の設定

設定は git の履歴に残らないので、値と読み方、戻し方をここに書く。

## PR の取り込み方

merge commit に限る。決定の理由は ADR-0031。`allow_squash_merge` と `allow_rebase_merge` は `false` にしている。

現在の値を読む。

```bash
gh api repos/berlysia/dotfiles --jq '{allow_merge_commit, allow_squash_merge, allow_rebase_merge}'
```

戻す。

```bash
gh api -X PATCH repos/berlysia/dotfiles -F allow_squash_merge=true
```

戻すと squash が再び選べ、この決定を機構で保証しなくなる。
