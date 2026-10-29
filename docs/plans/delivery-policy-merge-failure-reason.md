# delivery-policy merge の失敗の理由が空になる

`gh pr merge` が 0 以外で終わり、stderr が空だと、`delivery-policy merge` の理由が `gh pr merge failed:` だけになる。片付いたら、このファイルを消す。

## 状態

不具合・未修正。出どころ: dotfiles-feedback 20261029T091624Z-a3f92693a635。対象: `home/dot_claude/hooks/cli/delivery-policy.ts` の `gh pr merge failed` の理由を組み立てる行。

## 分かっていること

- 2026-10-29 に `~/.local/bin/delivery-policy merge 478` が exit 40 を返した。出力の最後の行は `delivery-policy: 40: gh pr merge failed:` で、コロンの後ろが空だった。
- 直後に `gh pr view 478` を実行すると、state は MERGED、mergedAt は 2026-10-29T09:14:36Z だった。
- 実行した cwd は、その PR の head ブランチの worktree（`.git/worktree/fix/...`）だった。
- 報告には問題が 2 つあった。1 つ目は、merge が済んでいても exit 40 を返すことである。背景の 1 回の呼び出しで待つ改修（ADR-0046 の 2026-10-29 の節）で直した。`gh pr merge` の失敗後に PR を読み直し、MERGED で head が一致すれば exit 0 にする。
- 2 つ目は、理由に stderr だけを使うことである。stderr が空だと、理由も空になる。gh の終了コードと stdout は理由に入らない。これは直っていない。

## 未確認

- gh が 0 以外で終わった原因は分かっていない。
- worktree の中で実行したことが関係するかも確かめていない。

## 再開するときの手順

理由に gh の終了コードと stdout を加える。出力は既存の `sanitizeLine` で 1 行にそろえる。その前に、その改修を配布した後の delivery-policy で同じ失敗が再現するかを確かめる。再現したら、gh が 0 以外で終わった原因を調べる。
