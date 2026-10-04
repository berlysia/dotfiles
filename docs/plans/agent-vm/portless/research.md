> **WIP・未承認**: #207 の Document Workflow の途中成果物。レビューは途中で、承認を受けていない。実装の根拠にしない（引き継ぎ先でレビューと承認をやり直す）。

# Research: agent-vm のポート割り当てを portless で仕組みにする（#207）

## 依頼

- #207 本文と 2026-10-04 のコメントを読んだ。オーダーは、portless（vercel-labs/portless）を使って、machine 間・worktree 間のポートの衝突を仕組みで避けること。
- 推奨は案 A。VM ごとに portless の proxy を置き、launcher が machine ごとに proxy のポートを 1 つ割り当てて `PORTLESS_PORT` で渡す。
- 案 A と案 B（mac に proxy を 1 つ）のどちらにするかは、この research で確かめて決める。

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
  - `forget_machine`（`rm` / `gc` から）が meta を消す。
  - 割り当てを meta に置けば、machine の削除と同時に枠が空く。解放の処理を別に作らなくてよい。
- **F4 lock**
  - repo lock は fd 9、browser store lock は fd 8、golden lock は fd 7 を使う。
  - `orb_q` は 9/8/7 を閉じて orb を呼ぶ（L107）。lock の fd が長生きの orb プロセスに残らないようにするためである（テスト `test_orb_q_closes_every_lock_fd`）。
  - machine をまたぐ lock は golden と browser store にしかない。ポートの割り当ては machine をまたぐ判断なので、別の lock が要る。
    - repo lock では足りない。別の repo の launcher が同時に空き枠を数えると、同じ枠を選べてしまう。
- **F5 VM への環境変数の渡し方**
  - `build_launch_script` L1472-1484 が、VM で実行する 1 行のスクリプトを組み立てる。
    - 中身は `cd repo; [env file を source して削除]; <forward_env_exports> exec tool args`。
  - `claude` / `codex` / `shell`（`run_tool bash`）はすべてここを通る（`run_tool` L1600-1626）。
  - `forward_env_exports` は、host の値を名前の allowlist で転送する仕組みである。host が決める値（ポート番号）を固定で渡す用途には合わない。
  - `export` を launch script に直接足せば、Claude の Bash tool、Codex、`agent-vm shell` のどれにも届く。
- **F6 一覧**
  - `machine_rows` は machine・状態・repo_path の TSV を出す。`cmd_list` が表示し、`cmd_gc` は awk の `$1` と `$2` だけを読む。
  - 4 列目を足しても `gc` は壊れない。

### VM 側

- **F7 VM のツールの入り方**
  - VM の mise は、host と共有の `home/dot_config/mise/config.toml` だけを持つ。`conf.d/`（host 専用のツールチェーン）は VM に配られない（`home/.chezmoiignore` L66-67、ADR-0018 の Amended by）。
  - `config.toml` に足したツールは、host と VM の両方で `00-install-mise-tools` が入れる。
  - `tests/agent-vm/run-templates.sh` の `test_mise_host_only_file_holds_only_toolchain_bound_tools` は、`conf.d/host-toolchains.toml` に go / rust 系だけを置くと決めている。
  - VM 専用の mise ファイルを作るには、`.chezmoiignore` の host 側と VM 側の両方に行を足し、`run-templates.sh` の期待リスト（`fixtures/vm-managed.txt`）も変える必要がある。
- **F8 mise の設定**
  - `minimum_release_age = "7d"` がある。
  - npm のツールには、週 1000 ダウンロードの閾値がある（`@mizchi/readability` に `allow_low_downloads` を付けた前例）。
- **F9 sudo**
  - VM の default user は passwordless sudo を持つ（ADR-0018 R6）。
  - Claude の permissions は `Bash(sudo:*)` を deny している（`.settings.permissions.json` L292-295）。
  - VM の Claude が portless で 80 / 443 を使うことはできない。

### portless（v0.15.7 のソース e06a3572、v0.15.6 は実機で確認）

- **P1 入手**
  - npm パッケージ・コマンドともに `portless` である。
  - `engines.node` は `>=24` だが、実行時には強制しない。mise の node は 24.15.0。
  - mise の registry に `portless`（backend `npm:portless`）がある。
  - npx / dlx での実行は拒否される。global か project-local の導入が要る。
- **P2 版**
  - 0.15.7 は 2026-10-02 公開で、`minimum_release_age = 7d` に掛かる（今日は 2026-10-04）。
  - 0.15.6 は 2026-08-24 公開。
  - 週ダウンロード数は、この環境の proxy で npm の downloads API が 403 になり、確かめられなかった。
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
- **P10 実機の確認（この Linux コンテナ、v0.15.6、TTY なし）**
  - 環境は `PORTLESS_PORT=17301 PORTLESS_HTTPS=0` で、stdin は `</dev/null`。
  - `portless run node s.js` で proxy が 17301 に上がり、`PORT=4633 HOST=127.0.0.1` で子が起動した。
  - `curl -H 'Host: myapp.localhost' http://127.0.0.1:17301/` が子の応答を返した。
  - root で実行したので、非 root の挙動（hosts の書き込みの失敗）は確かめていない。

### OrbStack の転送（既存の記録）

- **O1** VM の loopback に bind したサーバーには、mac の `localhost:<port>` から届く（`docs/agent-vm.md` V8、2026-09-30・2026-10-02 の確認）。
- **O2** 同じポートを複数の machine が使うと、先に bind した machine に届く。その machine のサーバーを止めても、2 台目には移らない（#207）。
- **O3** mac の `::1` への転送は確かめていない。portless の proxy は VM で `::1` にも bind するが、OrbStack が mac の `[::1]:<port>` を転送するかは不明である。

## 案 A と案 B の判定

- **案 B（mac に proxy を 1 つ）は成り立たない。** 理由は 3 つある。
  1. **経路の登録**: VM の portless は、自分の state dir（VM の `~/.portless`）に経路を登録する。mac の `~/.portless` は isolated machine から見えない（ADR-0018 K1、host のホームは VM に見えない）。mac の proxy に経路を届けるには、VM から host へ書く通路を作ることになり、ADR-0018 K23 の「VM から host への通信路は作らない」に反する。
  2. **転送先**: 仮に mac 側で `portless alias <name> <port>` を手で登録しても、転送先は mac の `localhost:<port>` だけである。そのポートは OrbStack の転送（O2）を通るので、アプリのポートが machine 間でぶつかると #207 の挙動がそのまま残る。portless のアプリのポートは 4000〜4999 の乱数で、machine をまたいだ重複は防げない。
  3. **sudo**: URL からポートを消す利点は、mac の proxy が 443 で待ち受けて初めて得られる。それには mac の sudo（または launchd の service install）が要る。
- **案 A は O2 の条件を満たさない。** 案 A で mac から見えるポートは、machine ごとに 1 つの proxy のポートだけである。launcher がそれを重ならないように割り当てるので、O2 の前提（同じポートを 2 台が bind する）が起きない。アプリのポートは VM の loopback で閉じ、mac に転送されなくても portless 経由で届く。
- **採用: 案 A。**

## 設計に効く事実と制約

- **C1** 割り当ては machine をまたぐ判断である。repo lock とは別の、短時間だけ持つ lock が要る（F4）。
- **C2** meta は起動のたびに書き直される（F2）。割り当てを保つには、書き直しで既存の値を引き継ぐ必要がある。
  - 他の launcher が同時に meta を読むので、書き込みは一時ファイルと `mv` で置き換える形にする。直接の `>` だと、読み手が空のファイルを見うる。
- **C3** ポートの範囲には、次の条件がある。
  - 1024 以上である（sudo を使わない、F9・P3）。
  - portless のアプリの範囲 4000〜4999 と、portless の fallback 1355 を避ける。
  - よく使う dev server のポート（3000、5173、8000、8080 など）を避ける。
  - Linux と macOS の ephemeral 範囲（32768〜60999、49152〜65535）を避ける。
  - WHATWG の blocked ports に入らない。
  - 例: 17300〜17399（100 枠）。
- **C4** mac 側で同じポートを別のプログラムが使っていても、launcher は検知できない（OrbStack の転送が勝つか mac 側が勝つかは未確認）。docs に書いて運用で避ける。
- **C5** `--no-tls` なので、mac のブラウザの URL は `http://<app>.localhost:<proxy のポート>` になる。cookie の注意（`localhost` はポートをまたいで cookie を共有する）は変わらない。
- **C6** VM の Claude は、何もしなければ今までどおり `npm run dev` で固定のポートに bind する。仕組みとして効かせるには、Claude に「`PORTLESS_PORT` があるときは `portless run` を使う」と伝える必要がある。
  - 置き場の候補は global の `home/dot_claude/CLAUDE.md` の Key Commands（host にも配られるが、条件付きの一文なので host の動作は変わらない）。
- **C7** 割り当てが変わる（重複の解消など）と、VM で動いている proxy は古いポートのまま残る。`portless proxy stop` か machine の再起動で直る。docs に書く。

## 変更が要らないもの

- **`scripts/smoke-provisioning-invariants.sh`**: chezmoi script の実行順序と、textlint の install-state の契約を検査するものである。mise の `[tools]` に 1 行足しても、script の名前・順序・内容は変わらない。検査の対象が増えないので変更しない。
- **`agent-vm/bootstrap.sh`**: portless は mise が入れる。bootstrap の apt / installer のリストは変わらない。
- **`.chezmoiignore`**: 共有の `config.toml` に足すので変わらない（F7）。

## 未確定（mac の実機で確かめる）

- **U1** mac のブラウザで `http://<app>.localhost:<port>` を開くと、VM の proxy に届くか。Chrome が `::1` を先に試す場合の OrbStack の転送（O3）も、ここで確かめる。
- **U2** mac の `curl http://<app>.localhost:<port>/` が解決できるか。curl は `.localhost` を自分で loopback に解決するはずだが、未確認。
- **U3** 2 台の machine で、それぞれの proxy のポートから別々のアプリに届くか。1 台目の proxy を止めても、2 台目の URL が影響を受けないか。
- **U4** mise が `portless` 0.15.6 を host と VM で入れられるか（週ダウンロードの閾値、P2）。
- **U5** 非 root（VM の default user）で proxy を起動したとき、/etc/hosts の書き込みの失敗が止まらずに続くか（P8）。
