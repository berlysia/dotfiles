# PR の取り込みを merge commit に限る作業から持ち越した課題

2026-10-07 の作業が、作業の中では確かめられなかった確認である。
決定は `docs/decisions/0031-merge-commits-only-on-master.md` に書く。
ADR-0031 は、この文書を足す PR の取り込みの後に出す PR で書く。この文書を取り込んだ時点では、まだ存在しない。

## 1. Renovate の次の auto-merge が merge commit で入ることの確認

- **内容**: Renovate の次の auto-merge が、merge commit で入ることを確かめる。次の月曜（2026-10-12）の Renovate の実行の後に確かめる。
- **分かっていること**:
  - `renovate.json` に `"automergeStrategy": "merge-commit"` を足した（`ce88a04`）。
  - リポジトリの設定で squash を無効にした（2026-10-07）。
  - Renovate の直近 8 件（#257〜#278）は、`SQUASH` で入っていた。
  - 指定が platform の auto-merge に効くことは、Renovate の文書に基づく理解で、このリポジトリでは確かめていない。
- **確認の方法**: 2026-10-07 より後に作られた Renovate の PR について、次のコマンドの 3 つ目の欄が `MERGE` であること。

  ```bash
  gh pr list --state merged --author app/renovate --limit 1 --json number,mergedAt,autoMergeRequest --jq '.[0] | "#\(.number) \(.mergedAt) \(.autoMergeRequest.mergeMethod)"'
  ```

- **止まっていた場合**: auto-merge の対象の Renovate の PR が、checks が通ったのに open のまま残っている。そのときは、止まった PR を `gh pr merge <番号> --merge` で手動で取り込む。リポジトリの設定は戻さない。戻すと squash が再び選べるようになる。

確かめ終えたら、この項目を消す。項目が無くなるので、ファイルごと消す。
