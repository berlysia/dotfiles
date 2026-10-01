# Spec: agent-vm の新規 machine を golden machine の clone で作る

調査: `research.md`（同ディレクトリ）。前提となる OrbStack の挙動は、2026-10-01 に host の OrbStack 2.2.3 で実測した。コードの参照行は master `85a60fe`（VM の headless browser と gh token の導入後）に合わせてある。

## Goal

repo ごとの isolated machine を新しく作るときの待ち時間（実測 5〜8 分）を、2 台目以降は数秒に縮める。ADR-0018 の隔離（machine 単位の認証、machine ごとの staging / outbox、VM 間の書き込み経路なし）は変えない。

## Experience Delta

- 変更前: 初めての repo で `claude` を打つと、毎回 5〜8 分待つ（`orb create` + cloud-init + 初回 bootstrap）
- 変更後: 最初の 1 台だけは今と同程度に待つ（golden の作成）。2 台目以降で、前回 golden を更新してから dotfiles（staging に入る tracked files）に変更が無ければ、golden を起動せずに clone、clone 先の起動、clone 先の bootstrap だけで起動する。clone 先の bootstrap は browser 対応前の実測で 1 秒だった。今の bootstrap は browsers の mount があると毎回 `apt-get update` を走らせる（`agent-vm/bootstrap.sh` の `install_browser_deps`）ので、この数秒が加わる見込みで、plan の実機検証で測り直す。apt や mise の上流の更新は dotfiles の変更ではないので、この判定では golden は更新されない。上流の更新を取り込みたいときは `agent-vm golden refresh` を実行する。dotfiles に変更があれば、golden の差分更新（golden の起動・bootstrap・停止）が加わる。golden の起動と停止の所要時間は未計測なので、plan の実機検証で測る。初回セットアップのときや dotfiles を更新した後に `agent-vm golden refresh` を実行しておけば、次の新規作成の待ちを前もって済ませられる

## Architecture

```
prepare_machine (repo lock: fd 9)
  ├─ build_staging <m>
  ├─ ensure_machine <m>
  │    ├─ machine があり、作成中の sentinel が無い → return（既存の machine、K9）
  │    ├─ machine があり、sentinel が残っている → orb delete -f <m>（前回の作成が途中で終わった、K5）
  │    ├─ check_mount_paths（repo path・staging/<m>・outbox/<m>・browsers/<m> のいずれかが `,` `:` 改行を含めば die、K4）
  │    ├─ golden lock (fd 7) を取得
  │    │    ├─ ensure_golden（K2、K11）
  │    │    │    ├─ golden の VM が無い / meta が無い / format か state が不明 / cloud-init hash か contract が現在と違う
  │    │    │    │    → golden の meta・VM・staging・outbox・browsers を消して作り直す（orb create。golden 専用の staging / outbox / browsers だけを mount し、repo は mount しない）
  │    │    │    │    → 作成した回は下の更新工程の代わりに、初回の bootstrap → seal → stop → verify_golden → meta（state=sealed）で終える
  │    │    │    ├─ build_staging agent-vm-golden
  │    │    │    ├─ state=sealed かつ staging_hash が今回の staging hash と同じ かつ golden が停止中 かつ refresh の強制でない
  │    │    │    │    → 更新を飛ばす
  │    │    │    ├─ それ以外（state=updating の再試行を含む）→ meta を state=updating に書き換える → 停止中なら orb start
  │    │    │    │        → maybe_bootstrap agent-vm-golden（差分だけ）
  │    │    │    │        → golden-seal.sh（VM 内: 識別子を消す、認証の痕跡を検査する、applied-hash を消して不在を確かめる。K7、K12）
  │    │    │    │        → orb stop agent-vm-golden
  │    │    │    ├─ verify_golden（host 側: 設定キーと outbox の中身を検査。更新を飛ばした場合も毎回行う、K6）
  │    │    │    └─ meta を state=sealed と今回の staging_hash で書く（一時ファイルに書いて mv。更新と検査が全部通ったときだけ）
  │    │    ├─ staging/<m>・outbox/<m>・browsers/<m>・browser-records を作る（今の orb create 経路と同じ）
  │    │    ├─ sentinel creating/<m> と browser-records/<m>.mount を書き、browser-records/<m>.id を消す（今の orb create 経路と同じ印）
  │    │    ├─ orb clone agent-vm-golden <m>
  │    │    ├─ orb config set machine.<m>.mounts "<repo>:<repo>,<staging/m>:/opt/agent-vm/src,<outbox/m>:/opt/agent-vm/outbox,<browsers/m>:/opt/agent-vm/browsers"
  │    │    └─ verify_clone_config <m>（全設定キーを検査、K4）
  │    ├─ golden lock を解放
  │    ├─ orb start <m>
  │    └─ sentinel を消す
  ├─ ensure_browsers <m>（既存の処理。browser store の lock は fd 8。golden の lock を解放した後に走る）
  └─ maybe_bootstrap <m>（golden-seal.sh が applied-hash を消してあるので必ず走る。K2）
```

失敗したら、clone 先を削除してから die する（`orb delete -f <m>`。削除が成功したら sentinel も消す）。削除に失敗した場合や、launcher が中断された場合は sentinel が残り、次の起動がそれを見て作り直す。

golden の名前は定数 `GOLDEN_MACHINE=agent-vm-golden` に固定する。`derive_machine_name` が返す名前は `agent-<base>-<6 桁の 16 進>` なので、`golden` が 16 進でない以上、どの repo の machine 名とも一致しない。この性質はテストで固定する。

## Alternative Approaches (Greenfield View)

### 差分最小案 (Incremental)

作成方式は変えず、apply の中身を速くする。marketplace 登録 5 件の並行化（26s）、VM で使わない mise ツールを `conf.d/host-toolchains.toml` へ移す（mise 76s の一部）、ログの無い 15s の特定。handoff の計測の範囲で見込める短縮は、合わせて 1〜2 分という推定である。create の 55〜249s と claude の install 52s は残るので、新規作成は 3 分を下回らない見込みになる。

### 白紙設計案 (Greenfield)

ゼロから設計するなら、「repo ごとの VM」と「ツールチェインの準備」を分け、準備済みの基礎 image から repo ごとの VM を派生させる。起源は、ADR-0018 が Docker container 案を「image の保守コスト」で却下した理由にある。image を別の定義（Dockerfile）で書けば、bootstrap との二重管理になる。そこで bootstrap 自身を image の定義とし、その実行結果を image として使う。OrbStack では、この「image」の候補が 3 つある。

1. `orb export` / `import` でファイル化した golden（import 1.2s。golden 1 台あたり数 GB のファイルを host に置く）
2. 作り置きした予備 machine の pool（`orb rename` で repo 名に付け替える。予備の台数分のディスクとメモリを常に使い、予備ごとに古くなる）
3. `orb clone`（copy-on-write。clone 直後の使用量は 16 kB、所要 1 秒未満）

3 は、1 と 2 の利点（速い、追加の定義が要らない）を持ち、欠点（ファイルの置き場所、予備の維持費）を持たない。白紙案は clone を使う golden になる。

白紙設計ではさらに、派生のときに隔離設定を構造的に正しい値へ固定したい。理想は、golden を mount ゼロで作り、clone 先が受け継ぐものを無害にすることである。しかし OrbStack の clone は設定を必ず受け継ぎ（実測）、作成時に mount を指定できない。そのため、clone 先の設定を起動前に差し替えて検査する形（K4）が、この環境で取れる最も近い構造になる。golden が mount するのは golden 専用の staging、空のディレクトリ 2 つだけの outbox、空の browsers であり、差し替えが漏れても検査が起動を止める。

### 採用案と理由

白紙案（clone を使う golden）を採る。根拠は 3 つある。

- 実測では、golden 方式の 2 台目以降の作成は、約 1 秒（clone + config + start）と 1 秒の bootstrap で済んだ。差分最小案の到達点（3 分以上という推定）とは桁が違う
- golden の中身は既存の `bootstrap.sh` の実行結果そのものなので、定義の二重管理は生じない。ADR-0018 が Docker 案を却下した理由（image の保守コスト）に当たらない
- 差分最小案の各施策は golden 方式と両立し、golden の作成と更新の時間をさらに縮める。今回は入れず、golden 方式で残る「最初の 1 台」の待ちに対する別の課題とする

## Key Decisions

- **K1: repo 用の machine は常に golden の clone で作る** — golden が無ければ先に作り、それから clone する。repo 用の machine を直接 `orb create` する経路は残さない。`orb create` は golden を作るときだけ使う。作成経路を 1 本にすれば、隔離設定の検査（K4）を、すべての新しい repo 用 machine に必ず通せる。最初の 1 台の待ちは、今の作成と同程度（golden の create と bootstrap）に、clone の 1 秒が加わるだけになる
  - 参照: `home/dot_local/bin/executable_agent-vm:276-295`（現在の `ensure_machine`）
- **K2: golden は clone の直前に差分更新し、clone 先では bootstrap を必ず 1 回走らせる** — `ensure_golden` は golden の staging を作り直す。更新を飛ばすのは、次の 4 つがすべて成り立つときだけである: meta が `state=sealed`、その hash が meta の `staging_hash` と一致する、`orb list` で golden が停止中、`golden refresh` による強制でない。`staging_hash` は前回 bootstrap に渡した staging の hash で、meta を書くときに計算し直さない。それ以外の場合は golden を起動して `maybe_bootstrap` を走らせ、差分の大部分（mise・APM・bun など）を golden で払う。golden が停止中であることを条件にするのは、手作業で起動したままの golden を clone しないためである。golden は seal の後に launcher から起動されておらず、host 側の検査（K6）は毎回行うので、更新を飛ばしても検査済みの状態のまま clone できる（手で golden に入った場合の限界は R8）。dotfiles に変更が無い限り、新規作成で golden の起動と停止を払わずに済む。同じ内容の staging が同じ hash になり、1 ファイル変えると hash が変わることは、テストで固定する。clone 先でも bootstrap を必ず 1 回走らせるために、golden-seal.sh が golden の `applied-hash` を消してから golden を止める。理由は、chezmoi のテンプレートが `.chezmoi.hostname` を使い（`home/dot_shell_common/env.sh.tmpl:33` の `CLAUDE_COMPUTER_NAME`、`home/dot_codex/private_config.toml.tmpl:10` の overlay 名、`home/.chezmoi.toml.tmpl:9`）、skip すると golden の hostname で描画された内容が clone 先に残るためである。clone 先の bootstrap は golden と内容が同じなので、差分の処理はほぼ無い（browser 対応前の実測で 1 秒、rc=0。今は `install_browser_deps` の `apt-get update` が加わるので、plan で測り直す）。これにより、「staging の hash が machine に依存しない」ことを skip の前提にしなくて済む
  - 参照: `home/dot_local/bin/executable_agent-vm:340-348`（`maybe_bootstrap`）、`agent-vm/bootstrap.sh:266-267`（`applied-hash` の記録）
- **K3: golden 専用の lock を fd 7 で持ち、clone の検査が終わるまで保持する** — fd 9 は repo の lock、fd 8 は browser store の lock（`acquire_store_lock`）が既に使っているので、golden の lock には fd 7 を使う。lock ファイルは `$AGENT_VM_STATE_DIR/golden/lock` に置く。`machines/` の外に置くので、`list` / `gc` / `rm` の走査には現れない。取得の順序は常に repo の lock（fd 9）が先、golden の lock（fd 7）が後とする。保持する範囲は、`ensure_golden` の開始から、clone、`config set`、`verify_clone_config` が終わるまで。こうすれば golden の更新・削除と clone が重ならず、同時の clone も起こらない。browser store の lock（fd 8）は `ensure_browsers` と `cmd_fetch_browsers` の中でしか取られず、`ensure_browsers` は golden の lock を解放した後に走るので、fd 7 と fd 8 を同時に持つ経路は無い。`agent-vm golden refresh|rm` は golden の lock だけを取るので、順序が逆になる経路は無い。golden の作成は 8 分かかりうるので、待ちの上限は 900 秒とし、待っている間は「another session is building the golden machine」と表示する（repo の lock の文言と区別する）。lock の fd が子プロセスに受け継がれると、launcher が終わっても lock が解けない。そこで新しく足す `orb` の呼び出しは、`</dev/null 9>&- 8>&- 7>&-` を常に付ける wrapper 関数 1 つにまとめ、golden の lock を持つ間に走る既存の `maybe_bootstrap` もこの wrapper に寄せる。同じく golden の lock を持つ間に走る `build_staging` の rsync と find にも `8>&- 7>&-` を足す
  - 参照: `home/dot_local/bin/executable_agent-vm:102-117`（`acquire_lock` は fd 9）、`:180-191`（`acquire_store_lock` は fd 8。順序は fd 9 → fd 8）、`:154`・`:167`（`build_staging` の `9>&-`）、`:278`・`:294`（`9>&- 8>&-` の既存の書き方）
- **K4: clone 先は、repo path と全設定キーを検査してから起動する** — clone 先は golden の mount を受け継いで生まれる。差し替えずに起動すると、clone 先どうしが golden の outbox を共有し、ADR-0018 が却下した「共有 staging」と同じ VM 間の経路ができる。手順は 3 段になる
  1. clone の前に、mount 文字列に入る 4 つの path（repo path、`staging/<m>`、`outbox/<m>`、`browsers/<m>`。後の 3 つは `AGENT_VM_STATE_DIR` で上書きできる）のいずれかが `,` `:` 改行を含めば die する。`config set` の値はカンマ区切りの `SRC:DEST` なので、カンマを含む path は余分な mount を注入できる。期待値も同じ文字列から作るので、後の比較では検知できない。die の文言では、該当する path と文字、`AGENT_VM=off` を示す。`:` を含む repo path は今の `--mount SRC:DEST` でも区切りがずれるので、新たに使えなくなる repo は無い見込みである（ADR-0020 に記録する）
  2. 今の `orb create` 経路と同じく、mount 元の `staging/<m>`・`outbox/<m>`・`browsers/<m>` と `browser-records` を作ってから、`browser-records/<m>.mount` を書き、`browser-records/<m>.id` を消す（`ensure_browsers` はこの印を見て、作成時に browsers の mount を付けた machine にだけ browser を配る）。そのうえで `orb config set machine.<m>.mounts` で repo 用の 4 つの mount（repo、staging、outbox、browsers）に差し替える
  3. `orb config show` から `machine.<m>.` で始まる行を取り出し、キーの集合が既知の 10 キー（`cpu` `disk_bytes` `forward_ssh_agent` `http_port` `https_port` `isolate_network` `isolated` `memory_mib` `mounts` `username`、2.2.3 で実測）と一致することを確かめる。そのうえで、`isolated` `isolate_network` `forward_ssh_agent` が `true`、`mounts` が期待値と文字列で完全一致することを確かめる。未知のキーや欠けたキーは不一致として扱う（OrbStack が新しい mount 系の設定を足しても、黙って通さない）。10 キーは停止中の golden と clone 先でも同じように出る（実測）。既知のキーの集合は定数 1 か所に置き、die の文言には未知のキー名と欠けたキー名を出す。OrbStack の更新でキーが増えたときは、この定数の更新が保守作業になる（ADR-0020 に記録する）

  一致しなければ起動せずに clone 先を削除して die する。設定は host 側の OrbStack が持ち、clone 先は検査から start まで停止しているので、VM がこの間に設定を変える経路は無い。VM 内の `mountinfo` による起動後の検査は行わない。VM の出力は VM が偽れるので、host 側の設定を真とする。`orb info -f json` ではなく `orb config` を使うのは、launcher が jq に依存しないためである（今の launcher は perl・awk・shasum だけで動く）
  - 参照: `home/dot_local/bin/executable_agent-vm:274-275`（mount root の前提）、`:281-294`（今の作成経路の 4 つの mount と browser の印）、`:56`（repo path の改行を拒む既存の検査）、`research.md`「OrbStack の事実」4・5
- **K5: 作成中の印（sentinel）を host 側に置き、途中で終わった clone 先は次の起動で作り直す** — clone の直前に `$AGENT_VM_STATE_DIR/creating/<m>` を書き、clone 先の start が成功したら消す。`ensure_machine` は、machine が存在しても sentinel が残っていれば `orb delete -f` して作り直す。sentinel が無い machine は今までどおり既存として扱う（K9）。各段の失敗では `|| { discard_clone <m>; die ...; }` の形で clone 先を消す。`orb delete` 自体が失敗した場合や、launcher が SIGINT / SIGKILL で中断された場合も、sentinel が残るので次の起動が作り直す。中断の trap は追加しない（sentinel が中断を含むすべての経路を拾う）。`discard_clone` は `orb delete` が成功したときだけ sentinel を消し、失敗したときは残す。`orb delete` が成功した後は、その machine の `browsers/<m>` の中身と `browser-records/<m>.*` も消す（`forget_machine` と同じく、VM が権限を落としている場合に備えて `chmod -R u+rwX` してから消す）。作り直す clone 先に、前の clone 先が配った browser の世代が残らないようにするためである。`machines/<m>` の meta、git 面の snapshot、取り込みの記録は repo に属するので消さない。`staging/<m>` と `outbox/<m>` も消さない。staging は `prepare_machine` が `ensure_machine` の前に作り直した最新の世代を持っている。outbox に前の clone 先が書いたログがあれば、通常の取り込み（追記専用の検証つき）の対象になるだけで、作り直した clone 先の動作には影響しない。machine が無くて sentinel だけが残っている場合は、次の作成が sentinel を書き直すので害は無い（テストで固定する）。`agent-vm rm` / `gc` は repo の lock を取らずに `forget_machine` を呼ぶので、作成中の machine を手で消すと競合しうる。これはユーザーが自分で起こす操作であり、消された machine は sentinel により次の起動で作り直されるので、lock は追加しない。`orb delete` が失敗したときの die の文言には、`orb delete -f <m>` を回復手順として示す。`forget_machine` は sentinel も消す
  - 参照: `home/dot_local/bin/executable_agent-vm:278-280`（存在だけで判定。`orb list` の失敗は既に die）、`:1052-1063`（`forget_machine`。browsers と browser-records も消す）
- **K6: golden の検査は host 側を主とし、VM 内の検査を補助とする** — 検査は golden を更新するたび、clone の前に行う。golden が手作業で作られていた場合も、meta が無いので作り直しになる（K11）
  - host 側（主）: golden の設定キーを K4 と同じ方法で検査する（mounts は golden 専用の 3 つ: staging、outbox、browsers）。golden の outbox の中身が、空のディレクトリ `claude-projects/` と `codex-sessions/` の 2 つだけであることを確かめる（bootstrap 直後の実測どおり）。ほかの entry が 1 つでもあれば（通常ファイル、symlink、FIFO を問わず）不合格とする。golden の browsers は空のディレクトリであることを確かめる（golden には browser を配らない）
  - golden には `browser-records/agent-vm-golden.*` を作らない。`ensure_browsers` は `.mount` の印が無い machine には何も配らないので（`home/dot_local/bin/executable_agent-vm:300`）、golden の browsers は空のまま保たれる。golden の bootstrap は、browser の実体が無いので「no headless shell」の警告（`report_browser_state`）を出すが、これは想定どおりで、文書に書く
  - golden に browsers の mount を付ける理由: bootstrap の `claude_keep` は `/opt/agent-vm/browsers` があるかどうかで、playwright と chrome-devtools の MCP を `~/.claude.json` に残すかを決める。golden を mount なしで作ると、golden の bootstrap がこれらを消す。clone 先の bootstrap では、chezmoi の `run_onchange_update-claude-json` は内容が変わらない限り再実行されないので、消えた MCP が clone 先でも戻らない。空の browsers を mount しておけば、golden の `~/.claude.json` は browsers の mount を持つ machine と同じ内容になる。browser の実体は、clone 先で `ensure_browsers` が clone 先の browsers に配る
  - この結合（golden の mount の形と、bootstrap が mount の有無で設定を決めること）は、散文だけでなく 2 か所で守る。`claude_keep` に「golden は clone の素材なので、この判定は golden と clone で同じ結果になる必要がある」というコメントを置く。`tests/agent-vm/run-bootstrap.sh` に、browsers の root が空のディレクトリとして存在するときに bootstrap が browser 系の MCP を残すこと、その後に golden-seal.sh を走らせても残ることを確かめるテストを置く。ADR-0020 にもこの契約を書く。golden-seal.sh で playwright と chrome-devtools の名前を決め打ちして存在を検査する案は採らない。利用者がこれらのサーバーを設定から外すと、seal が毎回落ちて golden が使えなくなるためである
  - VM 内（補助、golden-seal.sh）: 認証の痕跡が無いことを確かめる。対象は代表的なものを挙げた例示で、網羅ではない: `~/.claude/.credentials.json`、`~/.codex/auth.json`、`~/.claude.json` の `oauthAccount`、`~/.config/gh/hosts.yml`、`~/.git-credentials`、`~/.netrc`、`~/.npmrc`、`~/.ssh/id_*`、`~/.aws/`、`~/.config/gcloud/`、`~/.docker/config.json`、`~/.bash_history`、`~/.zsh_history`、`~/.claude/history.jsonl`。この検査は検知の補助なので、plan や実装で対象を増やし続けない。許可リスト方式は採らない。bootstrap 後のホームには mise や bun の導入物が数千ファイルあり、許可リストを保守できないためである。golden は構造上秘密を受け取らない（repo を mount せず、`inject_secrets` を呼ばず、ログインもしない）ので、この検査は手作業で golden に入った場合を拾う検知の役になる
  - 不合格なら clone せずに die し、回復手順として `agent-vm golden rm` を示す。`golden rm` は golden の outbox も消すので（K8）、作り直した golden は検査を通る
  - bootstrap は forward された SSH agent で private-skills を clone するので、その内容は golden と全 clone に入る。ただし、これは今もすべての machine が自分で clone している内容であり、新しく露出するものではない
  - 参照: `agent-vm/bootstrap.sh:240-250`（outbox への symlink）、`:132-139`（`claude_keep`）、`home/dot_local/bin/executable_agent-vm:854-874`（`inject_secrets` は repo 用の起動経路だけで呼ばれる）、`:297-338`（`ensure_browsers`）
- **K7: machine 固有の識別子は golden 側で消し、clone 先の初回起動で作らせる** — golden-seal.sh が `/etc/machine-id` を空にし、`/var/lib/systemd/random-seed` を消す。OrbStack の machine でも、空の `/etc/machine-id` は clone 先の初回起動で新しい値になり、再起動後も保たれた（実測）。clone 先は起動した時点で自分の値を持つので、古い値で動く時間は生じない。first boot の扱いで失敗する unit が増えないことも確かめた（失敗する 2 つの unit は既存の machine と同じ）。claude の `userID` / `machineID` は、claude が欠けた値を作り直すと確認できた場合だけ（R3）golden-seal.sh で消す。作り直さない場合は消さず、全 clone で共有されることを ADR-0020 に記録する。SSH の host key は golden に存在しない（image に sshd が無い、実測）ので扱わない
  - 参照: `research.md`「golden に残るもの」「OrbStack の事実」7
- **K8: golden の操作を `agent-vm golden refresh` と `agent-vm golden rm` で提供する** — どちらも golden の lock を取って実行する。`refresh` は、更新を飛ばす判定（K2）を迂回して `ensure_golden` を実行する。staging hash が同じでも、golden を起動して bootstrap、seal、検査をやり直す。用途は 3 つある。初回セットアップのときや dotfiles を更新した後に、次の新規作成の待ちを前もって済ませること（ADR-0018 K15 の `prewarm` と同じ考え方）。apt・mise・APM の上流の更新を取り込むこと。手で入ってしまった golden を seal し直して、VM 内の検査を走らせること。`rm` は `golden/meta`、golden の VM（`orb delete -f agent-vm-golden`）、`staging/agent-vm-golden`・`outbox/agent-vm-golden`・`browsers/agent-vm-golden` の順に消す。host 側のディレクトリを消すのは `orb delete` が成功した後に限り、`forget_machine` と同じく `chmod -R u+rwX` してから消す（VM が中で権限を落としていても残骸を残さないため。残骸があると K6 の検査に落ち続け、回復手順が循環する）。meta を最初に消すので、途中で止まっても次の `ensure_golden` が作り直しに入る。lock ファイルは消さない。消すと、待っている別のプロセスが古い inode の lock を持ったまま進み、排他が崩れる。`rm` は K6 の検査に落ちたときの回復手順と、golden を作り直したいときのためのもの。既存の repo 用 machine は `golden rm` の影響を受けない。clone 先は golden を消した後も golden のデータを保ったまま起動した（実測）。自動の refresh（dotfiles の変更を検知して裏で更新する）は入れない。K15 が自動 prewarm を採らなかったのと同じ理由による
  - 参照: `home/dot_local/bin/executable_agent-vm:1023-1026`（`cmd_prewarm`）、`cmd_gc`（lock ファイルも消す。golden ではこの手順を流用しない）
- **K9: 既存の machine はそのまま使い、契約と記録の形式は変えない** — `ensure_machine` は sentinel の無い既存の machine を作り直さないので、今ある machine は何も変わらない。移行処理は作らない（ADR-0018 K21 と同じ方針）。`BOOTSTRAP_CONTRACT` は 1 のまま据え置く。`bootstrap.sh` の引数と動作は変わらず、golden に固有の処理は別のスクリプト（K12）に置くためである。将来 contract を上げると、golden の meta の `contract` が合わなくなり、golden は作り直しになる（K11）。`machines/<m>` の meta も `format=1` のまま据え置き、clone で作ったかどうかは記録しない。dotfiles を戻して古い launcher に戻っても、clone で作った machine のうち sentinel の無いものはそのまま使える。古い launcher は sentinel を知らないので、戻す前に `$AGENT_VM_STATE_DIR/creating/` が空であることを確かめる必要がある。この手順を ADR-0020 に書く
  - 参照: `home/dot_local/bin/executable_agent-vm:12`（`BOOTSTRAP_CONTRACT=1`）、`:55-59`（meta の形式）
- **K10: 設計の記録は ADR-0020 として新しく立て、ADR-0018 の `## Amended by` から参照する** — 0019 は既に `0019-codex-config-toml-merge.md` が使っている。machine の作り方（ADR-0018 K1）と初回の待ち（R5）を変える判断なので、追記ではなく独立した ADR にする。`docs/agent-vm.md` には次の 3 つを加える: golden の説明、`golden refresh|rm`（初回セットアップで `golden refresh` を済ませる手順を含む）、mac 実機の検証項目
  - 参照: `docs/decisions/0018-agent-vm-orbstack.md`（`## Amended by` 節）
- **K11: golden の host 側の状態は 4 か所に置き、meta で完成と鮮度を表す** — golden の host 側の状態は次の 4 か所に置く
  - `$AGENT_VM_STATE_DIR/golden/{lock,meta}`
  - `staging/agent-vm-golden`
  - `outbox/agent-vm-golden`
  - `browsers/agent-vm-golden`（空のまま。K6）

  `golden/meta` は `format=1`、`cloud_init_hash`（`agent-vm/cloud-init.yaml` の sha256）、`contract`（`BOOTSTRAP_CONTRACT`）、`state`（`sealed` / `updating`）、`staging_hash`（最後に seal した golden の staging hash）を持つ。meta はどれも一時ファイルに書いて `mv` で置く。各状態の意味と書く時点は次のとおり
  - `state=sealed`: 最後に全工程と全検査を通ったことを表す。更新と検査がすべて通ったときにだけ書く
  - `state=updating`: 作成は済んでいて、差分更新の途中であることを表す。更新（bootstrap と seal）を始める前に書く。`staging_hash` は前回の値を残すが、`state=sealed` でないので skip の判定には使わない
  - meta が無い: golden の作成が途中で終わったか、golden が手作業で作られたことを表す。meta は、golden の作成（`orb create` と初回の bootstrap、seal、検査）がすべて通ったときに初めて `state=sealed` で書く。作成した回は更新の工程（`state=updating` の書き込み）を通らないので、作成の途中で meta が現れることは無い
  - host 側の `staging/agent-vm-golden` や `outbox/agent-vm-golden` が手で消された場合: staging は毎回 `build_staging` で作り直される。outbox のサブディレクトリが欠けると K6 の検査に落ち、回復手順の `agent-vm golden rm` で作り直す

  更新中の一過性の失敗（ネットワーク断、Ctrl-C、`orb start` の失敗）は `state=updating` として残り、次の起動は差分更新を再試行する（bootstrap と seal は冪等）。作り直しには至らない。`machines/<m>` の meta とはキーの集合が違うので、読み取りには `read_meta_field` を使わず、golden 用の関数を別に持つ。`ensure_golden` の判定は次のとおり
  - golden の VM が無い（`orb list` に無い）のに meta がある場合: golden が手で削除されたとみなし、meta と host 側の staging・outbox・browsers を消して作り直す
  - golden の VM があって meta が無い、または meta の `format` か `state` が不明な場合: 作成が途中で終わったか、手作業で作られたものとみなし、削除して作り直す
  - meta の `cloud_init_hash` または `contract` が現在の値と違う場合: 削除して作り直す。cloud-init は golden の作成時にしか効かず（clone 先は instance_id を受け継ぐので再実行しない、実測）、bootstrap の差分更新では取り込めないためである。作り直すときは理由を表示する
  - 作り直すときは、`golden rm` と同じ順序で host 側の staging・outbox・browsers も消す。outbox に残骸があると、作り直した golden が K6 の検査に落ち続けるためである
  - golden の lock の待ちが 900 秒を超えたら、待った秒数と、lock を持つ別の launcher を止めてから再実行する手順を示して die する

  OrbStack の版は meta に入れない。OrbStack の更新は guest の中身を変えないので、更新のたびに 8 分の作り直しを払う理由が無い
  - 参照: `agent-vm/cloud-init.yaml:1-22`、`research.md`「OrbStack の事実」8
- **K12: golden に固有の VM 内処理は `agent-vm/golden-seal.sh` に置く** — VM 内の状態を読み書きする処理は、launcher ではなく VM 側のスクリプトに置く。今の分担（VM 内のロジックは `bootstrap.sh`、launcher は `orb` の呼び出しと host 側の状態）に合わせるためである。golden-seal.sh は golden の staging から `orb -m agent-vm-golden bash <src>/agent-vm/golden-seal.sh` で実行し、次の 3 つを行う: 識別子の消去（K7）、認証の痕跡の検査（K6 の補助）、`applied-hash` の消去（K2）。`applied-hash` のパスは bootstrap の内部状態なので、seal は消した後にその不在を確かめ、残っていれば 0 以外で終わる。bootstrap がパスを変えたときに、seal が黙って何も消さず、clone 先の bootstrap が skip される事態を防ぐ。終了コードが 0 以外なら、launcher は golden の meta を書かずに die する。seal の版は meta に入れない。seal は golden を更新するたびに走り直すので、seal を変えても次の更新で反映される（ADR-0020 に記録する）。テストでは、bootstrap の後に seal を走らせると、次の bootstrap が skip されないことを固定する。`bootstrap.sh` と同じく、`AGENT_VM_*` の環境変数でパスを差し替えられるようにし、`tests/agent-vm/run-bootstrap.sh` と同じ方式で Linux 上で検証する
  - 参照: `agent-vm/bootstrap.sh:34-39`（環境変数による差し替え）、`tests/agent-vm/run-bootstrap.sh`

## Risks

- **R1**: `orb config set machine.<m>.mounts` は OrbStack の文書に載っていない使い方で、将来の版で効かなくなるおそれがある。効かなくなると、新しい repo 用 machine はすべて作れなくなる（既存の machine は影響を受けない）→ K4 の検査が起動前に止める。die の文言では、OrbStack の版と、回復手順として `AGENT_VM=off` を示す。この可用性の低下は、作成経路を 1 本にする（K1）ことのトレードオフとして ADR-0020 に記録する
- **R2**: cloud-init の `instance_id` は golden の名前のまま引き継がれ、clone 先では per-instance の module が再実行されない（実測）。この挙動が変わると、clone 先の初回起動で apt の導入などが再実行され、遅くなる → 正しさには影響しない（cloud-init の内容は冪等）。plan の mac 実機検証で clone 先の初回起動時間を測り、回帰に気づけるようにする
- **R3**: claude が `~/.claude.json` の `userID` / `machineID` の欠落時に作り直すかは未確認 → plan の最初の task で確かめ、K7 の分岐（消す / 消さずに記録する）を確定する
- **R4（解消）**: golden を削除しても、それを元にした clone 先が動き続けるか → 実測で確認した。clone 先を一度も起動しないうちに golden を削除しても、clone 先は golden のデータを保ったまま起動した。`golden rm` に制限は要らない。起動済みで書き込みのある clone 先が複数ある状態で golden を消す場合は未計測なので、plan の mac 実機検証に入れる
- **R5**: golden の claude 本体は、golden を作ったときの版のまま残る。bootstrap は claude が無いときしか installer を走らせない → clone 先の claude は autoUpdates で上がる見込み（推測）。古い版で困る場合は `agent-vm golden rm` で作り直せる。この手順を文書に書く
- **R6**: golden の作成中（最大 8 分）は、同じ repo の別セッションが repo の lock を 60 秒待って timeout する → 今の `orb create` 経路と同じ挙動で、新しく生じる問題ではない。別の repo の新規作成は golden の lock を待ち、K3 の文言でそれと分かる
- **R7（解消）**: 空の `/etc/machine-id` を起動時に作り直す systemd の扱いが、OrbStack の machine で働くか → 実測で確認した。clone 先は新しい値で起動し、再起動後も保たれた。failed になる unit は既存の machine と同じ 2 つ（`sys-kernel-debug.mount`、`netplan-configure.service`）で、first boot による増加は無い
- **R8**: golden を手で起動して中を変え、停止し直した場合、staging hash が同じなら次の新規作成は golden を更新せず、VM 内の補助検査も走らない → 起動したままなら skip の条件（停止中）に外れて更新と seal が走る。host 側の検査（設定キー、outbox）は毎回走る。golden を信頼できる前提は「golden に手で入らないこと」であり、ADR-0020 に書く。この信頼の対象には、`install_browser_deps` が golden のホームに置く `~/.local/lib/agent-vm-browser`（clone 先の headless shell が `LD_LIBRARY_PATH` で読む）も含まれる。手で入ってしまったときの一次手順は `agent-vm golden rm`（作り直し）とし、`agent-vm golden refresh`（seal し直し）を次善として文書に書く

## Phase 1 で意図的に提供しない体験

### 自動の golden 更新

- **代替経路確認**: `agent-vm golden refresh`（K8）と、新規作成時の差分更新（K2）が同じ更新を行う
- **非提供対象**: dotfiles の変更を検知して裏で golden を更新する仕組み
- **将来の予定**: 恒久的に非提供。ADR-0018 K15 が自動 prewarm を採らなかった理由（ユーザーの知らない時点で VM を起動しない）に従う

### 差分最小案の各施策

- **代替経路確認**: `home/.chezmoiscripts/run_onchange_install-claude-plugins-8.sh.tmpl:28-40`（marketplace 登録の逐次実行）など、handoff「clone 案が成り立たない場合の代替」の 3 項目
- **非提供対象**: golden の作成と更新を速くする施策
- **将来の予定**: 別の課題とする。golden 方式では最初の 1 台にしか効かない

## ISO 25010 次元選択

- **セキュリティ（機密性・完全性）**: clone 先が golden の mount を受け継ぐので、K4 の検査（repo path の入力検証、全設定キーの比較）が隔離を担う。golden に認証が入ると全 clone に配られるので、K6 の検査が要る
- **性能効率性（時間効率性）**: このオーダーの目的。2 台目以降の作成時間（golden の起動・停止を含む）を実機で測る
- **信頼性（回復性）**: sentinel による途中終了の回収（K5）、golden の lock（K3）、meta による golden の完成と鮮度の判定（K11）、golden の作り直し（K8）
- **保守性（試験性）**: `orb` の stub で、clone 経路の引数列、検査に落ちたときの削除、sentinel の回収、lock の順序を Linux と macOS の CI で検証する。golden-seal.sh は bootstrap と同じ方式で検証する
- **対象外**: 互換性（既存の machine と契約・記録の形式は変わらない、K9）、使用性（新しいコマンドは `golden refresh|rm` の 2 つだけで、既存の打鍵は変わらない）

## Approval

- Plan Status: complete
- Review Status: pass
- Approval Status: approved

## Reviewer Outputs (Round 1)

### logic-validator
- verdict: needs-work
- 主指摘: mounts をカンマ区切りの 1 文字列で渡すため、repo path のカンマで mount が注入される。K4 の比較は同じ文字列から作った期待値と比べるので検知できない。K5 は中断や `orb delete` の失敗で半端な clone 先が残り、次回は存在判定で検査が飛ばされる。clone が golden lock の外にある。cloud-init.yaml の変更が golden に取り込まれない。hostname に依存する描画が golden のまま残りうる

### scope-justification-reviewer
- verdict: needs-work
- 主指摘: K7 のうち claude の識別子の削除は根拠が無く、R3 の結果を条件にすべき。repo path のカンマの扱いが欠けている。停止中の golden を起動する工程が図に無い

### decision-quality-reviewer
- verdict: pass
- 主指摘: 支配軸（エルゴノミクス、隔離は固定制約）と整合している。R1 が顕在化すると新規作成が全面停止すること（既存の machine は無影響）を明記するよう助言

### greenfield-perspective-reviewer
- verdict: needs-work
- 主指摘: 識別子は golden 側で消すのが源流の対処で、K6 の検査にも含めるべき。最初の 1 台について、初回セットアップで `golden refresh` を済ませる導線を文書に入れる。R4 が否だった場合の `golden rm` の既定の仕様を spec で決めておく

### architecture-boundary-analyzer
- verdict: needs-work
- 主指摘: 中断に強い sentinel（作成中の印）が要る。VM 内の処理（personalize、検査）は launcher ではなく VM 側のスクリプトに置く。golden の host 側状態を 1 か所に集約し、`golden rm` の削除範囲を決める。cloud-init の hash と contract を golden に記録し、違えば作り直す。`orb` の呼び出しを fd を閉じる wrapper に集約する

### security-vulnerability-analyzer
- verdict: needs-work
- 主指摘: K4 は 4 キーだけでなく machine の全設定キーを検査すべき（未知のキーは不一致として扱う）。半端な clone 先の残存。golden の outbox は通常ファイルだけでなく全 entry を見る。K6 の検査対象が狭い（gh・git-credentials・netrc・履歴など）。host 側から見えるものを主検査とし、VM 内の検査は補助と位置づける

### data-contract-evolution-evaluator
- verdict: needs-work
- 主指摘: golden の永続状態（VM、staging、outbox、lock）の一覧と置き場所が無い。`golden rm` が host 側状態を消さないと、K6 の回復手順が循環する。clone をまたぐ applied-hash の不変条件が書かれていない。BOOTSTRAP_CONTRACT と meta format を据え置く判断を明記する

<!-- auto-review: pending -->
<!-- intent-triage: pending -->

## Reviewer Outputs (Round 2)

### logic-validator
- verdict: needs-work
- 主指摘: 更新中も古い meta が有効なまま残り、検査に落ちても作り直しにならない。R4 が否の場合の既定（`machines/` に記録があれば `golden rm` を拒否）は、自分の repo の記録で必ず拒否されて K6 の回復手順を塞ぐ。applied-hash を毎回消すので、新規作成のたびに golden の更新が全工程走り、「数秒」が成り立たない恐れがある。mount 文字列の検査が repo path だけで、state dir 由来の path を見ていない

### scope-justification-reviewer
- verdict: pass
- 主指摘: K11・K12 は round 1 の指摘に直接対応しており、範囲の逸脱は無い。contract を上げると golden も作り直しになることと、meta の format が不明な場合の扱いを 1 行ずつ補う

### decision-quality-reviewer
- verdict: pass
- 主指摘: 追加した安全機構は固定制約と実測した失敗モードに対応しており、エルゴノミクスを損なう摩擦を生まない。K6 は「検知の補助」の位置づけを保ち、検査対象を際限なく増やさないこと

### greenfield-perspective-reviewer
- verdict: pass
- 主指摘: round 1 の指摘はすべて解消した。seal の後に applied-hash が無いことをテストで固定する。R3・R7 が否の場合の分岐を plan に明示する

### architecture-boundary-analyzer
- verdict: needs-work
- 主指摘: golden-seal.sh が bootstrap の内部状態（applied-hash のパス）を直接知っている。パスが変わると黙って何も消さなくなるので、seal の最後に不在を検査する。更新を始める前に meta を消し、meta の意味を「最後に全検査を通過した記録」にする。`golden rm` の削除順序（meta を最初に消す）

### security-vulnerability-analyzer
- verdict: pass
- 主指摘: round 1 の指摘は解消した。low の指摘が 3 つある。mount 検査を state dir 由来の 2 path にも広げる。golden を作り直す経路でも host 側の staging と outbox を消す。VM 内の denylist に `~/.ssh/id_*` などを足す

### data-contract-evolution-evaluator
- verdict: needs-work
- 主指摘: 更新途中で失敗すると、古い meta が「検査済み」と誤って表明する。古い launcher は sentinel を知らないので、sentinel の残る machine を既存として起動しうる。K9 の「そのまま使える」は sentinel の無い machine に限られる。golden の meta は machines の meta と同じ `format=1` だが別のスキーマなので、読み取り関数を共用しない

<!-- auto-review: verdict=needs-work; hash=ed9d7df7bc6077ef1e215f9772bcd6b9fb0c7299c4ad4e13c0fcf8e0baafdb30; design-hash=884f9d15c422861f069dabb5ae7ab75d3b91adb5fcbad1d1073bcc71633298a2; round=1; at=2026-10-01T11:17:31.275Z; reviewers=logic-validator+scope-justification-reviewer+decision-quality-reviewer+greenfield-perspective-reviewer+architecture-boundary-analyzer+security-vulnerability-analyzer+data-contract-evolution-evaluator -->

## Reviewer Outputs (Round 3)

### logic-validator
- verdict: needs-work
- 主指摘: 更新の前に meta を消すので、更新中の一過性の失敗が、次の起動で全作り直し（4〜8 分）になる。meta が無いことを「作成中」と「更新中」の両方の意味で使っているのが原因。判定表に「meta はあるが golden の VM が無い」場合が無い。R4 の実測は起動前の clone 先だけで、起動済みの clone 先には一般化できていない

### scope-justification-reviewer
- verdict: pass
- 主指摘: 範囲の逸脱は無い。meta はあるが VM が無い場合の判定と、`refresh` が更新を強制しないことを K8 にも書くことを補う（任意）

### decision-quality-reviewer
- verdict: pass
- 主指摘: staging_hash による更新の skip は支配軸に直接効く。手で入った golden は `golden rm` で作り直すことを、ADR-0019 の一次手順として書く

### greenfield-perspective-reviewer
- verdict: pass
- 主指摘: 野心のずれ、anchor fixation、対症療法は見当たらない。R3 の分岐は plan の最初の task に明記する

### architecture-boundary-analyzer
- verdict: needs-work
- 主指摘: 鮮度を staging hash だけで判定するので、floating version のツール（mise・APM など）は dotfiles を変えない限り古いまま残り、強制的に更新する手段も無い。`golden refresh` で skip を迂回できるようにするか、この挙動を明記する。staging hash が決定的であることをテストで固定する

### security-vulnerability-analyzer
- verdict: pass
- 主指摘: skip の経路は、手で golden に入る場合（R8）を除いて新しい穴を開けない。skip の条件に「golden が停止中であること」を加えれば、起動したままの golden を clone するのを防げる。golden を信頼できる前提（手で入らない）を ADR-0019 に書く

### data-contract-evolution-evaluator
- verdict: pass
- 主指摘: round 2 の指摘はすべて反映された。meta に書く staging_hash は、bootstrap に渡した staging の hash に固定する。更新失敗後の再試行が全作り直しになる挙動を、意図したものとして記録するか、`state=updating` で区別する

<!-- auto-review: verdict=needs-work; hash=0f2aa5c3fcb322dab2a42cdbcce95e5ef212e160df76b0b303075b1d3c0be320; design-hash=a5790d2c2bcf847e7d8ba39b328dd3e5043031e46b0ad0375870ee65675a8d58; round=2; at=2026-10-01T11:24:08.839Z; reviewers=logic-validator+scope-justification-reviewer+decision-quality-reviewer+greenfield-perspective-reviewer+architecture-boundary-analyzer+security-vulnerability-analyzer+data-contract-evolution-evaluator -->

## Reviewer Outputs (Round 4)

### logic-validator
- verdict: pass
- 主指摘: round 3 の M1・M2・L1・L2 はすべて解消した。軽微な指摘が 3 件あり、反映済み。作成した回は更新の工程を通らず `state=sealed` で終えることを明記した。図の作り直し条件に「state が不明」を足した。host 側の golden の staging・outbox が手で消された場合の扱いを書いた

### architecture-boundary-analyzer
- verdict: pass
- 主指摘: round 3 の指摘（floating version の更新手段、手作業の前提、hash の決定性テスト）は解消した。plan への申し送りが 3 件ある。refresh 中に VM が消えた場合は作り直しに倒れること、決定性テストでファイルの列挙順と mtime に依存しないことも確かめること、R4 の実機検証項目を落とさないこと

### scope-justification-reviewer
- verdict: pass (carried from Round 3)
- 主指摘: Round 3 で pass、再実行なし

### decision-quality-reviewer
- verdict: pass (carried from Round 3)
- 主指摘: Round 3 で pass、再実行なし

### greenfield-perspective-reviewer
- verdict: pass (carried from Round 3)
- 主指摘: Round 3 で pass、再実行なし

### security-vulnerability-analyzer
- verdict: pass (carried from Round 3)
- 主指摘: Round 3 で pass、再実行なし

### data-contract-evolution-evaluator
- verdict: pass (carried from Round 3)
- 主指摘: Round 3 で pass、再実行なし

<!-- auto-review: verdict=needs-work; hash=0fa85a415c0cf60500c675c666ebb0fd3ff5f8526aa3f27d818c5a70daf7a4c1; design-hash=f6e5490fbf27105dbe95738ecb53fc3e06e5a03a6322847f12247db1f7367712; round=3; at=2026-10-01T11:28:36.018Z; reviewers=logic-validator+scope-justification-reviewer+decision-quality-reviewer+greenfield-perspective-reviewer+architecture-boundary-analyzer+security-vulnerability-analyzer+data-contract-evolution-evaluator -->

## Reviewer Outputs (Round 5)

### logic-validator
- verdict: pass
- 主指摘: `claude_keep` の推論と fd の順序は HEAD のコードと整合する。今の `install_browser_deps` は browsers の mount があると毎回 `apt-get update` を走らせるので、「clone 先の bootstrap は 1 秒」は browser 対応前の値で、再計測が要る。golden の bootstrap が出す「no headless shell」の警告は想定内と書く。sentinel から作り直すとき、古い browsers の中身が残る

### scope-justification-reviewer
- verdict: pass
- 主指摘: 差分はすべて master の browser 導入から出る必然の変更で、範囲の逸脱は無い。gh token は repo 用の起動経路でしか入らないので、golden と clone には影響しない

### decision-quality-reviewer
- verdict: pass
- 主指摘: 支配軸とのズレは無い。空の browsers の mount は bootstrap の `claude_keep` の仕様への依存なので、条件が変わったときに検知するテストを plan に入れる

### greenfield-perspective-reviewer
- verdict: pass
- 主指摘: golden に空の browsers を mount し、clone 先ごとに `ensure_browsers` を走らせる形は、白紙から設計しても同じになる。golden の mount と `claude_keep` の結合を、テストと ADR で明示的な契約にする

### architecture-boundary-analyzer
- verdict: needs-work
- 主指摘: fd の割り当てと lock の順序は一貫している。golden と `claude_keep` の結合が散文にしか無いので、golden-seal.sh で browser 系 MCP が残っていることを検査するか、bootstrap 側にコメントを置く。golden の mount の形を定数 1 か所で共有する

### security-vulnerability-analyzer
- verdict: pass
- 主指摘: golden の browsers から clone へ漏れる経路は無い。`install_browser_deps` が golden のホームに置く lib は clone に引き継がれるが、R8（golden に手で入らない）の信頼境界に含まれる。golden の browsers を消す手順は `forget_machine` と同じく chmod してから消す

### data-contract-evolution-evaluator
- verdict: needs-work
- 主指摘: golden には browser-records を作らないこと（`ensure_browsers` が配らない前提）を明記する。golden の browsers の削除は chmod してから行い、`orb delete` の成功後に行う。clone の経路でも mount 元のディレクトリを先に作る。途中で失敗した clone の後始末で、古い browsers と印をどう扱うかを書く

<!-- auto-review: verdict=pass; hash=0ec071c55ebe2b34b3d91c54eb27f21f1348b7cc9648df2dd9a0f97828b8421c; design-hash=eae4730d1995934646946bebc5cb044edf8b9fe8cbc8af259cc15b54be63dbf6; round=4; at=2026-10-01T11:31:29.005Z; reviewers=logic-validator+architecture-boundary-analyzer -->
<!-- intent-triage: adopted=103; excluded=0; at=2026-10-01T11:31:55.592Z -->

## Reviewer Outputs (Round 6)

### logic-validator
- verdict: pass
- 主指摘: round 5 の指摘はすべて解消した。fd の順序、図と K5・K8・K11 の整合、sentinel と discard_clone の関係は一貫している。作り直しで browser-records の印が一旦消えて書き直されることを plan のテストで固定する

### architecture-boundary-analyzer
- verdict: pass
- 主指摘: 結合の守り方（コメント、テスト、ADR）は「散文だけ」の状態を解消した。seal で名前を決め打ちする案を却下した理由を 1 行残す（反映済み）。golden の 3 つの mount と clone 先の 4 つの mount を同じ定数から組み立てることを plan に入れる

### data-contract-evolution-evaluator
- verdict: pass
- 主指摘: 4 つの処置はコードと整合する。`forget_machine` が sentinel を消す変更を plan のファイルとテストに入れる。discard_clone が staging と outbox を残しても害が無いことを書く（反映済み）

### scope-justification-reviewer
- verdict: pass (carried from Round 5)
- 主指摘: Round 5 で pass、再実行なし

### decision-quality-reviewer
- verdict: pass (carried from Round 5)
- 主指摘: Round 5 で pass、再実行なし

### greenfield-perspective-reviewer
- verdict: pass (carried from Round 5)
- 主指摘: Round 5 で pass、再実行なし

### security-vulnerability-analyzer
- verdict: pass (carried from Round 5)
- 主指摘: Round 5 で pass、再実行なし

<!-- auto-review: verdict=needs-work; hash=ba763cc4ef18029aead9cd9842b642601bdb34d48951b732095984b4e6869a5f; design-hash=b7096d79ac4452cd304e28f2cee96a63adfe7644a3c9be012c5bd5f5e4377afb; round=5; at=2026-10-01T15:17:54.329Z; reviewers=logic-validator+scope-justification-reviewer+decision-quality-reviewer+greenfield-perspective-reviewer+architecture-boundary-analyzer+security-vulnerability-analyzer+data-contract-evolution-evaluator -->

<!-- auto-review: verdict=pass; hash=d192e68e8b7ad4531624f3058511e027074b8bbd145fe3ef3d4ecaa901fedf6d; design-hash=e4e8f82e089b386f68baa57024ac3b66da07ed6edf04c6ee1e4252b99c367fe8; round=6; at=2026-10-01T15:19:31.988Z; reviewers=logic-validator+architecture-boundary-analyzer+data-contract-evolution-evaluator -->
<!-- intent-triage: adopted=18; excluded=0; at=2026-10-01T15:19:32.014Z -->
