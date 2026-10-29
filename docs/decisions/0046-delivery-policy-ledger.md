# ADR-0046: 済んだ作業の範囲を hook だけが書く台帳に置き、merge はラッパーが条件を確かめて行う

## Status

accepted (2026-10-23)

D5 のうち必須の context の条件の一文は、2026-10-25 の Amendments で改めた（Bot が付けた commit status も数える）。

## Context

Claude Code の Bash ツールの説明文には `Commit or push only when the user asks.` があり、オーダーの「片付いたら」を「PR は頼まれていない」と読んで commit で止まることが多かった。PR #367 で、済んだ作業をどこまで進めるか（`commit` / `pr` / `merge`）を repo ごとに `.tmp/docs/CONTEXT.md` に記録する Delivery Policy を入れた。

残った問題は 2 つある。

- auto mode の classifier は `gh pr merge` を拒否することがあり、そのたびに利用者が `!` で打ち直していた。拒否されるかどうかは会話の内容で揺れた。
- 記録は agent が Edit 1 回で書き換えられるファイルにあった。

公式 docs（permission-modes、auto-mode-config）によると、`Bash(npm test)` のような狭い allow rule に一致した操作は classifier より前に決まり、classifier を通らない。つまり merge のラッパーを allow に入れると、classifier が見ていた判断をラッパーが自分で持つことになる。その判断の根拠になる記録を agent が書けるなら、無条件の merge の許可と変わらない。

既存の Document Workflow の承認は、同じ脅威にすでに対処している。`tool_response` だけを読む、`answers` を先に埋めた質問を拒否する、台帳への Write/Edit を guard が拒否する、の 3 つである。

## Decision

- **D1 台帳**: 範囲の記録は `~/.claude/state/delivery-policy/ledger.jsonl` の 1 か所に置き、CONTEXT.md の Delivery policy 区分は廃止する。1 行は `{v:1, repo, scope, at}` で、repo ごとに最後の有効な行が効く。順序は追記の順だけで決め、`at` は表示にだけ使う。無効な行が 1 行でもあれば merge は止まる。範囲を狭めた記録が壊れていたときに、古い `merge` が生き返らないようにするためである。無効な行は利用者が手で消す。出力に出す行番号は、エディタで見える物理行とする。
- **D2 記録するのは hook だけ**: 質問は lib が repo 名から決まった形で作る。PostToolUse(AskUserQuestion) の hook が `tool_response` を、自分で作り直した質問と比べ、一致したときだけ追記する。subagent、afk の時間切れ、自由記述、notes 付きの回答は記録しない。
- **D3 書き込みの拒否**: guard と permissions の deny で、台帳の dir、配布先の hooks、ラッパー、`settings.json` への Write/Edit を拒否する。ラッパーの bun と CLI が読む設定と依存（global の bunfig、mise の設定と配置先、`node_modules`、`package.json`、`tsconfig.json`）も拒否する。Bash は、台帳の dir かラッパーのパスを含むコマンドを、`~/.local/bin/delivery-policy show|ask|merge <PR>` と完全に一致する形でなければ拒否する。
- **D4 ラッパーの起動環境**: allow rule は classifier を飛ばすので、ラッパーは呼び出し元の cwd・env・PATH を使わない。shebang は `/bin/bash` で、最初に PATH を固定する。home は passwd から取り、`~/.claude/hooks` に `cd` してから `env -i` で bun を起動する。bun の `os.userInfo().homedir` は `HOME` を読むので、CLI・recorder・guard も passwd（linux は `getent`、darwin は `dscl`）から home を取る。
- **D5 merge の条件**: 次がすべてそろったときだけ、`gh pr merge <N> -R <repo> --merge --match-head-commit <sha>` を実行する。
  - 台帳でその repo が `merge`
  - 実行者が repo の owner（個人アカウント）で、PR の author も実行者
  - PR が OPEN、base が default branch、head が default branch でなく、fork からでない
  - PR の files が保護パスに当たらない
  - 必須の context（ruleset と classic protection を合わせたもの）が 1 件以上あり、全部が head の sha の check-run で SUCCESS・NEUTRAL・SKIPPED のどれか。commit status は gh の token で書けるので数えない
  - `mergeStateStatus` が `CLEAN`

  判定は 10 行の表で順序を決め、失敗は待つより先に判定する。

- **D6 待ち方**: 1 回の呼び出しは開始から 100 秒で打ち切り、gh の各呼び出しの timeout は 10 秒と残り時間の短い方にする。Bash ツールの既定のタイムアウトが 2 分で、打ち切られると終了コードも理由も出ないためである。(repo, PR, head sha) ごとに最初に待った時刻を記録し、20 分以上たったら止める。待つ間に head の sha が変わったら止める。
- **D7 保護パス**: guard と delivery-policy の実行、またはその登録に入るファイルに触れる PR は、merge せず人間に戻す。対象は `.github/`、delivery-policy の lib・hook・CLI・ラッパー、guard と run-guard、settings と permissions の断片と統合の script、hook の依存、hook を配る経路（`.chezmoiscripts/`、`.chezmoiignore`、`.chezmoitemplates/`、`.chezmoiexternal*`、`mods/`）である。guard・recorder・CLI から import でたどれるファイル 28 件（入口を含む）も入れ、閉包がすべて定数に入っていることを unit test で確かめる。

## 却下した代替案

- **CONTEXT.md の記録をそのまま根拠にし、GitHub 側の条件だけを確かめるラッパー**: 作るのは早いが、merge してよいかを決める行が agent に書き換えられるファイルに残る。利用者は hook が記録した承認を選んだ。
- **PreToolUse の hook が `gh pr merge` を allow/deny する**: ラッパーも allow rule も増えない。しかし、hook の allow が auto mode の classifier を飛ばせるかは公式 docs で確かめられなかった。
- **`merge` だけを台帳に置き、`commit` / `pr` は CONTEXT.md に残す**: 範囲の読み方が 2 段になり、食い違ったときの優先順を決める規則が増える。
- **PR ごとの承認**: 強いが、merge のたびに質問が出る。利用者は repo ごとの永続の許可を選んだ。
- **`--admin` / `--auto`**: 前者は保護を回避し、後者は無人の merge を予約する。

## Consequences

- 受け入れた限界:
  - hook と agent は同じ OS ユーザーで動き、sandbox が無い。変数・符号化・`cd` の後の相対パスで台帳のパスを隠した Bash は防げない。
  - bun の shim、`/usr/bin/gh`、global の bunfig、mise の設定、`node_modules` を Bash で書き換える経路も防げない。こうした経路を通っても transcript には残る。
  - repo の同一性は cwd で `gh repo view` した結果で決まるので、remote を差し替えた clone では照合が偽れる。merge の対象は `-R` と `baseRepository` の照合で、記録の repo と同じ repo に限られる。
  - `integration_id` の無い必須の context（dotfiles の `status-check`）は、別の GitHub App が同じ名前の check-run を出せる状態になると、それで満たされる。
  - 必須の check が実行するテストや script は、保護パスの外なら PR 自身が書き換えられる。
- 台帳のパスかラッパーのパスを文字列に含む Bash は、`git commit -m` の本文であっても guard に拒否される。commit の本文にはこれらのパスを書かない。
- 台帳は手元の machine にあるので、別の環境では未記録になり、環境ごとに 1 回聞かれる。
- 台帳の `v` を上げるときは、新しい版を読める CLI を先に配り、書く hook を後に配る。古い CLI は未知の `v` を無効な行として扱い、merge を止める。
- 他の project の `.tmp/docs/CONTEXT.md` に PR #367 の `## Delivery policy` が残っていても、読まれない。
- delivery-policy 自身を変える PR は保護パスに当たるので、このラッパーでは merge できない。人間か従来の `gh pr merge` で merge する。

## Amendments

### 2026-10-25: Bot が付けた commit status を必須の context として数える

D5 の「check-run で SUCCESS・NEUTRAL・SKIPPED のどれか。commit status は gh の token で書けるので数えない」という一文を、次のように改めた。判定の表の順序、ほかの条件、終了コードは変えていない。

- `integration_id` の無い必須の context は、check run に加えて、creator の型が `Bot` と完全一致する commit status でも満たせる。creator が `User` などの Bot 以外の型か null の commit status は、判定に数えない（pass、fail、pending のどれにもしない）。
- `integration_id` の付いた必須の context は、commit status では満たさない。commit status からは投稿した App の ID を読めないためである。一致する check run が来るまで待つ。
- commit status の state は大文字に揃えて比べる。`SUCCESS` は pass、`PENDING` と `EXPECTED` は pending、`FAILURE` と `ERROR` は fail、それ以外は pending とする。
- 1 つの context について、一致する check run と数える commit status を合わせる。どれかが fail なら fail、どれかが pending なら pending、1 件も無ければ pending とする。GraphQL の `status.contexts` は context ごとに最新の 1 件だけを返す。
- 待つときの理由は次の 4 種類に分けた。
  - まだ終わっていない
  - App に固定されている
  - Bot 以外の commit status しか無い
  - 報告が無い

**きっかけ**: dotfiles の唯一の必須 context `status-check` は commit status だった。`status-check.yml` が `statuses: write` で付けている。この ADR は Consequences で `status-check` を check-run として書いていたが、実際とは違った。そのためラッパーは一度も merge できず、待ちの exit 10 を繰り返した。

**creator の型を数える根拠**: agent が使う gh の token は OAuth App の token（`gho_`）である。2026-10-25 にこの token で、status を 1 件付けた（id 57195279968）。context は `delivery-policy-creator-probe` である。付けた先は merge 済みの commit `1e358b674d16260634f85bf383b14bf021873b0d` である。REST の `creator.type` も GraphQL の `creator.__typename` も `User`（login `berlysia`）だった。同じ commit の `status-check` は `Bot`（`github-actions`）だった。gh の token で付けた status は、Bot として数えられない。そのため D5 が commit status を外した理由は、creator が Bot のものには当たらない。

**却下した案**:

- すべての commit status を数える。agent の gh の token で `success` を付ければ、merge の条件を満たせてしまう。
- creator を github-actions の Bot に限る。限れば、status を付けるほかの App の経路は閉じる。しかし最も手軽な経路（下の受け入れた限界の 1 つ目）は github-actions 名義なので閉じない。外部の CI の App が付ける status も数えられなくなる。
- `status-check.yml` が check run を出すように変え、ラッパーは変えない。dotfiles の症状は消えるが、commit status を必須にするほかの repo では同じ症状が残る。

**受け入れた限界**:

- agent は SSH の push で、別の branch に `statuses: write` の workflow を置ける。その workflow は github-actions 名義で、任意の sha に任意の context の status を付けられる。PR の diff の保護パス（`.github/`）は、別の branch への push を見ない。この経路は `checks: write` で同名の check run を作れるので、改める前の判定でも開いていた。閉じる手段は ruleset で workflow の変更を人間に限ることで、未実施である（`docs/plans/workflow-push-restriction.md`）。
- 保証の強さに差がある。check run は `integration_id` で投稿した App を固定できるが、commit status は creator の型しか見られない。そのため、commit status で満たす必須の context の保証は、App に固定した check run より弱い。弱さの内訳は 2 つある。投稿元の App を特定できないこと、repo に入った任意の Bot と GITHUB_TOKEN の workflow が数えられることである。status だけを付けられる App（`checks: write` を持たないもの）は、偽れる主体として新しく加わった。
- `integration_id` の付いた必須の context に commit status しか付かない repo では、20 分待って exit 12 で止まる。待ちの理由の文言で原因は分かる。
- Bot の `SUCCESS` の後に User が同名の status を付けると、最新の 1 件が User になる。ラッパーは待ち続け、20 分後に exit 12 で止まる。
- `mergeStateStatus` が `CLEAN` かどうかは、GitHub が User の status でも必須の context を満たしたと見るので、偽りへの備えにならない。偽りを防ぐのは、ラッパーの creator の判定だけである。
- 前提として、agent が手にする token は `gho_` である。GitHub App の user-to-server の token（`ghu_`）で付けた status の creator は Bot になりうる。

**拡張点**: 数える creator を login か `databaseId` の allowlist で絞る。今は入れていない。

### 2026-10-29: merge は背景の 1 回の呼び出しで check の完了まで待つ

D6 の「1 回の呼び出しは開始から 100 秒で打ち切る」を、次のように改めた。D3 の Bash の判定にも 1 つ条件を足した。判定の表の順序、ほかの条件、終了コードの意味は変えていない。

- 1 回の呼び出しは、(repo, PR, head sha) ごとの予算の 20 分まで待つ。呼び出しの締切は、開始から 23 分（予算 + 3 分）にした。
- guard は、Bash の `run_in_background` が JSON の `true` のときだけ `merge <PR>` を通す。前景で呼ぶと拒否し、背景で起動し直すよう理由文に書く。`show` と `ask` はすぐ終わるので、前景のまま通す。
- 待っている間も、台帳を 1 周ごとに読み直す。待っている間に範囲を狭めると、次の周で止まる。
- gh の読み込みが失敗した周は、4 周続くまで再試行する。失敗した周は、待ちの記録を書かない。
- 待っている間に、同じ head のまま PR が merge されたら exit 0 にする。理由文は `already merged at <sha>; merger not determined` で、誰が merge したかは判定しない。
- signal を受けたら、終わりの行を 1 行出して exit 10 で終わる。

**きっかけ**: 2026-10-25 に、直近に merge した PR 39 件を測った。最初の check run が始まってから `status-check` が success になるまでに、中央値 143 秒、上位 10% で 234 秒、最大 513 秒かかった。100 秒では多くの PR が exit 10 になり、agent は merge の前に `gh pr checks` を繰り返す監視のループを Bash で自分で書いていた。

**背景で起動する根拠**: 2026-10-29 に、この環境の Claude Code で `sleep 200` と `sleep 1260`（21 分）を起動した。`run_in_background` は `true` にした。どちらも打ち切られずに exit 0 で終わり、完了の通知も来た。21 分の方は、終わるまでに sleep の長さより 41 秒長くかかった。原因は調べていないが、締切の余裕 3 分より短い。同じ日に headless の Claude Code を起動し、PreToolUse の hook の入力を記録した。`"run_in_background": true` は JSON の真偽値だった。

**黙って打ち切られないことの保証**: D6 が防いでいたのは、Bash の打ち切りで終了コードと理由が出なくなることである。この保証は guard の拒否が支え、背景で打ち切られないという実測はその前提である。保証の範囲は guard を通る Claude Code の Bash だけである。利用者が端末で直接起動する場合は対象外で、2 分の制約もない。

**却下した案**:

- 1 回の待ちを 240 秒（上位 10% の値）にし、規則で前景の Bash の `timeout` を 300 秒にする。上位 10% の PR では、呼び直しがまだ要る。前景の Bash の上限は 600 秒なので、予算の 20 分にも届かない。`timeout` を付け忘れると、D6 の問題がまた起きる。
- GitHub の auto-merge（`gh pr merge --auto`）。この ADR が無人の merge の予約として却下した案である。予約した後に台帳の範囲を狭めても、merge は止まらない。
- check がすでに success なら、前景の呼び出しも通す。guard が判定する時点では、待ちが何秒になるかが分からない。check が success のときは、背景の呼び出しもすぐ終わって通知が来る。

**受け入れた差**:

- 締切（呼び出しの開始から）と予算（最初に待った時刻から）の 2 つの時計を残した。gh の各呼び出しの timeout を残り時間で抑える仕組み（DeadlineError）が締切を前提にしているためである。この仕組みを予算の残り時間に合わせれば、時計は 1 つにできる。
- 台帳の読み直しは `gh pr merge` の直前までである。読み直してから merge を起動するまでの間に狭めた範囲と、その間に来た signal は反映しない。
- 台帳の判定を待ちのループの中に移したので、開始時から範囲を狭めてある場合も、止まるのは、repo、viewer、最初の head を読んだ後になる。その間に gh が失敗すると、exit 20 でなく 40 になる。どちらでも merge はしない。
- 待ちの記録のファイルは、読んでから書き戻す作りである。同時に書くと、片方の記録は消えうる。消えると予算が少し延びるが、merge の条件は緩まない（`docs/plans/delivery-policy-waits-concurrency.md`）。
