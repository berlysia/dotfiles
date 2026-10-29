# claude-rc の展開で残っている作業

- 残りのプロジェクトを `~/.config/claude-rc/projects` に登録して `claude-rc-sync` を実行する。
  - 未登録: my-secretary、markdown-to-html、my-app（git でない）、pi-sandbox。先にそのディレクトリで `claude` を一度起動して信頼させる
  - 登録の名前 `CPK` と、以前挙げていた `CPK-C108` が同じものかを確かめる
  - 起動後: `systemctl --user status claude-rc@<name>`、`journalctl --user -u claude-rc@<name>`、スマホでオンラインを確認
- 最終テスト: Windows を再起動し、ログオンしない状態で各サービスがオンラインになるか確認する。

## RC 経由のセッションは umask 0002 で、japanese-check の依存テストが落ちる

不具合・未修正。出どころ: dotfiles-feedback 20261029T102030Z-03efa3f7728e。対象: `home/dot_config/systemd/user/claude-rc@.service`。

- **観察**（2026-10-29、`/proc/<pid>/status` で確認）: RC 経由のセッションでは、プロセスの umask が 0002 になる。`systemd --user`、`claude remote-control`、セッションの `claude`、Bash ツールの zsh が、どれも 0002 だった。端末で開いた zsh は 0022。
- `claude-rc@.service` には `UMask=` が無く、マネージャーの 0002 を引き継ぐ。`systemctl --user show` で `UMask=0002` と出た。
- **推測**（個別には試していない）: `systemd --user` は PAM を通る。pam_umask は `USERGROUPS_ENAB yes`（uid と gid が同じ 1000）のとき 022 を 002 にする、と設定から読んだ。
- **影響**: umask 0002 で `bun run test` を実行すると 17 件が落ちる。umask 022 なら 0 件。
  - 落ちるテスト: `japanese-check-deps.test.ts`、`japanese-check.test.ts`、`japanese-document-gate.test.ts`
- 送った人の見方: テストが作る runtime のディレクトリがグループ書き込み可になり、japanese-check が安全でないと判定するため。これも確かめていない。
- completion-gate の Stop hook もこの umask でテストを実行するので、無関係な変更でも完了が 3 回拒まれた。
- **送った人の直し方の案**:
  - `claude-rc@.service` の `[Service]` に `UMask=0022` を足す
  - あわせて、テストの fixture でディレクトリのモードを明示する。umask の値は前提にしない
- 関連: `docs/plans/hook-tests-umask.md`（hook のテストの umask）。
- **未決**: pam_umask が原因かを確かめる。`UMask=0022` だけで 17 件が通るか、fixture の修正も要るかを分けて確かめる。
