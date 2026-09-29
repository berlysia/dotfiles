# ADR-0018: 承認前の scratch 書き込みは gate の免除を広げず、deny の hint と規約で外へ誘導する

## Status

accepted (2026-09-30)

## Context

Document Workflow の plan が未承認の間、`document-workflow-guard` は実装系の書き込みを deny する。あるセッションで、承認待ちの間に chezmoi の `run_onchange_` の挙動を確かめる使い捨ての実験を試み、次の 3 回が続けて deny された。

| #   | コマンド（要旨）                                            | guard が見た target   |
| --- | ----------------------------------------------------------- | --------------------- |
| 1   | `bash -c 'P=$(mktemp -d); mkdir -p "$P/src" …'`             | `$P/src`              |
| 2   | `P=$PWD/.tmp/onchange-probe-$(date +%s); mkdir -p "$P/src"` | `$P/src`              |
| 3   | `cd <repo>/.tmp && mkdir -p onchange-probe2/src && …`       | `onchange-probe2/src` |

guard が target を判定するのは、shell が展開する前の文字列に対してである。`$P` は展開されず、`cd` は追跡されない。どちらもそのまま cwd 相対で解決されるので、プロジェクト内と判定される。

一方、プロジェクト外をリテラルのパスで指定した書き込み（`mkdir -p /var/folders/…/src`）は、当時の guard でも allow だった。deny メッセージが承認手順しか示さなかったので、この逃げ道にたどり着けなかった。

グローバルの CLAUDE.md は一時ファイルの置き場を `${projectRoot}/.tmp` と定めている。しかし `.tmp/` はプロジェクト内なので、承認前は gate の対象になっていた。

## Decision

### 1. プロジェクト内（`.tmp/` を含む）に scratch の免除を開けない

最初の案は「`.tmp/`（`.tmp/sessions/` を除く）を免除する」だった。この案で 5 ラウンドのレビューを行い、判定方式を 3 回変えた。

1. 危ない文字と形を列挙して拒否する
2. 許可する文字の集合を決める
3. 許可するコマンドと形だけを通す

どの方式でも、塞いだあとに次の抜け道が見つかった。見つかった抜け道は、原因によって 2 つの系統に分かれる。

**parser 系**: `lib/bash-parser.ts` の `individualCommands` は `string[]` を返し、代入・演算子・グループ化の情報を落とす。

- `rm -rf .tmp/sess(ions)` は `rm -rf .tmp/sess` と `ions` に分割される。target は `.tmp/sess` に見えるが、zsh では実行時に `.tmp/sessions` にマッチする
- `P=$(mktemp -d)` は `mktemp -d` だけになり、どの変数が何を指すかを guard 側で知る方法がない
- `&&` と `;` の区別がなくなるので、`cd` を追跡すると `;` の後の失敗時の cwd を誤認する
- `cp`/`sed -i` などで、最後の positional だけを target とみなす抽出が漏れる。例は `cp -rt src .tmp/a`、`perl -i -pe … src/a .tmp/b`、`sed -i 's/a/b/w src/x' .tmp/f`、そして展開後に `-t` が現れる `cp $V .tmp/d` である
- 単語の途中に引用符やバックスラッシュを入れる形がある。`.tmp/"sessions"` と `.tmp/sess\ions` は、字句上は別名に見えるが、実行時には `.tmp/sessions` を指す

**リンク系**: 判定するときのファイルシステムと、実行するときのファイルシステムがずれる。parser とは関係がない。

- 既存の symlink を辿る書き込みがある。`.tmp/docs/CONTEXT.md` は、CONTEXT.md 機構の規約で root の追跡ファイルを指す symlink として置かれる。そのため `cp x .tmp/docs` は追跡ファイルを上書きする
- `cp -r` が symlink を複製し、同じ呼び出しの中でそれを経由して書き込める
- `ln`/`cp -l` で hardlink を作れる
- `.tmp/l/../x` は、`resolve` が文字列の上で `..` を畳むのに対して、カーネルは symlink を辿ってから `..` を解決する。この差でずれる

`.tmp/sessions/` には、承認状態を支える hook の状態が入っている。`plan-review.cache.json`、`off-plan-writes.log`、`reviewer-runs.log` である。`.tmp/` の第 1 階層には retry カウンタもある。免除が漏れると、これらが改竄されたり削除されたりする。

免除の範囲を専用の狭いディレクトリに絞っても、状況は変わらない。parser 系の抜け道は target の文字列だけで成り立つので、狭いディレクトリに見える文字列なら通ってしまう。リンク系はリンクを置く場所を選ばない。

parser を構造化すれば parser 系を閉じられる見込みはある。ただし、それで十分かどうかは検証していない。リンク系は構造化しても残る。

### 2. deny の理由文に、固定の hint を無条件で付ける

guard が返すすべての deny の末尾に、`SCRATCH_HINT` を 1 行連結する。対象は次の 3 つである。

- Bash の診断 deny
- target を特定できないときの deny
- Write/Edit の診断 deny

hint の内容は次のとおりである。

- 書き込み先は、session の scratchpad か、新しく作った `mktemp -d` のディレクトリに限る
- 他のリポジトリ、`$HOME`、dotfiles は禁止する
- 先に `mktemp -d` を実行し、出力されたパスを次のコマンドにリテラルで書く

書き込み先を「プロジェクト外ならどこでもよい」にしないのは、hint がモデルの次の行動を実際に誘導する文だからである。今の guard は、`$HOME` や他のリポジトリへの書き込みでも、プロジェクト外であれば通す。

hint には発火条件を付けない。deny が起きるのは承認前だけなので、常に付けてもノイズにならない。条件を持たなければ、条件判定の漏れも起きない。

連結するのは `createDenyResponse` に渡す直前である。空 target の判定は理由文の文字列の同一性で行っているので、それより前で連結すると判定が壊れる。また `sanitizeForDisplay` には通さない。通すとバッククォートが消える。

`formatGateDiagnosis` は `workflow-cli status` と共用なので、変えない。

### 3. 規約を `rules/workflow.md` に書き、予算を 13KB に上げる

承認前の置き場の規約を、`rules/workflow.md` の「CRITICAL: 承認は人間のみ」節にある guard の行に 1 文追記する。この規約は gate が閉じている間だけの例外である。そこで、CLAUDE.md の Temp files の行（一般の規約）は変えず、gate を説明している operator guide 側に置く。

追記すると `workflow.md` は 12515 bytes になり、`workflow-md-budget.test.ts` の上限 12KB を超える。既存の関係ない行を縮めて収めることはせず、上限を 13KB に上げる。この予算は、常時ロードされるコンテキストを削減する目的（36KB から 12KB）で設けたものであり、1KB の引き上げはその意図を損なわない。

`SCRATCH_HINT` と規約の文は同じ内容を二重に持つので、互いを参照するコメントを置く。

## Consequences

- 承認前は、引き続き `.tmp/` を Bash からも Write からも使えない。scratch は scratchpad か `mktemp -d` の中で行う
- 発端の 3 件の書き方（`$P` や `cd` を使う形）は今も deny される。hint を読み、`mktemp -d` の出力をリテラルで書き直せば通る
- gate の判定は変えていない。既存の allow と deny の集合は変わらない
- 常時ロードされる `workflow.md` は約 240 bytes 増える
- 将来プロジェクト内の scratch を再検討するときは、この ADR の抜け道の一覧が出発点になる。parser を構造化するなら、それを spec として独立に起こし、リンク系は別の手当てとして扱うこと

## References

- `home/dot_claude/hooks/implementations/document-workflow-guard.ts` の `SCRATCH_HINT` / `withScratchHint`
- `home/dot_claude/rules/workflow.md` の「CRITICAL: 承認は人間のみ」節
- `home/dot_claude/hooks/tests/unit/workflow-md-budget.test.ts` の `BUDGET_BYTES`
- `docs/decisions/0013-workflow-dir-session-derivation.md`: guard の脅威モデル（anti-drift）と `.tmp/sessions` の containment
- `docs/decisions/0015-document-workflow-operator-ergonomics.md`: deny の診断化（K4）、interpreter の書き込み判定と scratch root（K3）、`workflow.md` の 12KB 化（K8）
