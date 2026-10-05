# Research: issue #269 — マージ済み PR の worktree が merged と判定されない

調査日: 2026-10-06。対象: `home/dot_local/bin/executable_git-worktree-cleanup` の `is_merged`。

## 結論

issue #269 が書いた 2 つの形は、同じ 1 つの原因で起きている。

**commit が main の上に載せ直されたとき、変更行の隣（context 行）が main 側で変わっていると、その commit の patch-id が変わる。**
`git cherry` は context 3 行つきの diff から patch-id を作るので、足した行・消した行が同じでも別の commit として扱う。

issue の診断のうち、次の 2 点は実物と合わない。

- 形 1（#245）は squash merge ではない。rebase merge である
- 形 2（#242）は「手元の tip はマージされた内容そのものではないので、判定されないのが正しい」ではない。手元の 5 commit は、足した行・消した行が同じ commit をすべて main に持つ

## 観察した事実

### #245 `fix/harden-path-checks`（手元 tip `b3b5ea2`）

- `gh pr view 245` の `mergeCommit` は `25f2c2c`。これは master に並ぶ 11 commit（`f36ac01`〜`25f2c2c`）の最後の 1 つで、親は `2482a52`。squash commit ではない
  - issue が squash commit の patch-id とした `d1dc6155aec5` は、この最後の 1 commit（docs の追加）の patch-id である。branch 全体を畳んだ diff と比べても一致しない
- `git cherry origin/master b3b5ea2` は 11 行のうち 10 行が `-`、1 行が `+`（`32afc54`）
- `git range-diff` は 10 組が `=`、1 組が `!`（`32afc54` と master の `81c768c`）
- `32afc54` と `81c768c` の patch の差は、`index` 行、hunk の行番号、context 1 行だけ。`document-workflow-guard.ts` の import の直前に、#243 が `import { parserGiveUpMark, … } from "../lib/bash-parser.ts"` を足したため、context が `import { getCommandFromToolInput }` から `import {` に変わった
- patch-id（`--stable`、先頭 12 桁）

| diff の取り方         | `32afc54`      | `81c768c`      |
| --------------------- | -------------- | -------------- |
| context 3 行（既定）  | `d5a1064efadb` | `a3ec2923e8e2` |
| context 0 行（`-U0`） | `b452835c17d2` | `b452835c17d2` |

### #242 `wip/207-portless-plan`（手元 tip `b904bc5`）

- PR は merge commit `bde3774` でマージされた。PR の head `da87152` は、手元の 5 commit を rebase した 5 commit と、追加の 3 commit からなる
- `git cherry origin/master b904bc5` は 5 行のうち 4 行が `-`、1 行が `+`（`8d00924`）
- `8d00924` と rebase 後の `c9b209f` の差は context だけ。`home/dot_config/mise/config.toml` で `portless = "0.15.6"` を足した行の隣を、Renovate が `yarn 4.18.0→4.18.1`、`mo 1.5.5→1.6.8` に変えた
- patch-id は context 3 行で `c2648a824212` / `fd77041a9157`、context 0 行でどちらも `fa1b921cd9f7`
- 追加の 3 commit は判定に関係しない。既存の rebase 判定は「branch の commit がすべて main にあるか」を見るもので、main の側に commit が多いことは許している

### #243 `fix/bash-parser-superlinear`（判定された）

rebase merge で、11 commit の隣の行を main が変えていなかった。`git cherry` が全行 `-` になった。

### 未マージの対照（#270、open）

`fix/hook-slash-path-settings-anchor`（tip `3defd95`、4 commit）は、context 0 行の比較でも 4 commit とも main に無い。

## git の側で変えられないこと

- `git cherry` は `-U` を受けない。`git -c diff.context=0 cherry origin/master b3b5ea2` でも `+` は 1 行残る
- `git log --cherry-mark -U0 origin/master...b3b5ea2` でも `32afc54` は `+` のまま。`-U0` は表示する diff にだけ効き、patch-id の計算には効かない
- 手元の git は 2.43.0

context 行を外した比較は、`git log -p -U0 … | git patch-id --stable` を自分で組む必要がある。

## squash の判定も同じ弱点を持つ

`is_merged` の squash の判定は、`merge-base..tip` を 1 commit に畳んだ probe を作り、`git cherry` で main の commit と比べる。
probe の diff は merge-base に対するもので、squash commit の diff はマージ時点の main に対するものである。
その間に main が隣の行を変えると、同じ理由で一致しない。

scratch repo で再現した（branch が `d` の次に 1 行足す。main が隣の `c` を変えてから squash merge する）。

- `git cherry main <probe>` は `+`
- patch-id は context 3 行で `cb0e3976` / `0e4c6e54`、context 0 行でどちらも `da6fc333`

実物の squash merge でこの形を観察したわけではない。再現できることを確かめただけである。

## プロトタイプで確かめたこと

`git log -p -U0 --no-merges --format='commit %H' <range> | git patch-id --stable` で、branch と main（どちらも `merge-base..` の範囲）の patch-id を集めて突き合わせた。

| 対象                                                         | 結果                                   |
| ------------------------------------------------------------ | -------------------------------------- |
| #245 `b3b5ea2`                                               | 11 commit すべて main にある           |
| #242 `b904bc5`                                               | 5 commit すべて main にある            |
| #270 `3defd95`（open）                                       | 4 commit とも main に無い              |
| scratch の squash（上記）                                    | 畳んだ diff が main の 1 commit と一致 |
| binary を別の内容に変えた commit どうし                      | 一致しない                             |
| 別のファイルの rename、mode だけの変更                       | 一致しない                             |
| 同じファイルの別の位置に空行を 1 行足した commit どうし      | 一致しない                             |
| 同じファイルの別の位置に同じ 1 行 `Z` を足した commit どうし | **一致する**                           |

最後の行が、context を外すことで増える取り違えである。「同じファイルに、同じ行を足し引きする」commit は、位置が違っても同じとみなす。

- master の直近 400 commit（merge を除く）で、context 0 行の patch-id が重複する組は 0 件だった
- `merge-base..origin/master`（52 commit）の patch-id を集めるのに 0.05 秒かかった

## 取り違えたときに失うもの

- cleanup は branch を消さない（`git worktree remove` だけ。ヘルプに `Branches are not deleted`）。commit は branch に残る
- 未 commit の変更・untracked は段 3 で KEEP になり、merged の判定に届かない
- `.tmp/` `.entire/` のファイルは段 5b で止まる。merged でも ASK_TMP で、一覧の id を渡した人の答えが要る
- 残るのは `node_modules/` などの再生成できる ignored と、worktree のディレクトリである

## 「新しい発見」の 5 点

issue の診断を覆すので、5 点を確かめた。

- 意図された実装か: `is_merged` のコメントと `docs/commands/git-worktree-cleanup.md` に、context の差を区別する意図は書かれていない。`git cherry` の既定をそのまま使っている
- 計測・計算ミスか: patch の差を `diff` で直接見た。`range-diff`、`git cherry`、patch-id の 3 つが同じ commit を指した
- 錯覚か: 2 つの PR で、差が出た commit はそれぞれ 1 つで、どちらも隣の行を変えた main の commit を特定できた（#243 の import、Renovate の版上げ）
- 局所のみの判断か: `is_merged` の呼び出しは `classify` の 2 か所（段 5b と段 7）。どちらも真偽と `merged_how` だけを使う
- 計器の誤りか: issue の「squash commit の patch-id」は、rebase merge の最後の 1 commit を測っていた。これが issue の診断がずれた原因である

## 既存の制約

- `gh` で PR の状態を見る案は commit `f89cd21` で却下されている（認証とネットワークが要り、GitHub でしか動かない）。今回の原因は手元の git だけで判定できるので、この却下を見直す理由は無い
- テストは `tests/git-worktree-cleanup/run.sh`。`rebase_merge` は cherry-pick の前に main へ別ファイルの commit を 1 つ足すだけで、隣の行を変える形を持たない。`squash_merge` も同じ
- CI は `.github/workflows/ci-git-worktree-cleanup.yml` が、スクリプトかテストの変更で `run.sh` を走らせる
- ユーザーの git 設定は `merge.ff=false`。テストで `git merge --squash` を使うときは既存の `squash_merge` に合わせる

## issue が挙げた方向の評価

- 「branch が触れたファイルが、tip と `origin/<main>` で同じ内容か」: main がその後で同じファイルを変えると成り立たない（issue 自身が書いている）。2026-10-06 の `origin/master` では、#245 の branch が触れた 16 ファイルのうち 8 ファイル、#242 の 10 ファイルのうち 2 ファイルが、tip と違う内容になっている
- 「同名の remote branch が消えていて、同じ件名・同じ patch-id の commit が main にある」: patch-id が合わないことが原因なので、条件を足しても届かない
- 「理由の文言で案内する」: 原因が判定できるので、案内に留める理由が無い
