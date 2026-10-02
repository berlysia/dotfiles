# Research: F3b heredoc 本文の綴りによる deny 側の誤検知

基準: master `f3d0da8`（F2 #217、F3a #218 merge 済み）。worktree `.git/worktree/fix/heredoc-body-deny-false-positive`。probe は session scratchpad の `probe.ts` / `probe-consumers.ts` / `probe-ast.ts` / `probe-idx.ts`（tree-sitter を読むには worktree で `bun install` が要る。未 install だと `collectExecutableTexts` が `ResolveMessage` で失敗して fallback になり、別の結果が出る）。

## 1. 断片（`extractCommandsStructured` の出力）

本文の行は個別の断片にならない。本文は「heredoc を含む文の全文」の断片の中にだけ現れる。この全文の断片は F3a 以前の base の分割（`extractBaseCommands`）でも返っていた。F3a の `collectExecutableTexts` は同じ文を AST から足し、入力全文も足す（`bash-parser.ts:1022-1026`）。

| 入力（本文は `rm -rf node_modules/x`）                     | 断片                                                  |
| ---------------------------------------------------------- | ----------------------------------------------------- |
| `cat <<EOF > out.txt` ⏎ 本文 ⏎ `EOF`                       | 文の全文、`cat`、`> out.txt`                          |
| `cat <<'EOF' > out.txt` …（引用符付き区切り）              | 同上                                                  |
| `git commit -m "$(cat <<'EOF'` ⏎ 本文 ⏎ `EOF` ⏎ `)"`       | `cat <<'EOF'⏎本文⏎EOF`、入力全文、`cat`               |
| `python3 - <<'EOF'` …                                      | 入力全文、`python3`                                   |
| `bash <<EOF` …                                             | `<<EOF`、入力全文、`bash`                             |
| `tee out.txt <<EOF` …                                      | 入力全文、`tee out.txt`                               |
| `cat <<< "rm -rf node_modules/x"`（herestring）            | 入力全文                                              |
| `cat <<EOF > out.txt` ⏎ `$(rm -rf node_modules/x)` ⏎ `EOF` | `rm -rf node_modules/x`、文の全文、`cat`、`> out.txt` |

引用符の無い本文の `$(…)` は tree-sitter が `command_substitution` として解析し、中のコマンドが独立した断片になる。本文中のバッククォートは解析されない（`cat <<EOF` ⏎ ``a `rm x` $(ls)`` ⏎ `EOF` で `command_substitution` は `ls` だけ）。

## 2. 消費者ごとの判定（実 hook / 実関数で確認）

| 入力                                                                | deny-node-modules                 | auto-approve の deny 段                                   |
| ------------------------------------------------------------------- | --------------------------------- | --------------------------------------------------------- |
| `cat <<EOF > out.txt` ⏎ `rm -rf node_modules/x` ⏎ `EOF`             | **deny**                          | 判定なし                                                  |
| 同、引用符付き区切り                                                | **deny**                          | 判定なし                                                  |
| `git commit -m "$(cat <<'EOF'` ⏎ `fix: rm -rf node_modules/x` …`)"` | **deny**                          | 判定なし                                                  |
| `python3 - <<'EOF'` ⏎ `# rm -rf node_modules/x` ⏎ `EOF`             | deny（インタプリタ。判定に残す）  | 判定なし                                                  |
| `bash <<EOF` ⏎ `rm -rf node_modules/x` ⏎ `EOF`                      | deny（シェル。残す）              | 判定なし                                                  |
| `tee out.txt <<EOF` ⏎ `rm -rf node_modules/x` ⏎ `EOF`               | **deny**                          | 判定なし                                                  |
| `cat <<< "rm -rf node_modules/x"`                                   | 判定なし（全文の read-only 除外） | 判定なし                                                  |
| `cat <<EOF > out.txt` ⏎ `$(rm -rf node_modules/x)` ⏎ `EOF`          | deny（展開で実行される。残す）    | 判定なし                                                  |
| `cat <<'EOF' > t.ts` ⏎ `rm -rf $HOME/x` ⏎ `EOF`                     | 判定なし                          | **deny**（`checkHomeDestruction`、home の直下の再帰削除） |
| `cat <<'EOF' > t.ts` ⏎ `find node_modules -delete` ⏎ `EOF`          | **deny**                          | 判定なし                                                  |

太字が誤検知。auto-approve の deny 段は node_modules を見ないが、`checkHomeDestruction`（入力全文に当てる、`auto-approve.ts:372`）と `checkDangerousCommand`（断片ごと、`auto-approve.ts:468`）が本文に当たる。

### 決定ログでの観測（`~/.claude/logs/decisions.jsonl*`、auto-approve と PermissionRequest の記録）

- `cat > <path> <<'EOF'` ⏎ （本文に `git push --force origin main` を含むテスト入力）が auto-approve で ask（`Command 'git push --force origin main': Force push can overwrite remote history`）。F3a の作業中に複数回
- 同じ入力が PermissionRequest の静的判定で `Static rule flagged as potentially dangerous (Layer 2a, source=dangerous-pattern)`。ただしこの層の deny は記録だけで、後段の LLM evaluator に回す（`permission-auto-approve.ts:613-627`）。heredoc を含む入力は `scanSafeList` が null なので、本文を外してもこの層は allow しない。F3b で変える意味が無い
- deny-node-modules の deny は決定ログに出ない（hook が自分で deny を返す）。観測は issue 記録 F3 の 2 件（`python3 - <<'EOF'` のテスト書き込み、`bun -e`）

### document-workflow-guard

`analyzeBashWrite`（`document-workflow-guard.ts:559-581`）は各断片を `splitShellWords` で語に割り、`>` / `>>` の次の語を書き込み先にする（`:960-991`）。文の全文の断片には本文が入るので、本文に `> plan.md` のような綴りがあると、Gate 閉時に書き込み先として判定される。インタプリタの本文検査（`isInterpreterWriteDenyWorthy`、`:777-796`）は `python3` などの断片の生テキストから heredoc 本文を取り出して書き込みの兆候を探す。これはインタプリタの本文なので F3b でも残す。

## 3. tree-sitter の AST の形（判断の根拠になる事実）

- `heredoc_redirect` の子: `heredoc_start`（区切りの綴り。引用符・バックスラッシュを含めば本文は展開されない）、同じ行の後続（`file_redirect`、`pipeline`、`command`、`&&` の続き）、`heredoc_body`、`heredoc_end`
  - `cat <<'EOF' | bash` ⏎ … では `pipeline`（`bash`）が `heredoc_redirect` の子になる。`cat <<'EOF' >out && bash out` では `command`（`bash out`）が子になる。同じ行の後続があるかは `heredoc_redirect` の子の種類で分かる
- `cat > f <<'EOF'` は `redirected_statement` の子に `file_redirect` と `heredoc_redirect` が並ぶ
- `mkdir -p d && cat <<'EOF' > d/f` は `redirected_statement` の body が `list`（`mkdir … && cat`）になり、heredoc は list に付く。シェルでは heredoc は list の最後のコマンド（`cat`）に渡る
- `git commit -m "$(cat <<'EOF' …)"` は `command`（git）→ `string` → `command_substitution` → `redirected_statement`（cat + heredoc）
- `(cat <<'EOF' … ) | bash` は `pipeline` → `subshell` → `redirected_statement`。本文が cat に渡っても出力は bash に流れる
- 1 行に heredoc が 2 つ（`cat <<A > a; tee b <<B`）は `hasError` になる。`cat <<'EOF' > f; ls` ⏎ … も `hasError`
- `startIndex` / `endIndex` は JS 文字列の添字（UTF-16）と一致する（日本語と絵文字の本文で `slice` が `node.text` と一致）

## 4. 既存の前提・制約

- F3a で決まったこと: allow は `scanSafeList` だけ。heredoc を含む入力は null で、hook は allow しない。heredoc commit も null（`safe-command-list.test.ts:153`）。F3a spec R9 で、F3a の allow 側のテストは F3b で緩めない
- deny-node-modules の `allow` 判定は `context.success({})`（何も返さない、`deny-node-modules.ts:71-72`）。auto-approve は deny 段が clear でも allow は `scanSafeList` に依る。どちらの hook も、本文を外したことで allow を返すことはない。変わるのは deny / ask → 次の層（本体の許可ルール、PermissionRequest、ユーザー）
- `isExemptReadOnlyCommand` は heredoc を含む入力を除外しない（`cat <<EOF > out` ⏎ `EOF` も `cat <<EOF` ⏎ `EOF` も false。確認済み）。本文を外しても除外は増えない
- ADR-0020 の Consequences は「heredoc の本文」を受容した誤検知として挙げ、R6 は「2 例目の綴りによる回避が観測されたら効果モデルを再検討」とする
- file-access-guard（`file-access-guard.ts:284-326`）と block-tsx は parser を使わず生の入力に正規表現を当てる。本文にも当たる。block-tsx は代替手段を示す誘導 deny（ADR-0020 K1）
- 本 session のユーザー判断: commit の allow は F3b で扱わない（deny 側だけ）。リダイレクト付き複合文が base の分割で丸ごと 1 断片になる誤検知（`(rm foo; ls node_modules) 2>&1`、F3a のテストのコメントで「F3b」とされたもの）は別の follow-up
