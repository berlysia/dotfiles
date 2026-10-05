# Plan: git-worktree-cleanup で、隣の行が変わったあとにマージされた branch を merged と判定する

調査: `research.md`（同じ workflow dir）。issue: #269

## Goal

GitHub でマージ済みの PR の worktree が、`git-worktree-cleanup` で merged と判定されない場合を無くす。
対象は、branch の commit が main に載る前に、変更行の隣（context 行）を main が変えていた場合である。
rebase merge、別の場所で rebase された branch の merge、squash merge の 3 つを含む。

issue #269 は 2 つの形を別々の原因として書いたが、原因は 1 つだった（research.md「結論」）。
issue が挙げた 2 つの方向（ファイル内容の比較、件名の比較）は、どちらもこの原因に届かないので採らない。

対象外:

- main がマージ時に内容を変えた場合（conflict の解消、squash 時の手直し）。足した行・消した行が違えば、マージ済みとはみなさない
- `gh` で PR の状態を見ること（commit `f89cd21` で却下済み。今回の原因は手元の git だけで判定できる）
- `--yes` が答える範囲、`.tmp/` `.entire/` の扱い（段 5b）、分類の段の順序
- detached HEAD の worktree。新しい比較を使わず、これまでどおり確認に回す（KD7）

## Experience Delta

- 変更前: #245 と #242 の worktree は「origin に無い commit がある」として残る。`.tmp/` があるので、#268 の `--discard-tmp=<id>` も出ない。片付けるには端末で `y` と答えるしかない
- 変更後: 同じ 2 つの worktree が `(merged: rebase, context ignored)` と判定され、`.tmp/` の一覧と `--discard-tmp=<id>` が出る。`.tmp/` が無い worktree なら確認なしで消え、出力に `merged into master (rebase, context ignored); branch <名前> stays at <tip の 12 桁>` が残る。判定の根拠が緩い比較だったことと、commit がどの branch にあるかが、出力から分かる

scratch の写しに修正を当てて、実物の 2 つの worktree で変更後の出力を確かめた（`--non-interactive`、どちらも ASK_TMP で残り、id が出た）。

## Alternative Approaches (Greenfield View)

### 差分最小案 (Incremental)

`is_merged` の既存の 3 つの判定（祖先、`git cherry`、squash の probe）はそのまま残す。
どれにも当たらなかったときだけ、context 行を外した patch-id（`git log -p -U0 | git patch-id --stable`）で、branch の commit と main の commit を突き合わせる。
当たったら `merged_how` に `rebase, context ignored` / `squash, context ignored` を入れる。

### 白紙設計案 (Greenfield)

merged の判定を、context 行を外した patch-id の突き合わせ 1 本にする。`git cherry` と `commit-tree` の probe は使わない。
起源: 「branch の変更が main に入っているか」を patch で判定するなら、載せ直しで変わる context 行は最初から比較に入れない。判定が 1 つの仕組みになり、dangling commit object も書かなくなる。

### 白紙設計案 2: merged を「merge しても何も変わらない」で定義する

patch の一致を見ない。`git merge-tree --write-tree origin/<main> <tip>` の結果の tree が `origin/<main>` の tree と同じなら merged とする。
起源: 「branch の内容が main に含まれている」を、そのまま 3-way merge に聞く。context のずれは merge が吸収し、位置の違う同じ行を取り違えること（R1）も、diff の切り方の差（R2）も起きない。

実物で試して却下した。#245（`b3b5ea2`）と #242（`b904bc5`）のどちらも、`git merge-tree --write-tree origin/master <tip>` が conflict（終了コード 1）になった。
マージの後で main が同じ場所をさらに変えると、この定義は成り立たない。2026-10-06 の時点で、#245 の branch が触れた 16 ファイルのうち 8 ファイルが tip と違う。
マージ直後にしか当たらない判定では、オーダーの 2 つの worktree が片付かない。

patch-id が一致した commit だけを `merge-tree` で確かめ直す併用も採らない。実物の 2 件では、確かめ直しが conflict になる。そのとき緩い判定に戻すなら、この 2 件に対して併用は何も足さない。merged としないなら、この 2 件が片付かない。

### 採用案と理由

差分最小案を採る。

- `git cherry` は git 自身が rebase で「すでに上流にある commit」を飛ばすのに使う判定と同じ規則である。これに当たった worktree は、今回の変更の前後で結果も出力も変わらない。既存の F4〜F10 など、`(squash)` `(rebase)` を出力で確かめているテスト 30 か所以上がそのまま通る
- 緩い比較には、厳密な比較に無い取り違えがある（Risks R1）。厳密な判定を先に置くと、緩い比較だけで決まった worktree を出力で区別できる。白紙設計案では、すべての判定が緩い比較になり、区別できない
- 白紙設計案の利点（dangling object を書かない）は、今回のオーダー（判定の取りこぼしを無くす）に含まれない

## Key Decisions

- **KD1: context 行を外した patch-id で比べ直す。** 却下: ファイル内容の比較（main がその後で同じファイルを変えると成り立たない。実物で #245 の 16 ファイル中 8 ファイルがすでに違う）。却下: 件名の一致（判定の根拠にならない。patch-id が合わないことが原因なので、条件を足しても届かない）。却下: `git range-diff`（組は作れるが、`!` が context だけの差か内容の差かを区別しない。#245 では 10 組が `=`、context だけが違う 1 組が `!` と出た）
- **KD2: 既存の判定の後ろに置く（置き換えない）。** 上の「採用案と理由」
- **KD3: rebase と squash の両方に入れる。** 実物で観察したのは rebase の 2 件である。squash は同じ仕組み（`git cherry` の patch-id が context 3 行を含む）から導いたもので、scratch で取りこぼしを再現した（research.md）。同じ集合（main の patch-id）を使い回すので、足すのは 6 行である
- **KD4: 緩い比較で決まったことと、commit の在りかを出力に出す。** `merged_how` は `rebase, context ignored` / `squash, context ignored` にする。REMOVE のときは理由に `; branch <名前> stays at <tip の 12 桁>` を足す。消した後で取り違えに気づいたとき、出力だけで `git worktree add <path> <branch>` を組める（パスは `Removing worktree:` の行にある）。戻るのは commit だけで、worktree にあった ignored ファイルは戻らない。branch 名は、`--discard-tmp` の案内と同じく `%q` で出す
- **KD5: 緩い比較で merged になった worktree も REMOVE（確認なし）にする。** 却下: ASK（`--yes` が答える）に落とす案。branch のある worktree では、取り違えても commit は branch に残る。未 commit は段 3、`.tmp/` `.entire/` は段 5b で先に止まる。失うのは worktree のディレクトリと、この 2 つ以外の ignored（`node_modules/` のほか、`.env` のような手で置いたファイルを含む。厳密な判定で消すときと同じ範囲）である。ASK にすると、エージェントの Bash からは `--yes` を付けないと片付かず、オーダーの「マージ済みなのに片付かない」が残る
- **KD6: 比較の範囲は両側とも `merge-base..`。** main 全体の履歴とは比べない。古い commit との偶然の一致を減らし、集める量も抑える
- **KD7: detached HEAD の worktree では緩い比較を使わない。** branch が無いので、取り違えると commit を指す ref が無くなる（worktree の HEAD reflog も worktree と一緒に消える）。KD5 の根拠が成り立たない。`is_merged` に branch 名を渡し、空なら緩い比較の手前で偽を返す。厳密な 3 判定は detached でもこれまでどおり働く。却下: detached も対象にして Risks に書くだけにする案（commit を失う側の取り違えを、確認なしの経路に足すことになる）。却下: 消す前に退避用の ref を作る案（このツールは ref を動かさない。オーダーの 2 件は branch のある worktree で、detached を要しない）

## Risks

- **R1: 取り違え。** 同じファイルに同じ行を足し引きする commit は、位置が違っても同じとみなす（scratch で確認し、D9 で固定する）。patch-id は空白の違いも無視するので、インデントだけが違う変更も同じになる（`git cherry` と同じ規則）
  - merged になるのは、branch の commit すべてが `merge-base..main` の範囲に相手を持つときだけである。1 commit で 1 行だけの branch が最も当たりやすい（版番号の更新、import の 1 行など）。空の diff の commit は比較に入らず、同じ id の commit が branch に複数あっても main に 1 つあれば足りる
  - master の直近 400 commit で、context を外した patch-id の重複は 0 件だった。この repo 1 つの数字である
  - 取り違えたときに失うものは KD5 のとおり。commit は branch に残り、出力の `branch <名前> stays at <tip>` から `git worktree add <path> <branch>` で戻せる
  - `permission-auto-approve` は `--yes` と `--non-interactive` の呼び出しを人間の確認なしで通す。緩い比較による削除も、この経路で実行される
- **R2: 取りこぼしは残る。** diff の取り方によって、同じ変更でも足し引きする行の切り方が変わることがある（同じ行が並ぶ場所への挿入など）。そのときは一致せず、これまでどおり確認に回る。実物では観察していない
- **R3: 時間。** main の patch-id を worktree ごとに集める。この repo の 52 commit で 0.05 秒だった。merge-base が古い branch では commit 数に比例して延びる。既存の `git cherry` も同じ範囲の commit すべての diff を取るので、増えるのはその 1 回分である。厳密な判定に当たらなかった worktree でしか走らない。commit 数の上限は設けない（遅くなった実例が無く、上限を超えた branch は理由の分からない取りこぼしになる）

## Files

```
# 編集
home/dot_local/bin/executable_git-worktree-cleanup   # patch_ids_no_context を追加、is_merged の引数と末尾、classify の 3 か所、ヘルプ
docs/commands/git-worktree-cleanup.md                # 段 7 の説明、注意事項、変更点

# テスト
tests/git-worktree-cleanup/run.sh                    # fixture の関数 6 つ、test_D1〜D9

# 新規作成
docs/plans/git-worktree-cleanup-context-drift/research.md   # この workflow dir の research.md
docs/plans/git-worktree-cleanup-context-drift/plan.md       # この workflow dir の plan.md
```

## Tasks

作業場所: `git-worktree-create fix/worktree-cleanup-context-drift` で作る worktree。
テストと実装のコードは、scratch の写しで通ることを確かめたものである（全 258 PASS、shellcheck 0.11.0 で指摘 0 件）。

### T1: 失敗するテストを足す（Red）

`tests/git-worktree-cleanup/run.sh` の `run_one() {` の直前に、次を足す。

```bash
# ---- context drift (#269): main changed a line near the branch's change before the merge ----

# put_lines <dir> <file> <message> <line>...: one commit that rewrites <file> with the given lines
put_lines() {
  local d=$1 f=$2 m=$3
  shift 3
  printf '%s\n' "$@" >"$d/$f"
  git -C "$d" add -- "$f"
  git -C "$d" commit -qm "$m"
}
# seed_lines: main gets lines.txt (l1..l9), pushed, so that a branch and main can change different lines of it.
seed_lines() {
  put_lines "$REPO" lines.txt "seed lines" l1 l2 l3 l4 l5 l6 l7 l8 l9
  git -C "$REPO" push -q origin main 2>/dev/null
}
# main_moves_near: on origin main, l3 becomes L3. That is two lines above the place where mk_inserting inserts:
# a context line of that hunk, and far enough for the two changes to merge without a conflict.
main_moves_near() {
  merger_update
  put_lines "$MERGER" lines.txt "main moves near" l1 l2 L3 l4 l5 l6 l7 l8 l9
  git -C "$MERGER" push -q origin main 2>/dev/null
}
# mk_inserting <branch> <line>: worktree with a commit that inserts <line> after l5 and a commit that adds a
# file; pushed. Call seed_lines first. Prints the path.
mk_inserting() {
  local d
  d=$(wt "$1")
  put_lines "$d" lines.txt "insert $2" l1 l2 l3 l4 l5 "$2" l6 l7 l8 l9
  commit_in "$d" "$1.txt"
  push_branch "$d"
  echo "$d"
}
# merger_replay <branch> [n]: cherry-pick the branch's first n commits (default: all) onto the merger's HEAD
merger_replay() {
  local c
  for c in $(git -C "$MERGER" rev-list --reverse "origin/main..origin/$1" | head -n "${2:-1000}"); do
    git -C "$MERGER" cherry-pick "$c" >/dev/null 2>&1
  done
}
# merger_publish <branch>: push the merger's main and delete the branch on origin, as a merged PR leaves it
merger_publish() {
  git -C "$MERGER" push -q origin main 2>/dev/null
  git -C "$MERGER" push -q origin --delete "$1" 2>/dev/null
}

test_D1() {
  make_repo d1
  seed_lines
  local d
  d=$(mk_inserting rb new)
  main_moves_near
  rebase_merge rb
  run_cleanup -n
  assert_removed "$d" "D1 removed"
  assert_contains "$OUT" "merged into main (rebase, context ignored)" "D1 how"
  assert_contains "$OUT" "; branch rb stays at $(git -C "$REPO" rev-parse --short=12 rb)" "D1 where the commits are"
}

# The shape of #242: the branch was rebased somewhere else, got one more commit, and was merged with a merge commit.
test_D2() {
  make_repo d2
  seed_lines
  local d
  d=$(mk_inserting moved new)
  main_moves_near
  merger_update
  git -C "$MERGER" checkout -q -b moved main
  merger_replay moved
  commit_in "$MERGER" later.txt
  git -C "$MERGER" checkout -q main
  git -C "$MERGER" merge -q --no-ff -m "merge moved" moved >/dev/null 2>&1
  merger_publish moved
  run_cleanup -n
  assert_removed "$d" "D2 removed"
  assert_contains "$OUT" "merged into main (rebase, context ignored)" "D2 how"
}

test_D3() {
  make_repo d3
  seed_lines
  local d
  d=$(mk_inserting sq new)
  main_moves_near
  squash_merge sq
  run_cleanup -n
  assert_removed "$d" "D3 removed"
  assert_contains "$OUT" "merged into main (squash, context ignored)" "D3 how"
}

# Only the first of the two commits reached main.
test_D4() {
  make_repo d4
  seed_lines
  local d
  d=$(mk_inserting part new)
  main_moves_near
  merger_update
  merger_replay part 1
  merger_publish part
  run_cleanup -n
  assert_kept "$d" "D4 kept"
  assert_not_contains "$OUT" "merged into main" "D4 not merged"
  assert_contains "$OUT" "2 commits not on origin" "D4 reason"
}

# Main got another line at the same place, and the same new file.
test_D5() {
  make_repo d5
  seed_lines
  local d
  d=$(mk_inserting other new-a)
  main_moves_near
  put_lines "$MERGER" lines.txt "insert new-b" l1 l2 L3 l4 l5 new-b l6 l7 l8 l9
  commit_in "$MERGER" other.txt
  merger_publish other
  run_cleanup -n
  assert_kept "$d" "D5 kept"
  assert_not_contains "$OUT" "merged into main" "D5 not merged"
  assert_contains "$OUT" "2 commits not on origin" "D5 reason"
}

# A branch whose only commit changes nothing has no patch-id; "every id is on main" must not hold vacuously.
test_D6() {
  make_repo d6
  seed_lines
  local d
  d=$(wt empty)
  git -C "$d" commit -q --allow-empty -m empty
  push_branch "$d"
  main_moves_near
  git -C "$MERGER" push -q origin --delete empty 2>/dev/null
  run_cleanup -n
  assert_kept "$d" "D6 kept"
  assert_not_contains "$OUT" "merged into main" "D6 not merged"
  assert_contains "$OUT" "1 commits not on origin" "D6 reason"
}

# With files in .tmp/, the context-free verdict reaches ASK_TMP and its id works.
test_D7() {
  make_repo d7
  seed_lines
  local d id
  d=$(mk_inserting rb new)
  main_moves_near
  rebase_merge rb
  add_tmp "$d"
  run_cleanup -n
  assert_kept "$d" "D7 kept"
  assert_contains "$OUT" "(merged: rebase, context ignored)" "D7 merged note"
  id=$(tmp_id_of)
  run_cleanup --discard-tmp="$id" rb
  assert_removed "$d" "D7 removed with the id"
}

# A detached HEAD has no branch to keep its commits, so the comparison without context lines is not used for it.
test_D8() {
  make_repo d8
  seed_lines
  local d
  d=$(mk_inserting det new)
  git -C "$d" checkout -q --detach
  main_moves_near
  rebase_merge det
  run_cleanup -n
  assert_kept "$d" "D8 kept"
  assert_not_contains "$OUT" "merged into main" "D8 not merged"
  assert_contains "$OUT" "2 commits not on origin" "D8 reason"
}

# A known limit (docs): the same line added to the same file at another place counts as the same change.
# When the comparison learns to tell the two apart, this test turns around: the worktree is then kept.
test_D9() {
  make_repo d9
  seed_lines
  local d
  d=$(wt same)
  put_lines "$d" lines.txt "insert new" l1 l2 l3 l4 l5 new l6 l7 l8 l9
  push_branch "$d"
  merger_update
  put_lines "$MERGER" lines.txt "insert new elsewhere" l1 new l2 l3 l4 l5 l6 l7 l8 l9
  merger_publish same
  run_cleanup -n
  assert_removed "$d" "D9 removed"
  assert_contains "$OUT" "merged into main (rebase, context ignored)" "D9 how"
}
```

確認: `bash tests/git-worktree-cleanup/run.sh D1 D2 D3 D4 D5 D6 D7 D8 D9` が `PASS: 13 FAIL: 11` で終わる。
FAIL は D1 の 3 つ、D2・D3・D9 の各 2 つ、D7 の `merged note` と `removed with the id` の計 11。
D4・D5・D6・D8 は実装前から PASS する。緩めた後も残ることを守るテストで、D8 は T2 で `is_merged` に branch 名を渡し忘れると FAIL する。

### T2: `is_merged` に context を外した比較を足す（Green）

`home/dot_local/bin/executable_git-worktree-cleanup` を 3 か所変える。

1 か所目。`is_merged` の直前のコメントと `local` を、次に置き換える。

```bash
# patch_ids_no_context <range>: one patch-id for each non-merge commit in <range>, from diffs taken without
# context lines. A commit with an empty diff prints nothing.
patch_ids_no_context() {
    git -C "$main_worktree" log -p -U0 --no-merges --no-renames --no-color --no-ext-diff --no-textconv --no-show-signature --format='commit %H' "$1" -- 2>/dev/null \
        | git -C "$main_worktree" patch-id --stable 2>/dev/null | cut -d' ' -f1
}

# is_merged <sha> [<branch>]: sets merged_how to ancestor | rebase | squash, or to "rebase, context ignored" |
# "squash, context ignored" when only the comparison without context lines matched. That comparison runs only
# with a branch: it can take another change for the same one, and a branch keeps the commits when it does.
# The squash probe writes one dangling commit object (no ref is moved; gc removes it).
merged_how=""
is_merged() {
    local sha=$1 br=${2:-} base n c probe main_ids ids id missing
```

2 か所目。`is_merged` の末尾（squash の `esac` の次の `return 1`）を、次に置き換える。

```bash
    # git cherry takes patch-ids over three context lines, so a commit replayed onto a main that changed a line
    # next to its change gets another id. Compare once more without context lines: the same lines added and
    # removed in the same files count as the same change, wherever in the file they are.
    if [[ -z "$br" ]]; then
        return 1
    fi
    if ! main_ids=$(patch_ids_no_context "$base..$main_ref") || [[ -z "$main_ids" ]]; then
        return 1
    fi
    if ! ids=$(patch_ids_no_context "$base..$sha"); then
        return 1
    fi
    # grep exits 0 when an id is missing from main, 1 when none is, 2 on an error. A branch of empty commits has
    # no id: grep then reads one empty line, which matches no id and so counts as missing.
    missing=0
    grep -qvxFf <(printf '%s\n' "$main_ids") <<<"$ids" || missing=$?
    if [[ $missing -eq 1 ]]; then
        merged_how="rebase, context ignored"
        return 0
    fi
    if id=$(git -C "$main_worktree" diff -U0 --no-renames --no-color --no-ext-diff --no-textconv "$base" "$sha" -- 2>/dev/null \
        | git -C "$main_worktree" patch-id --stable 2>/dev/null | cut -d' ' -f1) \
        && [[ -n "$id" ]] && grep -qxF "$id" <<<"$main_ids"; then
        merged_how="squash, context ignored"
        return 0
    fi
    return 1
```

`--no-ext-diff` `--no-textconv` `--no-color` `--no-show-signature` `--no-renames` は、利用者の git 設定で diff の文面が変わらないようにするために付ける。
grep の終了コードは 1 のときだけ merged にする。エラー（2）のときは、ほかの git コマンドの失敗と同じく merged にしない。

3 か所目。`classify` の 2 つの `is_merged "$sha"` を `is_merged "$sha" "$br"` にし、段 7 の REMOVE を次にする。

```bash
    if is_merged "$sha" "$br"; then
        verdict=REMOVE; reason="merged into $main_name ($merged_how)"
        if [[ "$merged_how" == *"context ignored" ]]; then
            printf -v hint '%q' "$br"
            reason="$reason; branch $hint stays at ${sha:0:12}"
        fi
        return 0
    fi
```

確認: `bash tests/git-worktree-cleanup/run.sh` が `PASS: 258 FAIL: 0` で終わる（Linux では `SKIP: 1`）。`scripts/lint-shell.sh` の指摘が 0 件。

### T3: ヘルプと docs

`executable_git-worktree-cleanup` の `show_help`。`Removed without asking:` の項を次にする。

```
  Removed without asking:
  - merged into the origin main branch (ancestor, rebase merge or squash merge).
    When main changed lines next to the branch's changes before the merge, the
    commits are compared without context lines and the output says "context ignored"
    (not for a detached HEAD)
```

`docs/commands/git-worktree-cleanup.md`:

- 段 7 の表の条件を「merged（tip が `origin/<main>` の祖先、rebase merge、squash merge のいずれか。下の「context を外した比較」を含む）」にする
- 表の下の箇条書きに、次の項を足す
  - 「context を外した比較: rebase merge と squash merge は、まず `git cherry`（変更行の前後 3 行を含む patch-id）で判定する。当たらないときは、前後の行を外した patch-id で `merge-base..tip` の commit と `merge-base..origin/<main>` の commit を比べ直す。マージの前に main が隣の行を変えていた branch は、こちらで merged になり、出力は `(rebase, context ignored)` / `(squash, context ignored)` になる」
  - 「この比較は、同じファイルに同じ行を足し引きする commit を、位置が違っても同じとみなす。空白だけの違いも同じとみなす。branch の commit すべてが main に相手を持つときだけ merged になる。取り違えても branch は残り、出力の `branch <名前> stays at <tip>` から `git worktree add <path> <branch>` で戻せる」
  - 「detached HEAD の worktree には、この比較を使わない。branch が無く、取り違えると commit を指す ref が残らないためである」
- 段 5b の案内の「`(merged: <方式>)` を添えて」に、「`<方式>` は `ancestor` `rebase` `squash` と、`rebase, context ignored` `squash, context ignored`」を足す
- 注意事項の「dangling commit object を書きます」の項に、「context を外した比較は object を書かない」を足す
- 「変更点（2026-10）」に「マージの前に main が隣の行を変えていた branch を、merged と判定するようになった（#269）。出力に `context ignored` と、branch の在りかが付く」を足す

確認: `bash home/dot_local/bin/executable_git-worktree-cleanup --help` の出力に `context ignored` が 1 回出る。`bun run lint` と formatter（pre-commit）が通る。

### T4: 実地確認

配布（`chezmoi apply`）はしない。作業 worktree のスクリプトを、main worktree から直接実行する。

0. 2 つの worktree のそれぞれで `git -C .git/worktree/<branch> status --porcelain --ignored --untracked-files=normal -- .tmp .entire` を実行し、`!! .tmp/` が出ることを確かめる。出ない worktree は 1 の対象から外す
1. main worktree で `bash .git/worktree/fix/worktree-cleanup-context-drift/home/dot_local/bin/executable_git-worktree-cleanup --non-interactive fix/harden-path-checks wip/207-portless-plan` を実行する
   - 期待: 2 つとも `(merged: rebase, context ignored)` と `--discard-tmp=<id>` が出て残る。終了コード 2
   - 2 つとも `.tmp/` にファイルがあるので、`--non-interactive` では判定がどうであっても消えない（段 5b は ASK_TMP か ASK_HUMAN にしかならない）
2. 同じ 2 つを対象に、変更前（`~/.local/bin/git-worktree-cleanup`）と変更後の実行時間を `time` で測る

open の #270 の worktree は対象に渡さない。`.tmp/` が無ければ、誤判定がそのまま削除になるためである。未マージの branch を残すことは、D4・D5・D6・D8 と、research.md のプロトタイプの結果（#270 の 4 commit は main に無い）で確かめる。

`~/.local/bin` への配布は、PR のマージ後に、いつもの `chezmoi apply` で行う。
2 つの worktree の `.tmp/` の片付けは、この plan の範囲に含めない。配布の後で、`~/.claude/rules/developer-experience.md` の手順（ファイルを読み、worktree ごとに聞く）で別に行う。

### T5: 成果物の保存、commit、PR

1. `research.md` と `plan.md` を `docs/plans/git-worktree-cleanup-context-drift/` に置く（`~/.claude/rules/workflow.md` の Session Artifact Retention。`.tmp/sessions/` は 7 日で消える）
2. commit する（`fix(git-worktree-cleanup): detect a merge whose context lines changed on main`、Contextual Commits の action line つき）
3. PR を作る。本文で issue #269 の診断の訂正（#245 は rebase merge、原因は context 行）を述べ、`Closes #269` を付ける

## テスト計画 (ISO 25010)

### 機能適合性

- 隣の行（2 行上）を main が変えたあとの rebase merge（D1） → worktree が消え、出力に `merged into main (rebase, context ignored)` と `; branch rb stays at <rb の tip の 12 桁>`
- 別の場所で rebase され、commit が 1 つ足され、merge commit でマージされた branch（D2、#242 の形） → 同上
- 隣の行を main が変えたあとの squash merge（D3） → worktree が消え、出力に `merged into main (squash, context ignored)`
- `.tmp/` にファイルが 1 つある同じ形（D7） → 残り、出力に `(merged: rebase, context ignored)` と 12 桁の id。その id で `--discard-tmp` すると消える
- 実物: #245 と #242 の worktree → T4 の 1 の期待

### 信頼性（消してはいけないものを消さない）

- 2 commit のうち 1 つだけが main にある（D4） → 残り、理由は `2 commits not on origin`
- main に同じ位置の別の行（`new-b`）と同じ新規ファイルがある（D5） → 残り、理由は `2 commits not on origin`
- 空の commit 1 つだけの branch（D6） → 残り、理由は `1 commits not on origin`
- D1 と同じ形で、worktree が detached HEAD（D8） → 残り、理由は `2 commits not on origin`
- 既知の限界: 1 commit の branch が `l5` の次に足した行 `new` を、main が `l1` の次に足している（D9） → 消える（`rebase, context ignored`）。R1 の取り違えを、起きる形のままテストに残す
- 既存の 234 件（全 258 件から D1〜D9 の 24 件を引いた数）が変更後も PASS する（厳密な判定に当たる worktree の結果と出力が変わらないこと）

### 互換性

- CI（`ci-git-worktree-cleanup.yml`）の ubuntu-latest と macos-latest の両方で `run.sh` が FAIL 0 件。macOS は `/bin/bash` 3.2 で、`<( )` と `<<<` を使う

### 性能効率性

- T4 の 2 の計測で、変更前後の差が 1 秒未満

### 対象外

- セキュリティ: 新しい引数も、外から受け取る入力も足さない。比べるのは手元の repo の commit だけである
- 使用性: 変わるのは理由の文言 1 か所で、KD4 と D1・D3・D7 の出力の検査で扱う

## Implementation Notes

2026-10-06 に実装した。

- T1 の後は `PASS: 13 FAIL: 11`、T2 の後は全件で `PASS: 258 FAIL: 0 SKIP: 1`（Linux）。`scripts/lint-shell.sh` の指摘は 0 件
- plan と違う形にした箇所: `tests/git-worktree-cleanup/run.sh` の `# ---- runner ----` の見出しコメントを、足したテストの後ろ（`run_one() {` の直前）に移した。docs の「context を外した比較」の項は、表の下の「detached HEAD では段 4 を評価しない」の直後に置いた
- T4 の実地確認: `fix/harden-path-checks`（#245）と `wip/207-portless-plan`（#242）はどちらも `(merged: rebase, context ignored)` になり、`--discard-tmp=<id>` が出て残った。終了コード 2。実行時間は変更前 2.20 秒、変更後 2.47 秒（1 回ずつ。fetch を含む）
- レビューの途中で分かったこと: `git merge-tree --write-tree origin/master <tip>` は、この 2 つの branch のどちらでも conflict になる。マージの後で main が同じ場所を変えているためである

## Approval

- Plan Status: complete
- Review Status: pass
- Approval Status: approved

## Reviewer Outputs (Round 1)

### logic-validator

- verdict: needs-work
- 主指摘: detached HEAD の worktree では「branch が残るので戻せる」が成り立たず、緩い比較は「origin に無い commit」の判定より前で REMOVE に届く。`! grep -qvxFf` は grep のエラー（終了コード 2）でも merged になる。「空集合で真になる」というコメントは誤りで、guard は効いていない。

### scope-justification-reviewer

- verdict: needs-work
- 主指摘: T4 の実地確認は、誤判定すると別作業（#270）の worktree を消す手順で、マージ前の `chezmoi apply` にも理由が無い。`.tmp/` の後片付けはオーダーの範囲外なので切り離す。T5 の保存の出典、KD3 の「観察済み／導出」の区別を書く。

### decision-quality-reviewer

- verdict: needs-work
- 主指摘: KD5 の根拠（失うのはディレクトリと再生成できる ignored だけ）は detached HEAD で崩れる。KD4 の `context ignored` は消した後にしか出ず、戻すための tip と branch 名が出力に無い。R1 の標本は小さく、1 commit の branch が最も取り違えやすい。

### greenfield-perspective-reviewer

- verdict: pass
- 主指摘: 白紙設計案が同じ方式の整理版に留まる。merged の別の定義（`git merge-tree` で「merge しても何も変わらない」を見る）を検討し、却下の根拠を記録する。

### security-vulnerability-analyzer

- verdict: needs-work
- 主指摘: 悪用できる筋道は無い。detached HEAD で commit が失われる点は同じ指摘。patch-id は空白の違いも同じとみなす。`--no-renames` `--no-show-signature` を足し、commit 数の上限を設けることを勧める。

### data-contract-evolution-evaluator

- verdict: pass
- 主指摘: 出力の文言を読むのはテストの `assert_contains` だけで、id の計算と終了コードは変わらない。`permission-auto-approve` が `--yes` / `--non-interactive` を確認なしで通すことを Risks に書く。docs の `(merged: <方式>)` の説明が更新漏れ。

<!-- auto-review: pending -->
<!-- intent-triage: pending -->

## Reviewer Outputs (Round 2)

### logic-validator

- verdict: pass
- 主指摘: Round 1 の 5 点は解消。plan の T1・T2 を scratch に当て、実装前 `PASS: 13 FAIL: 11`、実装後 全 258 PASS を再現した。D8 は KD7 の guard だけを守っている（guard を外すと 3 assert が FAIL）。軽微: 234 件の内訳の注記、T4 の前に `.tmp/` の有無を確かめる 1 行。

### scope-justification-reviewer

- verdict: pass
- 主指摘: Round 1 の 6 件は解消し、追加した変更に過剰なものは無い。軽微: 併用の却下理由を「実物 2 件では」に限定する、D9 のコメントに限界が解消されたときの扱いを書く、auto-approve の経路の残余リスクを Executive Summary にも出す。

### decision-quality-reviewer

- verdict: pass
- 主指摘: KD7 と KD4 で、支配的な軸（データを失わない）とのずれは解消した。未 push の named branch を対象に残す判断は妥当。軽微: 戻るのは commit だけで ignored は戻らないことを KD4 に書く。

### greenfield-perspective-reviewer

- verdict: pass
- 主指摘: 白紙から組み直しても採用案とほぼ同じ構成になる。KD7 の線引きは不変条件（取り違えても ref が残る場合にだけ緩い比較を使う）から出る。軽微: 併用の却下理由を実質の理由に書き直す、退避用 ref の案を却下として記録する。

### security-vulnerability-analyzer

- verdict: pass
- 主指摘: 悪用できる筋道は無い。detached の worktree が緩い比較に届く経路も、エラー時に merged へ倒れる経路も残っていない。軽微: `stays at` の branch 名を `%q` で出す。

<!-- auto-review: verdict=needs-work; hash=1d8d9a1adc42cf47604cf3634bca5978ccc5d1d0234c6281c49e09d6aa779336; design-hash=81721cba5ed6e34d460951eb639817358c9fb0271675044a9355771b36e1d32b; round=1; at=2026-10-05T19:19:04.750Z; reviewers=logic-validator+scope-justification-reviewer+decision-quality-reviewer+greenfield-perspective-reviewer+security-vulnerability-analyzer+data-contract-evolution-evaluator -->

<!-- auto-review: verdict=pass; hash=24af458540c4db35b8173aa20f7b3e20cf464315091a91697ac808986f3867b2; design-hash=bf2fd444378e14f8e178b8619dbd602393b1f2b8e75ca25b091f94a6869de062; round=2; at=2026-10-05T19:29:00.480Z; reviewers=logic-validator+scope-justification-reviewer+decision-quality-reviewer+greenfield-perspective-reviewer+security-vulnerability-analyzer -->
<!-- intent-triage: adopted=27; excluded=3; at=2026-10-05T19:29:09.316Z -->
