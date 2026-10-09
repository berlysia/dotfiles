# deny-node-modules が ask を返さなくなった後の残件

未着手。実装とコミットは `refactor/deny-node-modules-no-ask` にあり、配備していない。最初の一手は、このブランチを作業ツリーのブランチに取り込んで配備することである。

決定、理由、受容したリスク、見直す条件は、[ADR-0020](../decisions/0020-boundary-deny-rephrase.md) の追記（deny-node-modules は ask を返さない、2026-10-10）にある。

## 配備の後の確認

`chezmoi apply` の後、次の 9 つを 1 つずつ Bash で実行する。それぞれについて、`~/.claude/logs/hook-timing.jsonl` の `deny-node-modules` の行の `stdout_bytes` と、トランスクリプトの `permissionDecision` の判定元（`rule` / `classifier` / `subcommandResults` / `user_temporary` / `hook`）を記録する。

無出力を期待するもの（どれも読み取りだけ）:

- `echo "=== node_modules ==="`
- `readlink -f node_modules/typescript`
- `/home/berlysia/.local/share/chezmoi/node_modules/.bin/tsc --version`
- `node_modules/.bin/tsc --version`
- `jq -n '"node_modules" | test("node_modules")'`

deny を期待するもの（deny されるので、何も書き込まれない）:

- `echo x | tee /tmp/node_modules-probe.txt`
- `sort -o /tmp/out-probe node_modules/typescript/package.json`

許可規則を外した後の判定元を見るもの:

- `find . -maxdepth 1 -name package.json`
- `echo a | xargs echo`

結果の読み方: 判定元が `user_temporary` なら、人間への確認になっている。無出力を期待した 5 つのどれか、または `xargs` / `find` の 2 つがそうなったときは、ADR-0020 の追記の「見直す条件」に従う。許可規則の戻し方もそこにある。配備から 2 週間、同じ判定元を `xargs`・`find`・`.bin` のコマンドについて数え、確認が増えていないかを見る。

確認が済んだら、ADR-0020 の追記の「検証待ち」を、結果に書き換える。

## deny に足す候補（まだ足していない）

`git checkout -- node_modules` と `bun run build node_modules` は、`auto-approve` が allow を返すことをセキュリティレビューが実測した。足す基準の (1)（引数で書き込み先のファイルを名指しする）を満たさないので、足していない。前者は復元で、後者は引数が書き込み先かどうかがスクリプトしだいである。

この種の綴りを deny で足していくか、`Bash(tee *)` / `Bash(sort *)` / `Bash(uniq *)` などの許可規則を外す側で直すかは、下の実験の中で決める。

## deny して別の方法に誘導する候補

ask をやめて判定なしにしたものの中に、deny して別の方法を示したほうがよさそうなものがある。件数は、2026-09-24〜10-09 に ask になった 124 件のコマンドに対するものである。

| 綴り                                                         | 件数  | 示せる別の方法                                            | 気になる点                                                                                                      |
| ------------------------------------------------------------ | ----- | --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `node_modules/.bin/<tool> …`                                 | 約 35 | `bunx <tool> …`                                           | 害は無い。綴りをそろえる効果がある（`bunx tsc` などは既存の許可規則に当たる）。モデルが毎回 1 度やり直す        |
| `ln -s … node_modules`                                       | 12    | worktree なら `git-worktree-create`（依存を自分で入れる） | scratchpad のコピーには、代わりの方法が無い。そこまで deny にすると、モデルは行き場を失う                       |
| `sed -i … node_modules/…`、`prettier --write node_modules/…` | 2〜3  | パッケージマネージャで入れ直す                            | Edit / Write で同じことをすると、今も deny になる。デバッグのために一時的に書き換えたい、という目的は満たせない |

インタプリタの本文や heredoc（約 31 件）は、ほとんどが読むだけの解析スクリプトで、示せる別の方法が無い。`echo`、`jq`、`grep` などに文字として現れるだけのものは、操作ではない。どちらも判定なしのままでよい。

### deny を足してよいかの判断

利用者の方針（2026-10-10）: 「モデルをエンパワメントしつつ、お行儀よい方向に誘導したい」「行き場を失うから線引きをというのはいい話」。

deny を足してよいのは、理由文で次にどうすればよいかを示せるときである。候補ごとに、次の 3 つを確かめる。

1. その操作の代わりに、決まった方法があるか。
2. その方法で、モデルはやりたかったことを果たせるか。
3. deny の理由文に、具体的なコマンドの形まで書けるか。

上の表では、`.bin` は 3 つとも満たす。symlink は 2 が範囲しだいで、`sed -i` は 2 が弱い。

## 次の作業: 自動承認の hook を止めて、auto mode を観察する

利用者の発言（2026-10-10）: 「そもそも自動承認系のやつをいちど全部まっさらにしてもいい気がする」「denyもaskもauto-modeに任せる、でどうなるかを観察するという趣旨」「denyして別のやりかたにしろ系は結構よくできてる」「人間が手をかけたくないから自動承認の仕組みがあったんじゃん」。

調査で分かっている事実:

- 対象の hook は 3 つである。`auto-approve.ts`（PreToolUse）、`permission-auto-approve.ts` と `permission-llm-evaluator.ts`（PermissionRequest）。登録は `home/dot_claude/.settings.hooks.json.tmpl` にある。止めるだけなら、登録を外せばよい。コードとテストは残せる。
- `auto-approve.ts` は allow のほかに、ホームディレクトリの再帰削除・移動の deny、危険コマンドの deny（`mkfs`、`dd`、`curl … | sh` など）と ask（`git push --force`、`git branch -D`、`gh pr merge` など）、長すぎるコマンドの deny も返す。登録を外すと、これらも止まる。
- hook を止めても、設定の許可規則は Claude Code 本体が読むので残る。規則に当たるコマンドは、分類器を通らずに実行される。
- 観察の計器には、トランスクリプトの `permissionDecision` の判定元が使える。hook を止めると、`~/.claude/logs/decisions.jsonl` は書かれなくなる。

始める前に決めること:

- 実験の間も、ホームディレクトリの再帰削除の deny を残すか。
- 止める範囲を、allow を返す部分と ask に絞るか、deny も含めるか。

実験の後に、ADR-0020 の追記の決定のうち、`tee`・`sort -o`・`uniq` の deny と、`xargs`・`find` の許可規則の削除を見直す。前者は、`auto-approve` が allow を返すことを前提にしているからである。
