# ADR-0021: repo ごとの machine を bootstrap 済みの golden machine の clone で作る

## Status

accepted (2026-10-02)

ADR-0034 で VM 経由が opt-in になり、`AGENT_VM` は廃止された。R1 と 17 項の回復手順は、これに合わせて「agent-vm を通さずに `claude` / `codex` を直接打つ」と読む。

## Context

ADR-0018 は、claude / codex を repo ごとの OrbStack isolated machine で動かす。新しい repo で初めて起動すると、`orb create`（cloud-init の apt を含む）と初回の bootstrap（mise・APM・plugin・claude の導入と `chezmoi apply`）を待つ。実測では 5〜8 分かかり、create の所要は cloud-init の apt の取得がネットワークに左右されるので大きくぶれる。

ADR-0018 は Docker container 案を、ツールチェイン一式を image として保守するコストを理由に却下した。image を別の定義（Dockerfile）で書けば bootstrap との二重管理になる。そこで、bootstrap 自身を image の定義とし、その実行結果を image として使う方式を考えた。

OrbStack 2.2.3 では、`orb clone` は copy-on-write で 1 秒未満で終わる。一方で、clone 先は複製元の設定（`isolated`・`isolate_network`・`forward_ssh_agent`・`mounts`）をすべて受け継ぎ、clone の時点では mount を指定できない。設定は `orb config set machine.<m>.mounts` で clone 先の起動前に差し替えられる（いずれも実測）。

設計の全文は `git show 52dc6fd447:docs/plans/agent-vm/golden-clone/spec.md`（K1〜K12、R1〜R8）にある。

## Decision

支配軸は ADR-0018 と同じくエルゴノミクスである。isolated machine による隔離（machine 単位の認証、machine ごとの staging / outbox、VM 間の書き込み経路なし）は固定の制約とし、その内側で 2 台目以降の新規作成の待ちを縮める。

- **K1: repo 用の machine は常に golden（`agent-vm-golden`）の clone で作る**。golden が無ければ先に作る。`orb create` は golden を作るときだけ使い、repo 用の machine を直接作る経路は残さない。作成経路を 1 本にすることで、K4 の検査をすべての新しい machine に通す
- **K2: golden は clone の直前に差分更新し、clone 先では bootstrap を必ず 1 回走らせる**。golden の meta が `state=sealed`、その `staging_hash` が今回の staging hash と同じ、golden が停止中、`refresh` による強制でない、の 4 つがそろったときだけ更新を飛ばす。seal が golden の `applied-hash` を消すので、clone 先の bootstrap は skip されず、`.chezmoi.hostname` を使うテンプレートが clone 先の名前で描画し直される
- **K3: golden 専用の lock を持ち**、golden の更新の開始から clone 先の設定の検査が終わるまで保持する。取得順は repo の lock が先
- **K4: clone 先は、repo path と全設定キーを検査してから起動する**。mount に入る path が `,` `:` 改行を含めば die する。`config set` で repo 用の mount に差し替えた後、`orb config show` のキーの集合が既知のものと一致し、`isolated`・`isolate_network`・`forward_ssh_agent` が `true`、`mounts` が期待値と完全一致することを確かめる。一致しなければ起動せずに消す
- **K5: 作成中の印を host 側に置き**、途中で終わった clone 先は次の起動で作り直す。中断の trap は置かず、印がすべての中断の経路を拾う
- **K6: golden の検査は host 側を主とし、VM 内を補助とする**。host 側では golden の設定キーと、outbox が空のディレクトリ 2 つだけであること、browsers が空であることを毎回確かめる。VM 内では、代表的な認証の痕跡が無いことを確かめる
- **K7: machine 固有の識別子は golden 側で消し、clone 先の初回起動で作らせる**。`/etc/machine-id` を空にし、`/var/lib/systemd/random-seed` を消す。claude の `userID` / `machineID` も消す（R3 の結果）
- **K8: golden の操作を `agent-vm golden refresh` と `agent-vm golden rm` で提供する**。`refresh` は更新を飛ばす判定を迂回して、bootstrap・seal・検査をやり直す。`rm` は確認を求め、meta、VM、golden 専用の staging・outbox・browsers の順に消す。自動の refresh は入れない
- **K9: 既存の machine はそのまま使い**、`BOOTSTRAP_CONTRACT` と `machines/<m>` の meta の形式は変えない。移行処理は作らない
- **K10: 設計の記録はこの ADR として立て**、ADR-0018 の Status から参照する
- **K11: golden の host 側の状態は専用の 4 か所に置く**。meta は `cloud_init_hash` と `contract` を持ち、どちらかが変わったら golden を作り直す（cloud-init は作成時にしか効かない）
- **K12: golden に固有の VM 内処理は `agent-vm/golden-seal.sh` に置く**。識別子の消去、認証の痕跡の検査、`applied-hash` の消去と不在の確認を行い、0 以外で終わったら launcher は meta を書かずに die する

## 却下した代替案

- **`orb export` / `import` でファイル化した golden**: import は 1.2 秒と速いが、golden 1 台あたり数 GB のファイルを host に置く。clone は同じ速さで、追加の置き場所が要らない
- **予備の machine の pool（作り置きを `orb rename` で付け替える）**: 予備の台数分のディスクとメモリを常に使い、予備ごとに中身が古くなる
- **差分最小案（作成方式は変えず apply を速くする）**: marketplace 登録の並行化などで見込める短縮は 1〜2 分という推定で、新規作成は 3 分を下回らない。golden 方式の 2 台目以降（実測 6 秒）とは桁が違う。各施策は golden 方式と両立するので、golden の作成を速くする別の課題として残す
- **repo 用の machine を直接 `orb create` する経路を残す**: 作成経路が 2 本になり、K4 の検査をすべての machine に通せなくなる
- **起動後に VM 内の mountinfo で mount を検査する**: VM の出力は VM が偽れる。host 側の OrbStack の設定を真とし、起動前に検査する
- **golden の中身を許可リスト方式で検査する**: bootstrap 後のホームには mise や bun の導入物が数千ファイルあり、許可リストを保守できない

## Consequences

1. **R1**: `orb config set machine.<m>.mounts` は OrbStack の文書に載っていない使い方である。将来の版で効かなくなると、K4 の検査が起動を止め、新しい repo 用の machine は 1 台も作れなくなる（既存の machine は影響を受けない）。作成経路を 1 本にした（K1）ことのトレードオフで、回復は agent-vm を通さずに `claude` / `codex` を直接打つこと
2. `:` を含む repo path は使えない。今の `--mount SRC:DEST` でも区切りがずれるので、新たに使えなくなる repo は無い見込みである
3. OrbStack が machine の設定キーを足したときは、既知のキーの更新が保守作業になる
4. golden を信頼できる前提は「golden に手で入らないこと」である。更新を飛ばす経路では VM 内の検査が走らないので、手で入って停止し直した golden は検知できない。手で入ったときの一次手順は `agent-vm golden rm`、次善は `agent-vm golden refresh`
5. 古い launcher に戻す前に、作成中の印のディレクトリが空であることを確かめる。古い launcher は印を知らない（手順は `docs/agent-vm.md` 7 節）
6. golden-seal.sh の版は meta に入れない。seal は golden を更新するたびに走り直すので、seal の変更は次の更新で反映される
7. 鮮度の判定は dotfiles（staging の hash）を基準にする。apt・mise・APM の上流の更新は、`agent-vm golden refresh` で取り込む
8. **R5**: golden の claude 本体は、golden を作ったときの版のまま残る。clone 先は autoUpdates で上がる見込み（未検証）で、困ったら `agent-vm golden rm` で作り直す
9. **R3 の結果**: bootstrap 直後の golden で `~/.claude.json` の `userID` と `machineID` を消すと、claude は次の起動で 2 つとも新しい値を作る。seal がこの 2 つを消すので、clone ごとに別の値になる
10. golden-seal.sh や bootstrap.sh を変えると staging hash が変わるので、既存の machine は次の起動で 1 度だけ再 bootstrap される（冪等）
11. 範囲外として残す課題: repo の root が `$AGENT_VM_STATE_DIR` の祖先にある場合（例: `~` そのものが repo）、VM から state dir（golden の meta と staging を含む）を書き換えられる。ADR-0018 の時点からある性質で、golden はその影響を広げる。別の課題として扱う
12. 実測（mac 実機、OrbStack 2.2.3）: 最初の 1 台は 332 秒、2 台目（dotfiles が同じで golden の更新を飛ばす）は 6 秒で、目標の 30 秒以内に収まった。golden の作成は cloud-init の apt の取得に左右され、Ubuntu の mirror が遅いと大きく延びる
13. golden の record が欠けているか壊れていると、launcher は `agent-vm-golden` という名前の machine を消して作り直す。利用者が同じ名前で作った machine があれば消える。repo 用の machine の名前の形（`agent-<base>-<6 桁の 16 進>`）とは重ならない
14. golden と bootstrap の契約: golden は空の browsers を mount し、repo 用の machine と同じ mount の形を bootstrap に見せる。bootstrap が mount の有無で browser 系 MCP を残すかを決めるためで、golden で外れた MCP は clone 先で戻らない。seal で MCP の名前を決め打ちして検査する案は、利用者がサーバーを外すと seal が毎回落ちるので採らなかった。golden の bootstrap が出す `no headless shell` の警告は想定どおりである
15. golden の信頼の対象には、golden のホームに置かれるブラウザの依存ライブラリ（clone 先の headless shell が `LD_LIBRARY_PATH` で読む）も含まれる。clone 先の bootstrap は browsers の mount があると毎回 `apt-get update` を走らせるので、2 台目以降の作成にもその数秒が含まれる
16. 識別子: clone 先の machine-id は、空にした `/etc/machine-id` から初回起動で作られる。SSH の host key は golden に無く、cloud-init の instance は clone 先でも golden の名前のまま 1 つで、per-instance の module は再実行されない（R2 は顕在化していない）
17. 失敗時の扱い: `orb clone` が失敗しても、名前で machine を消さない（同名の machine を誤って消さないため）。作成中の印が残り、次の起動が回収する。golden の作成直後の検査が恒常的に落ちる環境では、起動のたびに golden の作り直しを試みて同じところで止まる。止まるたびに回復手順（`agent-vm golden rm`、または agent-vm を通さずに `claude` / `codex` を直接打つ）を示す。`agent-vm golden rm` は `cmd_rm` と同じく確認を求める

## References

- `git show 52dc6fd447:docs/plans/agent-vm/golden-clone/`（`spec.md` / `research.md` / `plan-1.md` / `plan-2.md`）
- `docs/decisions/0018-agent-vm-orbstack.md`
- `docs/decisions/0034-agent-vm-opt-in.md`
