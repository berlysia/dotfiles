# apply-sibling-guard（実害が出るまで作らない）

利用者の決定（2026-10-31）で、今は作らず記録だけにする。書きかけの hook が他のセッションにも反映される実害が出たら作る。

## 解く問題

`chezmoi apply` は、メインの作業ツリーの内容を配置先へ反映する。worktree の cwd から実行しても同じである。そのため、別セッションや人の書きかけの hook が、全セッションで動き始めることがある。集計では、他セッションへの配慮が 9 回 / 5 セッションで、そのうち apply の拒否は 2 回だった。

## 作るときの要点

- PreToolUse の settings hook で ask を返す。deny にはしない
- コマンド全体から引用符を除いて空白で語に分け、basename が `chezmoi` の語と apply 系の語（`apply`、`update`、`--apply`、`-a` など）を探す。シェルの書き方を列挙すると漏れが出続けるので、粗く拾う
- 判定は、source の作業ツリー（`chezmoi source-path` の toplevel）に未 commit の変更があるかだけで行う。worktree の兄弟の状態は見ない
- 語が文字列に現れない形（変数で組み立てる、スクリプトの中で呼ぶ）は検出できない
- probe の結果: ask は手元でも出先でも答えられる。`!` で打ったコマンドは PreToolUse を通らない。auto、dontAsk、bypassPermissions でも ask は効く

## 縮小案

`chezmoi` と apply 系の語があり、本体が dirty なら ask を返す。作業は worktree で行う決まりなので、本体が dirty になる場面は少なく、確認が増えて邪魔になりにくいと見込む。

この案では、次の 3 つを作らない。

- dry-run の免除の判定
- `-S`、`-c`、`-W` などの `custom-source` の判定
- 他セッションの name を理由に添える処理と、そのための sessions lib への依存
