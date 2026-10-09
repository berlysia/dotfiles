# node_modules の確認を減らす作業の残件

未着手。最初の一手は、2026-10-23 以降の数え直しである。

`deny-node-modules` の「Unknown node_modules operation requires approval」を減らす作業（2026-10-09）で、対象にしなかったものを記録する。決定、計器、数値は [ADR-0020](../decisions/0020-boundary-deny-rephrase.md) の追記（ask の範囲、2026-10-09）にある。件数は 2026-09-24〜10-09 の 124 件に対するもので、変更後も ask が残る 78 件の内訳である（1 つのコマンドが複数に入ることがある）。

## 導入後の実数を数える

変更の効果は、規則を作ったのと同じ 124 件で測った。導入から 14 日後（2026-10-23 以降）に、ADR-0020 の追記にある計器で hook の ask を数え直す。変更前の hook の ask は 16 日で 114 回（1 日あたり 7.1 回）、過去の標本での見込みは 78 回（1 日あたり 4.9 回、14 日で約 68 回）である。14 日で 82 回（見込みの約 1.2 倍）を超えていれば、下の節のどれが増えているかを見る。

次の 3 つは、数え直しの結果にかかわらず再検討しない: 複数行の断片とインタプリタの本文（ADR-0020 の決定）、`ln -s`（書き込み）、`echo` / `printf`（ADR-0020 の追記にある却下理由）。

## `.bin` の絶対パスでの実行（10 件）

`/home/…/node_modules/.bin/tsc` のように絶対パスで書かれた実行は ask のままである。許可規則の `*` は先頭にも置けるが、空白を含む任意の文字列に一致するので、`Bash(*/node_modules/.bin/tsc *)` は別のコマンドの引数にこのパスがあるだけで許可してしまう。hook だけ黙らせても確認は残る。

- 再検討の条件: 数え直しの 14 日間で絶対パスの `.bin` が 10 件以上あれば、auto-approve の safe-list（`home/dot_claude/hooks/lib/safe-command-list.ts` の `HEAD`）で `node_modules/.bin/<tool>` で終わる先頭語を読む設計を検討する。
- 検討するときの論点: `.bin` の中身を信頼できるのは、agent が `node_modules` に書けないからである。`tar x` や `unzip` が `node_modules/.bin/` を作る経路は `DESTRUCTIVE_NODE_MODULES_PATTERNS` に無い。

## 複数行の断片とインタプリタの本文（31 件）

`node -e "…"` / `python3 -c "…"` / heredoc の本文に `node_modules` があると ask になる。ADR-0020 が ask に残した範囲なので変えていない。読み取りだけのスクリプトをファイルに書いて実行すれば、hook は反応しない。

## `ln -s … node_modules`（12 件）

worktree や scratchpad に `node_modules` の symlink を張る操作が ask になる。書き込みであり、後段にも許可規則が無い。`git-worktree-create` が依存を用意する経路（[ADR-0022](../decisions/0022-agent-vm-node-modules.md)）で足りるなら、手で張る必要が無くなる。

## `echo` / `printf`（10 件）

対象から外した理由は ADR-0020 の追記にある（`printf -v` が添字を評価する、`echo` がパスを後続の断片に渡せる）。`echo` だけの単独コマンドに限れば安全に外せるが、消える確認は 3〜4 件である。

## 先頭語がばらつくもの（延べ 28 件、20 種）

`grep` 3、`cccc` 3、`time` 3、`rg` 2、`readlink` 2、ほか 15 種（`git ls-files`、`git check-ignore`、`git log`、`realpath`、`jq`、`timeout` など）が各 1。先頭語ごとに 1〜3 件で、まとまった形が無い。`grep` が ask になるのは、パーサが複数行を 1 つの断片として返し、read-only 動詞と `node_modules` が別の行にある場合である。

- 再検討の条件: 数え直しの 14 日間で、1 つの先頭語が 5 件以上あれば、その先頭語だけの形を `isNonModifyingShape` に足すことを検討する。足す条件は ADR-0020 の追記にある。

## 観測: Bash の PermissionRequest で LLM evaluator が動いていない

この作業の残件ではなく、調査中に見つけた別の問題である。

`~/.claude/logs/hook-timing.jsonl`（2026-10-06〜10-09）の Bash の PermissionRequest 22 件は、`permission-llm-evaluator` がすべて約 100ms・無出力で終わっていた。`reasonToSkipLLM` の git 判定か hold（`dot path in command text`、`cwd changes before the words`、`unresolved word`）で LLM を呼ばずに人間へ回している。ADR-0020 の「evaluator がベストエフォートで補う」は、Bash ではこの期間ほぼ働いていない。hold が意図どおりかは未確認である。
