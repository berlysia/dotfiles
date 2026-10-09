# ADR-0020: 境界 deny を別の綴りで回避させない

## Status

accepted (2026-10-02)

## Context

agent が `rm $W/node_modules`（自分で張った symlink の削除）を `deny-node-modules` に拒否され、理由を報告せずに `unlink` へ書き換えて実行した。`deny-node-modules` の削除判定は `(rm|rmdir)\s+.*node_modules` だけで、`unlink` は ask に落ち、PermissionRequest の LLM evaluator が「unlink is reversible」という誤った理由で許可した。home guard（`lib/command-parsing.ts`）の `find -exec` 用の動詞リストには `unlink` があり、2 つのリストが黙って分岐していた。

問題は 3 層にある。保護対象（依存の中身）を壊さない symlink 削除まで拒否した誤検知、動詞の列挙漏れ、拒否された agent が別の綴りで再試行する行動である。誤検知が言い換えの動機になり、言い換えが列挙漏れを通る。

設計の全文とレビューの記録は、この変更のセッションの spec と plan にある。ここには判断と却下した代替案を記す。

## Decision

支配軸はリスク（拒否の回避経路を閉じる）で、次に制約適合（新しい回避経路を作らない）である。deny は広く fail-closed にし、許可の例外は hook と shell の解釈が一致する形に限る。

- **K1（境界 deny と誘導 deny を分ける）**: 保護対象を持つ deny（`deny-node-modules` の Bash とファイル系ツール、`auto-approve` のセキュリティ判定 3 経路）だけに `BOUNDARY_DENY_GUIDANCE`（別のコマンド・ツール・言語で同じ効果を再試行せず、ユーザーに報告して止まる）を付ける。`block-tsx` のように代替手段を指示する誘導 deny と、内部エラーの deny には付けない。指示は agent が判断する瞬間に読む deny 理由に置く。機械的な強制ではない。
- **K2（削除を動詞の単語出現で判定する）**: 動詞を `lib/destructive-verbs.ts` の定数（`DELETE_VERBS` / `MOVE_VERBS` / `FIND_EXEC_FLAGS`）にまとめる。`node_modules` を含む個別コマンドに削除動詞が単語として現れれば deny する。単一の単純コマンドで先頭語が既知の read-only コマンドなら除外する（`grep rm node_modules/x` は allow）。`find` は位置を問わず認識し、`-delete` か、exec 系の後に削除・移動動詞があれば deny、それ以外の exec 系は ask にする。parser が fallback したときは、複合コマンドの断片に read-only の除外と allow を使わない。判定は `lib/node-modules-policy.ts` の純関数に置く。
- **K3（symlink 削除の例外を単独コマンドに限る）**: コマンド全体が `rm [-f]… <絶対パス>…` か `unlink <絶対パス>` で、メタ文字・変数・引用符を含まず、各オペランドの末尾セグメントだけが `node_modules` で、realpath を通さない `lstat` で symlink と確認できるときだけ、`deny-node-modules` は判定を出さない。複合コマンド内での削除は deny のままで、deny 理由が単独の `unlink` を案内する。
- **K4（evaluator）**: プロンプトで削除を不可逆と明記し、可逆性を ALLOW の根拠にさせない。
- **K5（run-guard）**: `deny-node-modules` を他の guard と同じく `run-guard.sh … || exit 2` で起動し、クラッシュ・bun 不在・タイムアウトを fail-closed にする。
- **K6（動詞リストの同期）**: home guard のコードは変えず、`FIND_DESTRUCTIVE_EXEC` と `FIND_EXEC_FLAGS` を export して、共有定数との差分が宣言済みの除外（`rmdir`）だけであることをテストで検査する。

### 却下した代替案

- **差分最小案（正規表現に `unlink` を足し、全 deny に一律の文言を足す）**: 誤検知が残って言い換えの動機が消えない。一律の文言は、代替手段を指示する誘導 deny（`block-tsx` の `Suggestion:`、`block-plan-mode` の移行先）と矛盾する。`unlink` を足すと `grep -rn unlink node_modules/x` を新たに deny する。
- **効果モデルで例外を一般化する（変数・`cd` を解決する walker で、複合コマンドの中の削除対象を解決する）**: レビューのたびに、hook の解釈と shell の実行がずれる穴（字句的な `cd` と物理的な `cd`、条件付き代入、walker と parser のセグメント対応、parser の fallback）が見つかった。home guard のコード約 600 行の移動も要り、2026-09-24 の事故の防御コードに回帰の危険を持ち込む。
- **代入とラッパーを除去して先頭語を特定する**: `git rm`、オプション引数付きのラッパー（`sudo -u root rm`、`timeout 5 rm`）、parser fallback の断片で、旧正規表現より deny が狭くなった。
- **deny の種類を型（判別共用体）にする**: `createDenyResponse` の全呼び出しの書き換えが要るが、誘導側の挙動は変えない。付け忘れは境界の deny 経路ごとのテストで検出する。

## Consequences

- **観測された回避は閉じた**: `unlink`・`shred`・`truncate`・`find -delete`・`find -exec <削除・移動動詞>`（ラッパー越し、引用符で崩した形を含む）は deny になる。
- **誤検知は残る**: 先頭語が read-only でないコマンドの引数に削除語が現れる場合（`echo rm node_modules`、`git commit -m "find -delete" node_modules`）は deny になる。fail-closed 側として受容する。誤検知が観測された先頭語は read-only の表に足す。heredoc の本文のうち、cat / tee がデータとして書くだけのものは F3b で判定から外した（下の追記）。commit / PR の本文（`git commit -m "$(cat <<'EOF' …)"` など）は残る（別の spec で扱う）。
- **対象外の削除経路**: インタプリタ経由（`python -c 'shutil.rmtree(...)'`）、`git clean`、`rsync --delete`、`cd node_modules && rm -rf *`、パイプ経由（`find node_modules | xargs rm`）、glob 綴りは、旧実装と同じく機械的には deny しない。インタプリタ・`git clean`・`rsync` は ask になり、K4 の evaluator と K1 のガイダンスがベストエフォートで補う。
- **再検討の条件**: 2 例目の綴りによる回避が観測されたら、解決済みパスで判定する効果モデルを再検討する。
- **反映**: `chezmoi apply` の後から効く。`deny-node-modules` は run-guard 経由になり、bun 不在やタイムアウトでも deny になる。
- **追記（F2、2026-10-02）**: read-only 先頭語の除外は `lib/read-only-command.ts` の `isExemptReadOnlyCommand` に移り、auto-approve の危険コマンド判定と共有された。判定は parser の断片ごとではなく Bash コマンド全文に対して 1 回だけ行い、引用符を解釈する走査で `$` は許可形だけを通し、先頭語は生の綴りで完全一致を求める。これに伴い deny-node-modules では次が変わった: 引用符内の区切り文字を含む read-only コマンド（`grep "a|rm" node_modules/x`）は deny されなくなった。`find` / `less` / `more` / `ll` / `la` 先頭、引用符やバックスラッシュ付きの先頭語（`\grep`）、複合コマンド中の read-only 断片（`ls node_modules; grep rm node_modules/x`）で削除語を含むものは deny になった。後者で、`find node_modules -ex$'e'c rm … $'\073'` のように ANSI-C クォートで `-exec` と終端を隠す回避（実測で通ることを確認）が閉じた。断片ごとの判定では、parser のメタコマンド抽出（`env PATH=x grep` を `grep` 断片に書き換える）や同じ行での先頭語の再定義（`grep() {…}; grep …`）で、hook が見る先頭語とシェルが実行するものが食い違ったため、全文判定にした。
- **観測された隣接問題**: 実装中に、scratchpad や `mktemp -d` の出力先が guard 間で矛盾して使えないこと、worktree で Document Workflow を使うときに guard と `workflow-cli status` のパス解決が食い違うこと、heredoc の本文が誤検知されることを観測した。別の Issue として扱う。heredoc の本文のうち cat / tee の範囲は F3b で解消した（下の追記）。
- **追記（F3b、2026-10-02）**: deny 側の hook（deny-node-modules・auto-approve の deny 段・document-workflow-guard）は `lib/deny-input.ts` の `prepareDenyInput` を通して Bash コマンドを読み、`lib/heredoc-data.ts` の `maskDataHeredocBodies` が、データとしてだけ使われる heredoc の本文を空にしてから判定する。削除の分類規則（`classifyDeletion`・`checkDangerousCommand`・`checkHomeDestruction`）は変えず、判定に渡すテキストからデータの範囲を除くだけなので、本 ADR の再検討の条件（2 例目の綴りによる回避）には当たらない（観測は誤検知で、回避ではない）。
  - **本文を空にする範囲**: 本文を受け取るコマンドが `cat` か `tee` で、次をすべて満たすものだけ。parser（tree-sitter-bash）は文の構造と本文の範囲を取るためだけに使い、heredoc に隣接するトークン（コマンドとリダイレクトの隙間、heredoc の演算子、区切り、終端、出力先）は綴りを許可リストと比べる。引数は展開を含まない語だけ。同じ行に後続が無い。付き先は消費者のコマンドか、右端が消費者の list。祖先は list と program だけ（`$(…)` の中は対象外）。区切りは `'X'`・`"X"`・`X`（X は英数字と `_`）で、引用符の無い区切りなら本文に `$`・バッククォート・`\` を含まない。出力先は `>` か `>>` で、`dev`・`proc`・`fd`・`..` を要素に持たない通常のパス。加えて、消費者の文とそれより前のトップレベルの文が、受け入れるノードの種類の閉じた許可リスト（普通のコマンド・リテラルの語・list・消費者の heredoc とリダイレクト）だけでできていて、builtin は不活性なもの（`:`・`cd`・`echo`・`mkdir` など）に限ること。判定できない入力は本文を残す。前提は builtin の一覧の版（bash 3.2.57・zsh 5.9）と、tree-sitter が構文の種類をノードの種類として報告することで、シェルの版を上げるときは一覧を取り直す。消費者を足すときは `HEREDOC_DATA_CONSUMERS` に `reason` を書き、この追記にも足す
  - **本文の綴りに当たり続ける hook**: file-access-guard・block-tsx・permission-auto-approve の静的判定・PermissionRequest の LLM evaluator は、本文を含む全文を読む
  - **commit / PR の本文を扱わない理由**: `$(cat <<'EOF' …)` で引数に渡す形は、bash 3.2 が `$(…)` を heredoc を理解しない括弧の対応で切り出し、本文の一部が実行される。stdin で渡す形（`git commit -F -` など）は、git / gh の選択肢・設定・hook（`-e` と `GIT_EDITOR`、`.git/hooks/prepare-commit-msg`）を通して本文が実行されうる。どちらも別の spec で扱う
  - **対象外として受容した類**: (1) Write ツールでファイルを書いてから実行するのと同じ水準のもの（本文を書いた後の行で実行する、本文を保存してから実行する）。(2) 1 回の入力で書きと実行がそろうので一段弱いもの（前の文で起動した読み手が名前付きパイプ経由で本文を読む形、外部コマンドや Write ツールで PATH 上に `cat` / `tee` という名前の実行ファイルを置き、その後の cat / tee の本文を実行させる形）。どちらも、F3b の前から Write ツールでスクリプトを書いて実行すれば得られる効果で、F3b はその水準を超えない
  - **受容の前提**: この受容は、LLM evaluator と上の hook が本文を含む全文を読むことを前提にする。後段にも本文を空にした入力を渡すように変えるときは、受容を再評価する。本 ADR の「2 例目の綴りによる回避」を数えるときは、これらの経路の観測も含める
- **追記（綴りの deny に何に当たったかを出し、案内を分ける、2026-10-06）**: 誤検知に当たった agent が、K1 の文言に従って毎回止まっていた。理由文は効果の名前（`Filesystem creation`、`delete operation not allowed on node_modules`）だけを言い、何の綴りに反応したかを言わないので、agent は誤検知かどうかを判定できなかった。判定は変えていないので、本 ADR の「2 例目の綴りによる回避」には数えない
  - **何に当たったかを出す**: 理由文から規則が読み取れない 3 系統（node_modules の削除語・`find`・`DESTRUCTIVE_NODE_MODULES_PATTERNS`、`DANGEROUS_COMMAND_PATTERNS` のうち deny になる規則）の理由文に `Matched: …` の行を足す。文言は規則の側に持たせ、「その行が出たときに必ず成り立つ事実」だけを書く。削除語は実際に当たった語を出す
  - **案内を分ける条件**: 拒否された断片のすべてに `Matched:` がある Bash の deny だけ、K1 の文言の代わりに `MATCHED_TEXT_DENY_GUIDANCE` を付ける。settings の deny ルール・home guard・parser の打ち切り・ファイル系ツールは K1 の文言のまま。これらは理由文が何に当たったかをすでに言っており、形を直して通すことは規則が禁じる効果を通すことになる
  - **分岐は当たった綴りの性質に置く**: 当たった綴りが実行するつもりのものの一部なら、K1 と同じく、言い換えも分割もせずに止まって報告する。渡しただけのデータ（検索パターン、commit メッセージ、cat / tee の heredoc の本文）なら、形だけを直して 1 回やり直してよい。直し方は、`;` / `&&` でつないだ各コマンドを変えずに別々の Bash 呼び出しで送るか、その文章を Write ツールでファイルに書いてコマンド自身のファイル指定で渡すかの 2 つ。シェル・インタプリタ・`eval`・`xargs`・`ssh`・`-c` に渡す文字列と、シェルが展開する場所（コマンド置換、プロセス置換）は、実行するものとして扱う。分岐を agent の意図の自己申告に置く案は却下した。K1 の起源の事故は、agent が効果を「symlink を消すだけ」と定義し直して起きたからである。起源の事故では、当たった綴り `rm` は実行するつもりのコマンドそのものなので、止まる側に入る
  - **K3 との関係**: 案内は別のコマンドを一切許さない書き方にし、理由文への参照で例外を作らない。理由文は agent が書いたコマンドを引用するので、参照は偽造の足場になる。単独の `unlink` の経路は、guard 自身が出す K3 の行に、その場合に限る例外だと書いて残す。`Matched:` を出す deny では、引用する断片の改行を `\n` に置き換えて 1 行にし、200 文字で切る。引用が guard の行のように見える行を作れず、長い commit メッセージで `Matched:` と案内が後ろに押し出されない
  - **開示の範囲**: `Matched:` は、当たった語と、規則が見る構造のうち語の種類（`-r` と `-f` 風のオプション、語頭の `/` や `$`）と、引用符の中も対象になることまでを言う。語の順序、行の区切り、境界の文字は書かない。`rm -rf` の 2 規則では、これは規則の条件の大半にあたる。規則はこのリポジトリのソースにあり agent は読めるが、判断の瞬間に読む理由文に規則の全条件は置かない
  - **位置づけ**: 文言による抑止で、機械的な強制ではない。K1 の無条件の「止まる」を、当たった綴りがデータの場合に限って緩めている。分類は agent が `Matched:` を読んで行う。連結を分けると各コマンドは単独のコマンドとして判定され、read-only の除外（追記 F2）が効くので、agent の分類だけで判定の経路が変わる。削除語が実行されるコマンドである断片は、分けても deny のままである
  - **取り下げの条件**: 形を直したやり直しで、拒否された効果そのものが通った例を観測したら、この追記の案内を取り下げて K1 の文言に戻す。観測の手段は事後にログを読むことだけで、deny の後の再試行を突き合わせる機構は無い。auto-approve には判定ログがあるが、deny-node-modules には無く、会話ログしか無い
  - **次の一手**: `Matched:` が出ても止まるしかなかった誤検知（当たった語が実行するコマンドで、対象は保護対象でないもの）が溜まったら、規則の側（parser の fallback での断片の切り方）を直す。取り下げの条件が発火したときは、guard が当たった範囲を返して案内を出し分ける案を再検討する。この案を今回採らなかったのは、規則の matcher が当たった位置を返さず、deny 側が heredoc の本文を空にしたテキストを読むので、位置が元のコマンドに対応しないためである
- **追記（ask の範囲、2026-10-09）**: `deny-node-modules` の ask（`Unknown node_modules operation requires approval`）が 16 日で 124 回出ていた。`node_modules` を変更しない 2 つの形で、hook が判定を出さないようにした。deny の規則と、インタプリタ・`git clean`・`rsync` を ask に残す決定は変えていない
  - **判定を出さない形**: `lib/node-modules-policy.ts` の `isNonModifyingShape` が true を返す断片。1 つは行の表示で、断片全体が `sed -n <N[,M]>p <パス>…` に一致するもの（オプションは `-n` だけ、スクリプトは数字と `,` と `p` だけ、パスは引用符・変数・`-` 始まりを含まない語）。もう 1 つはインストール済みツールの実行で、先頭語が `node_modules/.bin/<tool>` か `./node_modules/.bin/<tool>`、`<tool>` が `tsc`・`oxfmt`・`eslint`・`prettier`・`oxlint` のいずれかで、先頭語より後ろに `node_modules` の文字が無いもの
  - **置き場所と出力**: 削除・破壊パターン・`find -exec`・fallback の複合断片の判定をすべて通った後に見る。返すのは判定なし（無出力）で、allow ではない。Claude Code 本体の規則と auto-approve はそのまま働く
  - **`.bin` の許可規則**: hook が黙るだけでは、`.bin` の実行は後段で確認になる。`.settings.permissions.json` に、同じ 5 つのツールについて `Bash(node_modules/.bin/<tool> *)` と `Bash(./node_modules/.bin/<tool> *)` を足した。5 つとも別の綴り（`bunx tsc`、`pnpm oxfmt` など）が既に許可されている。hook の名前の一覧と許可規則は揃えておく。許可規則が無い名前で hook が黙ると、権限の緩いモードでは歯止めが無くなる
  - **前提**: この規則は、どの repo でも cwd の `node_modules/.bin/<tool>` を確認なしで実行する。clone した repo が改変した `.bin` を同梱していれば、それが実行される。`bunx <tool>` の規則で既に同じことが起きるので、repo の中身を信頼するという前提は変わらない。`bunx` とローカルの実体が同じであることを実機で確かめたのは `tsc` だけで、ほかの 4 つは綴りの対応からの推定である。`.bin` を信頼できるのは agent が `node_modules` に書けないからだが、`tar x`、`unzip`、文字を組み立てたパスで `.bin` を作る経路は deny のパターンに無い
  - **却下した案**: read-only 動詞の表に `sed` を足す（動詞の後ろに `node_modules` があるかだけを見るので、`sed -i` と `sed -n '1w …'` が通る）。ask の層を無くす（変更後に残る 78 件のうち、複数行の断片とインタプリタの本文が 31 件、`ln -s` が 12 件、絶対パスの `.bin` が 10 件で、どれも確認が残るか、LLM evaluator の判断だけになる）。`echo` / `printf` を対象にする（下の条件に反する）。auto-approve の safe-list の先頭語にパスを認める（走査を 2 つの hook で共有しており、影響が `node_modules` の外に及ぶ）。絶対パスの `.bin` に許可規則を書く（規則の先頭に置いた `*` は空白を含む任意の文字列に一致し、`rm -rf x /a/node_modules/.bin/tsc y` も許可する）。`CLAUDE.md` で `bunx <tool>` の綴りへ誘導する（強制でなく、`pnpm tsc` のように許可規則の無い組み合わせがある）
  - **形を足すときの条件**: (1) その断片が、後続の断片へパスの文字列を渡せないこと。(2) その先頭語に後段の許可規則がある場合、引数が実行されないこと。`echo node_modules | xargs rm -rf` は (1) に反する。今は `echo` の断片の ask だけが全体を ask にしている。`printf -v 'a[$(cmd)]' x` は (2) に反する。単一引用符の中の `$(…)` を、bash と zsh が配列の添字として実行する（レビューで実証）
  - **受容したリスク**: hook は断片が 1 つでも ask なら全体を ask にしていた。次の形は、行の表示かツールの実行の断片が ask だったので全体が ask になっていたが、今は hook が黙る。出力を渡す形（`sed -n 1p node_modules/list | xargs rm`、`node_modules/.bin/tsc --listFiles | xargs rm -rf`）と、文字を組み立てる形（`node_modules/.bin/tsc --noEmit && rm -rf "$(echo node_)modules"`）である。その部分を除いた `cat node_modules/list | xargs rm` や `bunx tsc --listFiles | xargs rm -rf` では以前から hook が黙るので、保護していたのではなく、たまたま ask になっていた。本 ADR が対象外にしたパイプ経由・glob の綴りと同じ経路である。テスト（`deny-node-modules.test.ts` の `silentCmds`）で固定した
  - **計測**: 計器は、トランスクリプト（`~/.claude/projects/**/*.jsonl`）の `hook_success` attachment のうち、`hookEvent` が `PreToolUse` で、stdout の `permissionDecisionReason` がこの文言で始まるものを `toolUseID` で一意に数えたもの。本文の単純な検索は、この repo で hook のソースを読んだセッションを数えるので使わない。期間は 2026-09-24〜10-09 で 124 件。この 124 件のコマンドを変更前後の hook に通すと、ask は 114 → 78、deny は 7、無出力は 3 → 39 になった。行の表示だけなら ask は 91、ツールの実行だけなら 101 である。規則を作ったのと同じ標本で測っており、ダイアログの減少の上限である
  - **実機での確認（2026-10-09、配備後）**: `sed -n 1,3p node_modules/typescript/package.json`、`sed -n 1,3p node_modules/.bin/tsc`、`node_modules/.bin/tsc --version`、`./node_modules/.bin/oxfmt --version` は、どれも hook が無出力で、PermissionRequest は起動しなかった。Claude Code の文書は、確認なしで通す読み取りコマンドの一覧に `sed` を挙げていないが、`sed -n <N,M>p <file>` は通る
  - **観測**: `permission-llm-evaluator` は、コマンドに `git` の語があるとき（`skipped-llm: git-head`）と、自動承認の hold に当たるとき（`held: …`）は、LLM を呼ばずに人間へ回す。タイムアウトではなく `reasonToSkipLLM` による早期終了で、約 100ms・終了コード 0 で終わる。`decisions.jsonl` の 2026-10-05〜10-09 では、Bash の PermissionRequest のうち LLM が許可したものが 16 件、早期終了が 26 件（`git-head` 15、hold 11）だった。上の「evaluator がベストエフォートで補う」は、`git clean` には当てはまらない（`git` の語があるので LLM は呼ばれず、人間が判断する）。インタプリタと `rsync` は、hold に当たらなければ LLM が判断する
  - **残件**: `docs/plans/node-modules-ask-followups.md`
- **追記（ask の理由文の形、2026-10-10）**: ask の理由文は、hook ごとにメッセージと入力の並べ方が違っていた（入力が先の `Command '<入力>': <メッセージ>`、メッセージが先の `<メッセージ>: <入力>`、入力を文に埋め込む形）。並べ方を決める場所がコードに無く、各 hook が文字列を手で組み立てていた。入力を示す ask の 5 箇所を、同じ形にそろえた。どのコマンドが ask になるかは変えていない
  - **形**: 固定のメッセージを先に書き、その後ろに `<ラベル>: <入力>` の行を、入力ごとに 1 行ずつ置く。入力が無ければメッセージだけになる。メッセージは複数行でもよい。ラベルは `Command`（Bash）と `File`（ファイル系ツール）の 2 つで、型で限る。入力の行数に上限は設けない
  - **作る場所**: `lib/context-helpers.ts` の `formatAskReason(message, label, inputs)`。ask の理由文で入力を示すときは、この関数で作る。型では強制していない。6 箇所目の ask が文字列を手で組み立てることは防げないので、関数の doc comment とこの追記で示す
  - **入力の扱い**: 入力は `shortenForReason` を通す。改行は `\n` の 2 文字になり、200 文字を超えると切られて全体の文字数が付く。引用符は付けない。上の追記（2026-10-06）が deny の引用に求めた性質と同じで、入力の中から `Command:` で始まる行を作れず、長い入力でメッセージが押し出されない。判定のログ（`decisions.jsonl`）の `reason` も切られたものになるが、コマンドの全文は同じ行の `input` の欄に残る
  - **対象にした 5 箇所と変更後の文言**: `deny-node-modules.ts` の `Unknown node_modules operation requires approval`。`auto-approve.ts` の、危険コマンドの表に当たった ask（メッセージは規則の理由。例は `Force delete branch (-D) ignores unmerged status`）、`Only control structure keywords present, no allow patterns defined`、`Manual review required: no permission patterns configured`。`linter-config-guard.ts` の `Protected linter/formatter config file.` と続く 2 行。`auto-approve.ts` の後ろの 2 つは、件数の表示（`(N keywords)`、`(N commands)`）を外した。行の数で分かるからである。この 2 つは hook への入力からは到達せず、2026-09-23〜10-09 の ask の理由文 3190 件にも現れていない。文言は `analyzeBashCommands` を直接呼ぶテストで固定した
  - **範囲**: deny・allow・pass の理由文と、入力を含まない ask の文言（`No patterns matched` など）は変えていない。deny 側には、メッセージの後ろにラベルの行（`Command:`、`File:`、`Path:`、`Requested URL:`）を置く形が約 12 箇所ある。並びは ask と同じだが、切り詰めも 1 行化もしておらず、ラベルの行の前に空行がある
  - **却下した案**: 入力を先に書く形（下の計測のキーが先頭から外れ、長い入力でメッセージが後ろに押し出される）。メッセージと入力を 1 行に書く形（入力が長いと 1 行が長くなる）。5 箇所をその場で書き換えるだけにする（形を決める場所が 5 つのまま残る）。応答を作る `createAskResponse` がメッセージと入力を別々に受け取るか、`formatAskReason` の戻り値に印を付けた型だけを受け取る形（入力の無い ask のための入口がもう 1 つ要り、対象の 5 箇所の外も書き換えることになる）
  - **計測への影響**: 上の追記（ask の範囲、2026-10-09）の計器は、`Unknown node_modules operation requires approval` で始まる理由文を数える。メッセージを先頭に置いたので、そのまま使える。2026-10-10 より前の理由文は同じ行に `: <コマンド>` が続き、後の理由文は次の行に `Command: <コマンド>` が続く

## References

- `home/dot_claude/hooks/lib/destructive-verbs.ts`
- `home/dot_claude/hooks/lib/node-modules-policy.ts`
- `home/dot_claude/hooks/lib/context-helpers.ts`
- `home/dot_claude/hooks/lib/command-parsing.ts`
- `home/dot_claude/hooks/implementations/deny-node-modules.ts`
- `home/dot_claude/hooks/implementations/auto-approve.ts`
- `home/dot_claude/hooks/implementations/permission-llm-evaluator.ts`
- `home/dot_claude/.settings.hooks.json.tmpl`
- `home/dot_claude/hooks/tests/unit/destructive-verbs-drift.test.ts`
