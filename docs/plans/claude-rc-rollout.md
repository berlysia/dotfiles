# claude-rc の展開で残っている作業

- 残りのプロジェクトを `~/.config/claude-rc/projects` に登録して `claude-rc-sync` を実行する。
  - 信頼済み: my-secretary、CPK-C108、gbf-automation、berlysia.net、eslint-config、shiori、kanbun-annotation
  - 未信頼: blog.berlysia.net、markdown-to-html、my-app（git でない）、pi-sandbox。先にそのディレクトリで `claude` を一度起動する
  - 起動後: `systemctl --user status claude-rc@<name>`、`journalctl --user -u claude-rc@<name>`、スマホでオンラインを確認
- 最終テスト: Windows を再起動し、ログオンしない状態で各サービスがオンラインになるか確認する。
- PR #308（feat/claude-rc）のマージ。
- 登録済み: dotfiles（`~/.local/share/chezmoi`、worktree、`--permission-mode auto`）。2026-10-15 にスマホからの session 作成を確認。
