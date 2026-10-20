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

## 却下した代替案

- **差分最小案（正規表現に `unlink` を足し、全 deny に一律の文言を足す）**: 誤検知が残って言い換えの動機が消えない。一律の文言は、代替手段を指示する誘導 deny（`block-tsx` の `Suggestion:`、`block-plan-mode` の移行先）と矛盾する。`unlink` を足すと `grep -rn unlink node_modules/x` を新たに deny する。
- **効果モデルで例外を一般化する（変数・`cd` を解決する walker で、複合コマンドの中の削除対象を解決する）**: レビューのたびに、hook の解釈と shell の実行がずれる穴（字句的な `cd` と物理的な `cd`、条件付き代入、walker と parser のセグメント対応、parser の fallback）が見つかった。home guard のコード約 600 行の移動も要り、2026-09-24 の事故の防御コードに回帰の危険を持ち込む。
- **代入とラッパーを除去して先頭語を特定する**: `git rm`、オプション引数付きのラッパー（`sudo -u root rm`、`timeout 5 rm`）、parser fallback の断片で、旧正規表現より deny が狭くなった。
- **deny の種類を型（判別共用体）にする**: `createDenyResponse` の全呼び出しの書き換えが要るが、誘導側の挙動は変えない。付け忘れは境界の deny 経路ごとのテストで検出する。

## Consequences

- **観測された回避は閉じた**: `unlink`・`shred`・`truncate`・`find -delete`・`find -exec <削除・移動動詞>`（ラッパー越し、引用符で崩した形を含む）は deny になる。
- **誤検知は残る**: 先頭語が read-only でないコマンドの引数に削除語が現れる場合（`echo rm node_modules`、`git commit -m "find -delete" node_modules`）は deny になる。fail-closed 側として受容する。誤検知が観測された先頭語は read-only の表に足す。commit / PR の本文（`git commit -m "$(cat <<'EOF' …)"` など）の中の削除語は、データとして扱えないので残る。
- **対象外の削除経路**: インタプリタ経由（`python -c 'shutil.rmtree(...)'`）、`git clean`、`rsync --delete`、`cd node_modules && rm -rf *`、パイプ経由（`find node_modules | xargs rm`）、glob 綴りは、機械的には deny しない。ask を返さなくなった後は、許可規則と auto mode の分類器が判定する（Amendments の「deny-node-modules は ask を返さない」）。
- **再検討の条件**: 2 例目の綴りによる回避が観測されたら、解決済みパスで判定する効果モデルを再検討する。
- **反映**: `chezmoi apply` の後から効く。`deny-node-modules` は run-guard 経由になり、bun 不在やタイムアウトでも deny になる。

## Amendments

### F2: read-only の除外を全文判定にして共有する（2026-10-02）

read-only 先頭語の除外を auto-approve の危険コマンド判定と共有し、断片ごとではなく Bash コマンド全文に対して 1 回だけ判定する形にした。断片ごとの判定では、parser のメタコマンド抽出（`env PATH=x grep` を `grep` 断片に書き換える）や同じ行での先頭語の再定義（`grep() {…}; grep …`）で、hook が見る先頭語とシェルが実行するものが食い違った。引用符を解釈する走査で `$` は許可形だけを通し、先頭語は生の綴りで完全一致を求める。引用符内の区切り文字を含む read-only コマンド（`grep "a|rm" node_modules/x`）は deny されなくなり、`find` / `less` / `more` 先頭、引用符やバックスラッシュ付きの先頭語、複合コマンド中の read-only 断片で削除語を含むものは deny になった。ANSI-C クォートで `-exec` と終端を隠す回避が閉じた。

### F3b: データとしてだけ使う heredoc の本文を判定から外す（2026-10-02）

誤検知（回避ではない）への対応で、本 ADR の再検討の条件には数えない。deny 側の hook（deny-node-modules・auto-approve の deny 段・document-workflow-guard）は、データとしてだけ使われる heredoc の本文を空にしてから判定する。削除の分類規則は変えず、判定に渡すテキストからデータの範囲を除くだけである。

- **本文を空にする範囲**: 本文を受け取るコマンドが `cat` か `tee` で、引数は展開を含まない語だけ、同じ行に後続が無く、区切りと出力先が単純な形（引用符の無い区切りなら本文に `$`・バッククォート・`\` を含まない。出力先は `>` か `>>` の通常のパス）のものだけ。消費者の文とそれより前のトップレベルの文が、閉じた許可リストのノード（普通のコマンド、リテラルの語、list）と不活性な builtin だけでできていることも要る。判定できない入力は本文を残す。parser（tree-sitter-bash）は文の構造と本文の範囲を取るためだけに使い、heredoc に隣接するトークンの綴りは許可リストと比べる。前提は builtin の一覧の版（bash 3.2.57・zsh 5.9）と、tree-sitter が構文の種類をノードの種類として報告することで、シェルの版を上げるときは一覧を取り直す。消費者を足すときは `HEREDOC_DATA_CONSUMERS` に `reason` を書き、この節にも足す。
- **本文の綴りに当たり続ける hook**: file-access-guard・block-tsx・permission-auto-approve の静的判定・PermissionRequest の LLM evaluator は、本文を含む全文を読む。
- **commit / PR の本文を扱わない理由**: `$(cat <<'EOF' …)` で引数に渡す形は、bash 3.2 が `$(…)` を heredoc を理解しない括弧の対応で切り出し、本文の一部が実行される。stdin で渡す形（`git commit -F -` など）は、git / gh の選択肢・設定・hook を通して本文が実行されうる。
- **対象外として受容した類**: (1) Write ツールでファイルを書いてから実行するのと同じ水準のもの。(2) 1 回の入力で書きと実行がそろうので一段弱いもの（名前付きパイプ経由、PATH 上の偽の `cat` / `tee`）。どれも F3b の前から Write ツールでスクリプトを書いて実行すれば得られる効果で、F3b はその水準を超えない。
- **受容の前提**: LLM evaluator と上の hook が本文を含む全文を読むこと。後段にも本文を空にした入力を渡すように変えるときは、受容を再評価する。「2 例目の綴りによる回避」を数えるときは、これらの経路の観測も含める。

### 綴りの deny に何に当たったかを出し、案内を分ける（2026-10-06）

誤検知に当たった agent が、K1 の文言に従って毎回止まっていた。理由文が効果の名前しか言わず、何の綴りに反応したかを言わないので、誤検知かどうかを判定できなかった。判定は変えていない。

- **何に当たったかを出す**: 理由文から規則が読み取れない 3 系統（node_modules の削除語・`find`・`DANGEROUS_COMMAND_PATTERNS` のうち deny になる規則）の理由文に `Matched: …` の行を足す。「その行が出たときに必ず成り立つ事実」だけを書き、引用する断片は改行を `\n` に置き換えて 1 行にし、200 文字で切る。開示するのは当たった語と語の種類までで、語の順序と境界の文字は書かない。
- **案内を分ける**: 拒否された断片のすべてに `Matched:` がある Bash の deny だけ、K1 の文言の代わりに `MATCHED_TEXT_DENY_GUIDANCE` を付ける。当たった綴りが実行するつもりのものの一部なら、K1 と同じく止まって報告する。渡しただけのデータ（検索パターン、commit メッセージ、cat / tee の heredoc の本文）なら、`;` / `&&` でつないだ各コマンドを別々の Bash 呼び出しに分けるか、文章を Write ツールでファイルに書いて渡す形で、1 回やり直してよい。シェル・インタプリタ・`eval`・`xargs`・`ssh`・`-c` に渡す文字列と、シェルが展開する場所は、実行するものとして扱う。
- **却下した案**: 分岐を agent の意図の自己申告に置く案。K1 の起源の事故は、agent が効果を「symlink を消すだけ」と定義し直して起きた。guard が当たった範囲を返して案内を出し分ける案も採らなかった。規則の matcher は当たった位置を返さず、deny 側は heredoc の本文を空にしたテキストを読むので、位置が元のコマンドに対応しない。取り下げの条件が発火したら再検討する。
- **K3 との関係**: 案内は別のコマンドを一切許さない書き方にし、理由文への参照で例外を作らない（理由文は agent が書いたコマンドを引用するので、参照は偽造の足場になる）。単独の `unlink` の経路は、guard 自身が出す K3 の行に、その場合に限る例外だと書く。
- **位置づけと取り下げの条件**: 文言による抑止で、機械的な強制ではない。形を直したやり直しで拒否された効果そのものが通った例を観測したら、この案内を取り下げて K1 の文言に戻す。観測の手段は事後に会話ログを読むことだけである。

### ask の理由文の形をそろえる（2026-10-10）

ask の理由文は hook ごとに並べ方が違っていた。固定のメッセージを先に書き、その後ろに `<ラベル>: <入力>` の行を入力ごとに 1 行置く形に決め、`lib/context-helpers.ts` の `formatAskReason` で作る。ラベルは `Command`（Bash）と `File`（ファイル系ツール）。入力は改行を `\n` にして 200 文字で切り、引用符は付けない（入力の中から `Command:` で始まる行を作れず、長い入力でメッセージが押し出されない）。どのコマンドが ask になるかは変えていない。型では強制していないので、ask の理由文を手で組み立てる箇所が増えることは防げない。deny・allow・pass の理由文は対象外。

### deny-node-modules は ask を返さない（2026-10-10）

`deny-node-modules` は、Bash のコマンドに deny か判定なしのどちらかだけを返す。ask を返していた 3 つの分岐（未知の操作、削除・移動の語を持たない `find -exec`、fallback パースの複合断片）を無くし、その分類のためだけにあったコードを消した。既存の deny の規則と判定の順序は変えていない。

- **理由**: この環境は auto mode で動く。hook が判定を出さず許可規則にも当たらないコマンドは分類器が判定し、hook が ask を返すと分類器を経ずに人間への確認になる。ask は字面の判定で、文字を組み立てれば反応しない。2026-09-24〜10-09 に ask になった 124 件に、`node_modules` の中身を削除・上書きするものは無く、ask が変更を止めた事例は観測されていない（確認に人間がどう答えたかは測っていない）。
- **線引きの基準**: deny は変更する綴りに当たったときだけ返り、誤って deny になっても理由文と案内がモデルに返って人間の手は止まらない。ask は言及があるだけで返り、モデルに何も教えずにそのたび人間の手を止める。
- **deny に足したもの**: `tee`、出力のオプションを持つ `sort`、`uniq`。足す基準は、(1) 引数で書き込み先のファイルを名指しする、(2) すべての断片が許可規則に当たる、(3) `auto-approve` が allow を返すことを実測した、の 3 つ。ask が無くなると (2) と (3) に当たるコマンドは何の判定も通らずに実行されるため。
- **外した許可規則**: `Bash(xargs *)`、`Bash(find *)`、`node_modules/.bin/<tool>` の 10 行。`echo node_modules | xargs rm -rf` のように、書き込むコマンドが `node_modules` の文字を持たない断片にある形は deny で止められないため。
- **受容した誤検知**: `tee /tmp/node_modules-report.txt`、`sort -o /tmp/out node_modules/list.txt`、`uniq node_modules/list.txt` は deny になる。先頭語をパスで書いたもの、変数や引用符で組み立てたパス、行の継続は見逃す（既存の `mv` などの規則と同じ）。
- **受容したリスク**: deny に当たらない綴り（インタプリタの本文、`rsync --delete`、`sed -i`、`ln -sf`、`git checkout -- node_modules`、`bun run <script>`、文字を組み立てた綴り、パスを別の断片へ渡す形）での変更に、人間の確認が入らなくなる。許可規則に当たるものは分類器も通らない。分類器の判定は確かめておらず、破壊的なコマンドを流す確認もしていない。`node_modules` は `bun install` で作り直せる。auto mode でない環境での動作も確かめていない。
- **却下した案**: ask を残して黙る形を足し続ける（形ごとに引数が実行されないかを調べ続けることになり、最大の分類であるインタプリタの本文は ask のまま残る）。`tee`・`sort`・`uniq` の許可規則を外す（`| sort | uniq | tee` はよく使う形で、使用量を測っていない）。
- **見直す条件**: (1) `node_modules` の中身を変えるコマンドが許可規則か分類器を通って実行された事例が出たら、その綴りを deny に足すか、許可規則を外す。(2) 無出力を期待したコマンドが人間への確認になったら、原因を調べてこの決定を見直す。(3) `xargs`、`find`、`node_modules/.bin/<tool>` で人間への確認が増えたら、該当する許可規則を戻す（`.settings.permissions.json` に `"Bash(find *)",` と `"Bash(xargs *)",`、または `.bin` の 10 行を戻して `chezmoi apply` する）。増えたかどうかは、トランスクリプトの `permissionDecision` の判定元が `user_temporary` になった回数で数える。
- **配備後の観測**: 配備後に 9 つのコマンドを 1 つずつ実行し、人間への確認は 0 件、変更する綴りの 2 つ（`tee`、`sort -o`）は deny、読み取りは分類器か auto-approve が通した。分類器が変更する綴りをどう判定するかは確かめていない。

### 自動承認の hook を止めて auto mode を観察する（2026-10-10）

自動承認の hook 3 つ（`auto-approve.ts`、`permission-auto-approve.ts`、`permission-llm-evaluator.ts`）を 2026-10-24 まで止め、allow も deny も ask も auto mode に任せたときに何が起きるかを観察する。利用者の意図は、「人間が手をかけたくないから自動承認の仕組みを作ったので、auto mode がその役目を果たすなら重なっている」である。コードとテストは残した。

- **決定**: 3 つの hook の登録を chezmoi のデータ `claude_hooks.auto_approval`（`home/.chezmoidata/claude_hooks.yaml`）で出し分ける。`false` の間は 3 つを登録せず、代わりに `home-destruction-guard.ts` を登録する。項目が無いときは `true`（3 つを登録する）として扱う。設定の許可規則は変えない。戻すかどうかを決める件数の閾値は置かない。
- **理由**: auto mode では、hook の allow は分類器を呼ばせず、hook の ask は分類器を経ずに人間への確認になる。2026-10-08〜10-09 の 1,766 件では、Bash 850 件のうち hook の allow は 46 件で、611 件は分類器が判定していた。auto mode がある前提では、hook の allow と ask は分類器の仕事を先取りしている。
- **止まるもの**: 危険コマンドの表の deny と ask、設定の deny 規則を断片ごとに照合して返す deny、LLM evaluator の deny、`decisions.jsonl` への書き込み。**残すもの**: ホームディレクトリの再帰削除・移動の deny。`checkHomeDestruction` の呼び出しは `auto-approve.ts` の 1 か所だけで、設定の deny 規則は `rm * ~` などの字面しか覆わないので、独立した hook にした。`auto-approve.ts` は変えていない。
- **計器と知らせ**: 実験中の各ツール呼び出しを止めた hook に子プロセスで渡し、「hook なら何と言ったか」を「実際の判定元」と並べて報告にする（`permissionDecision` の記録は 2026-10-08 以降しか無く、前後比較に使えるのは約 1.7 日ぶんだったため）。セッション開始時に、予定の日（2026-10-12、10-17、10-24）を過ぎて報告が無ければ未作成であることとコマンドを出し、報告があれば、hook なら deny だった呼び出しのうち実行された件数と止められた件数を出す。10-25 からは期日超過と戻し方を出す。報告は人が作る。
- **報告を自動で作る形を採らなかった理由**: systemd の user timer と、セッション開始時に切り離した子プロセスで作る形の 2 つを設計し、どちらもレビューが収束しなかった。前者は timer を止める手順、`bun` の解決、遅れて動いたときの扱いが要り、後者は再起動の歯止めと実行中の印、排他の作成が要る。どちらもセッションをまたいで残る状態を持ち、切り替えの値を戻してもその状態は消えない。「1 つの値で戻せる、2 週間の実験」という前提と合わない。
- **却下した案**: 登録の行を消して `hook-target-drift` のテストに例外を足す（戻す手順が 2 つになる）。`auto-approve.ts` を登録したままホームだけ判定するモードを足す（止めたはずの hook が設定の読み込みとログの書き込みを続ける）。home guard を共通の関数に抽出する（`auto-approve.ts` は 2026-09-24 の事故の防御コードで、K6 が変えないと決めている）。
- **受容したリスク**: 分類器が危険コマンドをどう判定するかは確かめていない。hook なら deny だった呼び出しが実行されても、気づくのは次に報告を作ったときである。auto mode でないセッションでは、hook が通していたものが人間への確認になる。同じ利用者として動くプロセスは、知らせが読むファイルを書き換えて知らせを止められる。
- **恒久の修正**: 分類器の環境の記述（利用者の設定の `autoMode.environment`）が特定の repo を信頼する記述で全プロジェクトに効いていたので、組み込みの既定（`"$defaults"`）と個人のヘルパーの 1 行に書き換えた。実験の状態ではないので、切り替えの値を戻しても戻さない。
- **見直す条件**: 2026-10-24 の報告を見て、3 つとも戻すか、止めたままにするか、deny だけ戻すかを利用者が決める。そのとき、上の「deny-node-modules は ask を返さない」の `tee`・`sort -o`・`uniq` の deny と、`xargs`・`find` の許可規則の削除も見直す（前者は `auto-approve` が allow を返すことを前提にしている）。hook なら deny だった呼び出しが実行されていたと分かったとき、または分類器の reject や人間への確認で作業が進まないと分かったときは、その場で利用者に報告し、戻すかどうかは利用者が決める。

### deny して別の方法に誘導する候補は足さない（2026-10-10）

ask をやめて判定なしにした綴りのうち、deny して別の方法を示す候補が 3 つあった。評価して、どれも足さないと決めた。

- **足してよい条件**: 理由文で次にどうすればよいかを示せること。(1) その操作の代わりに決まった方法があるか、(2) その方法でモデルはやりたかったことを果たせるか、(3) 理由文に具体的なコマンドの形まで書けるか。示せないなら、判定なしのまま分類器に任せる。
- **`node_modules/.bin/<tool>` を `bunx <tool>` へ**: (2) を満たさない場合がある。`bunx` は、ツールが cwd か祖先に入っていればそれを使い、入っていなければ最新版を取得して実行する。案内に従うと、固定していない版を実行する経路ができる。この綴りに害は無く、今は分類器が通す。
- **`ln -s … node_modules` を `git-worktree-create` へ**: 標本 16 件のうち 15 件は、リンクの置き先が scratchpad や tmp のコピーで、代わりの方法が無い。git worktree が置き先だった 1 件は、`git-worktree-create` が worktree の中で依存を入れるようになる前だった。
- **`sed -i … node_modules/…` を入れ直しへ**: 標本に `node_modules` の中へ実際に書き込むコマンドが 0 件で、一時的に書き換えて調べる目的は入れ直しでは果たせない。
- **見直す条件**: 置き先が `.git/worktree/` の下である `node_modules` の symlink を張るコマンドが 2026-10-06 より後に観測されたら、置き先が worktree のときだけ deny して `cd <worktree> && <パッケージマネージャ> install --frozen-lockfile` を案内する規則を検討する（worktree に張った symlink の下で install すると、リンク越しに共有の実体へ書き込む）。`node_modules` の中へ書き込む Bash のコマンドが観測されたときも見直す。
- **足すときの置き方**: 誘導の deny は `block-tsx` と同じく `createDenyResponse` で返し、`Suggestion:` に具体的なコマンドの形を書く。`createBoundaryDenyResponse` と `createMatchedTextDenyResponse` の案内は別のコマンドでの再試行を禁じるので、誘導と矛盾する（K1）。
