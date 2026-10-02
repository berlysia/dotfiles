# ADR-0022: agent-vm の VM では、repo の node_modules を VM ローカルのディスクに差し替える

## Status

accepted (2026-10-02)

## Context

ADR-0018 は、repo を host と同じパスで VM に mount する。`node_modules` もツリーの一部として共有される。TS7 のネイティブのコンパイラ（`@typescript/typescript-<platform>-<arch>`）や oxc 系のパッケージは、install したプラットフォームの分だけを入れる。mac で install した repo で VM の claude が `tsc` を実行すると `Unable to resolve @typescript/typescript-linux-arm64` で落ち、VM で install し直すと mac 側が壊れる。

対象は agent-vm で作るすべての machine で、repo ごとの設定を要求しない。

設計の全文は `docs/plans/agent-vm/node-modules/spec.md`（K1〜K10、R1〜R7）と `plan-1.md`〜`plan-3.md` にある。実験は `research.md` にある。ここには骨子と、却下した代替案を記す。

## Decision

ツリーは共有したまま、install 物の層だけを machine ごとに分ける。

- VM の中で、worktree の中の `package.json` を持つ各ディレクトリ（パッケージ）の `node_modules` を、VM ローカルの保存先（`/var/lib/agent-vm/node_modules/<key>/data`）への bind mount に差し替える。パッケージごとにするのは、npm、yarn、bun の hoisted がパッケージの下にプラットフォーム別の実体を置くためである（K1）。
- mount の仕組みは VM 側のヘルパー `agent-vm-node-modules` に閉じる。`sync <repo>`（収束。正はこれ）、`attach <worktree>`、`remove <worktree> -- <command>`、`--contract` を持つ。すべて冪等で、1 つの lock で直列化する。
- 呼び出しの入口は 3 つで、どれも収束を早める近道である。
  - launcher の起動のたびの `sync`。失敗は起動を止めない 1 行の警告にする。
  - `git-worktree-create`。VM では `attach`、host では `agent-vm node-modules-sync`。
  - `git-worktree-cleanup`。VM では `remove` で git の削除を包む。
- ヘルパーは chezmoi で VM にだけ配る。ADR-0018 K17 の VM 許可リストに足し、host では無視する。cloud-init と bootstrap の契約（ADR-0021 K9）には触れない。
- ヘルパーは権限の境界ではなく、正規の経路が偽の一覧や差し替えたパスに誘導されないための柵である（VM のユーザーはもともとパスワードなし sudo を持つ。ADR-0018 R6）。worktree は repo のルートか `<repo>/.git/worktree/` の配下に、パッケージは worktree の配下に限る。mount は root の perl が `O_NOFOLLOW` で開いた fd 経由で張り、mountinfo と device:inode で張った先を確かめる（K6）。mount 先の所有者は確かめない。OrbStack の virtiofs は所有者を見ている側の uid の写しとして返し、ファイルの属性として観測できないためである（plan-1 では確かめていたが、root からは 0 に見えて、共有 mount の上では導入から一度も張れていなかった。plan-3 の V26 の実行中に見つかり、`docs/plans/agent-vm/node-modules/plan-4.md` で直した）。
- mount の有効性は device:inode の一致で判定し、失効していれば張り直す（K9）。自分の mount の行は、mountinfo の root 欄が自分の `data` で終わり、mountpoint が `//deleted` で終わらない行とする。spec は major:minor の一致も条件にしていたが、OrbStack の btrfs では mountinfo の major:minor と stat の st_dev が一致しなかった（実測 0:37 と 0:64）。一致を条件にすると行を見つけられず、mount 中の中身を消す側に倒れるため、条件から外した。V26 では、host 側で mount 先を消しても行は `//deleted` にならずに元のパスのまま残り、sync はそのパスで外して張り直した。`//deleted` を除く条件は、この経路では使われない。
- launcher の警告は、spec の「is shared」を次のように細かくした。回収を中止しただけ（ヘルパーの終了コード 3）は「kept VM-local node_modules that may be stale」、それ以外は「may be shared」。`agent-vm node-modules-sync` は、machine の記録が無い、止まっている、に加えて、git の外、`orb list` が答えない、lock を取れない、の場合も黙って 0 で終わる（次の起動で収束し、そこで表に出るため）。
- 起動時の install は自動で行わない。VM の `node_modules` が空で host にある worktree について、1 行で促す（K5）。
- worktree 用ツールの細部（spec K7 からの差分）:
  - `git-worktree-cleanup` がヘルパーを通すのは `<repo>/.git/worktree/` 配下の worktree だけである。名指しで消す外の worktree は git を直接呼ぶ。ヘルパーは外の worktree に mount を張らず、渡されても拒否（64）するため。
  - ヘルパーが拒否（64）したときは、git を直接呼ばずに worktree を残す。直接呼ぶと、mount された VM ローカルの中身を消してから mountpoint の削除で失敗しうるため。
  - `git-worktree-create` は `attach` のレコード（stdout）を捨て、警告（stderr）だけを通す。

## Consequences

- 2 つの環境の install が互いを壊さない。VM で一度 install すれば、両側が独立して動く。
- VM ごとに install が要り、ディスクを使う。保存先は machine と一緒に消える。
- host に空の `node_modules` ディレクトリ（mount 先）が現れることがある。Node のモジュール解決と git には影響しない。
- `git worktree add` / `remove` を直接使うと、次の起動まで差し替えが追従しない。VM で直接 add した worktree でそのまま install すると、host の worktree に linux 用のパッケージが入る。規約上、worktree の作成と削除は 2 つのツールに限る。
- このリリースより前に、VM の install で host の `node_modules` が上書きされた repo は、host で install をやり直すまで壊れたままである。自動検出はしない。
- 1 つの worktree で差し替えるパッケージは 500 件までである。
- 実機での確認項目は `docs/agent-vm.md` 9 節の V24〜V29 である。結果は同じ節の確認結果に記録する。

## Alternatives

- **PM のグローバル設定で両方のプラットフォームのパッケージを入れる**: yarn は `.yarnrc.yml`、pnpm は環境変数、bun は install のフラグで成立するが、npm は成立しない（`os` / `cpu` / `libc` が単一値で、install のたびに片方を消す）。仕組みが PM ごとに分かれ、npm の repo に穴が残る。却下。
- **machine 作成時の OrbStack の mount 一覧に `node_modules` を足す**: host 側で宣言でき、machine の設定の検査にも乗る。しかし mount 一覧は作成時に固定され、セッション中に増える worktree に張れない。保存先も host のディスクになり、linux 用の中身が host に置かれる。却下。
- **launcher が install を自動で実行する**: PM の判定と lifecycle スクリプトの方針は repo ごとに違い、agent の作業と競合する。通知に留める。

## References

- `docs/plans/agent-vm/node-modules/spec.md` / `research.md` / `plan-1.md` / `plan-2.md` / `plan-3.md`
- `docs/decisions/0018-agent-vm-orbstack.md`（K17 の VM 許可リスト、R6）
- `docs/decisions/0021-agent-vm-golden-clone.md`（K9 の bootstrap の契約）
- `docs/agent-vm.md`（3 節「node_modules は host と VM で別になる」、9 節 V24〜V29）
