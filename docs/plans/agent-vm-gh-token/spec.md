# Spec: agent-vm の gh を repo 単位の fine-grained PAT で認証する

## Goal

agent-vm の VM 内の `gh` が、その repo だけに権限を絞った fine-grained PAT で動くようにする。PAT の発行・1Password への保存・env ファイルへの登録・期限前の更新を、`agent-vm env gh` 1 コマンドで行えるようにする。

## Experience Delta

- 変更前: VM 内の `gh` は未認証で、API を使う操作（`gh pr create` など）が失敗する。認証するには、手で PAT を作り、1Password に保存し、`agent-vm env edit` で `op://` 参照を書く必要がある。期限切れは `gh` が失敗して初めて分かる。
- 変更後: repo で `agent-vm env gh` を実行すると（初回は repo 名の入力と、vault を Personal / Formal から選ぶ手順がある）、権限と期限を埋めた作成画面が開く。repo を選んで Generate し、token を貼り付ければ、保存と登録までが終わる。以後は `agent-vm claude` / `codex` / `shell` の起動時に `GH_TOKEN` が入る。期限の 7 日前からは起動のたびに更新コマンドが表示され、同じコマンドで更新できる。更新の最後には、片付けとして、GitHub 上で削除する古い PAT の名前と、1Password で archive する古い item のコマンドが表示される。

## Architecture

秘密の参照は、これまでどおり repo 別 env ファイルの `GH_TOKEN=op://<vault>/<item id>/credential` の 1 行だけが持つ。どの item を使っているかの正本はこの行である。秘密ではない管理情報は、host 側にしかない状態ファイル `~/.config/agent-vm/repos/<machine>.gh` に置く。VM に mount されるのは repo、staging、outbox の 3 つだけなので（`executable_agent-vm:155-159`）、VM はこのファイルを読むことも書くこともできない。

```
状態ファイル repos/<machine>.gh（host のみ、600、秘密を含まない、1 行 1 項目の key=value）
  v=1                         書式の版。1 以外なら env gh は die する
  repo=<owner>/<repo>         信頼の根。人が入力して記録し、以後は origin と突き合わせる
  vault=Personal|Formal        この repo の token を置く vault。人が選んで記録する。PAT の期限もこれで決まる
  pat_name=<名前>             いま使っている PAT の、GitHub 上の名前。次の更新で「削除する古い PAT」として表示する
  expires=YYYY-MM-DD          いま使っている PAT の期限（UTC）。起動時の警告に使う

agent-vm env gh [--repo OWNER/REPO] [--vault Personal|Formal]
  0. 前提: op / jq / curl / perl が無ければ die。状態ファイルがあれば読み、書式違反なら die
  1. env ファイルを検査: 全体共通の env.1password に GH_TOKEN 行があれば die。
     repo 別 env ファイルの GH_TOKEN 行は「0 行」か「自動形式の 1 行」だけを許し、それ以外は die。
     自動形式の 1 行があれば、その vault と id を「古い item」として覚える
  2. repo を決める: 状態ファイルの repo があり、--repo が無ければそれを使う（origin と食い違えば die）。
     それ以外（初回、または --repo での付け替え）は、利用者に OWNER/REPO を入力させ、--repo と origin の値と突き合わせる
  2b. vault を決める: --vault があればそれ、無ければ状態ファイルの vault（repo を付け替えたときは使わない）、
     どちらも使えなければ Personal / Formal を選ばせる。
     期限の日数は vault から決まり（Personal は 90 日、Formal は 30 日）、ここで 1 回だけ計算して以後の手順で使う。
     op vault get で vault が使えることを確かめる（PAT を作らせる前に止めるため）
  3. PAT 名 <base>-<hash>-<YYMMDDHHMM>（UTC）を決める。状態ファイルの pat_name と同じなら die
  4. template URL を表示（darwin では open も行う）──▶ PAT 作成画面（repo の選択と Generate は手作業）
  5. token を tty から非表示で読み、前後の空白・CR・LF を除いて ^github_pat_[A-Za-z0-9_]{1,250}$ で検査
  6. curl で GET /repos/<owner>/<repo> を検証（token は stdin のヘッダ）──▶ api.github.com
  7. op item create --vault V --format json -（JSON は stdin）| jq -r .id ──▶ 1Password に新しい item
  8. op read で新しい参照が解決できることを確かめる（値は /dev/null に捨てる）
  9. env ファイルの GH_TOKEN 行を新しい参照にする（他の行はそのまま残す）
 10. 片付けを表示: 古い PAT の名前（状態ファイルの以前の pat_name）と削除画面の URL、
     古い item を archive する op コマンド（手順 1 で覚えた vault と id）。どちらも手作業
 11. 状態ファイルを書く（v、repo、vault、pat_name、expires）。失敗したら、書くはずだった内容をそのまま表示する

agent-vm claude|codex|shell（既存の run_tool）
  notice_orphan_env の後に notice_gh_token_expiry（常に 0 を返す）:
  - repo 別 env ファイルに自動形式の GH_TOKEN 行があり、状態ファイルの expires が今日 + 7 日以内なら警告する
  - 自動形式の行があるのに、状態ファイルが無いか壊れていれば「期限が分からない」と警告する
  - 全体共通の env.1password に GH_TOKEN 行があれば警告する
  inject_secrets（変更なし）が GH_TOKEN=op://… を解決して VM の tmpfs に渡す
```

## Alternative Approaches (Greenfield View)

### 差分最小案 (Incremental)

コードを変えず、docs に「PAT を手で作り、`agent-vm env edit` で `GH_TOKEN=op://…` を書く」手順だけを追記する。既存の `inject_secrets` がそのまま `GH_TOKEN` を VM に渡す（`executable_agent-vm:508-538`）。期限切れは GitHub のメール通知と `gh` の失敗で気付く。

### 白紙設計案 (Greenfield)

ゼロから設計するなら、人手の要らない短命 token を host が起動のたびに発行する。GitHub App を 1 つ登録し、その秘密鍵を 1Password に置き、launcher が起動時に JWT を作って installation access token を発行する。`repositories` を指定すればその repo だけに絞れ、ローテーションも手作業の発行も無くなる。起源: 長期の秘密を VM に渡さないという ADR-0018 K7 の方針を、gh にも機構として当てはめると、この形になる。

### 採用案と理由

半自動の fine-grained PAT（本 spec の Architecture）を採用する。白紙案を採らない理由は token の寿命である。installation access token は 1 時間で失効し（GitHub Docs `authenticating-as-a-github-app-installation.md:33`）、claude のセッションは 1 時間を超えることが普通にある。セッション中に token を差し替える経路は無い（`session_exec` は `orb -m … bash -lc` を 1 回実行して終わるまで戻らない。`executable_agent-vm:552`）。user access token でも寿命は 8 時間で（`refreshing-user-access-tokens.md:22`）、加えて refresh token の保管と App の登録・秘密鍵の管理が増える。

差分最小案を採らない理由は、ユーザーがスクリプト化を求めているためである。repo ごとに 4 つの手作業（作成画面での設定、1Password への保存、参照の記入、期限の把握）があり、更新のたびに繰り返す。fine-grained PAT を作る API は無い（research.md）ので、repo の選択と Generate のクリックだけが手作業として残る。

### 1Password の item の持ち方

- **(i) 固定 title の item を参照し、更新では消して作り直す**: env の行は `op://V/<固定 title>/credential` のまま変わらない。しかし「消す → 作る」の間に失敗すると参照先が無くなり、`op inject` が失敗して全起動が止まる（`executable_agent-vm:517` は fail-closed）。「作る → 消す」の順では同じ title の item が一時的に 2 つになり、title での参照が曖昧になる。
- **(ii) 同じ item を `op item edit --template <file>` で書き換える**: 参照は変わらない。しかし token を一時ファイルに書く必要がある。mac の host には `/dev/shm` のような tmpfs が既定で無いので、永続ディスクに秘密が載る。
- **(iii) 採用: 更新のたびに新しい item を作り、id で参照する**: 作って解決できることを確かめてから参照を書き換えるので、どの時点で失敗しても env は解決できる item を指している。

### 古い item と古い PAT の片付け（Round 2 で方針を変えた点）

- **自動で archive する案（Round 1〜2 の案）**: 状態ファイルに `item` と `prev_item` を持ち、条件を満たすときに古い item を `op item delete --archive` する。Round 2 のレビューで、この追跡状態から 5 つの欠陥が見つかった。手順の途中で失敗すると期限の警告が止まる、再実行で古い item が追跡から外れる、続けて失敗すると復旧できなくなる、vault の変更を表せない、archive の前提条件に抜けがある。どれも「env の行と状態ファイルの 2 か所が item を持つ」ことから生じる。
- **採用: 片付けは表示して手で行う**: item の正本を env の行 1 か所にする。更新の最後に、古い item を archive する `op` コマンドと、GitHub 上で削除する古い PAT の名前を表示する。GitHub の PAT を削除する API は無いので、片付けのうち GitHub 側はもともと手作業である。手作業として増えるのは、表示されたコマンドを 1 回実行することだけになる。代わりに、状態の不整合という種類の欠陥がまとめて無くなる。

## Key Decisions

この節の K 番号は本 spec 内のもので、ADR-0018 の K 番号を指すときは「ADR K7」のように書く。

- **K1: サブコマンドは `agent-vm env gh [--repo OWNER/REPO] [--vault Personal|Formal]` の 1 本にし、初回の登録と更新を同じ処理で行う** — 既存の `env edit|adopt` と同じく、repo 別 env ファイルを扱うコマンドの並びに置く。PAT の期限は vault から決まるので（K10）、日数を指定するオプションは持たない。`show_help` に 1 行足す。
  - 参照: `home/dot_local/bin/executable_agent-vm:689-695`（`env` の振り分け）
  - 参照: `home/dot_local/bin/executable_agent-vm:19-31`（`show_help`）
- **K2: token の権限は、VM の agent が使う gh の操作ごとに根拠を持つものだけにする** — `pull_requests=write`（`gh pr create` / `edit` / `comment` / `review`）、`issues=write`（`gh issue create` / `comment`）、`contents=read`（`gh pr create` が head と base を比べ、`gh pr view --json files` が差分を読むため）、`actions=read`（`gh run list` / `view --log` で CI の失敗を調べるため）。`contents=write` は付けない。push は SSH agent の転送で行う（ADR K3）。token に push 権限を持たせると、SSH を通らない 2 本目の push 経路ができてしまう。同じ理由で、`gh pr merge`（contents の write が要る）は VM からは行わず host で行う。`workflows` も付けない。ただし PAT は利用者本人として動くので、`pull_requests=write` があれば、他者（Renovate など）の PR を `gh pr review --approve` で承認し、`gh pr merge --auto` で auto-merge を有効にできる可能性がある（未確認。成立するかは branch protection の設定にもよる）。この経路が成立するなら、contents の write が無くても merge まで進みうる。これは R5 のゲートで確かめ、有効にできる場合は承認前にこの spec を改訂する。template URL の `target_name` は付けない（community #188111 の不具合があり、省略すれば自分のアカウントになる）。org の repo では resource owner を画面で選ぶよう表示する。
  - 参照: research.md「GitHub 側の事実」（パラメータ名と値の範囲）
- **K3: PAT の名前と template URL** — `name` は `<base>-<hash>-<YYMMDDHHMM>`。`<base>-<hash>` は machine 名から先頭の `agent-` を除いた部分（最長 27 文字）、日時は UTC の分単位で、全体は最長 38 文字となり、40 文字の上限に収まる。新旧の PAT は GitHub の一覧で日時で見分けられる。状態ファイルの `pat_name` と同じ名前になったとき（同じ分のうちに再実行したとき）は、1 分待つよう表示して die する。状態ファイルに記録される前に失敗した回の PAT と同じ名前になる場合は、GitHub の作成画面が同じ名前を拒否すると想定している（R5 で確かめる）。`description` は `agent-vm GH_TOKEN for <owner>/<repo>. Select only this repository and keep the expiration.`。`name` と `description` は perl で URL エンコードする。`expires_in` は vault から決まる日数（K10）。URL は常に表示し、darwin で `open` があれば開く。
  - 参照: `home/dot_local/bin/executable_agent-vm:43-49`（machine 名の作り方。`agent-` + 最長 20 文字 + `-` + 6 文字）
- **K4: repo の信頼の根は、人が入力して状態ファイルに記録した `repo`** — origin の URL（`git remote get-url origin`。`resolve_repo_root` と同じく fsmonitor と hooks を無効にする）は VM が書き換えられる `.git/config` から来るので、信頼の根にしない。origin の URL は `git@github.com:O/R`、`ssh://git@github.com/O/R`、`https://github.com/O/R` の 3 形だけを受け付け、末尾の `/` と `.git` を取り除いて `O/R` を作る。host が `github.com` 以外なら「解析できない」として扱う（検証先は api.github.com に固定のため）。origin から作った値は、`^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$` に合い、どちらの要素も `.` や `..` でないときだけ使う。合わなければ「origin は解析できない」とだけ表示し、生の値は表示しない（制御文字で表示を偽装されないため）。
  - repo 名の比較は、GitHub と同じく大文字と小文字を区別しない。
  - **状態ファイルに `repo` があり、`--repo` が無いとき**: 記録した `repo` を使う。origin の値が記録と食い違うか、origin を解析できなければ、記録した値と origin の値（上の検査を通った場合のみ）を表示して die する。案内には `agent-vm env gh --repo OWNER/REPO` と書き、origin の値をコマンド例に埋め込まない。GitHub 上で repo の名前を変えた場合は、先に host 側で `git remote set-url origin` を直してから `--repo` を使うよう案内する（付け替えでも origin との一致を求めるため）。
  - **それ以外（初回、または `--repo` での付け替え）**: 「この repo の GitHub 上の名前を OWNER/REPO の形で入力せよ。origin は VM から書き換えられるので、host 側で確かめた名前を入力すること」と表示し、入力を受ける。入力は同じ正規表現で検査する。`--repo` があれば入力と一致すること、origin の値があれば入力と一致することを求め、一致しなければ die する。付け替えのときは、記録していた値も表示する。
  - 検証で分かるのは「token でその repo が見える」ことまでで、token の権限が 1 repo に絞られているかは分からない（R2）。権限の範囲は、作成画面で人が repo を選ぶことで決まる。
  - 参照: `home/dot_local/bin/executable_agent-vm:35-41`（git を呼ぶときの hardened flags）
  - 参照: `home/dot_local/bin/executable_agent-vm:281`（ADR K13 の監視対象 `EXEC_CONFIG_RE` に `remote.*.url` は含まれない）
- **K5: 1Password には更新のたびに新しい item を作り、id で参照する（比較は Alternative Approaches）** — item は API Credential で、title は PAT 名と同じ `<base>-<hash>-<YYMMDDHHMM>` に `agent-vm-gh ` を前置したもの。`op item create --vault V --format json -` の出力は、そのまま `jq -r .id` に渡して id だけを取り出す。出力の全文は変数に入れず、表示もしない。id が `^[a-z0-9]{26}$` に合わなければ die する。続けて `op read "op://V/<id>/credential" >/dev/null` で参照が解決できることを確かめ、失敗すれば die する。env を書き換えるのはこの後である。
  - vault は K10 の規則で決まる（`Personal` か `Formal`）。
  - `op` は `--account` を付けず、既定のアカウントで呼ぶ。起動時に参照を解決する既存の `inject_secrets` の `op inject` も既定のアカウントを使うので（`executable_agent-vm` の `inject_secrets`）、`env gh` だけを固定すると、保存した item と起動時の解決とでアカウントが食い違いうる。複数のアカウントにサインインしている環境では、既定のアカウントに `Personal` と `Formal` があることが前提になる（research.md 末尾の T0 で、my.1password.com について確認済み）。既定のアカウントが組織側に切り替わっていて、そこに同じ名前の vault があると、token が組織の vault に黙って保存されうる。そこで手順 2b の `op vault get` の後に、使うアカウント（`op whoami` の URL。秘密ではない）を「アカウント <URL> の vault <名前> に保存する」と表示し、PAT を作らせる前に利用者が気付けるようにする。既定のアカウントに vault が無ければ、`op vault get` が PAT を作る前に止める。docs には、`OP_ACCOUNT` と `OP_SERVICE_ACCOUNT_TOKEN` が設定されていない前提であることを書く。
  - 古い item は自動では archive しない。手順 1 で覚えた古い参照の vault と id を使い、`op item delete --archive <id> --vault <vault>` を表示する。表示には「title が `agent-vm-gh ` で始まることを確かめてから実行せよ」と添える（手で書いた行が自動形式と同じ形をしている場合に、別の用途の item を指しうるため）。repo 別 env ファイルと全体共通の env.1password に、古い id がまだ（コメント行も含めて）残っていれば、「archive すると `op inject` が失敗して起動が止まるので、先にその行を消せ」と添える。vault を途中で変えても、古い item の vault は env の行から取るので、表示されるコマンドの vault は古い item のある vault になる。
  - 参照: research.md「1Password CLI」（`op item create -` は stdin を受け、`op item edit` は受けない）
- **K6: 秘密は argv、端末の表示、ログ、永続ディスクに出さない** — token は `read -rs` で受ける。読み込み元は `${AGENT_VM_TTY:-/dev/tty}` で、`AGENT_VM_TTY` はテストのための差し替えに限る（docs には書かない）。tty が開けなければ die する。検証では、`printf 'Authorization: Bearer %s\n'`（組み込みの printf）で作ったヘッダを `curl -sS --max-time 15 -o /dev/null -w '%{http_code}' -H @-` の stdin に流す。1Password への保存では、`printf '%s'` で token を `jq -Rs` の stdin に流して item の JSON を作り、それを `op item create` の stdin に流す。`op read` の出力は `/dev/null` に捨てる。token を扱う関数の中で `set -x` は使わない。
  - 参照: `tests/agent-vm/run.sh:289-294`（`test_secret_values_never_appear_in_argv` と同じ方法で検査する）
- **K7: 保存の前に token を検証する** — `GET https://api.github.com/repos/<owner>/<repo>` が 200 以外なら die し、1Password には何も保存しない。表示は HTTP のステータスと、それに応じた案内だけにし、応答の body は表示しない。`000` は「GitHub に接続できない」、`401` は「token が無効か期限切れ」、`403` と `404` は「作成画面でこの repo を選んだか確かめよ」と案内する。この検証で止められるのは、貼り付けの誤り、無効な token、private repo の選び忘れ（404 になる）である。止められないのは、public repo の選び忘れ（200 になる）と、全 repo を対象にした token（R2）である。
- **K8: env ファイルの検査と書き換え** — 対象は `^[[:space:]]*(export[[:space:]]+)?GH_TOKEN=` に合う行。
  - 全体共通の `env.1password` に合う行があれば die する。全 VM 共通の長期 token は注入しない（ADR K7）からである。
  - repo 別 env ファイルでは、合う行が 0 行か、自動形式 `^GH_TOKEN=op://[A-Za-z0-9_.-]+/[a-z0-9]{26}/credential$` の 1 行だけを受け付ける。検査の順序は、まず合う行に CR が含まれていないか（含まれていれば「CRLF の改行は扱えない」と表示して die）、次に行数と形式である。それ以外（手で書いた行、2 行以上、`export` 付き）は「手で書いた GH_TOKEN 行がある。`agent-vm env edit` で消してから実行せよ」と表示して die する。この検査は template URL を表示する前（手順 1）に行い、無駄な PAT を作らせない。自動形式は「このコマンドが書いた行」の印であると同時に、古い item を表示するための vault と id の出どころになる。
  - 書き換えでは、合う行があればその位置で新しい行に置き換え、無ければ末尾に足す。元のファイルが改行で終わっていなければ、足す前に改行を補う。他の行はバイト単位でそのまま残す。repo 別 env ファイルが無ければ作る（`cmd_env_edit` と同じく umask 077）。
  - env ファイルと状態ファイルは、どちらも同じディレクトリの一時ファイル（名前は `.<元の名前>.tmp.XXXXXX` で、`*.env.1password` の glob に当たらない）に umask 077 で書いて `mv` する。`mv` は同じファイルシステム内なので、起動中の `run_tool` が読むのと競合しても、新旧どちらか完全な内容が読まれる。ロックは取らない（`cmd_env_edit` と同じ）。一時ファイルは関数の中の trap で、失敗時と中断時に消す。
  - 参照: `home/dot_local/bin/executable_agent-vm:780-786`（env ファイルの作成方法）
  - 参照: `home/dot_local/bin/executable_agent-vm:500-538`（`env_files_for` は全体共通 → repo 別の順に連結し、VM 側は `set -a; . envf` で読む。後勝ち）
- **K9: 状態ファイルの書式** — `IFS= read -r` で 1 行ずつ読み、行末の CR と前後の空白を除き、最初の `=` で key と value に分ける。`source` や `eval` は使わない。知っている key（`v`、`repo`、`vault`、`pat_name`、`expires`）だけを読み、同じ key が複数あれば最初の行を使い、知らない key は無視する。書き直すときは知っている key だけを書く（知らない key は消える）。5 つの key はすべて必須で、どれかが欠けていれば壊れているものとして扱う。値は読むときに検査する。`v` は `1`、`repo` は K4 の正規表現、`vault` は `Personal` か `Formal`、`pat_name` は `^[a-z0-9-]{1,40}$`、`expires` は `^[0-9]{4}-[0-9]{2}-[0-9]{2}$`。
  - `env gh` は、状態ファイルがあって `v` が 1 でないか、どれかの値が検査に通らなければ、「状態ファイル <パス> が壊れている。消してから実行し直せ（repo の入力と vault の選択からやり直しになる）」と表示して die する。
  - 起動時の警告の扱いは K11 に書く。
- **K10: vault と期限は repo ごとに選ぶ（ユーザーの決定）** — vault は `Personal` と `Formal` の 2 つで、repo ごとにどちらかを使う。PAT の期限は vault で決まり、`Personal` は 90 日、`Formal` は 30 日である。この対応は launcher の中に定数として 1 か所で持つ。日数は手順 2b で 1 回だけ計算し、template URL の `expires_in`（K3）と状態ファイルの `expires`（K11）の両方に同じ値を使う。
  - **決め方**: `--vault` があればその値を使う。無ければ状態ファイルの `vault` を使う。どちらも使えないとき（初回、`--repo` で記録と違う repo に付け替えたとき）は、「この repo の token を置く vault を選べ（Personal: 期限 90 日 / Formal: 期限 30 日）」と表示して入力を受ける。repo を付け替えたときに古い repo の vault を引き継がないのは、vault は repo の性質で決まるからである。env に自動形式の行があれば、その行の vault を「今の vault」として一緒に表示する。どの経路でも、`Personal` か `Formal` 以外の値（大文字小文字も区別する。`personal` は die）は die する。入力は K6 と同じ `${AGENT_VM_TTY:-/dev/tty}` から読み、開けなければ die する（K4 の repo の入力も同じ）。
  - **名前で持つ理由**: vault は ID ではなく名前（`Personal` / `Formal`）で持つ。既存の `env.1password` も `op://<vault 名>/…` の形で書かれていて、vault の名前を変えればそちらも一緒に壊れるので、ID にしても守れる範囲は広がらない。名前を変えた場合は、次の事前確認が PAT を作る前に止める。
  - **事前確認**: vault が決まったら、`op vault get <vault>` で使えることを確かめ、失敗すれば die する。作成画面を開く前（手順 4 より前）に止めて、作った PAT が無駄にならないようにする。
  - **「repo の付け替え」の定義**: `--repo` の値が状態ファイルの `repo` と違う（大文字小文字を区別しない比較で）ときだけを付け替えと呼ぶ。`--repo` が記録と同じなら、付け替えではなく通常の更新として扱う（K4 の入力の確認は求める）。
  - **食い違いの検出**: 状態ファイルの `vault` を使う経路（`--vault` が無く、repo の付け替えでもないとき）で、env の自動形式の行の vault と状態ファイルの `vault` が違えば、両方を表示して die し、`--vault` で明示するよう案内する。手順 11 で失敗した後に再実行したときに、vault の付け替えが黙って元に戻るのを防ぐためである。
  - **付け替え**: `--vault` で env の行と違う vault を指定したときは、env の行の vault（古い item のある vault）と新しい vault、新しい期限の日数を表示する（30 日から 90 日へ気付かずに延ばすのを防ぐため）。新しい item は新しい vault に作る。古い item の archive コマンドは env の行の vault を使うので（K5）、古い vault の item を指す。
  - **env の行の vault**: K8 の正規表現（`[A-Za-z0-9_.-]+`）は `Personal` と `Formal` より広い。env の行の vault は古い item の場所を示すだけなので、値の範囲は検査せず、archive コマンドにそのまま使う。
  - **vault を読める人**: token は選んだ vault を読める人なら誰でも読める。`Formal` が他の人と共有する vault なら、その人たちも PAT を読める。どちらの vault を選ぶかは、この点も含めて利用者が決める。
  - **既定値を持たない理由**: どちらに置くかは repo の性質で決まり、取り違えると期限が変わる。初回に必ず選ばせ、以後は記録を使う。
  - 期限の 90 日では、VM が侵害されてから利用者が気付いて PAT を削除するまでの間、その repo に対して K2 の権限が使える時間が長くなる。security レビューは 30 日を勧めていた。どちらを選ぶかは repo ごとに利用者が決める。
- **K11: 期限の警告** — 期限は状態ファイルの `expires` に、perl の `gmtime` で「今日（UTC）+ vault から決まる日数」を書く（macOS の `date` は GNU の `-d` を持たない。launcher は既に perl を使っている）。`run_tool` の `notice_orphan_env` の直後に `notice_gh_token_expiry "$MACHINE"` を呼ぶ。次の場合だけ `step` で 1 行出す。
  - repo 別 env ファイルに自動形式（K8）の GH_TOKEN 行があり、`expires` が「今日 + 7 日」以前: `GH_TOKEN for this repo expires on <date>; renew with: agent-vm env gh`（過ぎていれば `expired on`）。
  - 自動形式の行があるのに、状態ファイルが無いか壊れている（K9）: 期限が分からないことと、`agent-vm env gh` で登録し直すよう案内する。`env gh` を通した運用では自動形式の行と状態ファイルが一緒に書かれるので、片方だけがあるのは、状態ファイルを手で消したか、`env gh` 以前の env ファイルを adopt した場合に限られる。
  - 全体共通の env.1password に GH_TOKEN 行がある: 全 VM に同じ token が入っていることを警告する（ADR K7）。
  
  GH_TOKEN 行が無いとき、手で書いた形の行のとき、期限まで 7 日より長いときは何も出さない。どの場合も 0 を返し、起動は止めない（`notice_orphan_env` と同じ）。期限の警告は害が見えるとき（期限が近いか過ぎたとき）だけ出す。
  
  既知の限界: 状態ファイルは item の id を持たないので、警告は状態ファイルの `expires` が env の今の item のものかを確かめられない。vault も同じで、状態ファイルの `vault` が env の行の vault と食い違うことがある（次の `env gh` では K10 の検出で止まる）。食い違うのは、主に K13 の手順 9〜11 の間で止まった場合と、env の行や状態ファイルを手で書き換えた場合で、表示された内容で状態ファイルを手で書けば解消する。id を状態ファイルに持たせると「2 か所が item を持つ」問題（Alternative Approaches）が戻るので、持たせない。
  - 参照: `home/dot_local/bin/executable_agent-vm:83-85`（perl の利用）
  - 参照: `home/dot_local/bin/executable_agent-vm:737-744`（`notice_orphan_env` は常に 0 を返す）
  - 参照: `~/.claude/rules/code-quality.md`「Recoverable State Must Announce Itself」
- **K12: 外部コマンドの呼び出し規約** — launcher の既存の規約に合わせる。stdin を使わない外部コマンド（`op read`、`git`、`open`）には `</dev/null` を付け、新しく呼ぶ外部コマンドはすべて fd 9（ロック）を閉じる（`9>&-`）。stdin を使うもの（`curl -H @-`、`jq`、`op item create -`）にはパイプで渡す。`x=$(f)` の中では errexit が効かないので、各ステップに `|| die` を付け、`local x=$(f)` は使わない。
  - 参照: `home/dot_local/bin/executable_agent-vm:5-8`（errexit の規約）
  - 参照: `home/dot_local/bin/executable_agent-vm:517`（`</dev/null 9>&-` の例）
- **K13: 途中で失敗したときに残る状態** — env の行が item の正本なので、どこで失敗しても env は解決できる item を指している。
  - 手順 0〜6 で失敗: 何も書かれていない。手順 4 の後なら、作成画面で PAT を作っていればその名前で残っているので、名前を表示し、作っていれば削除するよう案内する。
  - 手順 7 で `op item create` 自体が失敗した: 1Password には何も残らない。PAT の名前を表示し、削除するよう案内する。
  - 手順 7 で、item ができた後に id を取り出せなかった: title（`agent-vm-gh <PAT 名>`）を表示し、1Password で探して消すよう案内する。PAT の名前も表示する。
  - 手順 8（参照の確認）で失敗: 新しい item の vault と id、PAT の名前を表示し、消すよう案内する。env は古い item のまま。
  - 手順 9（env）で失敗: 同じく新しい item の vault と id、PAT の名前を表示する。env は古い item のまま。
  - 手順 7 の「title を表示して探す」案内にも、item を作った vault を含める。
  - 手順 10（片付けの表示）は表示だけなので失敗しない。表示には、片付けに加えて、手順 11 で状態ファイルに書く 5 行と「ここから先で止まっても再実行せず、この 5 行で状態ファイルを手で書け」という案内を含める。状態ファイルを書く前に表示するのは、手順 11 で失敗しても、手順 9 と 11 の間で中断されても、古い item と古い PAT の名前と、状態ファイルに書くべき内容が一度は表示されているようにするためである（手順 9 と 10 の間で中断された場合だけは表示されない。そのときは R6 と同じく item の title から PAT の名前が分かる）。
  - 手順 11（状態ファイル）で失敗: env はもう新しい item を指している。状態ファイルは古いままなので、書くはずだった内容（`v`、`repo`、`vault`、`pat_name`、`expires` の 5 行）をそのまま表示し、その内容で状態ファイルを手で書くよう案内する。再実行はしないよう案内する。再実行すると、手順 1 は新しい item を「古い item」として扱い、手順 10 は 1 世代前の PAT の名前を表示してしまうからである。
  - Ctrl-C で中断: 一時ファイルは trap で消える。どの手順まで進んだかで、上のいずれかの状態になる。
- **K14: 既存のサブコマンドとのつながり** — `env adopt` は、env ファイルと一緒に状態ファイルも移す。移動先の状態ファイルの有無は、env ファイルを移す前に、env ファイルの検査（`executable_agent-vm:793`）と並べて検査し、あれば何も移さずに die する。die のメッセージには、そのパスと、状態ファイルだけが残っているなら手で消してよいことを書く。移動元に状態ファイルが無ければ env ファイルだけを移す。GitHub 上で repo の名前が変わっていた場合は、adopt の後の `env gh` が origin との食い違いで止まるので、`--repo` で付け替える。状態ファイルだけが残った machine（env ファイルが無い）は orphan の検出（env ファイルが基準）にかからず、adopt の対象にもならない。害は無いので、docs に「手で消してよい」と書く。`rm` と `gc` は、env ファイルと同じく状態ファイルも消さない（host 側で書いたファイルは消さない方針、`executable_agent-vm:700`）。消えずに残った状態ファイルは、別の repo が同じ machine 名を得ても、記録した `repo` と origin の突き合わせで止まる。adopt すると machine 名が変わるので、それまでの PAT と item の名前には古い machine 名が残る。状態ファイルの `pat_name` は古い名前のままなので、次の更新の片付けの表示には正しい名前が出る。
  - 参照: `home/dot_local/bin/executable_agent-vm:700-704,712-720,788-796`（`forget_machine`、`orphaned_env_machines`、`cmd_env_adopt`）
- **K15: ADR-0018 と docs への記録** — ADR-0018 の `## Amended by` に 1 行追記する。内容は 2 点。gh の token は ADR K7（全 VM 共通の長期 token は注入しない）の**例外**として注入する。理由は、token が repo ごとに分かれ、権限も K2 の範囲に絞られるからである。残るリスクは、VM の中の agent が期限まで token を読めることである。ADR R21（VM に GitHub の token を置かない）は bootstrap の話なので変わらない。token は bootstrap ではなく、tool を起動するときにだけ注入されるからである。`docs/agent-vm.md` の秘密の節には次を書く。
  - 使い方（初回は repo 名の入力と vault の選択がある。期限は Personal で 90 日、Formal で 30 日。vault は `--vault` で変えられる）
  - vault を読める人は token も読めること（K10）
  - 侵害が疑われるときの失効手順: `https://github.com/settings/personal-access-tokens` で、状態ファイルの `pat_name` の PAT を削除する。状態ファイルが無ければ、env の行の id の item の title（`agent-vm-gh <PAT 名>`）から名前が分かる。
  - 更新の後は、表示された片付け（古い PAT の削除と古い item の archive）を実行すること。しないと、古い token が期限まで有効なまま残る。表示を見逃した場合は、PAT の一覧で `<base>-<hash>-` で始まるもの、1Password で title が `agent-vm-gh ` で始まるものを探す（adopt した repo では、adopt 前の machine 名の PAT も探す）。
  - `env gh` を同時に実行しないこと（R4）。
  - `GH_TOKEN` は VM の中で claude / codex / bash の環境変数になり、そこから起動される全てのプロセスから読めること。
  - `agent-vm rm` は PAT も 1Password の item も状態ファイルも消さないこと。状態ファイルだけが残った場合は手で消してよいこと。
  - archive した item にも token が残ること。
  - public repo の選び忘れと、全 repo を対象にした token は検証で止められないこと。
  
  spec と plan は `docs/plans/agent-vm-gh-token/` へ移す（`.tmp/sessions/` は 7 日で GC される）。
  - 参照: `docs/decisions/0018-agent-vm-orbstack.md:26,54,69,73-76`（ADR K7、却下理由、R21、Amended by の書き方）

## Risks

- **R1**: 初回の入力で、利用者が VM の書き換えた origin と同じ誤った repo を入力すると、それが記録される → 入力を求める文面で「host 側で確かめた名前を入力せよ」と明示する。権限の範囲を最終的に決めるのは作成画面で人が選ぶ repo である。2 回目以降は記録との食い違いで止まる。
- **R2**: 検証では、public repo の選び忘れと、全 repo を対象にした token を止められない → 前者は最初の書き込み系の `gh` 操作で 403 になって分かる。後者は検出できないので、作成画面の description と docs で「この repo だけを選ぶ」ことを示す。応答の `permissions` で token 自体の範囲が分かるかは確かめていないので、設計には入れない。
- **R3**: 作成画面で期限を変えると、記録した期限と実際の期限がずれる → description に「期限を変えない」と書く。ずれても、GitHub からの期限切れ前のメール通知が残る。期限が API の応答ヘッダから取れるかは R5 で見る。取れると分かった場合の K11 の改訂は、この spec の範囲外として別に扱う。
- **R4**: `env gh` を同時に 2 つ実行すると、後から書いた方が env に残り、先の方の item と PAT は使われずに残る → 対話的なコマンドなのでロックは取らない。残った方は片付けの表示に出ないので、docs に「同時に実行しない」と書く。これを許容するのは、残るのが使われていない PAT と item だけで、env は常に解決できる item を指しているからである。残った PAT は名前に日時が入っているので、PAT の一覧で見つけられる。
- **R5**: mac 実機でしか確かめられない前提がある → plan-1 の最初のタスクを、実機で次を確かめるゲートにする。
  - `op item template get "API Credential"` の秘密のフィールドの id が `credential` であること。違えば K5 の参照の field 名を直す。
  - `Personal` と `Formal` の両方で、`op vault get`、`op item create`、`op://<vault>/<id>/credential` の `op read` と `op inject` による解決ができること。
  - `curl --version` が 7.55 以上であること（`-H @-` のため）。
  - `jq` が PATH にあること（darwin の brews に宣言済み。`home/.chezmoidata/packages.yaml`）。
  - K2 の権限の PAT で、他者の PR に対して `gh pr review --approve` と `gh pr merge --auto`（auto-merge の有効化）ができるか。できる場合は、K2 で権限を減らすか、残るリスクとして K15 に書くかを決めて spec を改訂する。
  - 同じ名前の fine-grained PAT を作成画面が拒否するか（K3）。
  - 参考: PAT での API 応答に `github-authentication-token-expiration` ヘッダがあるか。
  - ゲートに通らなかった場合は実装に進まず、この spec を改訂する（field 名の違いは K5 の修正で済む。id での参照が解決できない場合は Alternative Approaches の比較からやり直す）。
- **R6**: 状態ファイルを手で消すと、次の `env gh` は repo の入力からやり直しになり、片付けの表示に古い PAT の名前が出ない → env の古い参照は残っているので、古い item の archive コマンドは表示される。PAT の名前は item の title（`agent-vm-gh <PAT 名>`）から分かる。状態ファイルを消してから次の `env gh` までの起動では、K11 の「期限が分からない」警告が出る。
- **R8**: `Personal` の 90 日では、VM が侵害されてから利用者が気付いて PAT を削除するまでの間、その repo に対して K2 の権限が使える時間が `Formal` の 3 倍になる → repo ごとに利用者が選ぶ（K10）。security レビューは 30 日を勧めていた。
- **R7**: 片付けは表示だけなので、実行し忘れると古い PAT と古い item が期限まで有効なまま残り、VM の侵害から失効までの時間が更新のたびに延びうる → 自動化しない理由は Alternative Approaches の「古い item と古い PAT の片付け」に書いた。docs に「更新の後は片付けを実行する」ことと、見逃したときの探し方を書く（K15）。

## ISO 25010 次元選択

- **セキュリティ（機密性・完全性）**: token が argv、端末の表示、ログ、永続ディスクに出ないこと。VM が書き換えられる origin で、権限の範囲が誘導されないこと。
- **機能適合性（機能正確性）**: env ファイルの手書きの行を壊さないこと。GH_TOKEN 行がちょうど 1 つになること。どの手順で失敗しても、env が解決できる item を指していること。
- **使用性（運用性）**: 期限の警告が、必要なとき（7 日以内）だけ出ること。壊れた状態ファイルでも起動が止まらないこと。片付けに必要な名前とコマンドが表示されること。
- **対象外**: 性能効率性（対話的なコマンドで、外部呼び出しは curl 1 回と op 2 回）、移植性（bash 3.2 と perl の既存の制約を守る。jq は darwin の brews に宣言済みで、無ければ手順 0 で die する）。

## Approval

- Plan Status: complete
- Review Status: pass
- Approval Status: approved

## Reviewer Outputs (Round 1)

### logic-validator
- verdict: needs-work
- 主指摘: 更新すると同名の PAT が新旧 2 つ並ぶ（K2/K8）。archive 失敗・create 失敗・Ctrl-C のときにどういう状態で終わるかが書かれていない。形式が一致するだけで archive すると無関係な item を巻き込む。K7 の警告関数が起動を止めうる。jq は新しい依存。ADR K7 に対しては「矛盾しない」ではなく「例外」と書くべき。

### scope-justification-reviewer
- verdict: needs-work
- 主指摘: K5（新しい item を作って古い item を archive する方式）は代替案（固定 title の item）との比較が無い。K2 の issues=write と actions=read を付ける根拠が無い。K4 は検証で得るものが小さいので、得るものを明記するべき。

### decision-quality-reviewer
- verdict: pass（advisory）
- 主指摘: 秘密の経路には厳格なのに token の権限は緩い。contents=write は SSH を通さない push 経路を作る。K5 は部品数に見合う比較が無い。

### greenfield-perspective-reviewer
- verdict: pass
- 主指摘: 期限は API 応答のヘッダから取れるかを実機で確かめる価値がある。参照を固定 title にする案を K5 で比較し、却下するなら理由を残す。

### architecture-boundary-analyzer
- verdict: needs-work
- 主指摘: VM が書き換えられる origin の値が、人が選ぶ repo の手掛かりになっていて、信頼境界を越える（R1 は成立しない。K13 は remote.*.url を監視していない）。stdin と fd 9 の扱いが規定されていない。侵害時に失効させる手順が無い。

### security-vulnerability-analyzer
- verdict: needs-work
- 主指摘: origin を信頼の根にしている（P1）。host 側に repo を記録して突き合わせるべき。contents=write と 90 日の既定は K7 の趣旨に対して広い。PAT 名に日付が無いので、手で削除するときに新旧を見分けられない。token は全体を正規表現で検証し、`op` の出力を表示しない。

### data-contract-evolution-evaluator
- verdict: needs-work
- 主指摘: op inject はコメントの中の op:// も解決するので、archive した item への参照が残っていると起動が止まる。手で書いた GH_TOKEN 行と自動で書く行を見分ける規則が無い（重複行、export、後勝ち）。期限コメントと GH_TOKEN 行の対応が保証されない。空白を含む vault 名と末尾改行の扱い。

<!-- auto-review: pending -->
<!-- intent-triage: pending -->

## Reviewer Outputs (Round 2)

### logic-validator
- verdict: needs-work
- 主指摘: 状態ファイルを env より先に書くので、手順 8 で失敗すると expires が先に進み、期限の警告が出なくなる。再実行で prev_item と pat_name が上書きされ、古い item と PAT が追跡から外れる。同じ日に 2 回実行すると PAT 名が衝突する。新しい参照が解決できるかを archive の前に確かめていない。

### scope-justification-reviewer
- verdict: needs-work（軽微）
- 主指摘: 状態ファイルの各項目に存在理由を書くべき。archive を自動で行う根拠と、archive をしない最小案との比較が無い。

### decision-quality-reviewer
- verdict: pass（advisory）
- 主指摘: 支配軸の取り違えは解消した。archive の自動化と prev_item による再開は、得るものに対して重いので、削る案を検討するべき。R5 のゲートに通らなかったときの退避先が無い。

### greenfield-perspective-reviewer
- verdict: pass
- 主指摘: 白紙設計で本当に必要なのは repo と expires だけ。archive は失敗してもよい作業として縮める余地がある。

### architecture-boundary-analyzer
- verdict: needs-work
- 主指摘: 状態ファイルが orphan の検出・adopt・rm・gc とつながっていない。prev_item の上書きで item が追跡から外れる。全体共通の env.1password にある GH_TOKEN を検査していない。検証では過大な権限範囲（全 repo の token）を検出できない。

### security-vulnerability-analyzer
- verdict: needs-work
- 主指摘: 初回の y/N 確認では、VM の書き換えた値が信頼の根になる（入力による突き合わせにするべき）。origin を表示する前に検査し、制御文字を出さない。状態ファイルの値を読むときに検査する。--repo での付け替えの案内に origin の値を埋め込まない。既定の期限は 30 日を推奨する。

### data-contract-evolution-evaluator
- verdict: needs-work
- 主指摘: 手順 8 が続けて失敗すると、復旧できない状態になる。状態ファイルの書式の契約（解析方法、重複キー、値の検査、バージョン）が無い。vault の変更を扱えない。CRLF の扱い。

<!-- auto-review: verdict=needs-work; hash=ed9c79b14032be00b0883c6d109879138f4625caf2fd75f334181b7e7c79591b; design-hash=a93b3e5cc9fb27f53b7d2828c409b2f44168125721bca4cb005016df0fa0d935; round=1; at=2026-10-01T11:05:59.147Z; reviewers=logic-validator+scope-justification-reviewer+decision-quality-reviewer+greenfield-perspective-reviewer+architecture-boundary-analyzer+security-vulnerability-analyzer+data-contract-evolution-evaluator -->
<!-- intent-triage: adopted=19; excluded=0; at=2026-10-01T11:06:58.195Z -->

## Reviewer Outputs (Round 3)

### logic-validator
- verdict: pass
- 主指摘: 手順 10 で失敗すると片付けの表示が出ず、古い item の id がそこでしか分からないのに失われる。片付けは 1 回しか表示されない。`--days` を前より短くすると、手順 10 で失敗したときに警告が早めに出る保証が無くなる。adopt で状態ファイルを移す順序。

### scope-justification-reviewer
- verdict: pass
- 主指摘: K15 の失効手順に、状態ファイルが無いときの手掛かり（item の title）を足す。R4 に、許容する理由を書く。

### decision-quality-reviewer
- verdict: pass
- 主指摘: 片付けを忘れると古い token が期限まで有効のまま残るので、そのリスクを R と docs に書く。K13 は畳めるところを畳んでよい。

### greenfield-perspective-reviewer
- verdict: pass
- 主指摘: 片付けの表示を見逃したときの探し方（`agent-vm-gh ` で始まる title、PAT の一覧）を docs に書く。

### architecture-boundary-analyzer
- verdict: needs-work（軽微）
- 主指摘: adopt の後に GitHub 上の repo の名前が変わっていれば `--repo` で付け替えることを書く。adopt で状態ファイルが無いときの扱いを書く。全体共通の env.1password に後から GH_TOKEN が足されても、起動時には分からない。GH_TOKEN は agent の全子プロセスから読めることを docs に書く。

### security-vulnerability-analyzer
- verdict: needs-work（軽微）
- 主指摘: origin の URL の解析規則（受け付ける形、`.git` と末尾の `/` の除去、host は github.com のみ）が無い。自動形式の行があって状態ファイルが無いと、期限の警告が永久に出ない。片付けを忘れたときのリスクを書く。archive のコマンドを表示するときは、title を確かめるよう案内する。`pull_requests=write` で auto-merge を有効にできるかを確かめる。

### data-contract-evolution-evaluator
- verdict: needs-work（軽微）
- 主指摘: 手順 10 で失敗した後に再実行すると、間の PAT が片付けの表示から落ちる。状態ファイルが現在の env の item のものかどうかを、起動時の警告が確かめていない。adopt で、移動先の状態ファイルを env を移す前に検査すること。CR の検査を形式の検査より前に置くこと。コメント行に残った古い参照。

<!-- auto-review: verdict=needs-work; hash=2d333ee7ba36897e6f186493a852f6c8234655fc4f6e500513f66e5ddf827f8b; design-hash=53bf15f1a54f1bb6351936ae08accfe76c72b29f5b96b08594823a2f9b647165; round=2; at=2026-10-01T11:10:22.573Z; reviewers=logic-validator+scope-justification-reviewer+decision-quality-reviewer+greenfield-perspective-reviewer+architecture-boundary-analyzer+security-vulnerability-analyzer+data-contract-evolution-evaluator -->
<!-- intent-triage: adopted=24; excluded=0; at=2026-10-01T11:10:49.021Z -->

## Reviewer Outputs (Round 4)

### logic-validator
- verdict: pass
- 主指摘: 手順番号と K13、K11 と K9 は整合している。軽微な点として、警告は状態ファイルの expires が今の item のものかを確かめない（既知の限界として書く）。手順 7 で op item create 自体が失敗した場合の記述が無い。（反映済み）

### architecture-boundary-analyzer
- verdict: pass
- 主指摘: repo の名前を変えた後の復旧は、付け替えでも origin との一致を求めるので、先に host で origin を直すよう案内する。adopt で移動先に状態ファイルだけが残っているときの die メッセージ。K11 の「正常な運用では出ない」の文言。（反映済み）

### security-vulnerability-analyzer
- verdict: pass
- 主指摘: auto-merge の経路は他者の PR の承認と auto-merge の有効化として確かめる。記録した repo があって origin が解析できないときは die する。repo 名の比較で大文字と小文字を区別しない。（反映済み）

### data-contract-evolution-evaluator
- verdict: pass
- 主指摘: 状態ファイルと今の item の対応は見られない（既知の限界として書く）。手順 9 と 11 の間の中断でも書くべき内容が表示されるようにする。状態ファイルの 4 つの key を必須にする。adopt 前の machine 名の PAT の探し方。（反映済み）

### scope-justification-reviewer
- verdict: pass (carried from Round 3)
- 主指摘: Round 3 で pass、再実行なし

### decision-quality-reviewer
- verdict: pass (carried from Round 3)
- 主指摘: Round 3 で pass、再実行なし

### greenfield-perspective-reviewer
- verdict: pass (carried from Round 3)
- 主指摘: Round 3 で pass、再実行なし

<!-- auto-review: verdict=needs-work; hash=d9ee991547a05354701a60f48b8eaebc1365116fe63effb6a2d8bae42c305e4c; design-hash=555589fbdee954ec7cdc9395de3246fcb9b98a9de1fef33c68faaf6b1bf4764d; round=3; at=2026-10-01T11:15:51.037Z; reviewers=logic-validator+scope-justification-reviewer+decision-quality-reviewer+greenfield-perspective-reviewer+architecture-boundary-analyzer+security-vulnerability-analyzer+data-contract-evolution-evaluator -->
<!-- intent-triage: adopted=20; excluded=0; at=2026-10-01T11:15:51.053Z -->

## Reviewer Outputs (Round 5)

### logic-validator
- verdict: pass
- 主指摘: R5 に、Private と Formal の両方で op item create と参照の解決を確かめる項目が要る。--repo で別の repo に付け替えたときに vault を引き継ぐかどうかが不明。壊れた状態ファイルの die メッセージは vault の選択もやり直しになることを書く。vault を入力する元を書く。docs に vault の選択を書く。

### scope-justification-reviewer
- verdict: needs-work（軽微）
- 主指摘: --days の廃止と --vault の付け替えは妥当。日数は 1 か所で計算する。初回の選択で tty が開けないときは die する。vault を付け替えても、更新が終わるまで警告は古い expires のままになる。

### decision-quality-reviewer
- verdict: pass
- 主指摘: K10 の反映は支配軸と整合している。付け替えでは、新しい expires を新しい vault の日数で計算することを明記する。

### greenfield-perspective-reviewer
- verdict: pass
- 主指摘: 手順 9〜11 の間で止まると、状態ファイルの vault が古いまま残る。これを既知の限界に足す。

### architecture-boundary-analyzer
- verdict: pass
- 主指摘: vault が実在して item を作れるかが、PAT を作った後（手順 7）まで分からない。事前に確かめる。repo と vault の入力元を書く。

### security-vulnerability-analyzer
- verdict: pass
- 主指摘: 各 vault を誰が読めるかの前提を書く。失敗時の案内に新しい item の vault を含める。入力元と大文字小文字の区別を書く。付け替えの表示に新しい期限を含める。

### data-contract-evolution-evaluator
- verdict: needs-work（軽微）
- 主指摘: --repo で付け替えると、古い repo の vault を黙って引き継ぐ。手順 11 で失敗した後に再実行すると、vault の付け替えが黙って元に戻る。env の行の vault は値の範囲を検査しないことを書く。付け替えで表示する古い vault は env の行の値にそろえる。

<!-- auto-review: verdict=pass; hash=f13947bd3bc8078d49dfdb4c45daed69e1677086228efa0e063eb113a5043f60; design-hash=f405f436cb306789ef34b29cf42b6edf867002ba921b4d57de149784ba077149; round=4; at=2026-10-01T11:18:25.256Z; reviewers=logic-validator+architecture-boundary-analyzer+security-vulnerability-analyzer+data-contract-evolution-evaluator -->
<!-- intent-triage: adopted=14; excluded=0; at=2026-10-01T11:18:25.273Z -->

## Reviewer Outputs (Round 6)

### logic-validator
- verdict: pass
- 主指摘: 手順 2b が repo を付け替えたときにも状態ファイルの vault を使うように読める。食い違いの検出を付け替えのときにも当てるかが決まっていない。「付け替え」の定義を K4 と K10 でそろえる。（反映済み）

### scope-justification-reviewer
- verdict: pass
- 主指摘: --repo だけで付け替えた場合の分岐の順序を plan のテスト項目にする。R8 と K10 の末尾は重複している。

### data-contract-evolution-evaluator
- verdict: pass
- 主指摘: 食い違いの検出は、状態ファイルの repo と同じ repo のときだけにする。K11 の「手順 9〜11 の間で止まった場合だけ」は言い過ぎで、手で編集した場合も起きる。（反映済み）

### decision-quality-reviewer
- verdict: pass (carried from Round 5)
- 主指摘: Round 5 で pass、再実行なし

### greenfield-perspective-reviewer
- verdict: pass (carried from Round 5)
- 主指摘: Round 5 で pass、再実行なし

### architecture-boundary-analyzer
- verdict: pass (carried from Round 5)
- 主指摘: Round 5 で pass、再実行なし

### security-vulnerability-analyzer
- verdict: pass (carried from Round 5)
- 主指摘: Round 5 で pass、再実行なし

<!-- auto-review: verdict=needs-work; hash=9cd686f4c53602dd0cc190d06897976006bdc7e77b20d6490fde69e9e7587c0d; design-hash=16a831f51240a5f9f1677e63ac20c4117a1fb6a0cf1f5fe44923ee7c77e5ce33; round=5; at=2026-10-01T11:23:07.686Z; reviewers=logic-validator+scope-justification-reviewer+decision-quality-reviewer+greenfield-perspective-reviewer+architecture-boundary-analyzer+security-vulnerability-analyzer+data-contract-evolution-evaluator -->
<!-- intent-triage: adopted=18; excluded=0; at=2026-10-01T11:23:07.702Z -->

## Reviewer Outputs (Round 7)

T0 の結果（個人用 vault の名前は Personal）を受けて、vault 名を置き換え、K5 に既定のアカウントの項目を足した回。

### logic-validator
- verdict: pass
- 主指摘: 置き換えの漏れや誤置換は無い（K7 の private repo は GitHub の意味なので残っている）。K5 の追加は他の K と矛盾しない。

### scope-justification-reviewer
- verdict: pass
- 主指摘: 名前で持つ判断と --account を付けない判断は比例的。K10 に「ID でなく名前で持つ理由」を 1 文足すとよい。（反映済み）

### decision-quality-reviewer
- verdict: pass
- 主指摘: 支配軸の整合は保たれている。

### greenfield-perspective-reviewer
- verdict: pass
- 主指摘: 新しいギャップは無い。既定のアカウントに vault が無ければ op vault get で止まることを K5 に書くとよい。（反映済み）

### architecture-boundary-analyzer
- verdict: pass
- 主指摘: K5 の根拠（inject_secrets の op inject も --account を使わない）は実コードと一致する。

### security-vulnerability-analyzer
- verdict: pass
- 主指摘: 既定のアカウントが組織側に切り替わり、同名の vault があると、token が組織の vault に黙って保存されうる。PAT を作る前に使うアカウントを表示する。OP_ACCOUNT / OP_SERVICE_ACCOUNT_TOKEN が無い前提を docs に書く。（反映済み）

### data-contract-evolution-evaluator
- verdict: pass
- 主指摘: vault の値域は全体で Personal|Formal にそろっている。旧値の状態ファイルは存在せず、紛れ込んでも K9 の検査で止まる。

<!-- auto-review: verdict=pass; hash=9c0471ab752d7d9cc4ec8e9947ca9bc01c511ecee015b07d33662d0dc750c17c; design-hash=6e45dc41dc39b073a28ab9cb837a9f6ee996420df7c96609f30dc843b4931469; round=6; at=2026-10-01T11:24:28.976Z; reviewers=logic-validator+scope-justification-reviewer+data-contract-evolution-evaluator -->
<!-- intent-triage: adopted=5; excluded=0; at=2026-10-01T11:24:28.992Z -->

<!-- auto-review: verdict=pass; hash=0a8017ccf3268da2b2fd6edd529c4eadceab6dc8233221c28a1a3a41144d3f6b; design-hash=bb1cec185ed93127ee60c129c81966b1572fc3f64c5faf7e3eeba2b4613481e0; round=7; at=2026-10-01T14:28:24.834Z; reviewers=logic-validator+scope-justification-reviewer+decision-quality-reviewer+greenfield-perspective-reviewer+architecture-boundary-analyzer+security-vulnerability-analyzer+data-contract-evolution-evaluator -->
<!-- intent-triage: adopted=3; excluded=0; at=2026-10-01T14:28:24.850Z -->
