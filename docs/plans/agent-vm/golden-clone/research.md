# Research: agent-vm の新規 machine 作成を golden machine の clone で短縮する

## オーダー

repo ごとの isolated machine を新しく作るときの待ち時間（約 5〜8 分）を、事前に用意した golden machine の clone で短縮する。ADR-0018 の隔離（machine 単位の認証、machine ごとの staging、VM 間の書き込み経路なし）は崩さない。

出典: `.tmp/docs/agent-vm-golden-clone-handoff.md`（VM 内セッションからの引き継ぎ）と、2026-10-01 のユーザー指示「すすめてよい」。

## 現状のコード

- 作成の入口は `prepare_machine`（`home/dot_local/bin/executable_agent-vm:554-572`）。手順は lock の取得 → git 面の検査と outbox の取り込み → `build_staging` → `ensure_machine` → `maybe_bootstrap` → lock の解放
- `ensure_machine`（`:151-161`）は `orb list` に名前が無いときだけ `orb create --isolated --isolate-network --forward-ssh-agent -c <wt>/agent-vm/cloud-init.yaml --mount repo:repo --mount staging/<m>:/opt/agent-vm/src --mount outbox/<m>:/opt/agent-vm/outbox ubuntu <m>` を実行する
- `maybe_bootstrap`（`:163-170`）は VM 内の `~/.local/state/agent-vm/applied-hash` を staging の内容 hash と比べ、違うときだけ `bootstrap.sh` を走らせる
- `bootstrap.sh` の処理は、VM 用ツールの導入（無いものだけ）、claude の導入（未導入時だけ）、outbox への symlink、`chezmoi init --apply`、MCP と hook のフィルタと自己検査、`applied-hash` の記録。すべて冪等で、差分だけを処理する
- `cloud-init.yaml` が書くものは、apt パッケージ、`/etc/agent-vm` marker、GitHub の host key、chezmoi のバイナリ
- host 側の状態は `$AGENT_VM_STATE_DIR/{machines,staging,outbox,snapshots,ingested,build}`。`machines/<m>` にはメタデータ（`repo_path`）を置き、`list` / `gc` / `rm` / `host_reason` がこれを読む
- lock は machine 単位の `flock`（`machines/<m>.lock`）

## 計測

| 対象 | 所要 | 出典 |
| --- | --- | --- |
| 新規 machine 1 台（handoff、既存の repo 用 machine） | 約 5 分（VM 作成 55s + apply 約 4 分） | handoff |
| `docs/agent-vm.md` V4 の初回 prewarm | 282s | `docs/agent-vm.md:140` |
| 本番相当の golden（cloud-init 付き create） | 249s | 2026-10-01 実測（scratchpad の state dir） |
| 同 golden の初回 bootstrap | 252s | 同上 |
| clone → `config set mounts` → start | 1s 未満 | 同上 |
| clone 後の最初の `orb -m` | 1s | 同上 |
| clone 後の `maybe_bootstrap`（staging hash が同じ） | 0s（skip） | 同上 |
| clone 後の bootstrap 強制再実行（dotfiles の内容は同じ、hash だけ変更） | 1s、rc=0 | 同上。mise・APM・bun・skills はいずれも「変更なし」 |

create の所要が 55s と 249s で大きく違う。cloud-init の `package_update` と apt の取得はネットワークに左右されるとみられる（推測。区間別には測っていない）。

## OrbStack の事実（2.2.3、host で確認）

1. `orb` と `orbctl` はどちらも `clone` / `export` / `import` / `config` を持つ。handoff の「`orb` には無い」は VM 内の `orb` の話で、host では当てはまらない
2. `clone` にはフラグが無い。`import` は `-n` だけ。clone の時点では mount も isolated 系の設定も指定できない
3. clone 先は `isolated` / `isolate_network` / `forward_ssh_agent` / `mounts` をすべて引き継ぐ。export ファイルにも設定が入る
4. machine ごとの設定は `orb config get|set machine.<name>.mounts` で読み書きできる。値はカンマ区切りの `SRC:DEST`。clone 直後（stopped）に set してから start すると、VM 内では差し替え先が見えた。複製元の設定は変わらない
5. `orb info <m> -f json` の `.record.config` で、起動前に実効設定を検査できる
6. clone は copy-on-write で、直後のディスク使用量は 16 kB。clone 中は複製元が pause される
7. hostname は clone 先の名前になる。IP は別のものが割り当てられた。`/etc/machine-id` は複製元と同じ値のまま
8. cloud-init の `instance_id` は複製元の名前（`vmtest-gold`）のまま引き継がれる。そのため clone 先の起動では per-instance の module（packages、runcmd）が再実行されず、per-boot の stage だけが 0.05s ほどで走って `status: done` になる

9. `orb config get machine.<m>.<key>` は値だけを返す（`true`、mounts はカンマ区切りの文字列そのまま）。存在しないキーは exit 1。`orb config show` は `machine.<m>.<key>: <value>` 形式で、machine ごとに 10 キー（`cpu` `disk_bytes` `forward_ssh_agent` `http_port` `https_port` `isolate_network` `isolated` `memory_mib` `mounts` `username`）を出す。停止中の machine でも、clone 直後の machine でも同じ 10 キーが出た
10. clone 先を一度も起動しないうちに複製元を削除しても、clone 先は複製元のデータを保ったまま起動した（clone 先は複製元から独立している）
11. 複製元で `/etc/machine-id` を空にしてから clone すると、clone 先の初回起動で新しい値が作られ、再起動後も保たれた。failed になる unit は既存の machine と同じ 2 つ（`sys-kernel-debug.mount`、`netplan-configure.service`）
12. OrbStack の machine は LXC で動いている（存在しない mount 元を渡したときのエラー文 `configure LXC: bind /mnt/mac/...` から）

未確認の点: 起動中の machine に `config set` したときの挙動、path にカンマを含む場合の扱い。

## chezmoi の描画の machine 依存

`.chezmoi.hostname` を使うテンプレートがある: `home/dot_shell_common/env.sh.tmpl:33`（`CLAUDE_COMPUTER_NAME`）、`home/dot_codex/private_config.toml.tmpl:10`（host overlay のファイル名）、`home/.chezmoi.toml.tmpl:9`（`only_private`）。clone 先で bootstrap を skip すると、golden の hostname で描画された内容が残る。

## golden の outbox

bootstrap 直後の golden の outbox（host 側）は、空のディレクトリ `claude-projects/` と `codex-sessions/` の 2 つだけだった（`link_outbox` が作る）。

## golden に残るもの（実測した golden の中身）

- 認証: `~/.claude/.credentials.json` と `~/.codex/auth.json` はどちらも無い（未ログインのため）
- `~/.claude.json` には `userID`、`machineID`、`firstStartTime` などがある。clone すると全 machine で同じ値になる。資格情報ではなく識別子だが、ADR-0018 が machine を単位に分けている「machine ごとの識別」が共有される点は判断が要る
- `/etc/machine-id` も全 clone で同じ値になる
- `~/.claude/projects` と `~/.codex/sessions` は `/opt/agent-vm/outbox/...` への symlink。mount 先の path は全 machine で同じなので、clone 後もそのまま正しい先を指す
- `~/.local/share/chezmoi` は dotfiles の tracked files のコピー（全 machine で同じ内容）
- `applied-hash` は golden の staging hash。clone 先の staging hash と同じならそのまま skip、違えば差分の bootstrap が走る

## 隔離に関わる論点

1. **mount の差し替え漏れ**: clone 先は golden の staging / outbox を指した状態で生まれる。差し替えずに起動すると、clone 先は golden の outbox に書き、golden の staging を読む。clone 先どうしが golden の outbox を共有すれば、ADR-0018 が却下した「共有 staging」と同じ VM 間の経路ができる。対策は、start の前に `orb info -f json` で mounts と isolated 系 3 フラグを期待値と完全一致で検査し、一致しなければ clone 先を削除して fail closed すること
2. **golden の汚染**: golden でセッションが動けば、認証やログが全 clone に配られる。golden は repo を mount せず、`derive_machine_name` が返しうる名前（`agent-<base>-<6hex>`）とも衝突しない名前にすれば、launcher の通常経路から golden でツールが起動することはない。加えて、golden の作成時と更新時に、認証ファイルが無いことを検査する
3. **識別子の共有**: `userID` / `machineID`（`~/.claude.json`）と `/etc/machine-id`。golden 側で消しておけば、clone 先の初回起動時に各ツールが作り直すとみられる（推測。claude が `userID` の欠落時に作り直すかは未確認）
4. **golden 自身の mount**: golden も isolated で作り、staging / outbox は golden 専用のものにする。golden は短時間しか起動せず、セッションも動かない

## golden のライフサイクルの論点

- **作成のきっかけ**: 明示的なコマンド（例: `agent-vm golden build`）か、初回の `ensure_machine` で自動的に作るか。自動にすると最初の 1 台は今より遅くならない（golden を作ってから clone する分、clone の 1s が足されるだけ）
- **古くなった golden**: clone 先の bootstrap が差分を処理するので、golden が古くても正しさは保たれる。古さは速さにだけ効く。更新は「golden を bootstrap し直す」だけで済む（`maybe_bootstrap` を golden に対して走らせる）
- **claude 本体の更新**: bootstrap は claude が未導入のときしか installer を走らせない。golden の claude が古ければ、clone 先は古い版から始まり、autoUpdates で上がる（推測）
- **並行性**: 2 つの repo が同時に初回作成すると、両方が golden を clone する。clone 中は golden が pause されるだけで、clone どうしは干渉しないとみられる（推測。同時 clone は未計測）。golden の更新と clone が重なる場合のために、golden 用の lock が要る
- **管理コマンド**: golden は `machines/` にメタデータを持たないので、`list` / `gc` / `rm` の対象に入らない。golden の削除と作り直しの手段は別に要る
- **golden が無いときの作成経路**: 現在の `orb create` 経路は、golden 自身を作るために残る。golden を使わない新規作成にこの経路を使い続けるかは、設計判断になる

## テストへの影響（sonnet subagent の調査を要約し、要点を自分で確認した）

- `tests/agent-vm/stubs/orb` はサブコマンドを解釈しない汎用 stub。argv を `%q` 形式で `$STUB_LOG` に 1 行ずつ追記する。`orb list` だけは `STUB_ORB_LIST_STDOUT` の出力を返し、それ以外はすべて `STUB_ORB_STDOUT` を返す
- launcher は `orb` だけを呼べばよい（host の `orb` に clone / config / info がある）ので、`orbctl` の stub は要らない。ただし `orb info -f json` の応答をサブコマンドごとに変える仕組みが stub に要る
- `orb create` の引数列を検査しているのは `tests/agent-vm/run.sh:250-260`（`test_create_uses_isolation_flags_and_mounts`）。`"orb create"` の有無を見ている箇所は `:264` と `:347`。`:176` の `STUB_ORB_FAIL_ON="create"` も作成経路が変われば見直しが要る
- CI（`.github/workflows/ci-agent-vm.yml`）は ubuntu と macOS の両方で、`/bin/bash`（macOS では 3.2）で `run.sh` を走らせる。bash 3.2 互換が必須

## 文書への影響

- ADR-0018: K1（machine の作り方）、K15（prewarm）、R5（初回の待ち時間）に関わる。`## Amended by` に追記するか、新しい ADR を立てる
- `docs/agent-vm.md`: `:32`（prewarm）、`:79`・`:83`・`:99-105`（作り直しと管理コマンド）、V 表（`:118`、`:140`）

## master `85a60fe` の取り込みで変わった前提（2026-10-02）

spec の承認後に master が 25 commit 進んだ（`50cf599..85a60fe`）。この設計に関わる変更は次のとおり。

- **mount が 4 つになった**: `ensure_machine`（`home/dot_local/bin/executable_agent-vm:276-295`）は `browsers/<m> → /opt/agent-vm/browsers` を加えた 4 つの mount で作る。作成の前に `browser-records/<m>.mount` を書き、`browser-records/<m>.id` を消す。`ensure_browsers`（`:297-338`）はこの印がある machine にだけ、host の browser store（`browser-store/mcp-<ver>`）を APFS clone で `browsers/<m>` に配る
- **fd 8 は browser store の lock**: `acquire_store_lock`（`:180-191`）が fd 8 を使い、順序は fd 9 → fd 8。golden の lock は fd 7 にする必要がある
- **`orb list` の失敗は既に die**: `ensure_machine:278` は `orb list` の失敗を die にしている
- **bootstrap は browsers の mount の有無で MCP の allowlist を変える**: `claude_keep`（`agent-vm/bootstrap.sh:132-139`）は `/opt/agent-vm/browsers` が無いと playwright と chrome-devtools を `~/.claude.json` から外す。clone 先の bootstrap では `run_onchange_update-claude-json` が再実行されないので、golden で外れた MCP は clone 先で戻らない。golden にも空の browsers の mount が要る
- **`forget_machine`（`:1052-1063`）は browsers と browser-records も消す**
- **ADR の番号**: `docs/decisions/0019-codex-config-toml-merge.md` が追加された。この設計の ADR は 0020 になる
- **shellcheck は全 severity で強制**: `scripts/lint-shell.sh` が拡張子なしの shebang ファイル（launcher、stub）と `agent-vm/*.sh`・`tests/agent-vm/*.sh` を severity 指定なしで検査し、CI（`ci-shellcheck.yml`）が落とす
- **テストハーネス**: run.sh に、作成時の browser の印を検査するテストが 5 本ある（`:1242`・`:1248`・`:1254`・`:1259`・`:1268`）。run-bootstrap.sh は実 chezmoi（template の実行用）を要し、`AGENT_VM_BROWSERS_ROOT` の既定は `$TMP_ROOT/no-browsers`

## T0 の結果（plan-1、2026-10-02、master 85a60fe、OrbStack 2.2.3）

使い捨ての `vmtest-gold`（state dir は `mktemp -d`、mount は staging・outbox・空の browsers の 3 つ、cloud-init 付き）で確かめた。所要は create 120s、bootstrap 263s（browser 対応後。`no headless shell` の警告は空の browsers なので想定どおり）。

- **Step 2（認証の痕跡と browser 系 MCP）**: `PRESENT` の行は 0、`.ssh/id_*` も無い。`.npmrc` はあり、`_authToken` は 0 件。`oauthAccount` は `false`。`mcpServers` のキーは `["chrome-devtools","context7","excalidraw","playwright","readability"]`。空の browsers を mount した golden では browser 系 MCP が残る。spec K6 の前提が成り立ち、T4 の検査対象から外す項目は無い
- **Step 3（R3）**: 削除前の `userID` と `machineID` を記録してから両方を消した。`claude --version` は 0 で終わり（2.1.286）、`claude -p hi` は `Not logged in` で 1 を返した。その後は 2 つとも存在し、どちらも削除前と違う値になった（値そのものは記録しない）。判定: claude は作り直す。T4 は seal で `userID` / `machineID` を消す分岐で進める
- 片付け: `orb delete -f vmtest-gold` 済み。既存の `agent-*` machine には触れていない

## モード判定

設計判断（golden の作成と更新の方式、識別子の扱い、検査の方式）を複数含み、launcher・bootstrap・テスト・文書・ADR にまたがる。handoff の指示どおり、Document Workflow（spec + plan-N）で進める。

## plan-2 T1 の結果（2026-10-02、master c3895ab、OrbStack 2.2.3）

使い捨ての repo 4 つ（`mktemp -d` + `git init`、以下 A〜D）で、別の mac 実機で確かめた。所要時間は `agent-vm prewarm` / `agent-vm golden refresh` の開始から終了までの壁時計。

| 項目 | 結果 |
|---|---|
| 実施日 / OrbStack の版 | 2026-10-02 / 2.2.3 |
| V18 所要時間 / 合否 | 332 秒（golden の作成と A の clone を含む）/ 合格。`creating the golden machine` が出て、golden は stopped、A は running。golden の bootstrap の `no headless shell` 警告は想定どおり |
| V19 所要時間 / `updating` が出なかったか | 6 秒 / 出なかった（合格） |
| V20 所要時間 / `updating` が出たか | 10 秒（golden の差分更新と C の clone を含む）/ 出た（合格） |
| V22 hostname / machine-id（A と B が違うか） | hostname は B の machine 名。B の machine-id は 32 桁の 16 進で、A と違う（合格） |
| V22 cloud-init instance の数と名前 / sem の時刻 < T_B か | 1 つで `agent-vm-golden` / `config_package_update_upgrade_install` と `config_set_hostname` の時刻は T_B より約 330 秒前（合格。R2 は顕在化していない） |
| V22 CLAUDE_COMPUTER_NAME / browser 系 MCP / headless_shell | B の machine 名 / mcpServers に `playwright` と `chrome-devtools` があり、playwright の args に `--executable-path /opt/agent-vm/browsers/current/bin/headless_shell` が入る / symlink の先の実体があり実行可能（合格） |
| V23 D の認証の痕跡（absent 2 行と false か） | B で claude と codex にログインした（`.credentials.json`・`auth.json` があり `oauthAccount` が `true` であることを確かめた）後、`golden refresh`（6 秒）と D の prewarm（6 秒）を実行した。D では `absent` が 2 行、`oauthAccount` は `false`（合格） |
| V21 golden rm 後に A・B が起動し `x` が出たか / refresh の成否 | A・B とも停止から起動し `x` を出した / `golden refresh` が golden を作り直して rc=0（1632 秒。下記） |
| 想定外の出力（あれば） | V21 の `golden refresh`（作り直し）は 1632 秒かかった。cloud-init の apt が `archive.ubuntu.com` から約 70KB/s でしか取得できなかったため（`orb logs` で 23.1 MB の deb に 326 秒）。同じ deb を host から取得しても約 71KB/s で、host の回線は他の宛先で約 20MB/s 出ていた。mirror 側の一時的な遅さで、golden の仕組みとは無関係と判断した。golden の作成の所要時間は V18 の 332 秒を代表値とする |

補足:

- V21 の書き込みと読み出しは、`agent-vm shell` の stdin にコマンドを渡して行った（`agent-vm shell` は引数を取らず、stdin を VM の bash に渡す）
- V18 のログにある `Only elvish v0.17 or higher is supported` は、starship のインストーラーが表示するシェル別の設定案内の一部で、警告ではない
- 既存の `agent-*` machine には触れていない。golden には `orb -m` で入っていない（console は `orb logs` で見た）
