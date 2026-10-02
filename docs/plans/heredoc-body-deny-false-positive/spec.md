# Spec: heredoc 本文をデータとして deny 側の判定から外す（F3b）

## Goal

heredoc の本文がデータとして読まれるだけの入力で、本文の綴りによって deny / ask が出る誤検知をなくす。本文をデータとして読む消費者は既知の一覧（cat / tee がファイルか端末に書く形）で定義し、一覧に無い消費者・インタプリタ・シェルの本文は従来どおり判定する（fail-closed）。commit / PR の本文の経路（`git commit`・`gh` に heredoc を渡す形）は、本 session のユーザー判断（Round 6 の後、reframer の推奨 (b)）で別の spec に分ける。

## Experience Delta

- 変更前（実 hook で再現済み、research §2）: 本文に削除語と `node_modules` を含む `cat <<'EOF' > out.txt` / `tee out.txt <<'EOF'` を deny-node-modules が deny する（`git commit -m "$(cat <<'EOF' …)"` も同じく deny されるが、この形は F3b では解消しない）。本文に `rm -rf $HOME/x` を含むテストファイルの書き込みを auto-approve の home guard が deny し、本文に `git push --force …` を含むと auto-approve が ask にする。本文に `node_modules` だけを含む書き込みは deny-node-modules が ask にする。Gate 閉時の document-workflow-guard は、本文中の `> plan.md` のような綴りを書き込み先とみなす
- 変更後: `cat <<'EOF' > out.txt`、`cat > out.txt <<'EOF'`、`tee out.txt <<'EOF'`、端末に出す `cat <<'EOF'` は、本文を理由に deny / ask にならない。判定は、本文を空にした入力（`cat <<'EOF' > out.txt` ⏎ `EOF`）に対して行う。書き込み先（`> node_modules/x`、Gate 閉時の `> src/x.ts`）は従来どおり判定する
- commit / PR の本文: `git commit -m "$(cat <<'EOF' …)"`、`git commit -F - <<'EOF'`、`gh … --body-file - <<'EOF'` など、git / gh に heredoc を渡す形は、どれも本文を判定に残す（誤検知は残る）。`$(…)` に渡す形は bash 3.2 の括弧対応による切り出しで本文の一部が実行され（Round 4）、stdin で渡す形は git / gh の選択肢・設定・hook（`-e` と `GIT_EDITOR`、tree-sitter が `-e<<` を演算子に取り込むこと。Round 5・6）を通して本文が実行される経路があり、parser の検査では閉じたことを示せない。この経路は別の spec「commit / PR 本文の経路」で、stdin 形への誘導・heredoc commit の allow と一体で扱う（本 session のユーザー判断）
- 変わらないもの: `python3 - <<'EOF'` などインタプリタの本文、`bash <<EOF` などシェルの本文、`cat <<'EOF' | bash` や `cat > >(sh) <<'EOF'` のように出力が別のコマンドに流れる形、引用符の無い区切りで本文に `$`・バッククォート・`\` を含む形、区切りが `'X'`・`"X"`・`X`（X は英数字と `_`）の形でないもの（`E""OF`、`'E-F'` など）は、従来どおり本文も判定する。書き込み先が `~`・`$HOME`・引用符付きの綴り、`dev`・`proc`・`fd` という名前の要素を含むパス、`/dev/null` の場合も、本文は判定に残る（K2 (g)。誤検知が残る側）。3 つの hook（deny-node-modules、auto-approve、document-workflow-guard）が allow を返す入力は増えない（heredoc を含む入力は `scanSafeList` が null のまま）。deny / ask が無判定に変わった入力は、Claude Code 本体の許可ルールと PermissionRequest 層の判断に委ねられる。heredoc を使う commit は、どの形でも従来どおり確認が出る（本 session のユーザー判断で、commit の allow は扱わない）。cat / tee より前の文に、`:`・`cd`・`echo`・`mkdir` などの少数を除く builtin（`command -v bun && cat …`）、綴りでないコマンド名（`~/bin/x; cat …`）、展開・代入・テスト・構文・パイプ・リダイレクト（`echo $HOME; cat …`、`x=1; cat …`、`[ -d d ] || mkdir d; cat …`、`if …; fi; cat …`、`ls | head; cat …`、`echo x > f; cat …`）があると、cat / tee の本文も判定に残る（K2 (f)。安全な入力でも多めに残す側に倒している）。cat / tee より後ろの行の文（`cat > f <<'EOF'` ⏎ … ⏎ `EOF` ⏎ `bun f 2>&1 | head`）は本文の扱いに影響しない。cat / tee と同じ行の後続（`cat <<'EOF' > f; x`）は、tree-sitter が構文エラーにするので本文が残る
- 対象の範囲: 本文を外すのは上の 3 つの hook の deny 側だけである。file-access-guard（生の入力への正規表現）、block-tsx（誘導 deny）、permission-auto-approve の静的判定、permission-llm-evaluator は、従来どおり本文を含む全文を読む（K3）

## Architecture

```
Bash の入力 (raw)
   │
   ├─ allow 側: scanSafeList(raw) ……………… 変更しない（F3a K1）
   │
   └─ deny 側: prepareDenyInput(raw) → { maskedText, individualCommands, parsingMethod }
          │   lib/deny-input.ts。maskedText = maskDataHeredocBodies(raw)（一覧の消費者に渡る
          │   heredoc の本文だけを空にした文字列。判定できない入力は raw のまま）、
          │   individualCommands / parsingMethod = extractCommandsStructured(maskedText)
          │
          ├─ deny-node-modules: individualCommands、isExemptReadOnlyCommand(maskedText)
          ├─ auto-approve の deny 段: checkHomeDestruction(maskedText)、individualCommands
          │                         （pattern-matcher の deny ルール照合もこの断片に当たる）、
          │                         isExemptReadOnlyCommand(maskedText)
          └─ document-workflow-guard: individualCommands
```

本文を空にしても、シェルの構文としては空の heredoc（`<<'EOF'` ⏎ `EOF`）になるだけで、コマンド行の語・リダイレクト・後続の文は変わらない。deny 側の各判定は、空にした入力を従来と同じ手順で判定する。`maskedText` は判定専用で、実行・表示・allow 側・LLM evaluator には渡さない（実行されるのは raw なので）。型は raw と同じ `string` なので、取り違えは名前と K1 の import 検査で防ぐ。

モジュールの依存は `implementations/*` → `lib/deny-input.ts` → {`lib/heredoc-data.ts` → `lib/bash-parser.ts`（`parseForCollect`）, `lib/bash-parser.ts`（`extractCommandsStructured`）} の一方向。`bash-parser.ts` は AST の取得（既存の `parseForCollect` を export）と断片の抽出を担い、どの消費者をデータとみなすかというポリシーは持たない（F3a で意味論を持つ `safe-command-list.ts` を parser から独立させたのと同じ分け方）。

## Alternative Approaches (Greenfield View)

### 差分最小案 (Incremental)

各消費者で、`<<` の印から区切り行までを正規表現で落とす（document-workflow-guard の `HEREDOC_MARKER_REGEX`、`document-workflow-guard.ts:623` と同じ読み方）。消費者の判定は「先頭語が cat / tee か」で行う。

却下の理由: 正規表現では、本文の出力の行き先が分からない。`cat <<'EOF' | bash`、`(cat <<'EOF' … ) | bash`、`cat <<'EOF' >s && bash s`（research §3 で、後続は `heredoc_redirect` の子や祖先の `pipeline` として現れる）を見分けられず、本文を実行する形をデータとして扱う。これは F3 の当初案が Round 1 で見つけた fail-open と同じ類である。1 行に heredoc が 2 つある入力（tree-sitter は `hasError`）でどの本文がどの区切りに対応するかも、正規表現では判定できない。

### 白紙設計案 (Greenfield)

入力の各語を「実行される位置」と「データの位置」に分ける語の役割モデルを作り、deny 側の綴りの判定は実行される位置の語にだけ当てる。heredoc の本文、`echo` の引数、`git commit -m` の値、`grep` のパターンは、いずれもデータの位置になる。

起源: ゼロから設計すると、問題は heredoc に固有ではない。ADR-0020 が受容した誤検知（`echo rm node_modules`、`git commit -m "find -delete" node_modules`）も、「綴りの判定がデータの位置にも当たる」という同じ原因から生じている。誤検知の類を一度に閉じるなら、この役割の分類が根になる。

### 採用案と理由

本文の範囲を parser の AST から取り、消費者の識別と出力の行き先を AST で確かめる、heredoc の本文に限った方式を採る（K1〜K3）。白紙案の語の役割モデルのうち、heredoc の本文だけを先に実装したものに当たる。

- heredoc の本文は、範囲が構文で決まる（`heredoc_body` ノード）。白紙案を引数に広げるには、コマンドごとのオプションの文法（`git -c alias.x='!…' commit` の `-c` の値は実行される、`git commit -m` の値はデータ）が要る。ADR-0020 は、先頭語の特定や変数の解決で hook の解釈とシェルの実行がずれる穴を、レビューのたびに見つけて却下した（ADR-0020「却下した代替案」の 2・3 番目）。引数の役割の分類は、同じ種類のずれを、コマンドの数だけ抱える
- 観測された誤検知は heredoc の本文と、インタプリタへのインライン引数（`bun -e`、`python3 -c`）である（issue 記録 F3 と追加観測）。後者はユーザー判断で判定に残す。引数の誤検知（`echo rm node_modules` など）は観測が無い
- `maskDataHeredocBodies` は「AST でデータの位置と確かめた範囲を空にする」関数として作る。引数の誤検知が観測されたら、同じ関数の対象を広げる形で白紙案に寄せられる
- 当初は commit / PR の本文も対象にした。`$(cat <<'EOF' …)` を引数に渡す形（形 B）は Round 4 で bash 3.2 の括弧対応による切り出しが見つかって外し、stdin で渡す形（`git commit -F -`、`gh … --body-file -`）に置き換えた。stdin 形も Round 5（`-e` と `GIT_EDITOR`）・Round 6（`-e<<` の演算子への取り込み）で本文が実行される経路が見つかった。Round 4〜6 の blocker はすべてこの経路から出ており、Round 4〜6 で見つかった読みのずれ（`$(…)` の切り出し、落ちる `-`、演算子に取り込まれる `-e`）は sink の検証で見つかったが、cat / tee の条件にも規則として取り込んだ（K2 (a)(d)）。それ以降、cat / tee の heredoc の構造そのもの（K2 (a)〜(e)(g)）を破る形は見つかっていない（Round 7〜12 の穴はすべて K2 (f)、同じ入力の別の文による cat / tee の差し替えで、別の系統。次の項）。sink の安全性は parser ではなく git / gh の意味論（選択肢・設定・hook・環境変数、版依存）で決まるので、review-reframer の推奨 (b) と本 session のユーザー判断で、F3b は cat / tee に絞り、commit / PR 本文の経路は別の spec にする（`reframer-review.spec.md`）
- Round 1〜6 の blocker はすべて「tree-sitter の読みとシェルの読みのずれ」という同じ型で、修正はどれも AST の解釈を綴りの許可リストに移すことだった。そこで K2 は、個別の条件の列挙の前に「parser は構造と範囲にだけ使い、heredoc に隣接するトークンはすべて綴りで比べる」という不変条件を置き、以後見つかるずれは plan-1 の表の行として足す
- Round 7〜12 の blocker / needs-work はすべて K2 (f) で、「cat を差し替えうるものを列挙すると、列挙の外から次が見つかる」という型だった（`builtin eval`、`trap '…' DEBUG`、zsh の `emulate -c`、`${functions[cat]=sh}`、`[[ 1 -eq PATH=0 ]]`、`a[PATH=0]=1`、`for PATH in .`、zsh の `: {PATH}>/dev/null`）。(f) の案は 4 つあった
  - (1) 差し替える builtin の名前の denylist を広げ続ける（Round 7・8 の版。どちらの round でも列挙の外から穴が出たので却下）
  - (2) 危険なノードの種類（展開、代入、算術、`[[ ]]`）を列挙し、builtin 名は実シェルの閉じた一覧から不活性なものだけを許す（Round 9〜11 の版。各 round でノードの種類の列挙の外から穴が出たので却下）
  - (3) 受け入れるノードの種類を閉じた許可リストにし、許可リストの外の種類が 1 つでもあれば残す（採用）。builtin 名は (2) と同じく閉じた一覧で判定する。外部コマンドはシェルの状態を変えられないので受け入れる
  - (4) 入力が cat / tee の 1 文だけのときに限る最小の述語。(f) の一覧も版の保守も要らないが、決定ログでは 1 行目が `cat … <<` の 24 件のうち 6 件（ask 5 件のうち 2 件）しか空にならないので却下（Round 11 の測定）
  - (3) の中で見る範囲も 2 案あった。(3a) 入力全体、(3b) 消費者の文とそれより前の文（採用）。(3b) にするのは、(3a) では決定ログで空になる入力が 23 件から 8 件に落ちる（Round 11 の測定）（後ろの `node … 2>&1 | grep` などで残る）一方、後ろの文は消費者を差し替えられないからである。(3) は、トークンの綴りの解釈には AST を使わないが、構文の種類の報告（どの種類のノードがあるか）には tree-sitter に依存する。この依存は K5 の前提として ADR に書く

## Key Decisions

- **K1: deny 側の入口を 1 つにし、そこで一覧の消費者の本文を空にする** — 2 つのモジュールを足す
  - `lib/heredoc-data.ts` の `maskDataHeredocBodies(command: string, parse?: ParseForCollect): Promise<string>`（`parse` はテストで parse の失敗と呼び出し回数を差し込むための省略可能な引数で、既定は `parseForCollect`。hook は渡さない）: K2 の条件を全部満たす heredoc の `heredoc_body` の範囲を空文字に置き換えた文字列を返す。入力に `<<` が無ければ parse せずにそのまま返す。tree-sitter の parse が null・throw・`rootNode.hasError` の入力でもそのまま返す。範囲は `startIndex` / `endIndex` で切り、切り出した文字列がノードの `text` と一致しないときもそのまま返す（UTF-16 の添字と一致することは research §3 で確認済み。一致の検査は、web-tree-sitter の更新で添字の単位が変わったときに本文を壊さないための保険）。tree は `finally` で `delete()` する
  - `lib/deny-input.ts` の `prepareDenyInput(raw: string): Promise<DenyInput>`（`DenyInput = { maskedText: string; individualCommands: string[]; parsingMethod: "tree-sitter" | "fallback" }`）: `maskedText = await maskDataHeredocBodies(raw)` とし、`extractCommandsStructured(maskedText)` の断片と parse 方式を合わせて返す。deny 側の判定は、全文を読むもの（`checkHomeDestruction`・`isExemptReadOnlyCommand`）には `maskedText` を、断片を読むものには `individualCommands` を渡す
  - 戻り値の契約（JSDoc に書き、plan-1 のテストで固定する）: `maskedText` は判定専用で、実行・表示・allow 側・LLM evaluator には渡さない。本文を空にした場合（`maskedText !== raw`）、`maskedText` を再度 parse しても `hasError` にならず、本文を空にした heredoc 以外の語・リダイレクト・文は raw と同じである（出力は raw から K2 に当たる `heredoc_body` の範囲だけを除いた文字列で、plan-1 のテストは除いた範囲の外の文字が raw と一致することも確かめる）。空にしなかった場合は `maskedText === raw`（raw が `hasError` ならそのまま）。`maskDataHeredocBodies` は冪等である（空にした本文は K2 の対象にならない）。JSDoc には、deny 側の判定は `extractCommandsStructured` を直接使わず `prepareDenyInput` を使うことも書く（`pattern-matcher.ts:79` のコメントは allow 側の照合の文脈で残る）
  - 断片の抽出（`extractCommandsStructured`）の中ではなく入口の関数で外すのは、`checkHomeDestruction`・`isExemptReadOnlyCommand` が断片ではなく入力全文を読むため。`extractBaseCommands` を使う許可ルールの提案ツール（`permission-analyzer.ts`）は変えない
  - 3 つの hook は `extractCommandsStructured` を直接呼ばず、`prepareDenyInput` だけを使う。plan-2 で、`implementations/*.ts` をすべて走査し、どのファイルのソースにも識別子 `extractCommandsStructured` と `heredoc-data.ts` への参照が無いこと、3 つの hook が `prepareDenyInput` を import していることを検査するテストを置く。静的 import、`lib/command-parsing.ts` の同名の再 export 経由、動的 `import()` のいずれでも識別子はソースに現れるので、4 つ目の hook が断片の抽出を直接使い始めたときもこのテストが落ちる（現状この識別子を含む implementations は 3 つの hook だけ。allow 側など正当な用途で使う hook を足すときは、テストの許可リストに理由付きで加える）
  - 参照: `home/dot_claude/hooks/lib/bash-parser.ts:993-1037`（`collectExecutableTexts`。tree-sitter の parse・`hasError` の扱い・fail-closed の型を踏襲する）
  - 参照: `home/dot_claude/hooks/lib/bash-parser.ts:943-950`（`parseForCollect`。`heredoc-data.ts` から使うために export する）
  - 参照: `home/dot_claude/hooks/lib/bash-parser.ts:1039-1052`（`extractCommandsStructured`）
- **K2: データとみなす消費者の一覧と条件** — 次の不変条件のもとで、(a)〜(g) を全部満たす heredoc の本文だけを空にする。どれか 1 つでも満たさない・判定できない本文は残す。条件と一覧は `lib/heredoc-data.ts` に置く
  - 不変条件: parser（tree-sitter-bash）は文の構造（どの文に heredoc が付くか、祖先の種類）と本文の範囲を取るためだけに使う。heredoc に隣接するトークン、つまり消費者の command の終わりから次のリダイレクトまでの隙間・heredoc の演算子・区切り・終端・出力先は、すべてソースの綴りを許可リストと比べて判定し、AST がそこから何を報告するかに頼らない。列挙に無い綴り・形と `hasError` の入力は本文を残す。Round 1〜6 で見つかった穴（宛先、区切りの引用符と行の連結、`$(…)` の切り出し、落ちる `-`、演算子に取り込まれる `-e`）は、どれも AST の読みとシェルの読みのずれで、この不変条件に当てはまる形で閉じた。以後見つかるずれは、plan-1 の表に行として足す
  - (a) 消費者: heredoc を受け取るコマンドが `cat` か `tee` で、代入の前置（`variable_assignment`）が無い。`command_name` は綴りの完全一致で比べる（`\cat`・`/bin/cat`・`"cat"` は一致しない）。引数のノードはすべて `word` で、綴りに `$` もバッククォートも含まない（プロセス置換、展開、引用符付き文字列の引数は一致しない）。cat / tee は引数をファイル名か選択肢として読むだけで、実行しない。tee の `-` で始まらない引数（書き込み先のファイル）は、(g) の宛先と同じ判定に通す（`tee //dev/fd/14 <<'EOF'` は一致しない）
    - 隙間: tree-sitter-bash は `<<` の直前に単独で置いた `-` を `command` の子から落とす（`cat - <<'EOF'` の command は `cat`。`hasError` は false。Round 5 で実測）。そこで、消費者の `command` の終わりから `redirected_statement` の次のリダイレクトの始まりまでの綴りを見る。空白（スペースとタブ）だけなら引数はそのまま、空白・単独の `-`・空白なら引数 `-` を 1 つ足す。それ以外の綴りがあれば一致しない
    - 演算子: tree-sitter-bash は、`<<` / `<<-` の直前に空白なしで付いた `-…` を演算子のトークンに取り込む（`-e<<` は `heredoc_redirect` の名前の無い子 1 つで、綴りは `-e<<`。Round 6 security が実行される形を実測し、main loop も AST で確認した）。演算子の綴りは `<<`・`<<-`・`-<<`・`-<<-` だけを受け付け、後の 2 つは引数 `-` を 1 つ足したものとして読む。それ以外（`cat -n<<`）は一致しない。ファイルへのリダイレクト（`-e>f`）では取り込みは起きないが、(g) の演算子も型ではなく綴りで比べる
  - (b) 同じ行の後続が無い: `heredoc_redirect` の名前付きの子が `heredoc_start`・`file_redirect`・`heredoc_body`・`heredoc_end` だけである（`cat <<'EOF' | bash`、`cat <<'EOF' >s && bash s` は一致しない）
  - (c) heredoc の付き先: `heredoc_redirect` の親の `redirected_statement` の body が消費者の `command` か、右端の子をたどると消費者の `command` に着く `list` である（`mkdir -p d && cat <<'EOF' > d/f` は tree-sitter が list に heredoc を付けるが、シェルでは右端の `cat` に渡る。research §3）
  - (d) 出力の行き先: `redirected_statement` の祖先が `list` と `program` だけである。消費者の出力は (g) を満たすファイルか、Bash ツールの結果として agent に返るだけになる。`$(…)`・サブシェル・パイプ・プロセス置換の中の heredoc は一致しない（`git commit -m "$(cat <<'EOF' …)"` も一致しない。Round 4 security が、bash 3.2 は `$(…)` の範囲を heredoc を理解しない括弧の対応で切り出し、本文の `x)"; echo EXEC; #` を実行することを実測した）
  - (e) 本文の終端の読みがシェルと一致し、本文が展開で実行されない: 次の全部を満たす
    - `heredoc_start` の綴りが、`'X'`・`"X"`・`X`（X は `[A-Za-z0-9_]+`）のどれかに完全一致し、`heredoc_end` の綴りが X に一致する。区切りの途中の引用符（`E""OF`、`E'O'F`、`"E"OF`、`EO'F'`）、`\`、空白・タブ、`$` を含む区切りは一致しない。シェルは区切りの引用符を除いて `EOF` で閉じるが、tree-sitter は綴りのまま `E""OF` まで閉じず、間の行の実行されるコマンドを本文として扱う（Round 3 security が bash 3.2 と zsh で実測。tee でも同型）
    - 区切りが引用符付き（`'X'`・`"X"`）なら、シェルは本文を展開せず行も連結しない。引用符の無い `X` なら、本文の綴りに `$`・バッククォート・`\` のいずれも含まない。tree-sitter は本文中のバッククォートを解析しない（research §1）。引用符の無い区切りで `EO\` ⏎ `F` と書くと、シェルは行を連結して `EOF` で閉じるが tree-sitter は閉じない（Round 1 security の実測）
    - どれも AST の解釈ではなく綴りで判定する。決定ログの heredoc の区切りは `<<'EOF'` が定型なので、許可リストに絞っても誤検知の解消範囲は変わらない
  - (f) 消費者の文と、それより前のトップレベルの文が、次の閉じた形だけでできている。外部コマンドのプロセスは、呼び出し元のシェルの関数・別名・オプション・trap・コマンド表・変数を変えられない。それらを変えられるのは現在のシェルが評価するもの（builtin、代入、展開、算術、関数定義、ループ変数、リダイレクトの fd 代入など）だけで、外部コマンドの引数の展開も現在のシェルが評価する。危険な種類を列挙すると、列挙の外から次が見つかった（Round 7〜11）。そこで受け入れる側を閉じる。Round 7〜11 の security が bash 3.2・zsh で実測した穴（下の例）は、どれもファイルを書かずに 1 つの入力で本文が実行されるので R1 では受容しない。R1 が受容するのは、書く文と実行する文が分かれ、実行する文が判定に残る形である（`mkfifo ff; sh ff & cat > ff <<'E'` も、実行する `sh ff` が判定に残るので R1 に入る）
    - ノードの種類: `program`・`list`・`command`・`command_name`・`word`・`raw_string`・`string`・`string_content`・`concatenation`・`number`・`comment`・`redirected_statement`・`heredoc_redirect`・`heredoc_start`・`heredoc_body`・`heredoc_end`・`file_redirect` だけ。これ以外（代入、展開、`((…))`、`[ … ]`・`[[ … ]]`、`if`・`for`・`select`・`while`・`case`、サブシェル、パイプ、関数定義、否定 `!` など）が 1 つでもあれば本文を残す。実測した穴の例: zsh の `true ${functions[cat]=sh}`・`x=${galiases[cat]=sh}`（Round 9）、`[[ 1 -eq PATH=0 ]]`・`a[PATH=0]=1`（Round 10）、`for PATH in .; do :; done`（bash 3.2・zsh、Round 11）。どれも許可リストの外の種類なので残る。`[ … ]` と `test` は bash 3.2・zsh 5.9 では算術を評価しないが、bash 4.3 以降の `test -v 'a[…]'` は添字を算術として評価するので受け入れない（Round 11 scope の指摘。bash 4 以降は手元で実行していない）
    - `redirected_statement` は、本体（またはその list の右端）が cat / tee のものだけ。ほかの文のリダイレクト（`: {PATH}>/dev/null`、`echo x > f`）は builtin では現在のシェルで処理されるので残す（zsh は `{PATH}>` で `PATH` に fd 番号を代入する。Round 11 security が zsh 5.9 で実測）
    - `{`・`}` を含む `word`: tree-sitter は `{PATH}` を語として報告するので、綴りで除く（ブレース展開 `{a,b}` も同じく残す）
    - データの本文（`heredoc_body`）の中には tree-sitter が展開のノードを作らないので、本文の `$`（`rm -rf $HOME/x`）は許可リストの判定に当たらない（plan-1 の表に行を置く）
    - command*name の綴りが `[A-Za-z0-9*./:-]` だけでない文（`$f …`、`"ev"al …`、`~/bin/x`、`[`）: 実行時に builtin に展開されうる
    - command_name が `SHELL_WORDS` にあり `INERT_SHELL_WORDS` に無い文。`SHELL_WORDS` は bash 3.2.57 の `compgen -b`・`compgen -k`、bash 4 以降の追加（`coproc`・`mapfile`・`readarray`・`compopt`）、zsh 5.9 の同梱モジュールをすべて読み込んだ状態の `${(k)builtins}`・`${(k)reswords}` の和集合を、版を書いて定数にしたもの（Round 9 security が実シェルの出力と照合し、欠けが無いことを確認した）。bash の予約語（`if`・`for`・`[[`・`!` など）は tree-sitter では構文のノードになり、上のノードの種類の許可リストで残る。zsh だけの予約語（`foreach`・`repeat`・`end` など）は command_name に出るのでこの項で一致する。`INERT_SHELL_WORDS` は、cat / tee の解決に効く関数・別名・オプション・trap・コマンド表・fd・変数を変えないもの（`cd` は `PWD` を書くが cat の解決には効かない。環境の `PATH` に相対の要素がある場合は既存の環境の状態で、対象外）。`:`・`cd`・`chdir`・`echo`・`false`・`pwd`・`true`、zsh/files を読み込んだときだけ builtin になるファイル操作 `chgrp`・`chown`・`mkdir`・`rm`・`rmdir`・`sync`）に限る。`ln`・`mv`・`chmod` は、消費者の直前に PATH 上の書けるディレクトリへ `cat` という名前の実行ファイルを置けるので含めない（`ln -s /bin/sh ~/.local/bin/cat` ⏎ `cat <<'E'` で本文が実行される。bash 3.2 で実測、zsh はコマンド表を先に作るので不発。Round 12 security）。`printf`（`-v` で変数に書く）・`read`・`stat`（zsh の `-A`）は含めない
    - 引数の語の綴りは見ない（`{`・`}` を除く）。展開を含まない外部コマンドの引数（`git add source`、`docker exec …`）はシェルの状態を変えないので、Round 7 の版の「どの語に `eval` などが現れても一致」は誤検知だけを生んでいた。builtin の引数で評価される形（`builtin eval`、`trap '…'`）は、その builtin 自体で一致する
    - 見る範囲は、消費者を含むトップレベルの文と、それより前のトップレベルの文だけ。後ろの文は、消費者のプロセスが起動した後にシェルを変えるので、消費者を差し替えられない（消費者を `&` で裏に回しても、子プロセスは fork の時点の状態を持つ）。後ろの文に別の heredoc があれば、その heredoc はその位置で同じ規則を当てる。消費者と同じ行の後続（`cat <<'E' > f; x`、`cat <<'E' > f &`）は tree-sitter が `hasError` を返すので、入力全体で本文が残る（Round 12 logic が実測）。この前提が効くのはシェルの状態についてだけで、ファイルシステムを介した差し替えは R1 で扱う
    - zsh の glob 修飾子（`*(e:'…':)`）は現在のシェルでコードを実行する。現在の tree-sitter は `hasError` を返すか綴りでない command_name にするので本文が残る。parser の更新でこれが変わったときに気づけるよう、plan-1 の表に行を置く
    - 多めに本文を残す側に倒れる形: 消費者より前に、`command -v bun && …`（`command` は安全な使い方でも一致する）、`~/bin/x`（綴りでない名前）、`echo $HOME`・`x=1`（展開・代入）、`[ -d d ] || mkdir d`・`if …; fi`（テスト・構文）、`ls | head`（パイプ）、`echo x > f`（消費者でない文のリダイレクト）がある入力。bash / zsh の新しい版で増えた builtin（一覧に無い名前は外部コマンドとして扱われるので、版を上げるときに一覧を取り直す。plan-1 の定数のコメントに取得コマンドを書く）。決定ログでの代償は下の「一覧の根拠」に書く
  - (g) 出力先のリダイレクトと tee の書き込み先: 消費者の `redirected_statement` の `file_redirect` と、`heredoc_redirect` の子の `file_redirect` は、演算子が `>` か `>>` で、宛先が 1 つの `word` のものだけである。宛先（と (a) の tee の書き込み先）の綴りは、文字種が `[A-Za-z0-9_./-]` だけで、`/` で区切った要素を小文字にしたものに `dev`・`proc`・`fd`・`..` を含まないものだけを受け付ける（macOS の既定のファイルシステムは大文字小文字を区別せず、`/DEV/fd/14` も devfs に届く。Round 3 security の実測）。`/dev/fd/3`・`//dev/fd/3`・`/./dev/x`・`../dev/x`・`/DEV/fd/3` は一致しない。`/dev/null` への出力と、`dev` などの名前の正当なディレクトリ（`src/dev/x.ts`）への出力も本文を残す側に倒れる。`>&3`（fd の複製）、`> >(sh)`（プロセス置換）、`>| f`、`2>`・`<` などそれ以外の演算子、引用符付き・展開・`~` を含む宛先は一致しない（Round 1 の logic-validator と security が `cat > >(sh) <<'EOF'`、`cat >&3 <<'EOF'` を、Round 2 の security が `coproc …` ⏎ `cat <<'EOF' > //dev/fd/14` を実測）
  - 一覧の根拠: 観測された誤検知の入力（research §2 の表、決定ログの `cat > … <<'EOF'`）が cat / tee に収まる。決定ログ（`~/.claude/logs/decisions.jsonl*` の 6 ファイル、ローテーション済みで 2026-10-01T20:52Z 以降、Round 12 の反映時点までの分。ログは書き込み中に増える）で、`<<` を含む Bash の記録（時刻とコマンドで重複を除く）は 359 件。そのうちコマンドの 1 行目が `cat … <<` で始まり `$(cat` を含まないものが 25 件（pass 14・allow 6・ask 5）。Round 12 の反映後の plan-1 T3（ノードの種類の許可リスト、`[ ]`・`test`・`ln`・`mv`・`chmod` を受け入れない、消費者より前の文だけを見る (f)。plan-1 の T3 のコードブロックを scratchpad に取り出して実行）に通すと 24 件で本文が空になり、ask の 5 件はすべて空になる。残る 1 件は本文がもともと空の入力（`cat > f <<'EOF'` ⏎ `EOF` ⏎ …）で、(f) によって多めに残した入力は 0 件だった。消費者より後ろの文まで見る版では 8 件に落ちた（Round 11 の測定で分母は 24 件。後ろの `node … 2>&1 | grep` などで残る）ので、見る範囲を前の文に絞った。入力が cat / tee の 1 文だけのときに限る最小案は、24 件のうち 6 件（ask は 2 件。Round 11 の測定）しか空にならないので採らない。tee は 0 件。以前この欄にあった件数（276・183、のちの 346・115）は、数え方の定義を再現できないので取り下げた。Round 1 の集計（古いログを含む）では tee 41 件、git commit 163 件、gh 21 件。commit / PR の本文は別の spec で扱う
  - (b)(c)(d) が AST の構造（`heredoc_redirect` の子、付き先の list の右端、祖先の種類）で判定するのは、不変条件が parser に任せる「構造」の側に当たるからである。構造の読みのずれ（`$(…)` の切り出し）は (d) で `$(…)` の中を一致させないことで閉じ、隣接するトークンの読みのずれは綴りの許可リストで閉じる
  - 隙間と演算子で単独の `-` を受け付けるのは、`cat -`・`cat - <<'EOF'`（stdin を明示する書き方）がシェルでは同じ意味で、受け付けないと誤検知が残るからである。受け付ける綴りは `-` 1 語に限り、Round 7 security の表（隙間・演算子・終端・末尾の計約 8,000 入力）で本文が実行される形は見つかっていない
  - 一覧は定数 `HEREDOC_DATA_CONSUMERS`（`{ name, reason }` の配列）に置く。各エントリは、本文・引数をコードとして実行する経路が無いことを書いた `reason` を必須で持ち、plan-1 のテストで空の `reason` を落とす。足すときは ADR-0020 の追記にも足す。heredoc 以外の引数で誤検知が観測されたら、一覧を広げるのではなく白紙案の語の役割モデルを再検討する
  - 参照: `home/dot_claude/hooks/lib/bash-parser.ts:961-969`（`isCoveredRedirect`。`redirected_statement` の body の型で分岐する既存の読み方）
- **K3: 適用する消費者は 3 つ** — deny-node-modules、auto-approve の deny 段、document-workflow-guard の Bash 書き込み判定。各 hook は入力ごとに 1 回 `prepareDenyInput` を呼ぶ
  - deny-node-modules: `analyzeBashCommand` の先頭で呼び、断片と `isExemptReadOnlyCommand(maskedText)` を使う。`standaloneSymlinkRemovalOperands`（ADR-0020 K3）は原文のまま（heredoc を含む入力は単独の rm / unlink の形に当たらない）
    - 参照: `home/dot_claude/hooks/implementations/deny-node-modules.ts:200-208`
  - auto-approve: `processBashTool` で呼び、`checkHomeDestruction(maskedText)`・断片・`isExemptReadOnlyCommand(maskedText)` を使う。`scanSafeList` は原文のまま（allow の根拠は変えない。F3a K1）。deny 段の対象（`denyTargets`）に足す `scanSafeList` の単純コマンドも原文由来のまま（heredoc を含む入力では null なので、空にした断片と原文由来の断片が同じ入力で混ざることは無い）。deny 段の `patternMatcherCheckDeny`（ユーザー設定の deny ルール照合、`pattern-matcher.ts:345` で断片を再 parse する）は、空にした断片に当たる。ユーザーの deny ルールも、本文の綴りでは当たらなくなる
    - 参照: `home/dot_claude/hooks/implementations/auto-approve.ts:372-396`、`:476-487`
  - document-workflow-guard: `analyzeBashWrite` で呼び、断片を使う。インタプリタの本文検査（`isInterpreterWriteDenyWorthy`）は、インタプリタの heredoc が K2 (a) に当たらないので、本文が残った断片を従来どおり読む
    - 参照: `home/dot_claude/hooks/implementations/document-workflow-guard.ts:559-581`
  - `isExemptReadOnlyCommand` の JSDoc（`read-only-command.ts:80-84`、「シェルが読む全文」）に、deny 側の呼び出しでは本文を空にした全文を受けると追記する。空にした入力で除外が増えないことは plan-2 の表で固定する（heredoc を含む入力は空にしても除外されない。research §4）
  - 適用しないもの（本文の綴りに当たり続ける。ADR-0020 の追記にも列挙する）:
    - permission-auto-approve の静的判定: deny は記録だけで後段に回し、heredoc を含む入力は `scanSafeList` が null で allow しない。外しても判定が変わらない（`permission-auto-approve.ts:471-505`）
    - file-access-guard: parser を使わず生の入力に正規表現を当てる別の機構（`file-access-guard.ts:284-326`）。本文に `cat /etc/x` などの綴りがあると当たる構造だが、観測は無い。適用するには同期の正規表現を非同期の入口に載せ替える変更が要るので、観測されたら `prepareDenyInput` の `maskedText` を渡す形で follow-up にする（`.tmp/docs/issue-boundary-deny-false-positives.md` への追記を plan-2 のタスクに入れる）
    - block-tsx: 代替手段を示す誘導 deny（ADR-0020 K1）
    - permission-llm-evaluator: LLM は本文を含む全文を読んで判断する
- **K4: 本文を外しても、3 つの hook の allow は増えない（不変条件）** — deny-node-modules の `allow` は `context.success({})` で、許可の判定を返さない（`deny-node-modules.ts:71-72`）。auto-approve の allow は `scanSafeList(原文)` だけで決まり、heredoc を含む入力は null になる（`safe-command-list.test.ts:153`。Round 1 logic-validator が `cat <<'EOF' > out.txt`、`git commit -m "$(cat <<'EOF' …)"`、`tee out.txt <<'EOF'` で null を実測）。document-workflow-guard は deny するか何も返さないかである。したがって本文を外した結果は、deny / ask から「次の層（Claude Code 本体の許可ルール、PermissionRequest、ユーザー）に委ねる」への変化に限られる。次の層の許可ルール（例: 本体の `Bash(cat:*)`）で実際に通る入力は増えうるので、本文を実行する形を K2 で確実に残すことが安全性の前提になる。F3a の allow 側のテスト（F3a spec R9）は変えない。permission-auto-approve の静的判定の allow 経路（`isProjectScopeSafe` など）は F3b で触れない
  - 参照: `home/dot_claude/hooks/implementations/auto-approve.ts:422-431`（`simpleCommands === null` なら pass）
- **K5: ADR-0020 R6 の再検討には当たらない** — R6 の条件は「2 例目の綴りによる回避の観測」である。F3b の観測は誤検知で、拒否を別の綴りで回避した観測ではない（issue 記録 F3 の agent は、保護対象に触れない編集を Edit ツールで行った）。F3b は削除の分類規則（`classifyDeletion`・`checkDangerousCommand`・`checkHomeDestruction`）を変えず、判定に渡すテキストからデータの範囲を除くだけなので、効果モデル（解決済みのパスで判定する）の論点とは独立している。ADR-0020 の Consequences の「誤検知は残る」の旧文を、heredoc の本文については F3b で一部解消したと読める形に直し、追記を足す。追記は README を参照せず ADR の中で完結させ、本文を空にする範囲（K2 の不変条件・cat / tee の一覧・条件の要約）、commit / PR の本文を扱わない理由（`$(…)` 形は bash 3.2 の括弧対応による切り出し、stdin 形は git / gh の選択肢・設定・hook を通す経路があり別の spec で扱う）、K2 (f) の保証の水準（消費者とそれより前の文を、受け入れるノードの種類の閉じた許可リストと、builtin 名の閉じた一覧で判定し、不活性なものだけを受け入れる。残る前提は、builtin の一覧の版〔bash 3.2.57・zsh 5.9〕と、tree-sitter が構文の種類をノードの種類として報告すること〔zsh の glob 修飾子のように、今は `hasError` で残る構文が、parser の更新で許可リストの種類として報告されうる〕）、一覧に足すときの統制（`reason` の必須と ADR への追記）を書く。あわせて、R1 の類（一覧の消費者で書いた本文を、別の文で実行する形）は Write ツールで書いてから実行するのと同じ水準の迂回経路になることを書き、R6 の「2 例目の綴りによる回避」を数えるときにこの経路の観測も含めると明記する。R1 の受容の前提（後段が全文を読む）と再評価の条件も ADR に転記する
  - 参照: `docs/decisions/0020-boundary-deny-rephrase.md`（Consequences「誤検知は残る」「再検討の条件」）

## Risks

- **R1: 一覧の消費者で書いた本文を、別の文で実行する形は、1 回の入力では判定されなくなる** — 本文を外すと、次の形で本文の中身が deny 側の判定に見えなくなる
  - 改行の後の文で実行する: `cat <<'EOF' > s.sh` ⏎ 本文 ⏎ `EOF` ⏎ `bash s.sh`
  - 先行する文と同時に実行する: `bash p & cat <<'EOF' > p`（fifo など）
  - 同じ入力の前の文で cat や出力先を差し替える形のうち、K2 (f) で一致しないもの（例: 実行可能なファイルを書いて別の入力で読み込む、`mkfifo ff; sh ff & cat > ff <<'E'` のように名前付きパイプへ書き、前の文の `sh ff` が読む。Round 11 の確認で bash 3.2・zsh で本文が実行されることを実測したが、`sh ff` が判定に残る）。PATH 上の書けるディレクトリに `cat`・`tee` という名前の実行ファイルを置き、その後の cat / tee の heredoc の本文を実行させる形もここに入る。同じ入力の中で `ln`・`mv`・`chmod` を使う形は K2 (f) で残すが、外部コマンド（`cp /bin/sh ~/.local/bin/cat`）や Write ツールで置く形は残らない。この形では実行する文が空にした cat そのもので、判定に残らない。それでも受容するのは、同じ効果（本文を判定させずに実行する）が F3b の前から Write ツールでスクリプトを書いて `bash s.sh` を実行すれば得られ、F3b はその水準を超えないからである。K2 (f) は同じ入力の中の現在のシェルによる差し替え（許可リストの外のノードの種類、不活性でない builtin、綴りでないコマンド名）を除き、外部コマンドがファイルや名前付きパイプを介して後で効く形は除かない。後者は、書く文と効く文が分かれ、効く側の文が判定に残る点で、1 つの入力の中で本文が実行される形（(f) で除く）と区別している
  - 本文を保存してから別の形で実行する: `tee notes.txt <<'EOF'` ⏎ 本文 ⏎ `EOF` ⏎ `sh < notes.txt`
  - このうち「先行する文と同時に実行する」と「同じ入力の前の文で差し替える」は、1 回の入力の中で書きと実行がそろう。Write ツールと Bash の 2 回の呼び出しが要る形より一段弱く、ADR の追記では Write 経由の類と別の項目に書く
  - → どれも「書く」と「実行する」の 2 段階が要る形で、同じ効果は今も Write ツールでファイルを書いてから `bash s.sh` を実行すれば得られ、どの hook も中身を判定しない（deny-node-modules は Write の内容を見ない、`deny-node-modules.ts:77-90`。ADR-0020 の Consequences「インタプリタ経由の削除は対象外」と同じ類）。実行する側の文（`bash s.sh`、`sh`）は空にした入力に残るので、その文自体の判定は従来どおりである。書き込み先が実行される場所（`~/.bashrc`、`.git/hooks/*`）である形も、書き込み先の判定は従来どおり残る。F3b が開くのは、この既存の経路と同じ水準までである。heredoc の 1 文で本文が実行される形（同じ行の後続、出力先のプロセス置換・fd）は受容の範囲外で、K2 (b)(f)(g) で本文を残す。後段の PermissionRequest の LLM evaluator は本文を含む全文を読む。この受容は、LLM evaluator（と K3 の「適用しないもの」の hook）が本文を含む全文を読むことを前提にする。K3 の一覧を変えて後段の判定にも空にした入力を渡すときは、R1 の受容を再評価する。ADR-0020 の追記に、この類を対象外として書く（K5）
- **R2: tree-sitter-bash の更新で AST の形が変わる** — K2 の条件は既知の形だけを受け付けるので、形が変わった入力は本文を残す側（誤検知が戻る側）に倒れる。逆に、本文の終端の読みが変わって本文を過大に空にする向きは、K1 の `hasError` と K2 (e) で抑える。→ plan-1 のテストで、K2 の各条件の受け付ける形と受け付けない形を入力ごとの表で固定する。このテストは `home/dot_claude/hooks/tests/unit/` にあり、tree-sitter-bash の更新はルートの `bun.lock`（`home/dot_claude` は workspace）を変えるので、`ci-typescript.yml` の paths フィルタに当たり `bun run test` が走る
- **R3: 本文を外した入力に、新たな deny / ask が出る** — 本文を空にした `cat <<'EOF' > out.txt` ⏎ `EOF` は、従来の全文の断片より語が少ないだけなので、新しい語は増えない。→ plan-2 のテストで、本文を外す入力の各 hook の判定が deny / ask から無判定に変わること、書き込み先の判定（`> node_modules/x` の deny、Gate 閉時の `> src/x.ts` の deny）が残ることを確かめる
- **R4: ユーザーのシェル（zsh）と bash で heredoc の読み方が違う** — 引用符付きの区切りで本文を展開しないこと、引用符の無い区切りで `$` とバッククォートを展開することは両者で同じである。K2 (e) は引用符の無い本文に `$` もバッククォートも無い場合だけを受け付ける。→ 追加の対処は不要。zsh で `<<EOF` をコマンド無しで書く形（`$READNULLCMD` が本文を読む）は K2 (a) の消費者に当たらないので本文を残す
- **R5: 入力ごとの parse が 1 回増える** — 各 hook は `extractCommandsStructured` の中ですでに tree-sitter で parse している。`maskDataHeredocBodies` は heredoc を含まない入力では parse の前に原文を返す（`<<` を含まない入力は対象が無い）。→ plan-1 で、heredoc を含まない入力は parse を呼ばないことをテストで固定する
- **R6: F3a の allow 側のテストを緩めない**（F3a spec R9） → plan-2 の受け入れ基準に、`safe-command-list.test.ts`・`auto-approve.test.ts`・`permission-auto-approve.test.ts` の既存テストを変更せずに通ることを入れる

## Phase 1 で意図的に提供しない体験

### heredoc の git commit の自動承認

- **代替経路確認**: `home/dot_claude/hooks/lib/safe-command-list.ts:1-10`（allow は全文の分割だけで決め、heredoc は null）。PermissionRequest の LLM evaluator（`permission-llm-evaluator.ts`）と Claude Code 本体の確認が後段にある
- **非提供対象**: `git commit -m "$(cat <<'EOF' …)"` を hook が allow すること
- **将来の予定**: 本 session のユーザー判断で、別の follow-up として扱う。allow 側の設計（hook の読みと、zsh / bash 3.2 の読みの一致の検証）が要る

### commit / PR の本文の経路

- **代替経路確認**: 本文に削除語や `node_modules` を含む commit / PR は、従来どおり deny-node-modules の deny・auto-approve の ask を受ける（変更前と同じ）。本文を含まない短い `git commit -m "…"` は影響を受けない。本文をファイルに書く経路は cat / tee（本 spec）で誤検知が解消するので、`cat <<'EOF' > .tmp/msg.txt` ⏎ 本文 ⏎ `EOF` の後に `git commit -F .tmp/msg.txt` とする形は、1 つ目の文の本文が判定から外れる（2 つ目の文に本文は無い。Round 7 logic-validator がプローブで確認し、plan-2 T6 で実 hook でも確かめる）。解消するのは本文に由来する deny / ask だけで、Gate 閉時の document-workflow-guard による書き込み先の判定と、git commit そのものの確認は従来どおり出る
- **非提供対象**: `git commit -m "$(cat <<'EOF' …)"`、`gh … --body "$(cat <<'EOF' …)"`、`git commit -F - <<'EOF'`、`gh pr|issue create|edit|comment --body-file - <<'EOF'` の本文を判定から外すこと
- **将来の予定**: 本 session のユーザー判断で、別の spec「commit / PR 本文の経路」にする。stdin 形への誘導・heredoc commit の allow・sink の deny 側の緩和を一体で設計し、sink の一覧は git / gh の版を固定した `reason` を持ち、選択肢の許可リスト（`-e`/`--edit` の除外）、`GIT_EDITOR`・`.git/hooks`（`prepare-commit-msg` は `--no-verify` でも動く）・`core.hooksPath`・`GIT_CONFIG_PARAMETERS` の経路を R1 と同じ水準で整理する。F3b の Round 5・6 の実測（`reframer-review.spec.md` と Reviewer Outputs）を引き継ぐ。追跡は `.tmp/docs/issue-boundary-deny-false-positives.md` に項目として足す（plan-2 T5）

### リダイレクト付き複合文の丸ごとの断片

- **代替経路確認**: `home/dot_claude/hooks/tests/unit/bash-parser.test.ts:449-468`、`deny-node-modules.test.ts:468-472`（F3a で既知の誤検知として記録済み）
- **非提供対象**: `(rm foo; ls node_modules) 2>&1` のように、base の分割が複合文を 1 断片で返し、別コマンドの削除語と `node_modules` が組になる誤検知の解消
- **将来の予定**: 本 session のユーザー判断で、別の follow-up として扱う。原因が base の分割にあり、heredoc の本文とは独立している

### herestring とインタプリタのインライン引数

- **代替経路確認**: `cat <<< "…"` は全文の read-only 除外で deny されない（research §2）。インタプリタの引数（`bun -e`、`python3 -c`）と本文はユーザー判断で判定に残す
- **非提供対象**: herestring の語と、インタプリタへのインライン引数を判定から外すこと
- **将来の予定**: herestring は語としてコマンド行の一部であり、本文のような構文上の範囲を持たないので、恒久的に対象外。インタプリタは恒久的に判定に残す

## ISO 25010 次元選択

- **機能適合性（機能正確性）**: K2 の各条件で、本文を外す入力と残す入力が入力どおりに分かれること。research §2 の太字の誤検知のうち cat / tee の形の行が deny / ask にならないこと（`git commit -m "$(cat <<'EOF' …)"` の行は従来どおり deny で、別の spec で扱う）。`cat <<'EOF' > .tmp/msg.txt` ⏎ 本文 ⏎ `EOF` ⏎ `git commit -F .tmp/msg.txt` の形で、本文に由来する deny / ask が出ないこと（Gate 閉時の書き込み先の判定と、git commit そのものの確認は従来どおり）
- **セキュリティ（完全性）**: 本文を実行する形（シェル・インタプリタ・パイプ・同じ行の後続・消費者より前の文でシェルの状態を変える形（K2 (f) の許可リストの外のノードの種類、不活性でない builtin）・出力先のプロセス置換と fd・行の連結による終端のずれ・`$(…)` に渡す形・git / gh に渡す形・演算子や隙間に AST が報告しない綴りがある形）は本文が判定に残ること。3 つの hook の allow が増えないこと（K4）
- **保守性（修正性）**: 消費者の一覧が 1 か所の定数にあり、足す根拠が書かれていること。deny 側の入口が `prepareDenyInput` 1 つで、3 つの hook が `extractCommandsStructured` を直接使わないこと
- **対象外**: 性能効率（parse は heredoc を含む入力でだけ 1 回増える。R5 のテストで heredoc を含まない入力の追加コストが無いことは固定する）、使用性・互換性・信頼性・移植性（hook の入出力の形は変えない）

## Approval

- Plan Status: complete
- Review Status: pass
- Approval Status: approved

## Reviewer Outputs (Round 1)

### logic-validator

- verdict: needs-work
- 主指摘: K2 (b)(d) は出力先のリダイレクトの宛先を検査しない。`cat <<'EOF' > >(bash)`（宛先がプロセス置換）、`exec 3> >(bash); cat <<'EOF' >&3` は全条件を満たし、本文が実行される（実測）。K4 は「hook の allow」に限定して書き、auto-approve の範囲に絞る。R1 に同時実行（`bash p & cat … > p`）を足す

### scope-justification-reviewer

- verdict: pass
- 主指摘: sink の gh 系は research に再現が無い。決定ログの件数（`<<` を含む記録で git commit 163、tee 41、gh pr create 7、gh issue 10、gh pr edit 3、gh pr comment 1）を根拠に書くか、create に絞るか、「同じ body 引数を取る」と束ねる根拠を書く

### decision-quality-reviewer

- verdict: pass
- 主指摘: 支配軸（リスク）と整合。advisory: R1 の受容を ADR に記録する。一覧を足す基準を定数のコメントに残す。K2 の固定テストが依存更新 PR で走ることを受け入れ基準にする

### greenfield-perspective-reviewer

- verdict: pass
- 主指摘: 白紙案に近い。advisory: 3 か所で個別に mask を適用するので、適用漏れを防ぐ一点の入口かテストを置く。対象が 3 hook だけであること、本文の綴りに当たり続ける hook を明記する

### architecture-boundary-analyzer

- verdict: needs-work
- 主指摘: deny 側の単一の入口（mask と断片の抽出を不可分にする `prepareDenyInput`）を置き、raw / masked の取り違えを構造で防ぐ。K2 の消費者・sink の一覧は deny のポリシーなので、bash-parser.ts から別モジュールに分ける。file-access-guard の非対称を明記する

### security-vulnerability-analyzer

- verdict: needs-work
- 主指摘: (1) 宛先の未検査（`cat > >(sh) <<'EOF'`、`cat >&3`、`/dev/fd/3`、形 B の cat の redirect）を bash 3.2 と zsh で実測。(2) 引用符の無い区切りで `EO\`⏎`F` と書くと、シェルは連結して `EOF` で閉じるが tree-sitter は閉じず、次の行の実行されるコマンドを本文として消す。(e) で `\` も除く。(3) (f) は網羅できない（eval・hash・PATH・source）。衛生的な除外と書き、R1 に含める。(4) 形 B は `string` の親に限る

### data-contract-evolution-evaluator

- verdict: needs-work
- 主指摘: 戻り値は raw と同じ string なので allow 側に渡しても型で検出できない。JSDoc とテストで守る。`isExemptReadOnlyCommand` の JSDoc（全文を受ける前提）を更新し、空にした入力での除外判定を表で固定する。pattern-matcher の deny ルール照合は空にした断片に当たることを明記する。冪等性のテストを足す

<!-- auto-review: pending -->
<!-- intent-triage: pending -->

## Reviewer Outputs (Round 2)

### logic-validator

- verdict: pass
- 主指摘: Round 1 の指摘は解消。(a)〜(g) で 1 文の中で本文が実行される形は見つからない（区切りの綴り約 20 通りを bash 3.2 / zsh で実測）。軽微: K1 の「再 parse で hasError にならない」は raw が hasError のときは成り立たないので条件を書く。(g) の `/dev/` は前置一致で `//dev/fd/3` が通る。tee の引数に (g) が当たらない

### scope-justification-reviewer

- verdict: needs-work
- 主指摘: 分割・条件・テストは観測と fail-open の指摘に釣り合う。軽微: (f) の各項目が (g) で閉じていない何を閉じるかを 1 行ずつ書く。R1 / K5 に「LLM evaluator が本文を読む前提が変わったら受容を再評価する」を足す。file-access-guard の issue 記録への追記を plan のタスクに入れる

### decision-quality-reviewer

- verdict: pass
- 主指摘: 支配軸（リスク）と整合。advisory: ADR の追記で、1 入力で書きと実行がそろう形（fifo、eval の差し替え）を Write 経由と別項目に書く。K5 の判断を Executive Summary に出す

### greenfield-perspective-reviewer

- verdict: pass
- 主指摘: 白紙案と採用案は heredoc に限った時点で同じ形に収束する。advisory のみ（引数の役割モデルと (f) の網羅性は根拠付きで受容済み）

### architecture-boundary-analyzer

- verdict: pass
- 主指摘: Round 1 の指摘は解消。advisory: import 禁止のテストは `command-parsing.ts` の再 export も対象にする。deny ルール照合の入力が `individualCommands` 由来であることを 1 件固定する

### security-vulnerability-analyzer

- verdict: needs-work
- 主指摘: `coproc sed …` ⏎ `cat <<'EOF' > //dev/fd/14` で本文が coproc に流れる（zsh で実測）。(g) は `/dev/` の前置一致で `//dev/`・`/./dev/`・`../dev/` が通り、tee のファイル引数は検査されず、`coproc` は (f) に無い。zsh の `functions[cat]=…` も (f) をすり抜ける。(g) を文字種の許可リストとパスの区切り単位の判定にし、tee の引数にも当て、(f) に coproc と zsh の特殊連想配列への代入を足す

### data-contract-evolution-evaluator

- verdict: pass
- 主指摘: Round 1 の指摘は解消。advisory: import 禁止の対象に `heredoc-data.ts` も入れる。`pattern-matcher.ts:79` の「extractCommandsStructured を使え」のコメントに対し、deny 側は `prepareDenyInput` を使うと JSDoc に書く

<!-- auto-review: verdict=needs-work; hash=4e6d75c31115e9c1a504f91e029bc301d4df2899a856b9231bf1a9ee86c610b7; design-hash=4101df95a14ec6a181087736d472c0ca78d49e0d7657d465d14ebeb634d98efa; round=1; at=2026-10-02T03:34:31.087Z; reviewers=logic-validator+scope-justification-reviewer+decision-quality-reviewer+greenfield-perspective-reviewer+architecture-boundary-analyzer+security-vulnerability-analyzer+data-contract-evolution-evaluator -->
<!-- intent-triage: adopted=16; excluded=1; at=2026-10-02T03:35:04.056Z -->

## Reviewer Outputs (Round 3)

### logic-validator

- verdict: pass
- 主指摘: Round 2 の指摘は解消。Experience Delta の入力（`> out.txt`、`tee out.txt`、git commit、list の右端、`dev` などを要素に持たない絶対パス）は本文が空になる。軽微: `dev`・`proc`・`fd` という名前の正当なディレクトリ、`~`、`/dev/null` への書き込みは本文が残ることを注記し、テスト表に 1 件入れる。(f) の exec・coproc の説明を「多層防御」と書き直す

### scope-justification-reviewer

- verdict: pass
- 主指摘: Round 2 の 3 点は解消。軽微: K5 に R1 の再評価条件への参照を 1 行足す

### decision-quality-reviewer

- verdict: pass
- 主指摘: 支配軸（リスク）と整合。advisory: plan-1 の入力表で条件と経路を 1 対 1 に固定する。R1 の再評価条件を ADR の追記にも転記する

### greenfield-perspective-reviewer

- verdict: pass
- 主指摘: 退行なし。advisory: (f) に足すときの基準を定数のコメントに残す

### architecture-boundary-analyzer

- verdict: pass
- 主指摘: 拡張は `heredoc-data.ts` 内に閉じ、依存は一方向のまま。plan-2 で import 禁止の対象に `command-parsing.ts` 経由と `heredoc-data.ts` を含める

### security-vulnerability-analyzer

- verdict: blocker
- 主指摘: (e) の欠陥。`cat <<E""OF > f` ⏎ `EOF` ⏎ `echo PWN` ⏎ `E""OF` で、シェルは引用符を除いた `EOF` で閉じて `echo PWN` を実行するが、tree-sitter は `E""OF` まで本文とみなす（bash 3.2・zsh で実測。`<<E'O'F`、`<<"E"OF`、`<<EO'F'`、区切りにタブ、tee、形 B も同型）。区切りを `'X'`・`"X"`・`X`（X は `[A-Za-z0-9_]+`）の許可リストで判定し、`heredoc_end` が引用符を除いた区切りと一致することを条件にする。P2: macOS は大文字小文字を区別しないので `/DEV/fd/14` が (g) を通る。要素を小文字にして比べる

### data-contract-evolution-evaluator

- verdict: pass
- 主指摘: インターフェースへの影響なし。plan-2 で import 禁止の対象を広げ、deny ルール照合の入力を 1 件固定する

<!-- auto-review: verdict=needs-work; hash=68085341cd33a10ab5e28c95246212a0281ce0d74279498792ef06f80fa95b40; design-hash=04820023361f7e783ec3e2428518bcca6049af39e1701125cff5aa44707cc88c; round=2; at=2026-10-02T03:42:53.267Z; reviewers=logic-validator+scope-justification-reviewer+decision-quality-reviewer+greenfield-perspective-reviewer+architecture-boundary-analyzer+security-vulnerability-analyzer+data-contract-evolution-evaluator -->
<!-- intent-triage: adopted=12; excluded=0; at=2026-10-02T03:42:53.288Z -->

## Reviewer Outputs (Round 4)

### logic-validator

- verdict: pass
- 主指摘: Round 3 の修正は他の条件・Experience Delta と矛盾しない。`<<'EOF'`・`<<"EOF"`・`<<EOF`・`<<-` で heredoc*start / heredoc_end は (e) の想定どおり（`<<-` の閉じ行のタブは body の末尾に入り heredoc_end には入らない）。閉じ行の読みのずれはすべて tree-sitter が早く閉じる安全側。軽微: Experience Delta に「区切りは英数字と `*`」と書く。plan-1 に `<<-'EOF'` とインデントされた閉じ行の行を足す（反映済み）

### scope-justification-reviewer

- verdict: pass
- 主指摘: Round 3 後の 3 変更はいずれも実測に基づき範囲内。軽微: plan-1 に `<<-EOF` を 1 件入れる（反映済み）

### decision-quality-reviewer

- verdict: pass
- 主指摘: 支配軸（リスク）と整合。根は「AST の解釈をシェルの解釈の代用にしている」ことで、条件を綴りの許可リストへ移す方向で収束している。advisory: 1 文で本文が実行される形は blocker、(f) の列挙漏れ（複数文の差し替え）は R1 の advisory として扱う基準を持つ

### greenfield-perspective-reviewer

- verdict: pass
- 主指摘: 新しい野心ギャップは無い。軽微: `<<-` と末尾空白の閉じ行を plan-1 の表に固定する（反映済み）

### security-vulnerability-analyzer

- verdict: blocker
- 主指摘: Round 3 の指摘は閉じた。形 A は plan-1 T3 の移植と実シェルで手書き約 50 入力・機械生成 3,240 入力を検証し、本文が実行される入力は 0 件。新しい欠陥は形 B: bash 3.2 は `$(…)` の範囲を heredoc を理解しない括弧の対応で切り出すので、`git commit -m "$(cat <<'EOF'` ⏎ `x)"; echo EXEC; #` ⏎ `EOF` ⏎ `)"` で bash 3.2 だけが `echo EXEC` を実行する（zsh・bash 4 以降・tree-sitter は本文と読む）。gh・素の区切り・`"EOF"` でも同じ。修正案は、形 B の本文から `( ) ' " ` \ $` を除く、bash 3.2 の対応の取り方を模擬する、形 B をやめる、のいずれか

<!-- auto-review: verdict=blocker; hash=81f06f88643fb9c893dffcc691fdc54d621c6aedc8f4af4f52c389f02531dfb8; design-hash=dcdef9c940e57173ea57171212e0d62a00ebcd8bd7e541c9044c116d862b6326; round=3; at=2026-10-02T03:49:35.443Z; reviewers=logic-validator+scope-justification-reviewer+decision-quality-reviewer+greenfield-perspective-reviewer+architecture-boundary-analyzer+security-vulnerability-analyzer+data-contract-evolution-evaluator -->
<!-- intent-triage: adopted=11; excluded=0; at=2026-10-02T03:49:35.461Z -->

## Reviewer Outputs (Round 5)

### logic-validator

- verdict: pass（初回は needs-work。指摘を反映した文書への再実行で pass）
- 主指摘: 初回: tree-sitter-bash は `<<` の直前の単独の `-` を `command` の子から落とす（`git commit -F - <<'EOF'` の command は `git commit -F`。main loop でも実測）ので、`isStdinSink` が `-F -` に一致しない。`number` が引数の型に無い。R1 に形 B の例が残る。再実行: 3 件とも解消し、plan-1 の擬似コードと scratchpad の probe は同一で 97 件 PASS、追加 50 入力で想定外の空にする判定は 0 件。軽微: 番号 2 つ・create に番号・`-S`・`2>&1`・`--title=t`・`-F -<<` の行を表に足す
- 再実行（修正後の文書）: scope-justification・decision-quality・greenfield も pass（advisory: gh の値付き選択肢の綴りの行、引数の役割モデルへ広げる再評価のきっかけを定数のコメントに書く）

### scope-justification-reviewer

- verdict: pass
- 主指摘: 範囲は一貫。軽微: 決定ログの件数は `$(…)` 形のもので stdin sink の需要の証拠ではない（`-F -` 等を含む Bash の記録は 5 件）。根拠はユーザー判断と書く。`-F -` 形への誘導の担い手が F3b に含まれるかを明記する

### decision-quality-reviewer

- verdict: pass
- 主指摘: 形 B を外したのは支配軸（リスク）を優先した正しい向き。advisory: 「commit / PR 本文の解消は `-F -` 形に切り替えたときだけ効く」を 1 行足す。採用案に形 B を外した経緯を 1 行置く。sink の根拠を確認した版を定数のコメントに書く

### greenfield-perspective-reviewer

- verdict: pass
- 主指摘: 新しい野心ギャップは無い。advisory: stdin sink の各綴りの一致形と、引数が混ざる形の不一致をテスト表に 1 件ずつ入れる

### architecture-boundary-analyzer

- verdict: pass
- 主指摘: 依存は一方向で循環なし。advisory: 依存図に `deny-input → bash-parser`（`extractCommandsStructured`）を足す。import 検査は `command-parsing.ts` 経由と動的 `import()` も対象にする。`git -c … commit -F -` の不一致を表に入れる

### security-vulnerability-analyzer

- verdict: needs-work
- 主指摘: `export GIT_EDITOR=sh` ⏎ `git commit --file=- -e <<'EOF'` ⏎ `touch …` ⏎ `EOF` で、本文が空にされたうえで git が `COMMIT_EDITMSG` を editor の `sh` に渡して実行する（bash 3.2・zsh で実測。`--edit`・`-qe` も同じ）。sink の引数を許可リストにし、`-e`/`--edit` と列挙外の語は一致させない。`-` の脱落は gap（command の終わりから次のリダイレクトまで）を綴りで見て直す。gh の alias・`-e`・git alias に実行経路は無く、約 13,500 入力の生成テストで他の穴は 0

### data-contract-evolution-evaluator

- verdict: needs-work
- 主指摘: K1 のシグネチャに plan-1 の注入用の第 2 引数を書く。import 検査は固定の 3 ファイルなので「4 つ目の適用漏れを検出」より弱い（`implementations/*.ts` を走査する）。ADR 追記は README を参照せず自己完結させ、旧文「誤検知は残る」も直し、`$(…)` を扱わない理由・(f) が衛生的除外であること・一覧の統制を書く。sink に根拠フィールドを必須で持たせる。`text` を名前で raw と区別する。`--file -`・`--body-file=-` の行を表に足す

<!-- auto-review: verdict=blocker; hash=207c4bb65cf1e020a6972138848cad3c22d0e32e7de55d9dff79d244c0657d66; design-hash=dfc308b42c4acff99d68cc3818cadb0bef44f6ad852cf6d7d3acb2fd15510659; round=4; at=2026-10-02T04:11:35.450Z; reviewers=logic-validator+scope-justification-reviewer+decision-quality-reviewer+greenfield-perspective-reviewer+security-vulnerability-analyzer -->
<!-- intent-triage: adopted=7; excluded=0; at=2026-10-02T04:11:35.470Z -->

## Reviewer Outputs (Round 6)

### logic-validator

- verdict: needs-work
- 主指摘: 文書の追記で直る軽微な不足。spec の Experience Delta / R3 が言う「Gate 閉時の `> src/x.ts` の deny が残る」の行が plan-2 T3 に無い。Round 4 の記録が「反映済み」とした `<<-EOF`（引用符なし）と末尾空白の閉じ行の行が表に無い。K2 が挙げる不一致形のうち `<`・`"cat"`・cat のプロセス置換と展開の引数の行が無い（いずれも反映済み）

### security-vulnerability-analyzer

- verdict: blocker
- 主指摘: Round 5 の穴（`-e` の空白あり、`--edit`、`-F - -e` など）は閉じた。新しい穴: tree-sitter は `<<` に空白なしで付いた `-e` などを演算子のトークンに取り込み（綴り `-e<<`）、command にも隙間にも現れないので、`export GIT_EDITOR=sh` ⏎ `git commit --file=- -e<<'EOF'` で本文が実行される（bash 3.2・zsh、`-ae<<`・`-ae<<-` も同じ。fuzz の穴 6 件はすべてこの種類）。演算子の綴りを `<<`・`<<-`・`-<<`・`-<<-` に限る。P2: 前の文で `.git/hooks/prepare-commit-msg` を書く形は R1 の例に足す。許可リストの各選択肢（`--amend`、`--no-edit`、gpg 署名の設定など）では editor は起動せず、gh の値付き選択肢にも実行経路は無い
- 反映後の確認（main loop）: 演算子の綴りの許可リストを擬似コードに入れ、plan-1 の表は 116 件 PASS。security の fuzz（seed 7・11、各 1,200 件、bash 3.2・zsh で実行）で穴 0 件

### data-contract-evolution-evaluator

- verdict: pass
- 主指摘: Round 5 の 4 点（K1 のシグネチャ、全 implementations の走査、ADR の自己完結と旧文の修正、表の行）と `reason` の必須・`maskedText` は解消。advisory: plan-2 の保守性の行を全走査に合わせる（反映済み）

### scope-justification-reviewer

- verdict: pass (carried from Round 5)
- 主指摘: Round 5 で pass、再実行なし

### decision-quality-reviewer

- verdict: pass (carried from Round 5)
- 主指摘: Round 5 で pass、再実行なし

### greenfield-perspective-reviewer

- verdict: pass (carried from Round 5)
- 主指摘: Round 5 で pass、再実行なし

### architecture-boundary-analyzer

- verdict: pass (carried from Round 5)
- 主指摘: Round 5 で pass、再実行なし

<!-- auto-review: verdict=needs-work; hash=d958a71c45d9f0a7a54896c988f01268002b0e5ed52b3b85d5d3bac22d83a89a; design-hash=11f661c14ad700893e817d7c6bf0b5756e00dc169750e2750931548d00fc7563; round=5; at=2026-10-02T05:07:20.444Z; reviewers=logic-validator+scope-justification-reviewer+decision-quality-reviewer+greenfield-perspective-reviewer+architecture-boundary-analyzer+security-vulnerability-analyzer+data-contract-evolution-evaluator -->
<!-- intent-triage: adopted=21; excluded=0; at=2026-10-02T05:07:36.124Z -->

## Reviewer Outputs (Round 7)

（stdin sink を外して cat / tee に絞り、K2 を不変条件の形にした後の full round。ユーザーが延長を承認）

### logic-validator

- verdict: pass
- 主指摘: sink の残骸は本文・plan に無く、Goal〜ISO と plan-1 の表・plan-2 の行は cat / tee の範囲で一致。`cat <<'EOF' > .tmp/msg.txt` → `git commit -F .tmp/msg.txt` の迂回路はプローブで確認。軽微: 解消するのは本文由来の deny / ask だけと添える（反映済み）

### scope-justification-reviewer

- verdict: needs-work
- 主指摘: 絞り込みは根拠・オーダー適合とも妥当で scope drift 0 件。ただし ISO と plan-2 T6 が「research §2 の太字」を受け入れ基準にしていて範囲外の git commit 行を含む。Experience Delta の変更前に解消しない git commit 例がある。cat 形の件数が無く、迂回路が実 hook で未検証（いずれも反映済み）

### decision-quality-reviewer

- verdict: pass
- 主指摘: 検証できない表面（git / gh の意味論）を切り離した再構成はリスク軸と整合。advisory: (b)(c)(d) は構造の判定で不変条件の外であることを書く、`-` を受け付ける理由を書く、cat の件数、別 spec の追跡先を issue 記録に置く（反映済み）。実シェルとの差分を回帰テストとして残す件は、fuzz が実シェルの起動を要し unit テストに載らないので、表の行として固定する方針のまま

### greenfield-perspective-reviewer

- verdict: pass
- 主指摘: 白紙設計と同形で新しい野心ギャップなし。advisory: (b)(c)(d) が構造側である理由を 1 行書く、cat の件数と別 spec の記録先を具体化する（反映済み）

### architecture-boundary-analyzer

- verdict: pass
- 主指摘: 依存は一方向、ポリシーは `heredoc-data.ts` に閉じる。advisory: テスト用の export を明示する（反映済み）、`pattern-matcher.ts:345` の動的 import は lib 側なので adoption test の対象外で、deny ルール照合が `individualCommands` 由来であることは plan-2 T2 の行で固定する

### security-vulnerability-analyzer

- verdict: needs-work
- 主指摘: cat / tee の heredoc の構造には穴なし（終端・末尾・隙間の表で計約 8,000 入力、fuzz 複数 seed で 0 件）。K2 (f) の差し替え検出が command_name の綴りだけを見るので、`builtin eval 'cat() { sh; }'`・`command eval …`・`f=eval; $f …`・`$(echo eval) …`・`printf -v X %s eval; $X …` の後の `cat <<'E'` で本文が実行される（bash 3.2・zsh）。ファイルを書かない 1 入力の形なので R1 で受容できない
- 反映後の確認（main loop）: (f) を、差し替え名を全語で引用符を外して比べる、前置コマンド（`builtin`・`command`・`noglob`・`nocorrect`・`time`・`-`・`.`）と綴りでない command_name で本文を残す、に広げた。plan-1 の表は 99 件 PASS、security の再現プローブは 9 件 → 0 件、fuzz（r7sec seed 5、r6sec seed 23）で 0 件

### data-contract-evolution-evaluator

- verdict: pass
- 主指摘: DenyInput・冪等性・失敗時の raw・連続範囲の除去は実装とテストで固定されている。advisory: ADR-0020 の 41 行目も直す、36 行目は heredoc ではない例を残して分ける、別の文の 2 つの heredoc の行を足す（反映済み）

<!-- auto-review: verdict=blocker; hash=dcc581d0966a53cc805d2089e6cf8e844d33f8e7c59d1119a7a5b69fda1a3e53; design-hash=7fee517b377d210628ebf2a9d4ec002bb74f3221553878ccc5a882a25e56a438; round=6; at=2026-10-02T05:16:07.536Z; reviewers=logic-validator+security-vulnerability-analyzer+data-contract-evolution-evaluator -->
<!-- intent-triage: adopted=7; excluded=0; at=2026-10-02T05:16:07.571Z -->

## Reviewer Outputs (Round 8)

### logic-validator

- verdict: pass
- 主指摘: Round 7 の反映は整合。advisory: (f) が多めに本文を残す形（`command -v x && cat`、`~/bin/x; cat`、`docker exec`）を Experience Delta の「変わらないもの」に書き、表に 1〜2 行足す（反映済み）

### scope-justification-reviewer

- verdict: pass
- 主指摘: 範囲は cat / tee に一貫。軽微: 決定ログの件数（276・183）が再集計（342・30・25）と合わない。定義と時点を書いて直す（反映済み: 1 行目で数え直し 346・115・0・25）

### security-vulnerability-analyzer

- verdict: needs-work
- 主指摘: (f) の名前の列挙の外にある builtin で、1 つの入力の中で cat が差し替わる。`trap 'cat() { sh; }' DEBUG` ⏎ `cat <<'E'`（bash 3.2・zsh）、zsh の `emulate zsh -c 'cat() { sh; }'` で本文が実行される（再現 5 件）
- 反映後の確認（main loop、ユーザー判断 A）: (f) を名前の列挙から、bash 3.2.57・zsh 5.9 から取り出した builtin と予約語の一覧のうち「何も差し替えない少数」以外があれば本文を残す形に反転した。引数の語の走査はやめた。plan-1 の表は 104 件 PASS、security の再現プローブは 5 件 → 0 件、r7sec-swap 0 件、終端・末尾の表（計 8,260 入力）0 件、fuzz（r7sec seed 11、r6sec seed 13、各 1,500）0 件。r7sec-cases の 2 件は R1 で受容済みの `tee x.sh <<…` ⏎ `sh x.sh`（bash・zsh で各 1）

### decision-quality-reviewer

- verdict: pass (carried from Round 7)
- 主指摘: Round 7 で pass、再実行なし

### greenfield-perspective-reviewer

- verdict: pass (carried from Round 7)
- 主指摘: Round 7 で pass、再実行なし

### architecture-boundary-analyzer

- verdict: pass (carried from Round 7)
- 主指摘: Round 7 で pass、再実行なし

### data-contract-evolution-evaluator

- verdict: pass (carried from Round 7)
- 主指摘: Round 7 で pass、再実行なし

<!-- auto-review: verdict=needs-work; hash=c0e141e97886a0898e0b8538d81675b5222b4bc86f4abfc46b073e056a6c857e; design-hash=d45252ac19a9a43da16c19c62d08ed446ba1e93bb42c5edcc8d4aff907751feb; round=7; at=2026-10-02T05:43:36.121Z; reviewers=logic-validator+scope-justification-reviewer+decision-quality-reviewer+greenfield-perspective-reviewer+architecture-boundary-analyzer+security-vulnerability-analyzer+data-contract-evolution-evaluator -->
<!-- intent-triage: adopted=17; excluded=0; at=2026-10-02T05:43:36.140Z -->

## Reviewer Outputs (Round 9)

### logic-validator

- verdict: needs-work
- 主指摘: (f) の前提「外部コマンドはシェルの状態を変えられない」は、引数の展開が代入する形を見ていない。zsh で `echo ${functions[cat]:=echo}` ⏎ `cat <<'E'` で cat が差し替わる（実測）。`$((…))`・`[[ ${…:=…} ]]` も同種。予約語は tree-sitter では command_name に出ないので、`SHELL_WORDS` の予約語は効かない（`if …; fi; cat` が残るのは (c) による）

### security-vulnerability-analyzer

- verdict: blocker
- 主指摘: zsh 5.9 で、引数・代入の右辺・case の頭・`[[ ]]` の中の `${functions[cat]=sh}`・`${aliases[cat]:=sh}`・`${galiases[cat]=sh}` が cat を差し替え、1 つの入力で本文が実行される（7 入力で実測、bash 3.2 では再現せず）。修正案は展開のノードがあれば本文を残す。`SHELL_WORDS` は実シェルの一覧（bash 79 語、zsh 179 語）と照合して欠けなし。INERT の悪用、`for PATH in`・env 前置の代入は穴なし
- 反映後の確認（main loop）: (f) に「展開のノード（`expansion`・`simple_expansion`・`arithmetic_expansion`・`command_substitution`・`process_substitution`）または `((…))` があれば本文を残す」を足し、前提の文を直した。`:` を綴りのコマンド名に含めた。plan-1 の表は 111 件 PASS（展開の 7 行を追加）、security の再現（r9sec-a・r9sec-b・r8sec-a・r7sec-swap）、終端・末尾の表、fuzz（r7sec seed 17、r6sec seed 19、各 1,500）はどれも 0 件。決定ログ（2026-10-02T06:16Z 時点の残り）で 1 行目が `cat … <<` の 22 件のうち 21 件は本文が空になり、deny / ask の 5 件はすべて空になる

### scope-justification-reviewer

- verdict: pass (carried from Round 8)
- 主指摘: Round 8 で pass、再実行なし

### decision-quality-reviewer

- verdict: pass (carried from Round 8)
- 主指摘: Round 8 で pass、再実行なし

### greenfield-perspective-reviewer

- verdict: pass (carried from Round 8)
- 主指摘: Round 8 で pass、再実行なし

### architecture-boundary-analyzer

- verdict: pass (carried from Round 8)
- 主指摘: Round 8 で pass、再実行なし

### data-contract-evolution-evaluator

- verdict: pass (carried from Round 8)
- 主指摘: Round 8 で pass、再実行なし

<!-- auto-review: verdict=needs-work; hash=0409ee24d38d2c2c65293fd702769fd1ee83b2f4b844d2a4d572bb6243506023; design-hash=3deab3edcf1b2b5ba06a671536c6940b99d4160bb5e489713f39886181f8a660; round=8; at=2026-10-02T06:15:12.253Z; reviewers=logic-validator+scope-justification-reviewer+security-vulnerability-analyzer -->
<!-- intent-triage: adopted=3; excluded=0; at=2026-10-02T06:15:12.275Z -->

## Reviewer Outputs (Round 10)

### logic-validator

- verdict: needs-work
- 主指摘: Round 9 の (1)(3) は解消。予約語は command_name に出ないのに、K2 (f)・Experience Delta・R1・plan-1 のコメントが予約語を (f) の効果として書いている（反映済み。`if …; fi; cat` が残っていたのは `:` が綴りのコマンド名に入っていなかったためで、`:` を足した後は本文が空になることを実測）

### scope-justification-reviewer

- verdict: needs-work
- 主指摘: 決定ログの件数が 2 系統（115 件と 22 件）あり、定義と母数の説明がない。本文に `$` を含む引用符付きの heredoc が (f) の展開の規則に当たらないことが表で固定されていない（反映済み: 件数を 1 組に統一し、表に行を追加）

### decision-quality-reviewer

- verdict: needs-work
- 主指摘: 支配軸（リスク）とは整合。Alternative Approaches の「cat / tee の形は Round 3 以降 穴なし」が Round 7〜9 の (f) の穴と食い違う。K5 と plan-2 の「(f) は網羅しない衛生的な除外」が反転後の設計と食い違う（反映済み）。advisory: zsh の glob 修飾子のような、ノードにならない評価の形を実測する

### greenfield-perspective-reviewer

- verdict: needs-work
- 主指摘: 白紙案（入力全体を閉じた形で受け入れる述語）と採用案は同じ方向に収束している。Alternative Approaches に (f) の 3 案（名前の denylist、種類ごとの閉じた集合、入力全体の受け入れ述語）を書く。代入の判定だけが変数名の denylist のままで、`BASH_CMDS` などを取りこぼしうるので、代入はすべて本文を残す側にする。1 入力の形と R1 の受容の切り分けを明記する。後続の文も見ることを書く（反映済み）

### security-vulnerability-analyzer

- verdict: blocker
- 主指摘: Round 9 の修正は有効。新たに、`[[ 1 -eq PATH=0 ]]`（bash 3.2・zsh）と `a[PATH=0]=1`・`a=([PATH=0]=x)`（bash 3.2）が算術の評価で `PATH` を書き換え、`./0/cat` があると 1 入力で本文が実行される。zsh の glob 修飾子は現在 `hasError` か綴りでない名前で本文が残る（意図した防御ではない）
- 反映後の確認（main loop）: 代入（`variable_assignment`）をすべて、`[[ … ]]` を本文を残す側にした（`[ … ]` は算術を評価しないので受け入れたまま。実測済み）。変数名の列挙 `SWAPPING_VARIABLES` は削除。plan-1 の表は 118 件 PASS（算術 3 行、代入、glob 修飾子、引用符付きの本文の `$`、`if` の行を追加）。security の再現（r10sec-a・b・c、r9sec-a・b、r8sec-a、r7sec-swap）、終端・末尾の表、fuzz（r7sec seed 23、r6sec seed 29、各 1,500）はどれも 0 件。決定ログで 1 行目が `cat … <<` の 23 件のうち 22 件で本文が空になり、残る 1 件は本文がもともと空の入力

<!-- auto-review: verdict=blocker; hash=634a8fabaf794216facc8fd25ad63c69ee39524f6d5d6c18a3a4299bba4e23b5; design-hash=89b84c611875e550b1abb4cb1f6742802dc447da424d7fccda36affdd601c868; round=9; at=2026-10-02T06:22:27.361Z; reviewers=logic-validator+security-vulnerability-analyzer -->
<!-- intent-triage: adopted=4; excluded=0; at=2026-10-02T06:22:27.381Z -->

## Reviewer Outputs (Round 11)

### logic-validator

- verdict: pass
- 主指摘: 旧い記述の残りは履歴の節以外に無い。118 件と決定ログの内訳を再計算で確認。advisory: `INERT_SHELL_WORDS` の「変数を変えない」は `cd` の `PWD` があるので「cat の解決に効く」に限定する。README と ISO のセキュリティ欄の粒度が古い。(1) の round の数え方を明記する（反映済み）

### scope-justification-reviewer

- verdict: pass
- 主指摘: Round 10 の指摘は解消。軽微: 決定ログの測定時点の実装を明示する。`[ … ]`・`test` を受け入れる根拠に版を書く。bash 4.3 以降の `test -v 'a[…]'` は添字を算術として評価しうる（反映済み: `[ … ]`・`test` を受け入れない側にした）

### decision-quality-reviewer

- verdict: pass
- 主指摘: 支配軸と整合。advisory: Round 4〜6 の読みのずれが cat の条件にも取り込まれたことを書き分ける。(f) は構文の種類の報告に tree-sitter に依存することを K5 の前提と合わせる（反映済み）

### greenfield-perspective-reviewer

- verdict: needs-work
- 主指摘: 「(3) は (2) と効果が同じ」は実装と一致しない（外部コマンドを受け入れるのは builtin の閉じた一覧に対する差分）。最小案（cat / tee の 1 文だけ）との比較が無い（反映済み: Alternative Approaches を 4 案に書き直し、最小案は決定ログで 24 件中 6 件しか空にならないので却下と記録）

### security-vulnerability-analyzer

- verdict: blocker
- 主指摘: `ln -s /bin/sh cat; for PATH in .; do :; done; cat <<'E'`（bash 3.2・zsh）と zsh の `: {PATH}>/dev/null` で `PATH` が変わり、1 入力で本文が実行される。for 変数も名前付き fd も、代入・展開のノードとして報告されない
- 反映後の確認（main loop）: 危険なノードの種類を列挙する方式をやめ、受け入れるノードの種類の閉じた許可リストにした（Alternative Approaches (3)）。消費者でない文のリダイレクトと `{`・`}` を含む語も残す。後ろの文まで見ると決定ログで空になる入力が 8 件に落ちたので、見る範囲を消費者とそれより前の文に絞った。plan-1 の表は 127 件 PASS。security の再現（r11sec-a、r10sec-a・b・c、r9sec-a・b、r8sec-a、r7sec-swap）、終端・末尾の表、fuzz（r7sec seed 31、r6sec seed 37）はどれも 0 件。r7sec-cases は 6 件（`tee x.sh` ⏎ `sh x.sh` と、`mkfifo ff; sh ff & cat > ff`・`tee ff` を bash・zsh で各 1）で、どれも実行する文が判定に残る R1 の類。決定ログで 1 行目が `cat … <<` の 24 件のうち 23 件で本文が空になり、ask の 5 件はすべて空になる

<!-- auto-review: verdict=blocker; hash=e1f919df9d2d35d8a94c7233112ff79e24a2d39ad9df9c7ef7588888a2cf959c; design-hash=96206b1a036c58516a75a7f706d1a239825e91b8e2fd41d126c89c8aa08b4e73; round=10; at=2026-10-02T06:41:01.790Z; reviewers=logic-validator+scope-justification-reviewer+decision-quality-reviewer+greenfield-perspective-reviewer+security-vulnerability-analyzer -->
<!-- intent-triage: adopted=12; excluded=0; at=2026-10-02T06:41:06.248Z -->

## Reviewer Outputs (Round 12)

### logic-validator

- verdict: needs-work
- 主指摘: 方式変更（ノードの種類の許可リスト、見る範囲を前の文に）の理由の記録は妥当。後ろの文の前提は妥当だが、同じ行の後続は `hasError` で残ること、前提はシェルの状態に限りファイルシステム経由は別扱いであることを書く。`ln -sf /bin/sh ~/.local/bin/cat` ⏎ `cat <<'E'` は R1 の基準（実行する文が判定に残る）に当たらない。plan-1 のコメントが「入力全体を見る」のまま。後ろの文と後ろの heredoc の行を表に足す。plan-2 の ADR 文に列挙方式の言い回しが残る（反映済み）

### scope-justification-reviewer

- verdict: pass
- 主指摘: 範囲は一貫。軽微: 決定ログの件数がどの版の実装で測ったかを明記する（反映済み: Round 12 の反映後の実装で 25 件中 24 件と測り直した）

### decision-quality-reviewer

- verdict: pass
- 主指摘: 支配軸と整合し、記述は採用設計と一致。advisory: list の後ろの部分の規則は (c) により空なので整理する。`cd` は相対の書き込み先の実体を変えるが、既存の hook も宛先を相対のまま見る（反映済み: list の規則を削り、同じ行の後続の扱いに置き換えた）

### greenfield-perspective-reviewer

- verdict: pass
- 主指摘: 白紙で作り直しても採用案に収束する。plan-1 のコメントが古い範囲を述べている。見る範囲の 2 案を (3) の中の選択として明示する（反映済み）

### security-vulnerability-analyzer

- verdict: needs-work
- 主指摘: `ln -s /bin/sh <PATH 上の書けるディレクトリ>/cat` ⏎ `cat <<'E'` で本文が実行される（bash 3.2、`mv`・`chmod` との組み合わせも同じ。zsh は不発）。後ろの文の前提、許可したノードの中身、不活性な builtin は、実測でどれも穴なし
- 反映後の確認（main loop）: `ln`・`mv`・`chmod` を不活性な builtin から外した。外部コマンドや Write ツールで PATH 上に cat を置く形は、Write ツールでスクリプトを書いて実行するのと同じ水準として R1 に明記した。plan-1 のコメントを直し、表に 7 行（後ろの文、後ろの heredoc、同じ行の後続 2 つ、`ln`・`mv`・`chmod`）を足した。plan-1 の表は 134 件 PASS。security の再現（r12sec-a・b、r11sec-a、r10sec-a・b・c、r9sec-a・b、r8sec-a、r7sec-swap）、終端・末尾の表、fuzz（r7sec seed 41、r6sec seed 43）はどれも 0 件。決定ログで 1 行目が `cat … <<` の 25 件のうち 24 件で本文が空になり、ask の 5 件はすべて空になる

<!-- auto-review: verdict=blocker; hash=855a48bb4b9569f0493c70fafd7676001cc3a93aaef3ee81c62dd2ccdae7382d; design-hash=08cc0d2f920e7c8906ace7c0016e864bba3fd11ecaf1e9b5d7224b692914744c; round=11; at=2026-10-02T06:53:39.739Z; reviewers=logic-validator+scope-justification-reviewer+decision-quality-reviewer+greenfield-perspective-reviewer+security-vulnerability-analyzer -->
<!-- intent-triage: adopted=13; excluded=0; at=2026-10-02T06:53:39.760Z -->

## Reviewer Outputs (Round 13)

### logic-validator

- verdict: pass
- 主指摘: Round 12 の指摘はすべて解消。軽微: 決定ログの 6 件・8 件に測定の round を付ける、`(f): for variable` の行が `ln` で残ってしまい for を単独で固定していない、「Round 7〜11」を「7〜12」に、Experience Delta に同じ行の後続の例外を足す（反映済み。表は 134 件 PASS のまま）

### security-vulnerability-analyzer

- verdict: pass
- 主指摘: R1 の受容の外で、1 入力のうちに本文が空のまま実行される形は見つからなかった（新しい 22 形を bash 3.2・zsh 5.9 で実測。先行する heredoc の本文の展開、区切りの差、cat / tee のリダイレクト、`cd`。`ln`・`mv`・`chmod` は本文が残ることを確認）。PATH に相対の要素がある環境での `cd` は既存の環境の状態で R1 と同じ類

### scope-justification-reviewer

- verdict: pass (carried from Round 12)
- 主指摘: Round 12 で pass、再実行なし

### decision-quality-reviewer

- verdict: pass (carried from Round 12)
- 主指摘: Round 12 で pass、再実行なし

### greenfield-perspective-reviewer

- verdict: pass (carried from Round 12)
- 主指摘: Round 12 で pass、再実行なし

<!-- auto-review: verdict=needs-work; hash=a8d09fd1e863a627bd24b2be7c34280e9d2e42072db4b66fc0c6860bc07290cd; design-hash=a79e765536557203144ca87e6382e92db77236cc7b03a699e1280b81e40d3ed0; round=12; at=2026-10-02T07:06:19.981Z; reviewers=logic-validator+scope-justification-reviewer+decision-quality-reviewer+greenfield-perspective-reviewer+security-vulnerability-analyzer -->
<!-- intent-triage: adopted=11; excluded=0; at=2026-10-02T07:06:20.002Z -->

<!-- auto-review: verdict=pass; hash=6da0539b31f531a826332124d7c73cb6d4cec43e82b58e039287450f29b87c82; design-hash=f20ff97b117ce903355e1e687ef5ba2dafa9380da6fbdcd3f70fca2eafc50ad9; round=13; at=2026-10-02T07:10:19.030Z; reviewers=logic-validator+security-vulnerability-analyzer -->
<!-- intent-triage: adopted=4; excluded=0; at=2026-10-02T07:10:19.049Z -->
