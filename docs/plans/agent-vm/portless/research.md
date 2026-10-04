# Research: agent-vm のポート割り当てを portless で仕組みにする（#207）

## 依頼

- #207 本文と 2026-10-04 のコメントを読んだ。オーダーは、portless（vercel-labs/portless）を使って、machine 間・worktree 間のポートの衝突を仕組みで避けること。
- 推奨は案 A。VM ごとに portless の proxy を置き、launcher が machine ごとに proxy のポートを 1 つ割り当てて `PORTLESS_PORT` で渡す。
- 案 A と案 B（mac に proxy を 1 つ）のどちらにするかは、この research で確かめて決める。

## 引き継ぎ（2026-10-04、ローカルの worktree `wip/207-portless-plan`）

この research は、クラウドのセッションが作った版（09b67f1）を引き継いだものである。portless の挙動（P1〜P10）はクラウドのセッションの記録で、ここでは確かめ直していない。それ以外は、この worktree で次のとおり確かめ直した。

- **H1 行番号**: launcher の関数の位置は、下の F1〜F6 に書いた行番号と一致した（`write_machine_meta` L66-70、`read_meta_field` L72-79、`orb_q` L107、`acquire_lock` L126-139、`build_launch_script` L1472-1484、`prepare_machine` L1500-1519、`machine_rows` L1707-1715）。
- **H2 テストの基準**: `bash tests/agent-vm/run.sh` は、この環境（WSL2、Linux）で「698 run, 0 failed」だった。クラウドの版が書いていた「692 run, 7 failed」は、クラウドのコンテナに固有の値である。
- **H3 fd 6**: launcher は fd 9・8・7・3 を使い、fd 6 は使っていない（`exec [0-9]+[<>]` と `[0-9]>&-` の grep）。
- **H4 呼び出し元**: `write_machine_meta` を呼ぶのは `prepare_machine`（L1506）だけである。
- **H5 `machines/` の列挙**: `machines/*` を回すのは L1550、L1709（`machine_rows`）、L2088 の 3 か所で、どれも glob の `*` である。ドットで始まるファイル名には一致しない。
- **H6 `set -e`**: launcher は L4 で `set -euo pipefail` を有効にしている。未設定の変数の参照は失敗する。
- **H7 確認項目の番号**: `docs/agent-vm.md` の表は V29 まで使っている。V24〜V27 は node_modules の確認（bind mount、sync、workspace の install）に割り当て済みである。クラウドの版が V24〜V27 と呼んでいた 4 項目は、V30〜V33 に振り直す。
- **H8 週ダウンロード数**: npm の downloads API は、`portless` の 2026-09-25〜2026-10-01 を 1,679,394 と返した。mise の閾値（週 1000）の 3 桁上である。
- **H9 mise の registry**: `mise registry`（mise 2026.9.12）に `portless  npm:portless` がある。
- **H10 Codex の指示ファイル**: `home/dot_codex/AGENTS.md` に `## Commands`（L13）があり、英語の箇条で書かれている。
- **H11 `8a6c0af`**: この branch の履歴に入っている。`docs/agent-vm.md` L51 の 2 文目がその追記である。
- **H12 glob の設定**: launcher に `dotglob` と `nullglob` の設定は無い（grep）。`machines/*` はドットで始まる名前に一致しない。
- **H13 先頭が 0 の数字**: bash の `[[ 017308 -ge 17300 ]]` は「value too great for base」の算術エラーで 1 を返す。`[[ 041624 -ge 17300 ]]` は 8 進数として 17300 と読まれて真になる（どちらもこの環境の bash で実行して確かめた）。`^[0-9]+$` だけでは、範囲の判定の前に桁を絞れない。
- **H14 指示ファイルの配布**: `home/.chezmoiignore` L81-84 は、VM に `.claude/**` と `.codex/**` を配る。`CLAUDE.md` と `AGENTS.md` に書いた指示は VM の agent に届く。
- **H15 env file の出所**: VM に渡す env file は、host 所有の `$AGENT_VM_CONFIG_DIR/env.1password` と `repos/<m>.env.1password` から作る（`env_files_for`）。repo の中の `.env` は読まない。
- **H16 portless のコマンドと環境変数（0.15.6 の tarball）**: `npm pack portless@0.15.6` で取得した tarball の `dist/` に、`portless proxy stop` と `portless proxy start` の文字列がある。README に `portless list`（Show active routes）がある。`dist/` に `PORTLESS_PORT`、`PORTLESS_HTTPS`、`PORTLESS_STATE_DIR`、`PORTLESS_LAN`、`PORTLESS_SYNC_HOSTS` が現れる。コマンドを実行した結果ではなく、文字列の有無を見ただけである。
- **H17 portless の install script**: 同じ tarball の `package.json` の `scripts` に、`preinstall`・`install`・`postinstall` は無い。`dependencies` と `optionalDependencies` も無い（`dist/` に同梱されている）。このパッケージの install で走る script は無い。
- **H21 portless の Host の照合（0.15.6 の tarball）**: proxy は `const host = rawHost.split(":")[0]` で Host ヘッダからポートを落とし、その名前で経路を探す（`dist/chunk-SLEZT6EJ.js` の `handleRequest` と `findRoute`）。Host にポートが付いていても付いていなくても、同じ経路に一致する。
- **H22 並ぶセッション**: 同じ machine に、複数のセッションが同時に開きうる。launcher はセッションの間、repo lock を持たない（テスト `test_session_runs_without_holding_the_lock`）。同じ repo の worktree は 1 台の machine を共有する（F1）。
- **H18 lock の持ち方の既存の形**: golden lock（fd 7）は呼び出し側が持つ。`ensure_machine` が `acquire_golden_lock` で取り、その下で `write_golden_meta` を呼び、`release_golden_lock` で放す。`write_golden_meta`（L430）は lock を取らず、一時ファイルに書いて `mv` するだけである。repo lock（fd 9）も `prepare_machine` が取って放す（L1507、L1518）。lock の順序は L145 の周辺のコメントに書かれている。
- **H19 flock の性質**: launcher の lock は perl の `flock` である（L130）。持っているプロセスが終われば解放されるので、古い lock は残らない。待ちが時間切れになるのは、別の launcher が lock を持ち続けているとき（止められたプロセスなど）である。lock のファイルを開けない場合（state dir に書けない）は、それとは別の失敗である。
- **H20 meta の読み方**: `read_meta_field` は、最初に一致した行を返す（L75-77）。同じキーの行が 2 つあれば、最初の行だけが使われる。

## 現状（コードから確かめた事実）

### launcher（`home/dot_local/bin/executable_agent-vm`）

- **F1 machine と repo の対応**
  - machine 名は `--git-common-dir` の親（repo の根）から導く（`resolve_repo_root` L48-54、`derive_machine_name` L56-62）。
  - 同じ repo の worktree は 1 台の machine を共有する。テストは `test_worktree_resolves_to_main_repo_root`。
- **F2 machine の meta**
  - meta は `$AGENT_VM_STATE_DIR/machines/<m>` にある（`meta_path` L64）。
  - 書き込みは `write_machine_meta` L66-70 で、`format=1` と `repo_path` の 2 行だけを `>` で直接書く。
    - 起動のたびに `prepare_machine` L1506 が呼ぶ。repo lock（L1507）を取る前である。
    - このまま meta にキーを足しても、毎回の上書きで消える。
  - 読み出しは `read_meta_field` L72-79 で、未知のキーは無視する。
    - 読み手は `machine_rows`、`known_repo_containing_cwd`、`cmd_rm`、`restore-git` / `accept-git`、`ingest_outbox`。
    - どれも `repo_path` しか読まないので、キーを足しても既存の読み手は壊れない。
  - `machines/` は、どの machine もマウントしない（L1545 のコメント）。VM は meta を書き換えられない。
- **F3 meta の削除**
  - `forget_machine`（L1678、`rm` / `gc` から）が meta を消す。
  - 割り当てを meta に置けば、machine の削除と同時に枠が空く。解放の処理を別に作らなくてよい。
- **F4 lock**
  - repo lock は fd 9、browser store lock は fd 8、golden lock は fd 7 を使う。
  - `orb_q` は 9/8/7 を閉じて orb を呼ぶ（L107）。lock の fd が長生きの orb プロセスに残らないようにするためである（テスト `test_orb_q_closes_every_lock_fd`）。
  - golden lock と store lock は、`{ exec N>"..."; } 2>/dev/null || return 1` の形で開く（L151、L226）。開けないときに `set -e` で落ちず、呼び出し側が失敗を扱える。
  - machine をまたぐ lock は golden と browser store にしかない。ポートの割り当ては machine をまたぐ判断なので、別の lock が要る。
    - repo lock では足りない。別の repo の launcher が同時に空き枠を数えると、同じ枠を選べてしまう。
- **F5 VM への環境変数の渡し方**
  - `build_launch_script` L1472-1484 が、VM で実行する 1 行のスクリプトを組み立てる。
    - 中身は `cd repo; [env file を source して削除]; <forward_env_exports> exec tool args`。
  - `claude` / `codex` / `shell`（`run_tool bash`）はすべてここを通る（`run_tool` L1578-1606）。
  - `forward_env_exports` は、host の値を名前の allowlist で転送する仕組みである。host が決める値（ポート番号）を固定で渡す用途には合わない。
  - `export` を launch script に直接足せば、Claude の Bash tool、Codex、`agent-vm shell` のどれにも届く。
- **F6 一覧**
  - `machine_rows` は machine・状態・repo_path の TSV を出す。`cmd_list` が表示し、`cmd_gc`（L2041）は awk の `$1` と `$2` だけを読む。
  - 4 列目を足しても `gc` は壊れない。
- **F7 起動時の表示**
  - launcher は、進行と注意を `step`（L25）で stderr に 1 行ずつ出す。`run_tool` は `prepare_machine` の後に `notice_orphan_env` と `notice_gh_token_expiry` を呼ぶ（L1590-1591）。
  - 起動時の案内を足す場所として、この並びに `notice_*` を 1 つ足す形が既にある。

### VM 側

- **F8 VM のツールの入り方**
  - VM の mise は、host と共有の `home/dot_config/mise/config.toml` だけを持つ。`conf.d/`（host 専用のツールチェーン）は VM に配られない（`home/.chezmoiignore`、ADR-0018 の Amended by）。
  - `config.toml` に足したツールは、host と VM の両方で `00-install-mise-tools` が入れる。
  - `tests/agent-vm/run-templates.sh` の `test_mise_host_only_file_holds_only_toolchain_bound_tools` は、`conf.d/host-toolchains.toml` に go / rust 系だけを置くと決めている。
  - VM 専用の mise ファイルを作るには、`.chezmoiignore` の host 側と VM 側の両方に行を足し、`run-templates.sh` の期待リスト（`fixtures/vm-managed.txt`）も変える必要がある。
- **F9 mise の設定**
  - `minimum_release_age = "7d"` がある（`config.toml` L8）。
  - npm のツールには、週 1000 ダウンロードの閾値がある（`@mizchi/readability` と `@berlysia/shiori` に `allow_low_downloads` を付けた前例、L38・L50）。portless はこの閾値に掛からない（H8）。
- **F10 sudo**
  - VM の default user は passwordless sudo を持つ（ADR-0018 R6）。
  - Claude の permissions は `Bash(sudo:*)` を deny している（`.settings.permissions.json`）。
  - VM の Claude が portless で 80 / 443 を使うことはできない。

### portless（クラウドのセッションの記録。v0.15.7 のソース e06a3572 を読み、v0.15.6 を実機で確認した）

- **P1 入手**
  - npm パッケージ・コマンドともに `portless` である。
  - `engines.node` は `>=24` だが、実行時には強制しない。mise の node は 24.15.0。
  - mise の registry に `portless`（backend `npm:portless`）がある（H9 で再確認）。
  - npx / dlx での実行は拒否される。global か project-local の導入が要る。
- **P2 版**
  - 0.15.7 は 2026-10-02 公開で、`minimum_release_age = 7d` に掛かる（今日は 2026-10-04）。
  - 0.15.6 は 2026-08-24 公開（`npm view portless time` で再確認）。
- **P3 proxy**
  - `portless run` などで自動起動し、daemon になる。ログは `<stateDir>/proxy.log`。
  - ポートは `PORTLESS_PORT`（または `-p`）で決まる。既定は TLS ありで 443、`--no-tls` で 80。TLS は `PORTLESS_HTTPS=0` で切れる。
  - 1024 未満のポートでは sudo を自動で呼ぶ。TTY が無い自動起動では、sudo を呼ばずに exit 1 になる。1024 以上のポートでは sudo も対話も起きない。
  - TLS を切れば、CA の信頼登録（sudo を呼ぶ経路）にも入らない。
- **P4 bind**
  - proxy は `127.0.0.1` と `::1` に bind する（`getProxyBindTargets`）。`--lan` / `PORTLESS_LAN=1` のときだけ `0.0.0.0` になる。
- **P5 アプリのポート**
  - 4000〜4999 から、`127.0.0.1` / `::1` / `0.0.0.0` / `::` のすべてで bind できるものを選ぶ。
  - 子プロセスに `PORT`、`HOST=127.0.0.1`、`PORTLESS_URL` を渡す。Vite などには `--port` と `--host` を足す。
- **P6 名前と worktree**
  - `portless run` の名前は、`--name`、`portless.json`、package.json の `name`、git の根の basename、cwd の basename の順に決まる。
  - linked worktree では、ブランチ名の最後の `/` 区切りを接頭辞にする（`fix-ui.myapp.localhost`）。main worktree、`main` / `master`、detached HEAD では付けない。
  - `portless <name> <cmd>`（named mode）は接頭辞を付けない。worktree の衝突を避けるには `portless run` を使う。
- **P7 URL**
  - 80 / 443 以外のポートでは、URL にポートが付く（`http://myapp.localhost:17301`）。
- **P8 /etc/hosts**
  - proxy は既定で /etc/hosts の管理ブロックを書き換えようとする。root でなければ失敗し、`proxy.log` に 1 行の警告を残すだけで止まらない。
  - `.localhost` は Chrome / Firefox / Edge が自分で loopback に解決する。
- **P9 状態**
  - 状態は `~/.portless`（`PORTLESS_STATE_DIR`）にある。前回の port / TLS は `proxy.port` などに残り、自動起動はそれを読む。明示した環境変数のほうが勝つ。
  - 同じ state dir では proxy は 1 つである。
- **P10 実機の確認（クラウドの Linux コンテナ、v0.15.6、TTY なし）**
  - 環境は `PORTLESS_PORT=17301 PORTLESS_HTTPS=0` で、stdin は `</dev/null`。
  - `portless run node s.js` で proxy が 17301 に上がり、`PORT=4633 HOST=127.0.0.1` で子が起動した。
  - `curl -H 'Host: myapp.localhost' http://127.0.0.1:17301/` が子の応答を返した。
  - root で実行したので、非 root の挙動（hosts の書き込みの失敗）は確かめていない。

### OrbStack の転送と machine 間の到達（既存の記録）

- **O1** VM の loopback に bind したサーバーには、mac の `localhost:<port>` から届く（`docs/agent-vm.md` L280 の V8、2026-09-30・2026-10-02 の確認）。
- **O2** 同じポートを複数の machine が使うと、先に bind した machine に届く。その machine のサーバーを止めても、2 台目には移らない（#207、`docs/agent-vm.md` L305）。
- **O3** mac の `::1` への転送は確かめていない。portless の proxy は VM で `::1` にも bind するが、OrbStack が mac の `[::1]:<port>` を転送するかは不明である。
- **O4** `<machine>.orb.local` は、`0.0.0.0` に bind したサーバーにしか届かない（`docs/agent-vm.md` L50、L280）。
- **O5** `--isolate-network` を付けても、isolated machine 同士は IP で互いに届く。VM のブラウザは、ほかの VM が `0.0.0.0` に bind したサービスに届きうる（ADR-0018 L84、#200）。
- **O6** O1 は、ポートの番号を選ばない。VM が loopback に bind したポートは、どれも mac の `localhost` に転送されると考えられる。これには 2 つの帰結がある。
  - portless が起動したアプリのポート（4000〜4999、`HOST=127.0.0.1`、P5）も、mac に転送されうる。2 台の machine が同じアプリのポートを選べば、そのポートでは O2 が起きる。人が開くのは proxy のポートなので、proxy 経由の閲覧に影響するかどうかは別の問いで、確かめていない。
  - VM の中のプロセスは、ほかの machine に割り当てられた proxy のポートにも bind できる。host はこれを止められない。先に bind すれば、mac のそのポートは bind した VM に届く（O2 と同じ性質）。
- **O7** mac の側で OrbStack が転送のために listen するアドレス（`127.0.0.1` だけか、`0.0.0.0` か）は確かめていない。O1 の観測は「mac の `localhost` から届く」までである。

## 案の判定

### 案 B（mac に proxy を 1 つ）

採らない。理由は次の 3 つである。

1. **URL からポートが消えるのは 443 のときだけ**: 案 B の利点は、人が名前だけを覚えればよいことである。それは mac の proxy が 443（または 80）で待ち受けて初めて得られる。portless は 1024 未満のポートで sudo を呼ぶ（P3）。macOS そのものが 443 の待ち受けに特権を求めるかどうかは確かめていない。1024 以上のポートで待ち受けるなら URL にポートが残り、案 A との差は「ポートが machine ごとか、全体で 1 つか」だけになる。
2. **転送先の選び方が、どちらも別の問題を持ち込む**
   - mac の `localhost:<app port>` に転送する場合、アプリのポート（4000〜4999 の乱数）が machine 間で重なると、O2 の挙動がそのまま残る。
   - `<machine>.orb.local:<app port>` に転送する場合、アプリを `0.0.0.0` に bind させることになる（O4）。そのサーバーには、ほかの isolated machine から届く（O5）。
3. **経路を mac に集める部品が要る**: VM の portless は、VM の `~/.portless` に経路を登録する。mac の proxy がそれを知るには、host が `orb -m <m> portless list` のように各 machine から引くことになる。host から VM を読む向きなので ADR-0018 K23（VM から host への通信路は作らない）には反しないが、machine の起動・停止に追従する常駐の部品を新たに作ることになる。

クラウドの版は「案 B は K23 に反するので成り立たない」と書いていた。host から引く形なら K23 には反しないので、この言い方は強すぎた。退ける理由は上の 3 つである。

案 B には、転送先を「案 A が machine ごとに配った proxy のポート」にする形もある。この形では、アプリのポートの重なりも `0.0.0.0` の bind も要らない。理由 2 は当たらず、残るのは理由 1 と 3 である。つまり案 A は、案 B の下の層としても使える。mac の側の名前の振り分けは、案 A の後から足せる。そのときは、machine 間でアプリの名前が重なる場合の扱い（名前に machine を含めるなど）を決める必要がある。

### 案 C（`<machine>.orb.local` と固定のポート）

採らない。全 machine の proxy を `0.0.0.0`（`PORTLESS_LAN=1`）に bind し、同じポートを使う。mac からは `http://<machine>.orb.local:<port>` で machine を区別するので、割り当てが要らない。

- proxy が `0.0.0.0` に bind されるので、ほかの isolated machine から届く（O5）。proxy の先には、その machine のすべての dev server がある。
- portless は Host ヘッダの `.localhost` の名前で振り分ける（P6、P8）。`<machine>.orb.local` の Host で、アプリと worktree をどう区別するかは確かめていない。
- `PORTLESS_LAN=1` のときのほかの挙動（mDNS の広告など）も確かめていない。
- `0.0.0.0` に bind したうえで、VM の中の packet filter（nftables など）で送信元を mac の側に絞る緩和策も考えられる。これには次の 3 つが要る。どれも今は無い。
  - filter を root で入れる provisioning（bootstrap の変更）。
  - mac からの接続が VM でどの送信元アドレスに見えるかの確認。
  - VM の中の agent が filter を外せないことの保証。VM の default user は passwordless sudo を持つ（F10）ので、Claude の permissions の外（Codex、`agent-vm shell`）では外せる。

### 案 D（machine 名の hash からポートを決める）

採らない。台帳なしでポートが決まるが、100 枠に 10 台を割り当てると、少なくとも 1 組が衝突する確率は約 37% である（1 − 0.99 × 0.98 × … × 0.91 ≈ 0.372）。衝突を解くには結局 lock と記録が要る。「同じ machine は同じポートを使い続ける」という hash の利点は、記録した値を保つ規則でも得られる。

### 案 E（host が mac の側の待ち受けを持ち、VM へ中継する）

採らない。launcher が mac の側で machine ごとのポートを自分で listen し、`orb` 経由で VM の proxy へ中継する。mac のポートの持ち主が、OrbStack の先着順の転送から host に移る。

- 得られるもの: host が先に mac のポートを bind できれば、VM がほかの machine のポートに直接 bind しても、mac のポートは奪えない（O6 の 2 つ目）。`::1` の転送（O3）と、OrbStack が listen するアドレス（O7）にも左右されない。host が先に bind できるか、既に使われているポートに対して OrbStack の転送がどう振る舞うかは、確かめていない。
- 要るもの: machine ごとに、中継のプロセスを host に置く。同じ machine にセッションが並びうる（H22）ので、最初に起動した launcher の終了で中継が切れないようにするには、セッションの外で持つか、参照数の管理が要る。machine の起動と停止、launcher の終了、mac の再起動にも追従させる必要がある。今の launcher は、常駐するプロセスを持たない。
- OrbStack の転送は止められないので、VM が loopback に bind したポートは、これまでどおり mac の `localhost` にも現れる。中継のポートと OrbStack の転送のポートが mac の上でぶつからないように、番号を分ける必要がある。
- 中継の実現（`orb` の標準入出力を通すのか、VM の IP に直接つなぐのか）は調べていない。後者は VM の側の `0.0.0.0` の bind を要する。

### 案 A（VM ごとの proxy、launcher が割り当てる）

採る。案 A で人が mac から開くポートは、machine ごとに 1 つの proxy のポートだけである。launcher がそれを重ならないように割り当てるので、人が開くポートでは O2 の前提（同じポートを 2 台が bind する）が起きない。proxy からアプリへの転送は VM の loopback の中で完結し、mac の転送を通らない。アプリのポートそのものは mac に転送されうる（O6）が、人はそのポートを開かない。

## 設計に効く事実と制約

- **C1** 割り当ては machine をまたぐ判断である。repo lock とは別の、短時間だけ持つ lock が要る（F4）。
- **C2** meta は起動のたびに書き直される（F2）。割り当てを保つには、書き直しで既存の値を引き継ぐ必要がある。
  - 他の launcher が同時に meta を読むので、書き込みは一時ファイルと `mv` で置き換える形にする。直接の `>` だと、読み手が空のファイルを見うる。
  - 一時ファイルの名前をドットで始めれば、`machines/*` の列挙（H5）に出ない。
- **C3** ポートの範囲には、次の条件がある。
  - 1024 以上である（sudo を使わない、F10・P3）。
  - portless のアプリの範囲 4000〜4999 と、portless の fallback 1355 を避ける。
  - よく使う dev server のポート（3000、5173、8000、8080 など）を避ける。
  - Linux と macOS の ephemeral 範囲（32768〜60999、49152〜65535）を避ける。
  - WHATWG の blocked ports に入らない。
  - 例: 17300〜17399（100 枠）。
- **C4** mac 側で同じポートを別のプログラムが使っていても、launcher は検知できない（OrbStack の転送が勝つか mac 側が勝つかは未確認）。docs に書いて運用で避ける。
- **C5** `--no-tls` なので、mac のブラウザの URL は `http://<app>.localhost:<proxy のポート>` になる。cookie はホスト名で分かれ、ポートでは分かれない。2 台の machine のアプリが同じ名前（`app.localhost`）を持つと、同じブラウザのプロファイルでは cookie を共有する。これまでの `localhost:<port>` でも同じ共有はあった。portless では、名前が package.json の `name` から決まるので、machine の間で重なりうる。
- **C6** VM の agent は、何もしなければ今までどおり `npm run dev` で固定のポートに bind する。仕組みとして効かせるには、agent に「`PORTLESS_PORT` があるときは `portless run` を使う」と伝える必要がある。
  - Claude は global の `home/dot_claude/CLAUDE.md` の Key Commands、Codex は `home/dot_codex/AGENTS.md` の `## Commands`（H10）が置き場になる。どちらも host に配られるが、条件付きの一文なので host の動作は変わらない。
- **C7** 割り当てが変わる（重複の解消など）と、VM で動いている proxy は古いポートのまま残る。`portless proxy stop` か machine の再起動で直る。docs に書く。
- **C8** `PORTLESS_PORT` が無い VM で portless を起動したときの挙動は、state dir の中身で変わる。
  - state dir が空なら、既定の 443 を使おうとする（P3）。TTY が無ければ exit 1 になる。TTY のある `agent-vm shell` では sudo が通りうる（F10）が、そのときの挙動は確かめていない。
  - 前に proxy を起動したことがあれば、state dir の `proxy.port` に前回のポートが残っている（P9）。環境変数が無ければ、それを読んで前回のポートで起動すると考えられる。確かめていない。
- **C9** 割り当ての付け替えは、手で meta を編集したとき以外にも起きる。
  - この変更より前の launcher は `proxy_port` を知らず、起動のたびに meta を 2 行で書き直す（F2）。古い launcher で起動すると `proxy_port` が消え、次に新しい launcher で起動したときに、別の枠になりうる。dotfiles の版は環境ごとにずれうるので、これは起きうる。
  - meta を失ったとき、範囲外の値を直したときも同じである。
- **C10** `prewarm` も `prepare_machine` を通る（`cmd_prewarm`）。`write_machine_meta` に割り当てを置くと、`prewarm` でも枠が取られる。枠は machine に属するので、後の起動が使う枠を先に取るだけである。
- **C11** 枠を空けるのは `forget_machine`（`agent-vm rm` と `gc`）だけである。`orb delete` を launcher の外で実行すると meta が残り、枠を持ち続ける。repo が残っていれば `gc` の対象にもならない（`gc` は repo が無くなった machine だけを拾う）。`agent-vm rm <repo>` で空く。

## 変更が要らないもの

- **`scripts/smoke-provisioning-invariants.sh`**: chezmoi script の実行順序と、textlint の install-state の契約を検査するものである。mise の `[tools]` に 1 行足しても、script の名前・順序・内容は変わらない。検査の対象が増えないので変更しない。
- **`agent-vm/bootstrap.sh`**: portless は mise が入れる。bootstrap の apt / installer のリストは変わらない。
- **`.chezmoiignore`**: 共有の `config.toml` に足すので変わらない（F8）。

## 未確定（mac の実機で確かめる）

- **U1** mac のブラウザで `http://<app>.localhost:<port>` を開くと、VM の proxy に届くか。Chrome が `::1` を先に試す場合の OrbStack の転送（O3）も、ここで確かめる。
- **U2** mac の `curl http://<app>.localhost:<port>/` が解決できるか。curl は `.localhost` を自分で loopback に解決するはずだが、未確認。
- **U3** 2 台の machine で、それぞれの proxy のポートから別々のアプリに届くか。1 台目の proxy を止めても、2 台目の URL が影響を受けないか。
- **U4** mise が `portless` 0.15.6 を host と VM で実際に入れられるか。週ダウンロードの閾値には掛からない（H8）ので、残るのは install そのものの確認である。
- **U5** 非 root（VM の default user）で proxy を起動したとき、/etc/hosts の書き込みの失敗が止まらずに続くか（P8）。
