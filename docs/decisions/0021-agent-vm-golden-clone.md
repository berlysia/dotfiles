# ADR-0021: repo ごとの machine を bootstrap 済みの golden machine の clone で作る

## Status

accepted (2026-10-02)

## Context

ADR-0018 は、claude / codex を repo ごとの OrbStack isolated machine で動かす。新しい repo で初めて起動すると、`orb create`（cloud-init の apt を含む）と初回の bootstrap（mise・APM・plugin・claude の導入と `chezmoi apply`）を待つ。実測では 5〜8 分かかった（既存の repo 用 machine で VM 作成 55 秒 + apply 約 4 分、V4 の初回 prewarm で 282 秒、本番相当の作成で create 249 秒 + bootstrap 252 秒）。create の所要は、cloud-init の apt の取得がネットワークに左右されるので大きくぶれる。

ADR-0018 は Docker container 案を、ツールチェイン一式を image として保守するコストを理由に却下した。image を別の定義（Dockerfile）で書けば bootstrap との二重管理になる。そこで、bootstrap 自身を image の定義とし、その実行結果を image として使う方式を考えた。

OrbStack 2.2.3 では、`orb clone` は copy-on-write で 1 秒未満で終わり、clone 直後のディスク使用量は 16 kB だった。一方で、clone 先は複製元の設定（`isolated`・`isolate_network`・`forward_ssh_agent`・`mounts`）をすべて受け継ぎ、clone の時点では mount を指定できない。設定は `orb config set machine.<m>.mounts` で clone 先の起動前に差し替えられる（いずれも実測）。

設計の全文は `git show 52dc6fd447:docs/plans/agent-vm/golden-clone/spec.md`（K1〜K12、R1〜R8）にある。ここには骨子と、却下した代替案を記す。

## Decision

支配軸は ADR-0018 と同じくエルゴノミクスである。isolated machine による隔離（machine 単位の認証、machine ごとの staging / outbox、VM 間の書き込み経路なし）は固定の制約とし、その内側で 2 台目以降の新規作成の待ちを縮める。

- **K1: repo 用の machine は常に golden（`agent-vm-golden`）の clone で作る**。golden が無ければ先に作る。`orb create` は golden を作るときだけ使い、repo 用の machine を直接作る経路は残さない。作成経路を 1 本にすることで、K4 の検査をすべての新しい machine に通す
- **K2: golden は clone の直前に差分更新し、clone 先では bootstrap を必ず 1 回走らせる**。golden の meta が `state=sealed`、その `staging_hash` が今回の staging hash と同じ、golden が停止中、`refresh` による強制でない、の 4 つがそろったときだけ更新を飛ばす。seal が golden の `applied-hash` を消すので、clone 先の bootstrap は skip されず、`.chezmoi.hostname` を使うテンプレートが clone 先の名前で描画し直される
- **K3: golden 専用の lock を fd 7（`$AGENT_VM_STATE_DIR/golden/lock`）で持ち**、`ensure_golden` の開始から clone 先の設定の検査が終わるまで保持する。取得順は repo の lock（fd 9）が先。待ちの上限は 900 秒
- **K4: clone 先は、repo path と全設定キーを検査してから起動する**。mount に入る 4 つの path が `,` `:` 改行を含めば die する。`config set` で repo 用の 4 つの mount に差し替えた後、`orb config show` のキーの集合が既知の 10 キーと一致し、`isolated`・`isolate_network`・`forward_ssh_agent` が `true`、`mounts` が期待値と完全一致することを確かめる。一致しなければ起動せずに消す
- **K5: 作成中の印（`$AGENT_VM_STATE_DIR/creating/<m>`）を host 側に置き**、途中で終わった clone 先は次の起動で作り直す。中断の trap は置かず、sentinel がすべての中断の経路を拾う
- **K6: golden の検査は host 側を主とし、VM 内を補助とする**。host 側では golden の設定キーと、outbox が空のディレクトリ 2 つだけであること、browsers が空であることを毎回確かめる。VM 内（golden-seal.sh）では、代表的な認証の痕跡が無いことを確かめる
- **K7: machine 固有の識別子は golden 側で消し、clone 先の初回起動で作らせる**。`/etc/machine-id` を空にし、`/var/lib/systemd/random-seed` を消す。claude の `userID` / `machineID` も消す（R3 の結果）
- **K8: golden の操作を `agent-vm golden refresh` と `agent-vm golden rm` で提供する**。`refresh` は更新を飛ばす判定を迂回して、bootstrap・seal・検査をやり直す。`rm` は確認を求め、meta、VM、golden 専用の staging・outbox・browsers の順に消す。自動の refresh は入れない
- **K9: 既存の machine はそのまま使い**、`BOOTSTRAP_CONTRACT` と `machines/<m>` の meta の形式は変えない。移行処理は作らない
- **K10: 設計の記録はこの ADR として立て**、ADR-0018 の `## Amended by` から参照する
- **K11: golden の host 側の状態は 4 か所**（`golden/{lock,meta}`、`staging/agent-vm-golden`、`outbox/agent-vm-golden`、`browsers/agent-vm-golden`）に置く。meta は `cloud_init_hash`・`contract`・`state`・`staging_hash` を持つ。`cloud_init_hash` か `contract` が変わったら golden を作り直す（cloud-init は作成時にしか効かない）
- **K12: golden に固有の VM 内処理は `agent-vm/golden-seal.sh` に置く**。識別子の消去、認証の痕跡の検査、`applied-hash` の消去と不在の確認を行い、0 以外で終わったら launcher は meta を書かずに die する

### 却下した代替案

- **`orb export` / `import` でファイル化した golden**: import は 1.2 秒と速いが、golden 1 台あたり数 GB のファイルを host に置く。clone は同じ速さで、追加の置き場所が要らない
- **予備の machine の pool（作り置きを `orb rename` で付け替える）**: 予備の台数分のディスクとメモリを常に使い、予備ごとに中身が古くなる
- **差分最小案（作成方式は変えず apply を速くする）**: marketplace 登録の並行化などで見込める短縮は 1〜2 分という推定で、新規作成は 3 分を下回らない。golden 方式の 2 台目以降（実測 6 秒）とは桁が違う。各施策は golden 方式と両立するので、golden の作成を速くする別の課題として残す
- **repo 用の machine を直接 `orb create` する経路を残す**: 作成経路が 2 本になり、K4 の検査をすべての machine に通せなくなる
- **起動後に VM 内の mountinfo で mount を検査する**: VM の出力は VM が偽れる。host 側の OrbStack の設定を真とし、起動前に検査する
- **golden の中身を許可リスト方式で検査する**: bootstrap 後のホームには mise や bun の導入物が数千ファイルあり、許可リストを保守できない

## Consequences

1. **R1**: `orb config set machine.<m>.mounts` は OrbStack の文書に載っていない使い方である。将来の版で効かなくなると、K4 の検査が起動を止め、新しい repo 用の machine は 1 台も作れなくなる（既存の machine は影響を受けない）。作成経路を 1 本にした（K1）ことのトレードオフで、回復は `AGENT_VM=off`
2. `:` を含む repo path は使えない。今の `--mount SRC:DEST` でも区切りがずれるので、新たに使えなくなる repo は無い見込みである
3. OrbStack が machine の設定キーを足したときは、`MACHINE_CONFIG_KEYS` の更新が保守作業になる。今の 10 キーは OrbStack 2.2.3 の `orb config show` で、起動中・停止中・clone 直後の machine について実測したものである
4. golden を信頼できる前提は「golden に手で入らないこと」である。更新を飛ばす経路では VM 内の検査が走らないので、手で入って停止し直した golden は検知できない。手で入ったときの一次手順は `agent-vm golden rm`、次善は `agent-vm golden refresh`
5. 古い launcher に戻す前に、`$AGENT_VM_STATE_DIR/creating/` が空であることを確かめる。古い launcher は sentinel を知らない
6. golden-seal.sh の版は meta に入れない。seal は golden を更新するたびに走り直すので、seal の変更は次の更新で反映される
7. 鮮度の判定は dotfiles（staging の hash）を基準にする。apt・mise・APM の上流の更新は、`agent-vm golden refresh` で取り込む
8. **R5**: golden の claude 本体は、golden を作ったときの版のまま残る。clone 先は autoUpdates で上がる見込み（未検証）で、困ったら `agent-vm golden rm` で作り直す
9. **R3 の結果**: bootstrap 直後の golden で `~/.claude.json` の `userID` と `machineID` を消すと、claude は次の起動（未ログインでの `claude -p` を含む）で 2 つとも新しい値を作った。そこで seal はこの 2 つを消し、clone ごとに別の値になる
10. golden-seal.sh の追加と bootstrap.sh のコメントの変更で staging hash が変わるので、既存の machine は次の起動で 1 度だけ再 bootstrap される（冪等）
11. 範囲外として残す課題: repo の root が `$AGENT_VM_STATE_DIR` の祖先にある場合（例: `~` そのものが repo）、VM から state dir（golden の meta と staging を含む）を書き換えられる。ADR-0018 の時点からある性質で、golden はその影響を広げる。別の課題として扱う
12. mac 実機の実測（2026-10-02、OrbStack 2.2.3）: 最初の 1 台（golden の作成と clone）は 332 秒、2 台目（dotfiles が同じで golden の更新を飛ばす）は 6 秒、dotfiles を変えた後の新規作成（golden の差分更新を含む）は 10 秒だった。2 台目は目標の 30 秒以内に収まった。golden の作成は cloud-init の apt の取得に左右され、Ubuntu の mirror が遅かった回の作り直しには 1632 秒かかった
13. golden の record が欠けているか壊れていると、launcher は `agent-vm-golden` という名前の machine を消して作り直す。利用者が同じ名前で作った machine があれば消える。repo 用の machine の名前の形（`agent-<base>-<6 桁の 16 進>`）とは重ならない
14. golden と bootstrap の契約: golden は空の browsers を mount し、repo 用の machine と同じ mount の形を bootstrap に見せる。bootstrap の `claude_keep` が mount の有無で browser 系 MCP を残すかを決めるためで、golden で外れた MCP は clone 先で戻らない。この契約は `claude_keep` のコメントと `tests/agent-vm/run-bootstrap.sh` のテストで守る。seal で MCP の名前を決め打ちして検査する案は、利用者がサーバーを外すと seal が毎回落ちるので採らなかった。golden の bootstrap が出す `no headless shell` の警告は想定どおりである
15. golden の信頼の対象には、`install_browser_deps` が golden のホームに置く `~/.local/lib/agent-vm-browser`（clone 先の headless shell が `LD_LIBRARY_PATH` で読む）も含まれる。clone 先の bootstrap は、browsers の mount があると毎回 `apt-get update` を走らせるので、2 台目以降の作成にもその数秒が含まれる
16. 識別子: clone 先の machine-id は、空にした `/etc/machine-id` から初回起動で作られる（実測。2 台の clone で別の値になった）。first boot の扱いで失敗する unit は増えない（失敗する 2 つは既存の machine と同じ）。golden に SSH の host key は無い（image に sshd が無い）。cloud-init の instance は clone 先でも golden の名前のまま 1 つで、per-instance の module は再実行されない（実測、R2 は顕在化していない）
17. 失敗時の扱い: `orb clone` が失敗しても、名前で machine を消さない（同名の machine を誤って消さないため）。sentinel が残り、次の起動が回収する。golden の作成直後の検査が恒常的に落ちる環境（OrbStack の設定の扱いが変わった場合など）では、起動のたびに golden の作り直しを試みて同じところで止まる。止まるたびに回復手順（`agent-vm golden rm` または `AGENT_VM=off`）を示す。`agent-vm golden rm` は `cmd_rm` と同じく確認を求める

## References

- `git show 52dc6fd447:docs/plans/agent-vm/golden-clone/`（`spec.md` / `research.md` / `plan-1.md` / `plan-2.md`）
- `home/dot_local/bin/executable_agent-vm`
- `agent-vm/golden-seal.sh`
- `docs/decisions/0018-agent-vm-orbstack.md`
