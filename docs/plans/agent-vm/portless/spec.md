# Spec: agent-vm の dev server のポートを portless で割り当てる（#207）

## Goal

VM で動かす dev server を、machine 間でも worktree 間でも、人が開くポートが衝突しない形で、mac のブラウザから開けるようにする。ポートの選択を人と agent の判断から外し、launcher と portless の仕組みで決める。

この変更で最も重く見るのは、日常の使い勝手である。人が開く URL のポートを launcher が決めること、agent がポートを選ばなくてよいことを優先する。

次の 3 つは、満たすべき制約として扱う。使い勝手のために緩める対象にはしない。

- **境界**: ADR-0018 の境界を保つ。この変更が、ほかの machine から届く面を新たに足すことはしない（案 C を退ける理由）。既存の面（R9）は変えない。この変更が全 machine のポートを 1 つの範囲に集める分は、R9 で受け入れる。VM は host の状態を書き換えられない。VM から host への通信路は作らない。dev server は loopback に bind したままにする。
- **sudo なし**: VM の agent は sudo を使えない（research F10）。1024 未満のポートと CA の信頼登録は使わない。
- **bash 3.2**: launcher は macOS の `/bin/bash`（3.2）で動く。

## Experience Delta

- **変更前**
  - VM の dev server は、各自が選んだポート（5173 など）で loopback に bind する。
  - 2 台の machine が同じポートを使うと、mac の `localhost:<port>` は先に bind した machine に固定される。そのサーバーを止めると、どちらにも届かなくなる（#207）。
  - docs は「machine ごとにポートを変える」と書くだけで、どのポートにするかは決まらない。
  - 同じ repo の worktree 同士も、1 台の machine の中でポートを取り合う。
- **変更後**
  - VM では `portless run <dev コマンド>` で起動し、`http://<app>.localhost:<machine の proxy のポート>` を開く。worktree なら `http://<branch>.<app>.localhost:<同じポート>` になる。
  - proxy のポートは launcher が machine ごとに重ならないように割り当てる。launcher は起動時に、そのポートを 1 行で表示する。後からは `agent-vm list` の 4 列目で確かめられる。
  - ポートは、machine がある間は変わらない。`agent-vm rm` で machine を作り直すと、別のポートになりうる。
  - 人が開くのは machine ごとの proxy のポートだけになる。launcher の割り当ては、meta を手で編集しない限り重ならないので、agent と人が portless を通す限り、2 台の machine が同じポートを取り合って #207 の状況になることはない。
  - 例外が 3 つ残る。mac の別のプログラムがそのポートを使っている場合（R2）、割り当てが付け替わった後に古い proxy が残っている場合（R3）、VM の中のプロセスがほかの machine のポートに直接 bind した場合（R9）である。
  - VM の Claude と Codex は、`PORTLESS_PORT` があれば `portless run` を使うよう、global の指示ファイルで指示される。

## Architecture

```
mac browser ── http://feat.app.localhost:17301 ──▶ mac 127.0.0.1:17301
                                                    │ OrbStack の localhost 転送（loopback bind、V8）
                                                    ▼
machine agent-foo-abc123 (proxy_port=17301 は host の meta に記録)
  portless proxy  127.0.0.1:17301 / ::1:17301（PORTLESS_PORT, PORTLESS_HTTPS=0）
     ├─ app.localhost       → 127.0.0.1:4xxx（main worktree の dev server）
     └─ feat.app.localhost  → 127.0.0.1:4yyy（linked worktree の dev server）

machine agent-bar-def456 (proxy_port=17302)
  portless proxy  127.0.0.1:17302 ...
```

- **host（launcher）**
  - 起動のたびに、machine の meta（`$AGENT_VM_STATE_DIR/machines/<m>`）に `proxy_port` を確保する。
  - 確保は machine をまたぐ lock の下で行い、ほかの meta が持つ値と重ならない最小の空き枠を選ぶ。
  - VM のセッションには `PORTLESS_PORT=<proxy_port>` と `PORTLESS_HTTPS=0` を export して渡す。
  - セッションを開く前に、割り当てたポートを stderr に 1 行で表示する。
- **VM**
  - portless は mise で入る（host と共有の `config.toml`）。
  - proxy は最初の `portless run` で daemon として自動起動し、VM の loopback に bind する。
  - proxy からアプリ（4000〜4999）への転送は、VM の loopback の中で完結する。mac の転送を通らない。
  - アプリのポートそのものは、loopback に bind されるので mac に転送されうる（research O6）。人はそのポートを開かない。

## Alternative Approaches (Greenfield View)

### 差分最小案 (Incremental)

launcher は変えない。docs に「machine ごとに 5170 + n のように手で決めたポートを使う」と表を書き、`8a6c0af` の注意書きを残す。

- 割り当ての台帳が人の記憶と docs にしかなく、新しい machine で何番を使うかは決まらない。#207 のコメント（「結局ぶつかる」）がこの案を退けている。
- worktree 同士の衝突も解けない。

### 白紙設計案 (Greenfield)

ゼロから設計するときの起源は 2 つ立てられる。

- **起源 1**: 「人が覚えるのは名前だけにしたい。ポートは機械が持つ情報で、URL に出る必要はない」。これはこの spec が立てた起源で、オーダーの文面（衝突を仕組みで避ける）より一歩先の要求である。案 B、C、D が出る。
- **起源 2**: 「mac のポートの持ち主を、OrbStack の先着順から host に移す」。オーダーの文面から直接出る。案 E が出る。

それぞれの案と、採らない理由は次のとおりである。

- **案 B: mac に reverse proxy を 1 つ置き、URL からポートを消す。**
  - 採らない理由 1: URL からポートが消えるのは、mac の proxy が 443 か 80 で待ち受けるときだけである。portless は 1024 未満のポートで sudo を呼ぶ（research P3）。macOS そのものが特権を求めるかどうかは確かめていない。1024 以上で待ち受けるなら URL にポートが残り、起源 1 の利点が消える。
  - 採らない理由 2: mac の proxy から VM のアプリへ直接転送する形は 2 通りで、どちらも別の問題を持ち込む。
    - mac の `localhost:<app port>` に転送すると、アプリのポート（4000〜4999 の乱数）が machine 間で重なったときに #207 がそのまま残る。
    - `<machine>.orb.local:<app port>` に転送すると、アプリを `0.0.0.0` に bind させることになり、ほかの isolated machine から届く（research O4、O5）。
  - 採らない理由 3: VM の portless は VM の中に経路を登録する。mac の proxy がそれを知るには、host が各 machine から経路を引く常駐の部品が要る。host から読む向きなので ADR-0018 K23 には反しないが、machine の起動と停止に追従する部品を新たに作ることになる。今の launcher は、常駐するプロセスを持たない。
  - 案 B には、転送先を「案 A が配った machine ごとの proxy のポート」にする形もある。この形には理由 2 が当たらず、理由 1 と 3 が残る。案 A は案 B の下の層としても使えるので、mac の側の名前の振り分けは後から足せる。今回は提供しない（「Phase 1 で意図的に提供しない体験」）。
- **案 C: 全 machine の proxy を `0.0.0.0` に bind して同じポートを使い、`http://<machine>.orb.local:<port>` で machine を区別する。**
  - 割り当てと台帳が要らなくなる。
  - 採らない理由 1: proxy が `0.0.0.0` に bind されるので、ほかの isolated machine から、その machine のすべての dev server に届く（research O5）。境界は制約であり、使い勝手のために緩めない（Goal）。
  - VM の中の packet filter で送信元を mac の側に絞る緩和策は、採らない。root での provisioning、送信元アドレスの確認、agent が filter を外せないことの保証の 3 つが要り、どれも今は無い。VM の default user は passwordless sudo を持つので、3 つ目は Codex と `agent-vm shell` では成り立たない（research 案 C）。
  - 補強: portless は Host ヘッダの `.localhost` の名前で振り分ける。`<machine>.orb.local` の Host で、アプリと worktree を区別できるかは確かめていない。確かめるには mac の実機が要る。区別できなければ、worktree 間の衝突（オーダーの半分）が解けない。この点は未確認なので、退ける主な理由は理由 1 である。
- **案 D: machine 名の hash からポートを決め、台帳を持たない。**
  - 採らない理由: 100 枠に 10 台で、少なくとも 1 組が衝突する確率は約 37% である（research 案 D）。衝突を解くには lock と記録が要り、台帳なしの利点が残らない。同じ machine が同じポートを使い続ける性質は、K3 の規則 1 でも得られる。
- **案 E: launcher が mac の側で machine ごとのポートを自分で listen し、`orb` 経由で VM の proxy へ中継する。**
  - 得られるもの: host が先に mac のポートを bind できれば、VM が直接 bind しても mac のポートは奪えない（R9 が小さくなる）。host が先に bind できるか、既に使われているポートに対して OrbStack の転送がどう振る舞うかは、確かめていない。`::1` の転送（R1）と、OrbStack が listen するアドレス（R11）にも左右されない。
  - 採らない理由 1: machine ごとに、中継のプロセスを host に置くことになる。同じ machine に claude / codex / shell のセッションが並びうる（research H22）ので、最初に起動した launcher の終了で中継が切れないようにするには、セッションの外で持つか、参照数の管理が要る。machine の起動と停止、launcher の終了、mac の再起動にも追従させる必要がある。案 B の理由 3 と同じ種類の部品で、今の launcher には無い。
  - 採らない理由 2: OrbStack の転送は止められないので、VM が loopback に bind したポートは mac の `localhost` にも現れ続ける。中継のポートと転送のポートを mac の上で分ける設計が要る。中継の実現の方法も調べていない（research 案 E）。
  - R1 か R11 が V30 で崩れた場合は、この案が spec の改訂の候補になる。

案 A の形（人が開くポートを machine ごとに 1 つに絞り、その 1 つを host が配る）は、「loopback に bind し、OrbStack の `localhost` 転送で mac から開く」という既存の選択（ADR-0018 K23）から来る。この選択の下では、mac から見える名前空間は「mac の `localhost` のポート」の 1 つしかなく、machine を区別できるのはポート番号だけである。この選択を保つ案（B の `localhost` 転送）は、アプリのポートの重なりで退く。この選択を変える案（B の `orb.local` 転送、C）は、`0.0.0.0` の bind を要するので退く。転送を host が持ち直す案（E）は、常駐の部品を要するので退く。残るのは、OrbStack の転送をそのまま使い、ポートを host が配る形である。

### 採用案と理由

案 A（VM ごとの proxy と、launcher によるポートの割り当て）を採る。

- **根拠 1（#207 の原因の除去）**: OrbStack の転送は「同じポートを 2 台が bind する」ときに壊れる（research O2）。人が開くポートを machine ごとに 1 つにし、host が重複なく配れば、portless を通す machine 同士が同じポートを取り合うことはない。案 B の `localhost` 転送は、アプリのポートの重複（4000〜4999 の乱数）を、人が開く経路に残す。直接 bind する VM（R9）は、この根拠の外にある。
- **根拠 2（境界）**: 割り当ての台帳は、VM がマウントしない `machines/` に置く（research F2）。VM は meta を書き換えられないので、meta を介してほかの machine の割り当てを奪うことはできない。proxy もアプリも loopback に bind したままで、ほかの machine から届く面を増やさない。VM がほかの machine のポートに直接 bind する経路は、この変更の前からあり、残る（R9）。
- **根拠 3（既存の仕組みの再利用）**: meta は `agent-vm rm` / `gc` で消える（research F3）。解放の処理を新たに作らなくてよい。常駐するプロセスも要らない。
- **残る不満**: URL にポートが残る。起源 1 の「名前だけを覚える」は満たさない。ポートは machine を作り直すと変わる。これを起動時の 1 行の表示（K11）と `agent-vm list`（K6）と docs の 1 か所の手順（K9）で補う。起源 2 の「mac のポートの持ち主を host にする」も満たさない（R9 が残る）。

## Key Decisions

- **K1: 案 A（VM ごとの portless proxy）を採る。** 理由は上の「採用案と理由」に書いた。
  - 参照: `docs/decisions/0018-agent-vm-orbstack.md:51`（K23: 人の閲覧は host から VM への `localhost` 転送で行い、VM から host への通信路は作らない）
  - 参照: `docs/agent-vm.md:305`（先に bind した machine に転送が固定される観測）
- **K2: proxy のポートの範囲は 17300〜17399（100 枠）にする。**
  - 1024 以上なので sudo が要らない。
  - portless のアプリの範囲（4000〜4999）と fallback（1355）を避ける。
  - よく使う dev server のポート（3000、5173、8000、8080 など）、Linux と macOS の ephemeral 範囲（32768〜）、WHATWG の blocked ports も避ける。
  - 100 は、machine を作り続けても `gc` 前に溢れない余裕として選んだ。範囲は launcher の定数にする。
  - 参照: research C3
- **K3: 割り当ては meta の `proxy_port` に記録し、専用の lock の下で決める。**
  - **関数の分担**（lock は、決定と書き込みをまとめる関数（`assign_proxy_port`）が持ち、書く関数（`write_machine_meta`）は lock を取らない。`ensure_machine` が golden lock を持ち、`write_golden_meta` が取らない既存の形に合わせる。research H18）
    - `valid_proxy_port <value>`: 有効な値かどうかを判定する。判定はこの関数 1 つに置き、下の 3 か所がこれを呼ぶ。
    - `pick_proxy_port <machine>`: 決める。`machines/*` のうち `*.lock` を除くすべての meta を読むだけで、何も書かない（`machine_rows` と同じ除外）。
    - `write_machine_meta <machine> <repo_path> [<proxy_port>]`: 書く。meta を書く関数は、これまでどおりこれ 1 つである。lock は取らない。3 つ目の引数が有効な値なら `proxy_port` の行も書く。今の `>` での直接の上書き（L69）を、一時ファイルと `mv` での置き換えに変える。
    - `assign_proxy_port <machine> <repo_path>`: 割り当ての 1 回分をまとめる。port lock を取り、書き換える前の自分の値を読み、`pick_proxy_port` で決め、`write_machine_meta` で書き、lock を放す。結果を 2 つのグローバル変数に置く。`PROXY_PORT` は今回の値（空きが無ければ空）、`PROXY_PORT_PREV` は書き換える前の自分の値（有効な値が無ければ空）である。2 つの変数は、書き込みが成功した後に代入する。記録できていないポートを案内しないためである。`write_machine_meta` が失敗したら、lock を放して launcher を止める（state dir に書けない状況で、下の「lock」の、lock を開けない場合と同じ扱いにする）。前の値を lock の中で読むので、同じ repo の launcher が 2 つ並んでも、後の側が古い値を見ることはない。
    - `prepare_machine`: 冒頭で `PROXY_PORT` と `PROXY_PORT_PREV` を空に初期化する。今の `write_machine_meta` の呼び出し（L1506）を `assign_proxy_port` に置き換える。その直後に、付け替えの表示（K12）と枠切れの警告（K4）を出す。`MACHINE` と `REPO` を置くのと同じ場所である。冒頭で初期化するので、host の環境に同じ名前の変数があっても使われない。
    - `prewarm` も `prepare_machine` を通るので、枠を取る（research C10）。枠は machine に属し、後の起動が同じ枠を使うので、これは意図した動作である。K12 と K4 の表示は `prepare_machine` の中にあるので、`prewarm` でも出る。
    - 値の受け渡しは、グローバル変数への代入で行う。`assign_proxy_port` はサブシェルの中で呼ばない。`pick_proxy_port` だけは `$(...)` で呼ぶが、読むだけなので、サブシェルで失われるものは無い。
  - **lock**
    - `$AGENT_VM_STATE_DIR/ports.lock` を fd 6 で持つ。fd 6 は launcher でまだ使われていない（research H3）。
    - 保持するのは、`assign_proxy_port` の中で、前の値を読んでから meta を書き終えるまでの間だけである。この間に orb を呼ばず、ほかの lock も取らない。`prepare_machine` は repo lock（fd 9）を `assign_proxy_port` の後に取るので、fd 6 と fd 9 を同時に持つことはない。lock の順序による行き詰まりは起きない。この順序（fd 6 を放してから fd 9）を、lock の順序を書いた既存のコメント（L145 の周辺）に足す。
    - `orb_q` が閉じる fd に 6 を足す。保持中に orb を呼ばない決まりが将来破られても、lock が長生きの orb プロセスに残らないようにするためである（fd 9・8・7 と同じ扱い）。
    - lock を取れないとき（30 秒待っても取れない、または lock のファイルを開けない）は、launcher を止める。lock なしに meta を書くと、ほかの launcher と同じ枠を選びうる。`proxy_port` なしで書くと、既にある割り当てを消す。どちらも割り当てを壊すので、起動しない。K4（枠が無いときは止めない）とは場合が違う。
      - 30 秒待っても取れないのは、別の launcher が lock を持ち続けているとき（止められたプロセスなど）である。lock は flock なので、持っているプロセスが終われば解放される（research H19）。保持は meta を最大 100 個読んで 1 個書く間だけなので、正常な launcher が 30 秒持つことはない。
      - lock のファイルを開けないのは、state dir に書けないときである。そのときは meta も書けない。
  - **規則（決定的）**
    1. 自分の meta の `proxy_port` が有効で、ほかのどの meta も同じ値を持たなければ、それを使い続ける。
    2. それ以外は、ほかの meta が持たない最小の枠を選ぶ。
    3. 空きが無ければ `proxy_port` を書かない（K4）。
  - **有効な値**: 先頭が 0 でない 5 桁の数字で、17300 以上 17399 以下のもの。桁の判定を先に行い、通ったものだけを数として比べる。bash は先頭が 0 の数字を 8 進数として読むので、桁を絞らずに比べると `041624` が 17300 として通り、`017308` は算術エラーになる（research H13）。有効でない値は、自分のものでもほかのものでも、無いものとして扱う。
  - **重複**: 2 つの meta が同じ値を持つとき（手の編集などで起きる）、動くのは次に起動した側である。起動していない側の meta は書き換えない。1 つの meta に `proxy_port` の行が 2 つあるとき（これも手の編集でしか起きない）は、最初の行だけが使われる（research H20）。次の起動の書き直しで 1 行になる。
  - **読めない meta**: 列挙した後に消えた meta（ほかの launcher の `rm`）は、枠を持たないものとして扱う。
  - **書き方**: meta は、`machines/.<machine>.XXXXXX` の名前の一時ファイルに書き、`mv` で置き換える。ほかの launcher が書き込み途中の meta を読まないようにするためである。名前がドットで始まるので、`machines/*` の列挙に出ない（research H5、H12）。
  - **meta の契約**: `machines/<m>` のキーは `format`、`repo_path`、`proxy_port` の 3 つになる。`format` は 1 のままにする。キーは足すだけで、読み手は知らないキーを無視する（`read_meta_field`）。この record の `format` を検査する読み手は無い。書き直しで保たれるのは `proxy_port` だけなので、将来キーを足すときは `assign_proxy_port` と同じように、書く前に読み直して渡す。`write_machine_meta` は、3 つ目の引数を渡さなければ、既にある `proxy_port` を消す。launcher で meta を書き直す箇所は `assign_proxy_port` だけにし、ほかの箇所から 2 つの引数で呼ばない。これを `write_machine_meta` の定義のコメントと L419 の周辺に書く。
  - 参照: `home/dot_local/bin/executable_agent-vm:66-70`（`write_machine_meta`。起動のたびに 2 行で上書きする）
  - 参照: `home/dot_local/bin/executable_agent-vm:1500-1507`（`prepare_machine` が repo lock の前に meta を書く）
  - 参照: `home/dot_local/bin/executable_agent-vm:107`（`orb_q` が lock の fd を閉じる）、`tests/agent-vm/run.sh:366`（そのテスト）
  - 参照: `home/dot_local/bin/executable_agent-vm:145-159`（lock の順序のコメントと `acquire_golden_lock`）、`:430`（`write_golden_meta`。lock を取らず、一時ファイル経由で置き換える既存の形）、`:574-588`（呼び出し側が golden lock を持つ）
- **K4: 空きが無いとき、起動を止めない。そのセッションでは portless の仕組みを使わない。**
  - ポートは dev server のための補助で、Claude / Codex の起動の前提ではない。止めると、無関係な作業までできなくなる。
  - launcher は、起動のたびに警告を出す。警告には、この machine では dev server が portless を通らないことと、回復手順を書く。回復手順は `agent-vm rm <repo>`（使わなくなった machine を消す）を先に書き、`agent-vm gc` は「repo を消した machine があれば」と条件を付ける。`gc` が拾うのは repo が無くなった machine だけで、枠切れの原因はたいてい、repo が残っている machine である（research C11）。
  - launch script は `unset PORTLESS_PORT PORTLESS_HTTPS` を実行する。env file にこれらの値があっても、セッションに残さない。env file のほかの `PORTLESS_*`（`PORTLESS_STATE_DIR` など）には触れない。env file は host 所有で、そこに何を書くかは人が決める。
  - このとき VM の agent は、K8 の条件（`PORTLESS_PORT` がある）が成り立たないので、これまでどおり自分でポートを選んで起動する。#207 の衝突は、この machine では防がれない。知らせるのは launcher の警告だけである。
  - 人が `agent-vm shell` で portless を手で起動した場合の挙動は確かめていない。state dir に前回のポートが残っていれば、それで起動すると考えられる（research C8）。そのポートは、既にほかの machine に割り当てられているかもしれない。docs の「ポートが割り当てられないとき」に、この machine では portless を手でも起動しないことを書く。
  - これらを受け入れる理由: 枠が切れるのは、meta が 100 個を超えたときだけである。警告が毎回出て、回復は 1 コマンドである。
  - 参照: `home/dot_local/bin/executable_agent-vm:1578-1606`（`run_tool`。起動の流れ）
- **K5: VM には `PORTLESS_PORT` と `PORTLESS_HTTPS=0` を launch script の `export` で渡す。**
  - 置く位置は env file の source の後にする。env file は host 所有の `env.1password` から作る（research H15）。そこに古い `PORTLESS_PORT` があっても、割り当てが勝つ。この順序は古い値を防ぐためのもので、境界ではない。VM の agent は、セッションの中で環境変数を変えられる。
  - `build_launch_script` は、`PROXY_PORT` を埋める前に、`valid_proxy_port`（K3）で自分でも確かめる。有効でなければ、空のときと同じ扱い（K4 の `unset`）にする。値を launch script の文字列に quote なしで埋めるので、埋める関数が最後に確かめる。判定の関数は K3 と同じ 1 つなので、2 か所で判定がずれることはない。
  - `build_launch_script` は `${PROXY_PORT:-}` で読む。launcher は `set -u` で動き（research H6）、既存のテストは `PROXY_PORT` を設定せずにこの関数を呼ぶ。
  - `claude` / `codex` / `shell` はすべて `build_launch_script` を通るので、1 か所で済む。
  - `forward_env_exports`（host の値を名前で転送する allowlist）は使わない。値は host の環境ではなく meta から来る。
  - `PORTLESS_SYNC_HOSTS` は渡さない。非 root の proxy では /etc/hosts の書き込みが失敗し、`proxy.log` に残るだけである、というのがクラウドのセッションのソースの読みである（research P8）。実機では確かめていない（V33）。
  - 参照: `home/dot_local/bin/executable_agent-vm:1472-1484`（`build_launch_script`）、`tests/agent-vm/run.sh:546-560`（既存のテスト）
- **K6: `agent-vm list` に `proxy_port` を 4 列目として出す。**
  - mac で開く URL のポートを、VM に入らずに後から確かめられるようにする。
  - `proxy_port` の無い meta（この変更の後にまだ起動していない machine、枠切れの machine）では、4 列目は空で、行は tab で終わる。`machine_rows` のコメントの列の説明に、4 列目と「空のことがある」を足す。
  - 4 列目は `valid_proxy_port`（K3）を通った値だけを出す。通らない値は空にする。launcher が無いものとして扱う値を、人に見せないためである。重複した値は、どちらの行にもそのまま出る。次の起動で片方が動く（K3）。
  - `gc` は 1・2 列目しか読まないので影響しない。4 列目は表示のためだけのもので、launcher の中に読み手は無い。
  - 既知の限界: `repo_path` が tab を含むと、4 列目がずれて見える。`write_machine_meta` が拒むのは改行だけである（L67）。影響は表示だけなので、tab を拒む変更は入れない。
  - 見出し行は足さない。`machine_rows` の出力は `cmd_gc` も読む TSV で、`cmd_list` だけに見出しを足すと、`agent-vm list` を awk で読む使い方で 1 行目がずれる。ポートの場所は、K11 の表示と docs（K9）で知らせる。
  - 人向けのサブコマンド（`agent-vm url` のようなもの）は、今回は足さない。V30 で、ポートを後から探す手間についての所感を記録する。足りないと分かれば、別の変更で扱う。
  - 参照: `home/dot_local/bin/executable_agent-vm:1707-1720`（`machine_rows`、`cmd_list`）、`:2041-2043`（`cmd_gc` の awk）
- **K7: portless は、host と共有の `home/dot_config/mise/config.toml` に `portless = "0.15.6"` で入れる。**
  - 0.15.6 にする理由: 0.15.7 は 2026-10-02 の公開で、`minimum_release_age = "7d"` に掛かる。以後の更新は Renovate の mise manager に任せる。
  - VM 専用の mise ファイルにしない理由: `.chezmoiignore` の host 側と VM 側の両方と、`run-templates.sh` の期待リストを変える必要がある（research F8）。host に入っても、portless は自分からは起動しない。
  - host に入る npm のパッケージが 1 つ増える。host は既に mise で npm のツール（`@openai/codex`、`@mizchi/readability` など）を入れているので、新しい種類の経路ではない。0.15.6 の tarball には、install のときに走る script も、外から取る依存も無い（research H17）。
  - npm の install（`npm i -g`）にしない理由: VM のツールは mise で宣言管理している（ADR-0018 K5）。npx での実行は portless が拒否する（research P1）。
  - `allow_low_downloads` は付けない。週ダウンロード数は 1,679,394 で、閾値の 1000 に掛からない（research H8）。
  - 参照: `home/dot_config/mise/config.toml:19-50`
- **K8: VM の agent への指示を、Claude と Codex の global の指示ファイルに 1 行ずつ足す。**
  - Claude: `home/dot_claude/CLAUDE.md` の Key Commands に足す。文言: 「**Dev server**: `PORTLESS_PORT` が設定されているとき（agent-vm）は `portless run <dev コマンド>` で起動し、表示された URL を使う。ポートを自分で選ばない。`portless` が失敗するときは、ほかのポートで起動し直さずに報告する」
  - Codex: `home/dot_codex/AGENTS.md` の `## Commands` に、同じ内容を英語で足す（この節は英語で書かれている）。文言: 「**Dev server**: when `PORTLESS_PORT` is set (agent-vm), start it with `portless run <dev command>` and use the URL it prints. Do not pick a port yourself. If `portless` fails, report it instead of starting the server on another port」
  - どちらのファイルも VM に配られる（research H14）。条件付きなので、host（`PORTLESS_PORT` なし）の動作は変わらない。
  - これが無いと、VM の agent は今までどおり固定のポートで起動し、仕組みが使われない（research C6）。Codex も `build_launch_script` を通って `PORTLESS_PORT` を受け取るので、Claude だけに書くと Codex の dev server が衝突の元として残る。
  - VM 専用の指示ファイルを別に配る形は採らない。配る経路（`.chezmoiignore` の VM 側）が増える。条件付きの 1 行なら、既存の経路のままで済む。
  - この指示は、agent が従うことに頼る。仕組みとして強制はしない（R13）。
  - 参照: `home/dot_claude/CLAUDE.md:13-21`、`home/dot_codex/AGENTS.md:13-18`
- **K9: 記録は docs と ADR-0018 に残す。**
  - `docs/agent-vm.md`「VM でブラウザを使う」の「同じポートの衝突」を、portless の使い方に書き換える。`8a6c0af` の観測（先に bind した machine を止めても移らない）は残す。
  - 同じ節に、次の 4 つを書く。
    - 「どの URL を開くか」の 1 か所の手順。ポートは launcher の起動時の表示か `agent-vm list` の 4 列目、名前は VM の `portless run` の出力か `portless list` で分かる。
    - `portless list` に出ない dev server は、portless を通っていないこと（R13）。
    - cookie の注意（R10）。
    - 開いた先が想定の machine かどうかの確かめ方と、確かめられない URL に認証情報を入れないこと（R9）。確かめ方は、V31 で実際に使えると分かった形を書く。
  - mac の実機での確認項目 V30〜V33 を足す。内容は、この spec の「mac の実機での確認」に書く。表は V29 まで使われているので、その続きの番号にする（research H7）。引き継ぎ前の文書と #207 のコメントが V24〜V27 と呼んでいた 4 項目に対応する（R9〜R12 に合わせて手順を足した）。
  - ADR-0018 に 2 つ書く。
    - Amended by に 1 項を足す。dev server のポートを VM ごとの portless の proxy で振り分けることと、R9 を既存の性質として受け入れたことを書く。
    - Consequences の「`localhost` は先に bind した machine に届く」の項に、portless で避けることと、直接 bind する VM には効かないことを追記する。
  - spec / plan / research は `docs/plans/agent-vm/portless/` に置く。引き継ぎ前の版（WIP の注記つき）を置き換え、`review-notes.md` は内容をこの spec と plan に反映したので消す。これは文書の後始末で、機能の変更ではない。PR の本文では別の項目として書く。
  - 参照: `docs/agent-vm.md:50-51`、`:221-255`、`docs/decisions/0018-agent-vm-orbstack.md:85`、`:89`
- **K10: `scripts/smoke-provisioning-invariants.sh` と `agent-vm/bootstrap.sh` は変えない。**
  - smoke は chezmoi script の名前・順序・内容の不変条件を検査する。mise の `[tools]` に 1 行足しても、検査の対象は変わらない。
  - bootstrap は apt と installer を扱い、mise のツールの一覧を持たない（research「変更が要らないもの」）。
  - #207 のオーダーは smoke script を変える見込みと書いていた。変えない理由は PR の本文にも書く。
  - 参照: `scripts/smoke-provisioning-invariants.sh:3-12`
- **K11: launcher は、セッションを開く前に proxy のポートを 1 行で表示する。**
  - 文言: `agent-vm: dev servers: run them with 'portless run <command>'; open http://<app>.localhost:17301 on the mac`。ポートは割り当てた値を出す。`<app>` は文字どおり出す。名前は portless が dev server の起動時に決めるので、launcher は知らない。
  - 出す先は stderr だけである。stdout には何も足さない。`step` を使うほかの案内と同じである。
  - 出すのは `run_tool` が VM でセッションを開くときだけにする。host で動かす経路と `prewarm` では出さない。`prewarm` はセッションを開かないので、開く URL の案内は要らない。ポートが割り当てられなかったときは、K4 の警告が代わりに出る。
  - 理由: 人が URL のポートを知る手段が `agent-vm list` だけだと、dev server を開くたびに別のコマンドを打つことになる。案 A は URL にポートが残る（採用案の「残る不満」）ので、ポートを探す手間を launcher の側で減らす。
  - 限界: Claude や Codex の画面が開くと、この 1 行は流れて見えなくなる。後から知る手段は `agent-vm list`（K6）と docs の手順（K9）である。VM の中では、portless が起動時に URL を表示する。この 1 行が実際に役に立つかどうかは、V30 で人が確かめる。
  - 参照: `home/dot_local/bin/executable_agent-vm:1589-1591`（`prepare_machine` の後に `notice_orphan_env` と `notice_gh_token_expiry` を呼ぶ並び）
- **K12: ポートが付け替わったとき、launcher が回復手順を表示する。**
  - 付け替えは、`PROXY_PORT_PREV` が空でなく、`PROXY_PORT` がそれと違うときである（K3）。`PROXY_PORT` が空（枠切れ）の場合も含む。
  - 付け替えが起きるのは、前の値が有効なのに保てなかったときである。K3 の規則から、それは、範囲の定数（K2）が変わらない限り、「ほかの meta が同じ値を持つ」ときだけである。重複は、手で meta を編集したときに起きる。
  - 表示は `prepare_machine` の中で出す（K3）。`run_tool` でも `prewarm` でも出る。K11 と置き場所が違うのは、付け替えを知れるのが、meta を書き換えたその呼び出しだけだからである。`prewarm` が付け替えた後の `run_tool` では、前の値と今回の値が同じに見える。
  - このとき、VM で前から動いている proxy があれば、古いポートで待ち受け続ける。launcher の K11 の表示は新しいポートを案内するので、表示どおりに開くと届かない。VM の `portless run` が表示する URL も古いポートのままで、そのポートは今はほかの machine のものかもしれない。回復には、人が VM の中で `portless proxy stop` を実行する必要がある（コマンドは 0.15.6 にある。research H16）。
  - 文言: `agent-vm: proxy port for <machine> changed 17300 -> 17301; a proxy still running in the VM may listen on 17300, and URLs it prints may be stale. recover: run 'portless proxy stop' in the VM, then start the dev server again`。古い値、新しい値、回復の操作を、決まった位置に置く。新しい値が無いときは `none` と出す。launcher は proxy が動いているかどうかを知らないので、「may」と書く。
  - 付け替えが無い起動では出さない。初めての割り当て（前の値が無い）でも出さない。
  - launch script に `portless proxy stop` を入れて自動で止めることは、しない。動いている dev server の経路を落とすかどうかを確かめていない。
  - 検知できない場合: 前の値が meta に無いときは、付け替えかどうかが分からない。古い launcher で起動して `proxy_port` が消えた後（research C9）と、meta を失った後がこれに当たる。meta の中には、古い launcher が消さない場所が無い（古い launcher は meta の全体を 2 行で書き直す）。meta の外に控えを置けば検知できるが、台帳が 2 つになり、`forget_machine` で消す対象も増える。古い launcher で起動するのは版を戻したときに限られるので、控えは置かない。docs の手順で補う（R3）。
  - 理由: 回復に人の手順が要る状態は、害が見えた時点で系が手順を示す（`rules/code-quality.md` の「Recoverable State Must Announce Itself」）。docs に書くだけでは、起きたときに見つからない。

## mac の実機での確認（V30〜V33）

この節の手順は、この作業のセッションでは実行しない。セッションは Linux（WSL2）で動いていて、mac の実機に触れない。人が mac で実行し、結果を `docs/agent-vm.md` の「確認結果」に日付つきで記録する。引き継ぎ前の文書では V24〜V27 と呼んでいた。

この節の判定と merge の条件が正である。コマンドの細部は、plan の task と `docs/agent-vm.md` が複写し、実機での補正はそちらで行う。判定が変わる補正は、spec を改訂する。

**いつ実行するか**: spec と plan を承認して実装し、PR を draft で作った後に実行する。PR は、次の 2 つがそろって ready にするまで merge しない（plan の最後の task に gate として置く）。draft にしておくのは、判定を忘れたまま merge することを GitHub の仕組みで防ぐためである。

- V30・V31・V32 の判定が出ている。
- V30 の R11 の判定と、V33 の手順 2 の判定に「merge しない」と書いた条件が出ていない。

V33 のそのほかの項目は記録だけで、gate にしない。V30 は launcher の変更が無くても実行できる（下の「先に実行する場合」）ので、実装より前に R1 を確定させたいときは、人が先に実行してよい。

**前提**: この変更を含む dotfiles で `chezmoi apply` を済ませる。2 つの repo（X、Y）で `agent-vm shell` を開いておく。下の例では、X のポートを 17300、Y のポートを 17301 とする。実際の値は、launcher の起動時の表示か `agent-vm list` の 4 列目で確かめる。

**先に実行する場合**（V30 だけ、launcher の変更なし）: 既存の machine の `agent-vm shell` で `mise use -g portless@0.15.6` を実行し、手順 3 のコマンドの前に `PORTLESS_PORT=17300 PORTLESS_HTTPS=0` を付ける。launcher が未変更の間は、17300 を割り当てる仕組みが無いので、ほかの machine で同じポートを使わない。ほかの手順は同じである。

- **V30（mac から届くこと）**
  - 操作:
    1. X のポートを控える。
    2. X の VM で `mkdir -p /tmp/vx && cd /tmp/vx && printf '{"name":"vx"}\n' >package.json` を実行する。
    3. 同じ dir で `portless run sh -c 'exec python3 -m http.server --bind 127.0.0.1 "$PORT"'` を実行する。
    4. mac の Chrome で `http://vx.localhost:17300/` を開く。
    5. mac で `curl -sS -H 'Host: vx.localhost:17300' 'http://127.0.0.1:17300/'` を実行する。名前の解決を通さずに、IPv4 の loopback に直接つなぐ。Host は Chrome が送るのと同じ形にする（portless 0.15.6 は Host のポートを落としてから照合するので、ポートの有無で結果は変わらない。research H21）。
    6. mac で `curl -sS -H 'Host: vx.localhost:17300' 'http://[::1]:17300/'` を実行する。
    7. mac で `curl -sS http://vx.localhost:17300/` を実行する（research U2）。
    8. mac で `lsof -nP -iTCP:17300 -sTCP:LISTEN` を実行する。
  - 判定（R1）: 手順 4 と 5 の結果で決める。

    | 手順 4（Chrome） | 手順 5（`127.0.0.1`） | 判定                                                                     |
    | ---------------- | --------------------- | ------------------------------------------------------------------------ |
    | 開く             | どちらでも            | R1 は解消。merge してよい                                                |
    | 開かない         | 届く                  | 原因は `::1` の転送か名前の解決。merge しない。spec を改訂する           |
    | 開かない         | 届かない              | 転送そのものが想定と違う。merge しない。research O1 から調べ直す         |

  - 判定（R11）: 手順 8 の出力の待ち受けアドレスが `127.0.0.1` か `[::1]` だけなら可。`*` や LAN のアドレスがあれば、merge せずに扱いを決める。出力が空のときは、可としない。`sudo lsof -nP -iTCP:17300 -sTCP:LISTEN` を試すか、`netstat -an -p tcp | grep 17300` で待ち受けアドレスを確かめる。どちらでも見えなければ、R11 は未確認として PR に書き、merge しない。
  - 記録だけするもの: 手順 6 と 7 の結果。起動時の 1 行の表示（K11）が役に立ったか、ポートを後から探すのに手間が掛かったか（K6）。
- **V31（machine 間で衝突しないこと）**
  - 操作:
    1. Y でも V30 の 1〜3 を、`/tmp/vy` と `"name":"vy"` で行う。
    2. mac で `curl -sS -H 'Host: vx.localhost:17300' 'http://127.0.0.1:17300/'` と `curl -sS -H 'Host: vy.localhost:17301' 'http://127.0.0.1:17301/'` を実行する。
    3. X と Y の両方の VM で、別の端末から `python3 -m http.server 5174 --bind 127.0.0.1` を起動する（portless を通さない、同じポートへの直接の bind）。その状態で 2 をもう一度実行する（R12）。
    4. X の VM で `portless proxy stop` を実行する。mac で `curl -sS -H 'Host: vy.localhost:17301' 'http://127.0.0.1:17301/'` を実行する。
    5. X の proxy が止まっている状態で、Y の VM で `python3 -m http.server 17300 --bind 127.0.0.1` を起動する。その後、X の VM で `portless run ...` を起動し直す（X の proxy が起動する）。mac で `curl -sS -H 'Host: vx.localhost:17300' 'http://127.0.0.1:17300/'` を実行し、続けて `orb -m <X の machine 名> curl -sS -H 'Host: vx.localhost:17300' http://127.0.0.1:17300/` を実行する。確かめたら Y の bind を止める（R9）。
    6. X と Y の両方で `"name":"app"` の dir を作って同じように起動し、Chrome で `http://app.localhost:17300/` を開いて開発者ツールで cookie を 1 つ設定する。`http://app.localhost:17301/` を開いたときに、その cookie が送られるかを見る。さらに、Y の dev server が `Set-Cookie: t=1; Domain=localhost` を返す状態で `http://app.localhost:17301/` を開き、その後 `http://app.localhost:17300/` を開いて、`t` が X に送られるかを見る（R10）。
  - 判定: X のポートと Y のポートが異なる。2 と 3 は、`vx` の側が `/tmp/vx` の一覧を、`vy` の側が `/tmp/vy` の一覧を返す。4 は `/tmp/vy` の一覧を返す。どれかが崩れたら、merge しない。
  - 記録だけするもの: 5 で R9 が再現したか（mac の応答が Y の一覧になるか）と、X の中から見た応答との比べ方で差が出たか。差が出れば、この比べ方を docs の確かめ方に書く。6 の結果と、Domain つきの cookie の結果。
- **V32（worktree）**
  - 操作:
    1. X の VM で `cd /tmp/vx && git init -q && git add -A && git -c user.name=t -c user.email=t@example.invalid commit -qm init` を実行する。
    2. `git worktree add ../vx-feat -b feat/ui` を実行する。
    3. `/tmp/vx` と `/tmp/vx-feat` のそれぞれで、V30 の 3 と同じ `portless run ...` を実行する。
  - 判定: `/tmp/vx-feat` の側が表示する URL は `http://ui.vx.localhost:17300` である。mac の `curl -sS -H 'Host: ui.vx.localhost:17300' 'http://127.0.0.1:17300/'` と `curl -sS -H 'Host: vx.localhost:17300' 'http://127.0.0.1:17300/'` が、同時にそれぞれの dir の一覧を返す。崩れたら、merge しない（worktree 間の衝突はオーダーの半分である）。
- **V33（導入と、VM の中の待ち受け）**
  - 操作:
    1. mac と VM の両方で、`mise ls portless` と `portless --version` を実行する。
    2. VM で、proxy が動いている状態で `ss -ltn | grep 17300` を実行する。
    3. VM で `grep -i hosts ~/.portless/proxy.log` を実行する（research U5）。
    4. VM で `portless list` を実行する。
  - 判定: 1 は、どちらも 0.15.6 を示す。2 の待ち受けアドレスは `127.0.0.1` と `[::1]` だけである（`0.0.0.0`、`*`、`[::]` があれば、境界の前提が崩れているので merge しない）。3 に /etc/hosts の書き込みの失敗が出ていても、V30 の手順 5 は届いている。4 は、起動した dev server の名前を表示する。
  - mise が install を拒否した場合は、その出力を PR に記録し、対処を別 PR で決める。

## Risks

- **R1（使い勝手の最大のリスク）**: mac の `::1` に向かう接続を、OrbStack が VM に転送するかどうかが分からない（research O3）。Chrome が `app.localhost` を `::1` から試し、失敗したときに `127.0.0.1` を試すかどうかも確かめていない（推測では試すが、根拠は無い）。この変更の主眼は使い勝手なので、mac の Chrome で URL が開かなければ、変更の価値が無くなる。
  - 判定の手順と表は、上の V30 に書いた。Chrome で開かなければ、PR を merge しない。
  - 開かなかったときの改訂の候補は、proxy を `127.0.0.1` だけに bind させる portless の設定の有無の確認と、案 E（host が mac の側の待ち受けを持つ）である。どちらも今は確かめていない。案 E は、常駐の部品の費用を見積もっていないので、採るかどうかは改訂のときに決める。
  - 実装が先で確認が後になるのは、このセッションが mac に触れないからである。確認が崩れた場合に捨てることになるのは、launcher の変更（割り当てと表示）と docs である。割り当ての部分は案 E の下でも使えるので、捨てるのは主に docs と指示の文言になる。
- **R2**: mac 側で 17300〜17399 を別のプログラムが使っていると、そのポートの machine には届かない。launcher は mac 側の使用を検知しない。→ docs に書く。`agent-vm list` でポートが分かるので、該当 machine を `rm` して作り直せば別の枠になる。
- **R3**: 割り当てが付け替わると、VM で動いている proxy は古いポートのまま残る。portless は state dir の `proxy.port` を見て、既に動いている proxy を使う。
  - 検知できる付け替え: 前の値が meta にあって保てなかった場合。重複の解消がこれに当たる。K12 の表示が回復手順を示す。
  - 検知できない付け替え: 前の値が meta に無い場合。古い launcher で起動した後（research C9）と、meta を失った後がこれに当たる。表示は出ない。→ docs に「表示のポートで開けないときは、VM で `portless proxy stop` を実行してから dev server を起動し直す」と書く。
- **R4**: mise が host と VM で portless 0.15.6 を実際に入れられるかは、まだ確かめていない（research U4）。週ダウンロードの閾値には掛からない（research H8）。入らなければ、VM には `PORTLESS_PORT` だけがあって `portless` が無い状態になり、agent は K8 の指示に従って失敗を報告する。→ 人が mac と VM で確かめる（V33）。
- **R5**: portless の `engines.node` は `>=24` で、mise の node は 24.15.0 なので満たす。node を 24 未満に下げると壊れうる。→ 実行時には強制されない（research P1）。今は対処しない。
- **R6**: 既存の machine の meta には `proxy_port` が無い。→ 次の起動で `assign_proxy_port` が割り当てる。移行処理は要らない。起動するまでは枠を持たないので、ほかの machine の割り当てと衝突しない。
- **R7**: portless の挙動（research P1〜P10）は、クラウドのセッションがソースと Linux コンテナで確かめた記録で、この worktree では確かめ直していない。この worktree で確かめたのは、0.15.6 の tarball にコマンドと環境変数の名前があること（research H16）と、install の script が無いこと（H17）までである。mac と OrbStack の VM での挙動は V30〜V33 で初めて確かめる。proxy が loopback だけで待ち受けること（P4）も、V33 で確かめる。→ V30〜V33 の結果を `docs/agent-vm.md` の確認結果に記録する。
- **R8**: 途中で落ちた launcher が残すもの。
  - 書いている途中で落ちると、`machines/` にドットで始まる一時ファイルが残る。列挙には出ず（research H5）、次の起動は別の名前の一時ファイルを作るので、動作には影響しない。掃除の処理は入れない。
  - meta を書いた後、machine の作成に失敗すると、枠は meta とともに残る。`agent-vm rm <repo>` で空く。
  - `orb delete` を launcher の外で実行すると、meta が残り、枠を持ち続ける。repo が残っていれば `gc` の対象にならない（research C11）。`agent-vm rm <repo>` で空く。K4 の警告は、この手順を先に示す。
- **R9（既存の性質、受け入れる）**: VM の中のプロセスは、ほかの machine に割り当てられた proxy のポートに直接 bind できる。host は止められない（research O6）。先に bind すれば、mac のそのポートは bind した VM に届く。
  - 影響は次の 3 つである。
    - 人がほかの machine の URL を開いたつもりで入力した値（認証情報など）が、bind した VM に渡る。同じ名前のアプリの cookie も送られる（R10）。
    - 奪われた側の machine は気づけない。その machine の proxy は自分の VM の中で bind に成功し、`portless list` も正常に見える。
    - 範囲は 100 個に決まっている。1 台の VM が 17300〜17399 のすべてに先に bind すれば、後から proxy を起動するすべての machine の URL が、その VM に向かう。
  - 奪える窓は、相手の proxy がそのポートに bind していない間である。先に bind した側が勝つ（#207 の観測）ので、相手の proxy が動いている間は奪えない。machine の停止や再起動の後、proxy を止めた後、最初の `portless run` の前に窓が開く。
  - この変更の前から、どのポートでも同じことが起きる（#207 の性質そのもの。ADR-0018 の Consequences は、これを同じポートの衝突として記録している。悪意のある bind による奪取としての記録は、今回の Amended by が初めてである）。5173 や 3000 のような広く使われるポートは、前から予測できる。この変更が加えるのは、すべての machine のポートが 1 つの決まった範囲に入ることである。
  - この差を受け入れる理由: 防げる可能性のある手段は案 E だけで、常駐の部品を要し、実現の方法も調べていない。奪うには、VM の中の agent が意図してほかの machine のポートに bind する必要があり、窓も上のとおり限られる。
  - この変更が保証するのは、launcher の割り当てが重ならないことまでである。VM の中の悪意ある bind は防がない。
  - 防ぐ仕組みは入れない。OrbStack の転送は host から制御できない。mac の `lsof` で見えるのは OrbStack の待ち受けだけで、どの VM に転送されるかは分からない。防げる可能性があるのは案 E（host が mac の側の待ち受けを先に持つ）だが、既に使われているポートに対する OrbStack の振る舞いは確かめていない。
  - 確かめ方: mac から届く応答と、その machine の中から見た応答を比べる。`agent-vm list` と VM の `portless list` の突き合わせでは分からない。どちらも奪われた側の正しい情報で、奪われていても一致する。比べる具体的なコマンドは V31 の手順 5 で確かめてから docs に書く。使えなければ、docs には「確かめる手段が無い」と書く。比べて違えば、奪われている。同じでも、bind した側が要求を相手の proxy に中継していれば区別できないので、安全の証明にはならない。docs にもこの限界を書く。
  - docs に、確かめられない dev server の URL に認証情報を入れないことを書く。
  - 見直す条件: OrbStack が machine ごとの転送の制御を提供したとき。信頼しない repo を isolated machine で扱う使い方が増えたとき。launcher が起動時に mac の側の待ち受けと VM の側の待ち受けを比べる検知（R2 も同時に扱える）が、常駐の部品なしで足せると分かったとき。
  - ADR-0018 の Amended by に、この受け入れを書く（K9）。
- **R10（cookie。境界の限界）**: cookie はホスト名で分かれ、ポートでは分かれない（research C5）。2 台の machine のアプリが同じ名前（`app.localhost`）を持つと、同じブラウザのプロファイルでは、片方の dev server がもう片方の cookie を受け取る。片方の VM の agent を信頼しない前提では、もう片方の dev server の認証の cookie がその VM に渡る、ということである。これまでの `localhost:<port>` でも同じ共有はあった。portless では名前が package.json の `name` から決まるので、machine の間で重なりうる。→ docs に書く。認証つきの dev server を複数の machine で開くときは、ブラウザのプロファイルを分けるか、名前を machine の間で重ならないものにする。V31 で、cookie が実際に共有されるかを記録する。
- **R11（mac の側の待ち受け）**: mac の側で OrbStack が転送のために listen するアドレスは確かめていない（research O7）。`0.0.0.0` なら、平文の dev server が LAN から届く。これも転送の既存の性質だが、この変更は毎回の起動で同じポートを案内するので、確かめておく。→ V30 の手順 8 で記録する。loopback 以外なら、PR を merge せず、扱いを決める。
- **R12（アプリのポートの転送）**: アプリのポート（4000〜4999）も mac に転送されうる（research O6）。2 台が同じアプリのポートを選ぶと、そのポートでは #207 と同じことが起きる。proxy からアプリへの転送は VM の中で完結するので、人が開く経路には影響しないと考えられるが、確かめていない。→ V31 の手順 3 で確かめる。
- **R13（指示への依存）**: K8 は、agent が指示に従うことに頼る。agent が `portless run` を使わずに固定のポートで起動すれば、衝突は防がれない。launcher は検知しない（「Phase 1 で意図的に提供しない体験」）。→ 受け入れる。指示は Claude と Codex の両方に届く（research H14）。人が気づく手段として、docs に「`portless list` に出ない dev server は portless を通っていない」と書く（K9）。

## Phase 1 で意図的に提供しない体験 (任意)

### portless を通さない dev server の衝突の検知

- **代替経路確認**: `portless run` が、アプリのポートを `PORT` と `--port` で上書きする（research P5）。portless を通せば、人が開くのは proxy のポートだけになる。
- **非提供対象**: portless を使わずに直接 bind したサーバー同士の衝突（#207 の状況そのもの）を、launcher が検知・警告すること。VM の中の bind を host から監視する仕組みが要り、OrbStack の転送の内部状態は観測できない。
- **将来の予定**: 恒久的に非提供。docs で「portless を通す」と案内する。

### URL からポートを消す（mac の側の名前の振り分け）

- **代替経路確認**: `PORTLESS_PORT` で任意の 1024 以上のポートを使える（research P3）。ポートは起動時の表示（K11）と `agent-vm list`（K6）で分かる。
- **非提供対象**: `https://<app>.localhost`（ポートなし）での閲覧。mac の側に、名前から machine ごとの proxy のポートへ振り分ける部品を置けば実現できる（案 B の、案 A を下の層にする形）。443 での待ち受けと、machine の起動と停止に追従する常駐の部品が要る。
- **将来の予定**: 今回は提供しない。案 A の割り当ては、その形の下の層としてそのまま使える。要るようになったら別の spec で扱う。

## ISO 25010 次元選択

- **機能適合性（正確性）**: 割り当てが重ならないこと、同じ machine で同じ値が続くこと、有効でない値（範囲外、先頭が 0、数字以外）と空きが無い場合の扱い。launcher の関数の単体テストで確かめる。複数の launcher の同時起動は、別プロセスを並べて走らせるテストで確かめる。
- **互換性（共存性）**: 既存の meta の読み手（`repo_path` だけを読む）と `gc` が、`proxy_port` の追加で変わらないこと。`write_machine_meta` を 2 つの引数で呼ぶ既存のテストが、そのまま通ること。`proxy_port` の無い古い meta を読んで割り当てられること。4 列目が空の行（tab で終わる）と値のある行の両方。`proxy_port=041624` の meta は 4 列目が空になること。3 つの引数で書いた meta を 2 つの引数で書き直すと `proxy_port` の行が消えること（意図した動作）を、単体テストで固定する。
- **信頼性（障害許容性）**: 空き枠がないときも起動が止まらないこと。lock が他の lock から独立し、割り当ての後に fd が残らず、`orb_q` が fd 6 を閉じること。付け替えのとき（`prewarm` の経路を含む）に回復手順が表示され、付け替えの無い起動と初めての割り当てでは表示されないこと。
- **セキュリティ（完全性）**: 2 つを分けて扱う。
  - meta を介した経路: VM は meta を書き換えられない（meta は VM から見えない、既存の性質）。env file の `PORTLESS_PORT` が割り当てに勝たないこと、有効でない `PROXY_PORT` を `build_launch_script` に直接渡しても launch script に埋まらず `unset` になることを、単体テストで確かめる。
  - 直接 bind する経路: 防がない（R9）。テストの対象にしない。
- **使用性**: 起動時の 1 行がポートを含み、stderr だけに出ること（単体テスト）。URL の開きやすさそのものは mac の実機の確認（V30〜V33）で見る。
- **対象外**
  - 性能効率: 割り当ては meta の数（最大で 100）を 1 回読むだけで、計測するほどの差がない。
  - 保守性・移植性: bash 3.2 互換は制約（Goal）である。追加するテストは `tests/agent-vm/run.sh` に入り、CI の macOS の job が `/bin/bash` で走らせる。この作業の環境（bash 5）では確かめられない。

## Approval

- Plan Status: complete
- Review Status: pass
- Approval Status: approved

## Reviewer Outputs (Round 1)

### logic-validator
- verdict: needs-work
- 主指摘: 「アプリのポートは VM の中で閉じる」は research O1 と矛盾する（loopback の bind は mac に転送される）。K4 の「443 を使おうとして失敗する」は P9（前回のポートを state dir から読む）と整合しない。ほかに、先頭 0 の値の判定、lock を取れないときの扱い、`PROXY_PORT` の受け渡しの記述、`orb delete` を直接実行した machine の枠が minor。

### scope-justification-reviewer
- verdict: pass
- 主指摘: K1〜K11 に評価語だけの根拠は無い。minor は、portless が無いときの agent の動き、K4 と K8 の組み合わせ（枠切れでは agent が従来どおり起動する）、K11 の `<name>` の表記、stdout を汚さないことの確認。

### decision-quality-reviewer
- verdict: needs-work
- 主指摘: 支配軸の選択は合っている。最大の使い勝手のリスク R1 の検証が実装の後ろにあり、届かない場合の分岐が spec の中で決まっていない。minor は、K11 の 1 行が TUI で流れること、K4 と K8 の矛盾、bash 3.2 と sudo なしを Goal の制約に並べること。

### greenfield-perspective-reviewer
- verdict: pass
- 主指摘: 前回の指摘 4 点は反映済み。minor は、案 C に VM 内の送信元の制限を検討していないこと、案 A が案 B の下層になれること、「443 には sudo が要る」は portless の挙動であること、ポートは machine を作り直すと変わること。

### architecture-boundary-analyzer
- verdict: needs-work
- 主指摘: `write_machine_meta` が割り当ても担うのに、決める関数・書く関数・`PROXY_PORT` を設定する場所が spec に書かれていない。`prewarm` も枠を取ることの扱いが無い。minor は、`orb_q` で fd 6 を閉じること、lock の順序の記述、重複のときにどちらが動くか。

### security-vulnerability-analyzer
- verdict: needs-work
- 主指摘: VM はほかの machine の proxy のポートに直接 bind して転送を奪える（既存の性質だが、spec の「奪えない」「起きない」は言いすぎ）。`*.localhost` の cookie はポートをまたいで machine 間で共有される。mac 側で OrbStack が listen するアドレスが確認項目に無い。minor は、8 進数、`build_launch_script` での再検証、枠切れのときに env file の値が残ること、host に入る install script。

### data-contract-evolution-evaluator
- verdict: needs-work
- 主指摘: ポートが付け替わったとき、VM の proxy は古いポートで動き続け、launcher は新しいポートを案内する。回復手順を付け替えた起動で示す必要がある。付け替えは手の編集のほか、古い launcher での起動でも起きる。minor は、meta のキーの規約の記録、書き直しで保つのは `proxy_port` だけであること、4 列目が空になる場合。

<!-- auto-review: pending -->
<!-- intent-triage: pending -->

## Reviewer Outputs (Round 2)

### logic-validator
- verdict: needs-work
- 主指摘: 前回の blocking 2 件は解消。残りは minor。K3 の「30 秒取れないのは state dir に書けないとき」は flock の性質と合わない（別の launcher が持ち続けている場合である）。K12 の「前の値」を読む場所と、枠切れで値が無くなる場合が未定義。R1 の判定に使う curl の形が固定されていない。`portless proxy stop` の実在が research に無い。

### scope-justification-reviewer
- verdict: pass
- 主指摘: 足した変更はどれもオーダーか制約に結び付く。minor は、`prewarm` で付け替えが起きると K12 が出ないこと、K12 と R3 の「付け替えが起きる場合」のずれ、K12 の文言の断定。

### decision-quality-reviewer
- verdict: needs-work
- 主指摘: 軸のずれは無い。R1 の分岐は書かれたが、V30 を先に実行するかどうかが開いたままで、R1 が未確定のまま承認できる。手順の全文と判定の欄を spec に置き、既定を決めること。minor は、ポートを後から探す手間の所感の記録、R13 に気づく手段。

### greenfield-perspective-reviewer
- verdict: pass
- 主指摘: 前回の 6 件は反映済み。minor は、「起きない」が R9 より強いこと、K12 の原因の列挙が R3 より狭いこと、host 主導の転送（launcher が mac の listener を持って VM へ中継する）の案が一覧に無いこと。

### architecture-boundary-analyzer
- verdict: needs-work
- 主指摘: 「書く関数が lock を取る」は既存の流儀（golden lock は呼び出し側が持ち、`write_golden_meta` は lock を取らない）の逆で、「採らなかった形」の理由も成り立たない。呼び出し側が lock を持ったまま決定と書き込みを呼べばよい。`prewarm` で付け替えが起きると K12 が出ない。

### security-vulnerability-analyzer
- verdict: needs-work
- 主指摘: R9 の確かめ方（`agent-vm list` と `portless list` の突き合わせ）は、どちらも乗っ取られた側の正しい情報なので検知にならない。R9 を受け入れるなら、影響（入力した値が渡る、乗っ取られた側は気づけない、範囲の全部を 1 台が押さえられる）と再検討の条件を書くこと。`prewarm` で付け替えが起きると K12 が出ない。

### data-contract-evolution-evaluator
- verdict: needs-work
- 主指摘: K12 の「前の値」を取る場所と時点が未定義（上書きの前にしか取れない）。`prewarm` が付け替えを先に消費すると K12 が一度も出ない。K12 が検知できるのは実質、重複の解消だけで、R3 の書き方はそれより広く読める。minor は、`repo_path` の tab、`proxy_port` の行が 2 つある meta。

<!-- auto-review: verdict=needs-work; hash=6be197e4090eff061a51744b8d15c8fe272384aec4a344fd9171cbbbd5d65b94; design-hash=2193e1b1dd032c815a62e6a2ece90650cb09f3f4855df1c3257d4d2f912d7645; round=1; at=2026-10-04T09:28:43.516Z; reviewers=logic-validator+scope-justification-reviewer+decision-quality-reviewer+greenfield-perspective-reviewer+architecture-boundary-analyzer+security-vulnerability-analyzer+data-contract-evolution-evaluator -->

## Reviewer Outputs (Round 3)

### logic-validator
- verdict: pass
- 主指摘: 前回の指摘 7 件は解消。設計の矛盾は無い。minor 4 件（`pick_proxy_port` の `*.lock` の除外の明記、V30 の curl の Host にポートを付ける、Experience Delta に「手で編集しない限り」、K12 に「範囲の定数が変わらない限り」）は、示された文言で反映した。

### scope-justification-reviewer
- verdict: pass
- 主指摘: 足したものにオーダーと結び付かないものは無く、退けたものにも具体的な根拠がある。minor 3 件（merge の gate の範囲に V32・R11・V33 の手順 2 を含める、判定が正でコマンドの細部は plan と docs で補正する、「同じ 4 項目」の言いすぎ）は反映した。

### decision-quality-reviewer
- verdict: pass
- 主指摘: 前回の blocking は解消（手順の全文、判定の表、既定の gate がそろった）。軸のずれは無い。minor 4 件（PR を draft で作る、Goal の「境界」の範囲、R9 の差を受け入れる理由、先に実行するときの注意）は反映した。R9 の受け入れ理由の文言は、reviewer の案を採らず、奪える窓の記述と合わせて書いた。

### greenfield-perspective-reviewer
- verdict: pass
- 主指摘: 案 E の退け方は具体的な根拠で成り立ち、取りこぼした案は無い。minor 3 件（中継がセッションより長生きする必要の根拠、「R9 が消える」の言いすぎ、R1 の改訂の候補としての案 E の費用）は反映した。

### architecture-boundary-analyzer
- verdict: pass
- 主指摘: 前回の blocking は解消。`assign_proxy_port` が lock を持ち、書き手が取らない形は、`ensure_machine` と `write_golden_meta` の既存の形と一貫する。minor 1 件（K3 の見出しの「呼び出し側が持つ」の言い方）は反映した。

### security-vulnerability-analyzer
- verdict: pass
- 主指摘: 前回の blocking 3 件は解消。R9 の受け入れは脅威モデルの下で妥当。minor 7 件（確かめ方の限界、V31 の手順 5 で R9 を再現する、`lsof` の出力が空のとき、`[::]`、Domain つきの cookie、ADR の記録の言い方、見直す条件）は反映した。奪える窓（相手の proxy が bind していない間）の記述も足した。

### data-contract-evolution-evaluator
- verdict: pass
- 主指摘: 前回の blocking 2 件は解消。契約の穴は無い。minor 3 件（2 つの引数で呼ぶと `proxy_port` が消える契約の明示、`agent-vm list` の 4 列目は有効な値だけを出す、書き込みの失敗の扱いと代入の順序）は反映した。

<!-- auto-review: verdict=needs-work; hash=aaa31600248749bb04a0622aef9343fcb3ae0158ea1ccb87a10c75dda5c55b8e; design-hash=8b54465f7572bfe8624e1a1c98f9123fb7e84b131c0d61831eb50f332df3a562; round=2; at=2026-10-04T09:35:08.280Z; reviewers=logic-validator+scope-justification-reviewer+decision-quality-reviewer+greenfield-perspective-reviewer+architecture-boundary-analyzer+security-vulnerability-analyzer+data-contract-evolution-evaluator -->

<!-- auto-review: verdict=pass; hash=a0a147a1a66b04bb6dfeb243bb98d63a031be2c9ee398799bfb2d64a8e4a7813; design-hash=dca67b619e52aeaeaea767def119c4d853f1643b07b08c62b2da5ac2dc6e768e; round=3; at=2026-10-04T09:44:00.377Z; reviewers=logic-validator+scope-justification-reviewer+decision-quality-reviewer+greenfield-perspective-reviewer+architecture-boundary-analyzer+security-vulnerability-analyzer+data-contract-evolution-evaluator -->
<!-- intent-triage: adopted=106; excluded=1; at=2026-10-04T09:44:23.110Z -->
