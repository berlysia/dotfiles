# delivery-policy の 1 回あたりの待ち時間

`delivery-policy merge` が 1 回の呼び出しで待つ時間を、必須の check が成功するまでの実際の時間に合わせる課題である。片付いたら、このファイルを消す。

## 待ち時間が check の所要時間より短い

提案・未決。

- **内容**: 1 回の呼び出しは開始から 100 秒で打ち切り、終了コード 10 を返す。値は `home/dot_claude/hooks/cli/delivery-policy.ts` の `CALL_WAIT_LIMIT_MS` にある。dotfiles の必須の `status-check` は、多くの PR でこれより長くかかる。そのため、多くの PR で同じコマンドを 2 回以上呼ぶことになる。
- **分かっていること**:
  - 2026-10-25 に、直近に merge した PR 39 件を測った。最初の check run が始まってから `status-check` が success になるまでの時間は、中央値 143 秒、上位 10% が 234 秒、最大 513 秒だった。#396 は 1 回目が時間切れになり、2 回目で merge した。
  - 100 秒にした理由は ADR-0046 の D6 にある。Bash ツールの既定のタイムアウトは 2 分で、打ち切られると、終了コードと理由のどちらも出ない。
  - 利用者が出した案は 2 つある。既定の待ち時間を延ばす案と、check の平均の所要時間を測ってその数字を使う案である。
- **再開の入口**: 既定を約 240 秒（上位 10% の値）にする案から検討する。あわせて、規則（`home/dot_claude/rules/developer-experience.md` の Merging）に、Bash の `timeout` を 300 秒にすると書く。`timeout` を指定し忘れたときに、打ち切りの理由が出ない問題（D6）がまた起きないかを確かめる。所要時間を測る案は、GitHub API の呼び出しが増え、Bash のタイムアウトとの兼ね合いも残るので、延ばす案で足りないと分かってから考える。ADR-0046 の決定を変えるので、Document Workflow（plan.md）を通す。

## merge 済みの PR に exit 40 を返し、理由も空で出す

不具合・未修正。出どころ: dotfiles-feedback 20261029T091624Z-a3f92693a635。対象: `home/dot_claude/hooks/cli/delivery-policy.ts`。

- **観察**（2026-10-29）: `~/.local/bin/delivery-policy merge 478` が exit 40 を返した。出力の最後の行は `delivery-policy: 40: gh pr merge failed:` で、コロンの後ろが空だった。
- 直後に `gh pr view 478` を実行すると、state は MERGED、mergedAt は 2026-10-29T09:14:36Z だった。PR は merge されていた。
- 実行した cwd は、その PR の head ブランチの worktree（`.git/worktree/fix/...`）だった。
- delivery-policy の問題は 2 つある。
  - `gh pr merge` が 0 以外で終わると、PR の状態を確かめずに 40 を返す。exit 40 は「人に戻す」意味なので、merge が済んでいても agent は止まり、利用者に確認を頼むことになる
  - 理由として stderr だけを切り出しているため、stderr が空だと理由が空になる。stdout と終了コードが残らない
- **送った人が望む挙動**:
  - gh が 0 以外で終わったら PR の state を読み直す。MERGED で、merge した head が `--match-head-commit` の sha と一致すれば、0（merged）として扱う
  - それ以外の失敗では、gh の終了コードと stdout も理由に含める
- **未確認**: gh が 0 以外で終わった原因は分かっていない。worktree の中で実行したことが関係するかも確かめていない。
- **未決**: 再現できていないので、まず原因を調べる。MERGED の確認だけで足りるかは、原因を知ってから決める。
