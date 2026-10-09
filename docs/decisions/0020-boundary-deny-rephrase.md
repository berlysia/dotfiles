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
  - **残件**: `git show e3562f4:docs/plans/node-modules-ask-followups.md`（2026-10-10 に削除。ask を返さなくなり、数え直す対象が無くなった）
- **追記（ask の理由文の形、2026-10-10）**: ask の理由文は、hook ごとにメッセージと入力の並べ方が違っていた（入力が先の `Command '<入力>': <メッセージ>`、メッセージが先の `<メッセージ>: <入力>`、入力を文に埋め込む形）。並べ方を決める場所がコードに無く、各 hook が文字列を手で組み立てていた。入力を示す ask の 5 箇所を、同じ形にそろえた。どのコマンドが ask になるかは変えていない
  - **形**: 固定のメッセージを先に書き、その後ろに `<ラベル>: <入力>` の行を、入力ごとに 1 行ずつ置く。入力が無ければメッセージだけになる。メッセージは複数行でもよい。ラベルは `Command`（Bash）と `File`（ファイル系ツール）の 2 つで、型で限る。入力の行数に上限は設けない
  - **作る場所**: `lib/context-helpers.ts` の `formatAskReason(message, label, inputs)`。ask の理由文で入力を示すときは、この関数で作る。型では強制していない。6 箇所目の ask が文字列を手で組み立てることは防げないので、関数の doc comment とこの追記で示す
  - **入力の扱い**: 入力は `shortenForReason` を通す。改行は `\n` の 2 文字になり、200 文字を超えると切られて全体の文字数が付く。引用符は付けない。上の追記（2026-10-06）が deny の引用に求めた性質と同じで、入力の中から `Command:` で始まる行を作れず、長い入力でメッセージが押し出されない。判定のログ（`decisions.jsonl`）の `reason` も切られたものになるが、コマンドの全文は同じ行の `input` の欄に残る
  - **対象にした 5 箇所と変更後の文言**: `deny-node-modules.ts` の `Unknown node_modules operation requires approval`。`auto-approve.ts` の、危険コマンドの表に当たった ask（メッセージは規則の理由。例は `Force delete branch (-D) ignores unmerged status`）、`Only control structure keywords present, no allow patterns defined`、`Manual review required: no permission patterns configured`。`linter-config-guard.ts` の `Protected linter/formatter config file.` と続く 2 行。`auto-approve.ts` の後ろの 2 つは、件数の表示（`(N keywords)`、`(N commands)`）を外した。行の数で分かるからである。この 2 つは hook への入力からは到達せず、2026-09-23〜10-09 の ask の理由文 3190 件にも現れていない。文言は `analyzeBashCommands` を直接呼ぶテストで固定した
  - **範囲**: deny・allow・pass の理由文と、入力を含まない ask の文言（`No patterns matched` など）は変えていない。deny 側には、メッセージの後ろにラベルの行（`Command:`、`File:`、`Path:`、`Requested URL:`）を置く形が約 12 箇所ある。並びは ask と同じだが、切り詰めも 1 行化もしておらず、ラベルの行の前に空行がある
  - **却下した案**: 入力を先に書く形（下の計測のキーが先頭から外れ、長い入力でメッセージが後ろに押し出される）。メッセージと入力を 1 行に書く形（入力が長いと 1 行が長くなる）。5 箇所をその場で書き換えるだけにする（形を決める場所が 5 つのまま残る）。応答を作る `createAskResponse` がメッセージと入力を別々に受け取るか、`formatAskReason` の戻り値に印を付けた型だけを受け取る形（入力の無い ask のための入口がもう 1 つ要り、対象の 5 箇所の外も書き換えることになる）
  - **計測への影響**: 上の追記（ask の範囲、2026-10-09）の計器は、`Unknown node_modules operation requires approval` で始まる理由文を数える。メッセージを先頭に置いたので、そのまま使える。2026-10-10 より前の理由文は同じ行に `: <コマンド>` が続き、後の理由文は次の行に `Command: <コマンド>` が続く
- **追記（deny-node-modules は ask を返さない、2026-10-10）**: `deny-node-modules` は、Bash のコマンドに deny か、判定なしのどちらかだけを返すようにした。ask は返さない。2026-10-10 に配備し、配備の後の確認は期待どおりだった（下の「配備の後の確認」）
  - **決定**: `node_modules` の文字を含む断片は、既存の deny の規則に当たれば deny、当たらなければ判定なしにする。ask を返していた 3 つの分岐（未知の操作、削除・移動の語を持たない `find -exec`、fallback パースの複合断片）を無くした。既存の deny の規則と判定の順序は変えていない。ask と allow を分けるためだけにあったコード（`isNonModifyingShape`、read-only 動詞の表 `READ_ONLY_VERBS` とそこから作る照合、`mayAllowAsReadOnly`、`classifyDeletion` の `ask-find`）を消した
  - **理由**: この環境は auto mode で動いている（設定の `defaultMode` が `auto`）。hook が判定を出さず、許可規則にも当たらないコマンドは、分類器が判定する。hook が ask を返すと、分類器を経ずに人間への確認になる。ask は字面の判定で、文字を組み立てれば反応しない。2026-09-24〜10-09 に ask になった 124 件のコマンドに、`node_modules` の中身を削除・上書きするものは見当たらず、ask が変更を止めた事例は観測されていない（確認に人間がどう答えたかは測っていない）
  - **線引きの基準**: deny は、変更する綴りに当たったときだけ返る。誤って deny になっても、理由文と案内がモデルに返り、人間の手は止まらない。ask は、言及があるだけで返り、モデルに何も教えずに、そのたびに人間の手を止める
  - **deny に足したもの**: `tee`、出力のオプション（`-o`、または `--o` で始まる長いオプション）を持つ `sort`、`uniq`。どれも、語の後ろの同じ行に `node_modules` があれば当たる。足す基準は 3 つである。(1) 引数で書き込み先のファイルを名指しする。(2) すべての断片が許可規則に当たる。(3) `auto-approve` が allow を返すことを実測した。deny は変更する綴りの一部しか覆っておらず、覆っていない綴りは ask が受けていた。ask が無くなると、(2) と (3) に当たるコマンドは、何の判定も通らずに実行される（`echo x | tee node_modules/a/index.js`、`sort -o node_modules/a/f /tmp/in`、`uniq in.txt node_modules/out` を実測）
  - **外した許可規則**: `Bash(xargs *)`、`Bash(find *)`、2026-10-09 に足した `node_modules/.bin/<tool>` の 10 行。`echo node_modules | xargs rm -rf` や `find node_modules -exec chmod 000 {} \;` は、書き込むコマンドが `node_modules` の文字を持たない断片にあるので、deny では止められない。許可規則を外すと、`node_modules` に関係しない `xargs` と `find` も、規則だけでは通らなくなる
  - **受容した誤検知**: `tee /tmp/node_modules-report.txt`、`sort -o /tmp/out node_modules/list.txt`、`uniq node_modules/list.txt` は、読むだけか、`node_modules` に書かないが、deny になる。`sort` の規則が出力のオプションとパスを結び付けないのは実装上の選択で、結び付ける照合は線形時間を保つ書き方が複雑になる。`uniq` は出力先を示すオプションを持たないので、読み取りと書き込みを綴りで分けられない。先頭語をパスで書いたもの（`/usr/bin/tee …`）、変数や引用符で組み立てたパス、行の継続は見逃す。既存の `mv` などの規則と同じである
  - **受容したリスク**: deny に当たらない綴り（インタプリタの本文、`rsync --delete`、`sed -i`、`ln -sf`、`git checkout -- node_modules`、`bun run <script>`、文字を組み立てた綴り、`echo node_modules | xargs rm -rf` のようにパスを別の断片へ渡す形）での変更に、人間の確認が入らなくなる。許可規則に当たるものは分類器も通らない（`git checkout -- node_modules` と `bun run build node_modules` は、`auto-approve` が allow を返すことを実測した）。分類器がこれらをどう判定するかは確かめていない。破壊的なコマンドを流す確認はしていない。`node_modules` は `bun install` で作り直せる。auto mode でない環境での動作も確かめていない
  - **上の記述のうち、当てはまらなくなったもの**: Consequences の「インタプリタ・`git clean`・`rsync` は ask になり、K4 の evaluator と K1 のガイダンスがベストエフォートで補う」は成り立たない。これらは判定なしになり、許可規則と分類器が判定する（`git clean -f` / `-d` は、`auto-approve` の危険コマンドの表が ask を返す）。追記（ask の範囲、2026-10-09）は、「観測」の項を除いて、全体がこの追記で置き換わる。その追記が「ask の層を無くす」を却下した根拠のうち、「許可規則の無いコマンドは後段で確認になる」は既定の権限モードを前提にした推論で、誤りだった。同じ追記の「実機での確認」で `sed -n` を通したのは、Claude Code 本体の読み取りの判定ではなく、分類器だった。追記（ask の理由文の形、2026-10-10）の対象は 5 箇所から 4 箇所になり、「計測への影響」は数える対象が無くなった
  - **却下した案**: ask を残して、黙る形を足していく（`printf -v` や `echo` のように、形ごとに引数が実行されないか・後続に渡らないかを調べ続けることになり、最大の分類であるインタプリタの本文は ask のまま残る）。`Bash(tee *)`、`Bash(sort *)`、`Bash(uniq *)` の許可規則を外す（すべての綴りを覆えるが、`| sort | uniq | tee` はよく使う形で、どれだけ使っているかを測っていない）
  - **見直す条件**: (1) `node_modules` の中身を変えるコマンドが、許可規則か分類器を通って実行された事例が出たら、その綴りを deny に足すか、該当するコマンドの許可規則を外す。(2) 配備の後の確認で、無出力を期待したコマンドが人間への確認になったら、原因（分類器の判定か、別の hook か）を調べて、この決定を見直す。(3) `xargs`、`find`、`node_modules/.bin/<tool>` で人間への確認が増えたら、該当する許可規則を戻す（`.settings.permissions.json` に `"Bash(find *)",` と `"Bash(xargs *)",`、または `.bin` の 10 行を戻して `chezmoi apply` する）。増えたかどうかは、トランスクリプトの `permissionDecision` の判定元が `user_temporary` になった回数で数える
  - **計測**: 2026-09-24〜10-09 に ask になった 124 件のコマンドを、変更前後の hook に通した。ask 78 / deny 7 / 無出力 39 が、ask 0 / deny 7 / 無出力 117 になった。117 は hook が黙る件数で、人間への確認が減る件数ではない。標本は変更前に ask になったコマンドで、偏りがある。足した 3 つの deny に当たる過去のコマンドは無い
  - **配備の後の確認（2026-10-10）**: 9 つのコマンドを 1 回の Bash 呼び出しに 1 つずつ実行し、`~/.claude/logs/hook-timing.jsonl` の `deny-node-modules` の行の `stdout_bytes` と、トランスクリプトの `permissionDecision` の `reasonType` を記録した。このセッションの `permissionMode` は、トランスクリプトに `auto` と記録されている。人間への確認（`user_temporary`）は 0 件で、PermissionRequest の hook は 1 度も起動しなかった
    - **hook が無出力（0 バイト）だった 5 つ**: `echo "=== node_modules ==="` と `jq -n '"node_modules" | test("node_modules")'` の判定元は `hook`（`auto-approve` の allow）。`readlink -f node_modules/typescript` は `subcommandResults`。`node_modules/.bin/tsc --version` は、相対パスでも絶対パスでも `classifier`
    - **deny になった 2 つ**: `echo x | tee /tmp/node_modules-probe.txt`（1325 バイト）と `sort -o /tmp/out-probe node_modules/typescript/package.json`（1384 バイト）。判定元は `hook` の reject
    - **許可規則を外した 2 つ**: `find . -maxdepth 1 -name package.json` は `classifier`、`echo a | xargs echo` は `subcommandResults`
    - **見直す条件との対応**: (2) は発火していない。(3) は、配備から 2 週間の計数で判断する（手順は `docs/plans/deny-node-modules-no-ask-followups.md`）
    - **この確認が示さないこと**: どれも 1 回ずつの観測である。分類器が通したのは読み取りだけで、変更する綴りを分類器がどう判定するかは確かめていない（「受容したリスク」は変わらない）。`subcommandResults` が、`xargs` の許可規則が無い `echo a | xargs echo` を何を根拠に通したかは調べていない
    - **足す基準 (3) についての観測**: `auto-approve` は、上の `sort -o` のコマンドに allow ではなく pass（`held: node_modules/typescript/package.json: dot segment .bun`）を返した。`tee` のコマンドには allow を返した。基準 (3) の実測（`sort -o node_modules/a/f /tmp/in`）とはパスが違う
- **追記（自動承認の hook を止めて auto mode を観察する、2026-10-10）**: 自動承認の hook 3 つ（`auto-approve.ts`、`permission-auto-approve.ts`、`permission-llm-evaluator.ts`）を 2026-10-24 まで止めて、allow も deny も ask も auto mode に任せたときに何が起きるかを観察する。コードとテストは残した。利用者の意図は、「人間が手をかけたくないから自動承認の仕組みを作ったので、auto mode がその役目を果たすなら重なっている」である
  - **決定**: 3 つの hook の登録を、chezmoi のデータ `claude_hooks.auto_approval`（`home/.chezmoidata/claude_hooks.yaml`）で出し分ける。`false` の間は 3 つを登録せず、代わりに `home-destruction-guard.ts` を登録する。項目が無いときは `true`（3 つを登録する）として扱う。設定の許可規則は変えない。戻すかどうかを決める件数の閾値は置かない
  - **理由**: auto mode では、hook が allow を返すと分類器は呼ばれず、hook が ask を返すと分類器を経ずに人間への確認になる。2026-10-08〜10-09 の 1,766 件では、Bash 850 件のうち hook の allow は 46 件で、611 件は分類器が判定していた。Bash 以外の 916 件では、439 件を hook が通していた。auto mode がある前提では、hook の allow と ask は分類器の仕事を先取りしている
  - **止まるもの**: 危険コマンドの表の deny（`mkfs`、`dd … /dev/`、変数や `/` 始まりの `rm -rf`、`sudo rm`、`gh repo delete`、`npm unpublish`）と ask（`git push --force`、`git reset --hard`、`git branch -D`、`gh pr merge`、`npm publish` など）。設定の deny 規則を parser の断片ごとに照合して返す deny。LLM evaluator の deny。`~/.claude/logs/decisions.jsonl` への書き込み（`update-auto-approve` skill と `analyze-permissions` は、止めている間は新しいデータを得られない）
  - **残すもの**: ホームディレクトリの再帰削除・移動の deny。`checkHomeDestruction` の呼び出しは `auto-approve.ts` の 1 か所だけで、設定の deny 規則は `rm * ~` などの字面しか覆わないので、独立した hook にした。`auto-approve.ts` は 1 行も変えていない。2 つの hook が同じコマンドに同じ判定を返すことは、テスト（`home-destruction-guard.test.ts`）で検査する
  - **計器**: トランスクリプトの `permissionDecision` と、止めた `auto-approve.ts` への通し直し。`permissionDecision` が記録されるのは 2026-10-08T08:00Z 以降だけで、基準値は約 1.7 日ぶんしか無い。前後の期間を比べる代わりに、実験中の各ツール呼び出しを止めた hook に子プロセスで渡し、「hook なら何と言ったか」を「実際の判定元」と並べる（`scripts/auto-mode-experiment-report.ts`）
  - **知らせ**: セッション開始時に、状態を持たない 3 つを出す。予定の日（2026-10-12、10-17、10-24）を過ぎて報告が無ければ、報告が作られるまで毎回、未作成であることとコマンドを出す。報告があれば、hook なら deny だった呼び出しのうち実行された件数と止められた件数を出す。2026-10-25 からは、期日を過ぎたことと戻し方を出す。報告は人が作る
  - **却下した案**: 登録の行を消して `hook-target-drift` のテストに例外を足す（戻す手順が 2 つになり、戻し忘れると孤児の実装を検出しなくなる）。`auto-approve.ts` を登録したままホームだけ判定するモードを足す（止めたはずの hook が、設定の読み込みとログの書き込みを続ける）。home guard を共通の関数に抽出する（`auto-approve.ts` は 2026-09-24 の事故の防御コードで、本 ADR の K6 が変えないと決めている）
  - **報告を自動で作る形を採らなかった理由**: 2 つの形を設計し、どちらもレビューが収束しなかった。systemd の user timer は、値を戻したときに timer を止める手順、`ExecStart` での `bun` の解決、遅れて動いたときの扱い、日付の二重管理、無人の実行の資源の上限が要る。セッション開始時に切り離した子プロセスで作る形は、失敗した後の再起動の歯止め、実行中の印、配備の時刻の排他の作成、起動するプロセスの環境、状態のファイルの検証が要る。どちらも、セッションをまたいで残る状態を持ち、切り替えの値を戻してもその状態は消えない。「1 つの値で戻せる、2 週間の実験」という前提と合わない。切り離した子プロセスが hook とセッションの終了後も動くことは、`claude -p` で実測した（hook が 18:11:30Z に起動し、セッションが 18:11:37Z に終わり、子プロセスが 18:11:57Z に完了）
  - **受容したリスク**: 分類器が危険コマンドをどう判定するかは確かめていない。確かめるために流すこともしていない。hook なら deny だった呼び出しが実行されても、気づくのは次に報告を作ったときである。auto mode でないセッション（2026-09-26 以降の 131 セッション中 21）では、hook が通していたものが人間への確認になる。guard が動かないと、すべての Bash が止まる（ほかの guard と同じ起動の形）。同じ利用者として動くプロセスは、知らせが読むファイルを書き換えて知らせを止められる。分類器の reject がトランスクリプトにどう残るかは、Claude Code の文書に無く、基準の期間には 1 件も無い
  - **分類器の環境の記述**: 利用者の設定の `autoMode.environment` は、特定の repo（`berlysia/eslint-config`）を信頼する記述で、全プロジェクトに効いていた。利用者が、組み込みの既定（`"$defaults"`）と、個人のヘルパーの 1 行に書き換える。これは実験の状態ではなく恒久の修正で、切り替えの値を戻しても戻さない。この repo の管理には入れていない
  - **見直す条件**: 2026-10-24 の報告を見て、3 つとも戻すか、止めたままにするか、deny だけ戻すかを利用者が決める。そのとき、上の追記の `tee`・`sort -o`・`uniq` の deny と、`xargs`・`find` の許可規則の削除も見直す（前者は `auto-approve` が allow を返すことを前提にしている）。報告で、hook なら deny だった呼び出しが実行されていたと分かったとき、または分類器の reject や人間への確認で作業が進まないと分かったときは、その場で利用者に報告し、戻すかどうかは利用者が決める
  - **計画から外れた点**: (1) 設定を統合するスクリプトの Hash の行に、`deployed-at` の「有無と中身」を入れると設計したが、実装は中身を読まず、`stat` の種類・大きさ・更新時刻を入れた。この行は `chezmoi status` と `chezmoi diff` でも評価されるので、中身を読む形は、その場所に FIFO や大きなファイルがあると chezmoi のコマンドが止まる。作成・削除・書き直しで Hash が動く、という目的は同じである。(2) `sync-experiment-deployed-at.test.ts` の「有効な値」の固定値を、計画の `2026-10-10T01:00:00Z` から `2026-10-01T01:00:00Z` に変えた。計画の値は、実装した時点の実際の時計（UTC で 2026-10-09）より後で、bash の関数が正しく「未来なので書き直す」と判定した。実装ではなく、固定値が実際の時計に依っていた
- **追記（deny して別の方法に誘導する候補は足さない、2026-10-10）**: ask をやめて判定なしにした綴りのうち、deny して別の方法を示す候補が 3 つあった。評価して、どれも足さないと決めた
  - **足してよい条件**: 理由文で、次にどうすればよいかを示せること。候補ごとに 3 つを確かめる。(1) その操作の代わりに、決まった方法があるか。(2) その方法で、モデルはやりたかったことを果たせるか。(3) deny の理由文に、具体的なコマンドの形まで書けるか。示せないなら、判定なしのまま分類器に任せる
  - **標本**: トランスクリプトの `hook_success` attachment のうち、理由文が `Unknown node_modules operation requires approval` で始まるもの。2026-09-24〜10-09 で 140 件を得た。上の追記の 124 件とは一致せず、差の原因は突き止めていない。hook を開発していたセッションのコマンドが多く、偏りがある
  - **`node_modules/.bin/<tool>` を `bunx <tool>` へ**: 足さない。(2) を満たさない場合がある。`bunx` は、ツールが cwd か祖先に入っていればそれを使う（eslint で、ローカル 10.11.0、`bunx` 10.11.0、最新 10.12.0 を実測）。入っていなければ、最新版を取得して実行する（空のディレクトリの `bunx tsc` と、この repo の `bunx eslint` で実測）。案内に従うと、固定していない版を実行する経路ができる。断片の先頭語が `.bin` のツールだった 26 件のうち、約 9 件は pnpm のプロジェクトで、10 件は絶対パス（別のプロジェクトや子パッケージの `.bin`）だった。この綴りに害は無く、今は分類器が通す
  - **`ln -s … node_modules` を `git-worktree-create` へ**: 足さない。16 件のうち、リンクの置き先が scratchpad や tmp のコピーだったものが 15 件で、そこには代わりの方法が無い。git worktree が置き先だった 1 件は 2026-09-28 で、`git-worktree-create` が worktree の中で依存を入れるようになった 2026-10-06 より前である
  - **`sed -i … node_modules/…` をパッケージマネージャでの入れ直しへ**: 足さない。`node_modules` の中へ実際に書き込むコマンドは、標本に 0 件だった。`sed -i` の 2 件は、パターンの文字列に `node_modules` があるだけで、書き込み先は別のファイルだった。(2) も弱い。一時的に書き換えて調べる、という目的は入れ直しでは果たせない
  - **見直す条件**: 置き先が `.git/worktree/` の下である `node_modules` の symlink を張るコマンドが、2026-10-06 より後に観測されたら、置き先が worktree のときだけ deny して `cd <worktree> && <パッケージマネージャ> install --frozen-lockfile` を案内する規則を検討する。worktree に張った symlink の下で install すると、リンク越しに共有の実体へ書き込むからである。`node_modules` の中へ書き込む Bash のコマンドが観測されたときも見直す
  - **足すときの置き方**: 誘導の deny は、`block-tsx` と同じく `createDenyResponse` で返し、`Suggestion:` に具体的なコマンドの形を書く。`createBoundaryDenyResponse` と `createMatchedTextDenyResponse` は使わない。これらが付ける案内は、別のコマンドでの再試行を禁じるので、誘導と矛盾する（K1）

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
- `home/.chezmoidata/claude_hooks.yaml`
- `home/dot_claude/hooks/implementations/home-destruction-guard.ts`
- `home/dot_claude/hooks/lib/auto-mode-experiment.ts`
- `home/dot_claude/scripts/auto-mode-experiment-report.ts`
- `home/.chezmoitemplates/sync-experiment-deployed-at.sh`
