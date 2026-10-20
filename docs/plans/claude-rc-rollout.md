# claude-rc の展開で残っている作業

- 残りのプロジェクトを `~/.config/claude-rc/projects` に登録して `claude-rc-sync` を実行する。
  - 未登録: my-secretary、markdown-to-html、my-app（git でない）、pi-sandbox。先にそのディレクトリで `claude` を一度起動して信頼させる
  - 登録の名前 `CPK` と、以前挙げていた `CPK-C108` が同じものかを確かめる
  - 起動後: `systemctl --user status claude-rc@<name>`、`journalctl --user -u claude-rc@<name>`、スマホでオンラインを確認
- 最終テスト: Windows を再起動し、ログオンしない状態で各サービスがオンラインになるか確認する。
