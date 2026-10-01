<!-- spec-ref: spec.md -->

# Plan: golden machine の clone による新規作成（mac 実機検証・設計記録・利用者向け文書）

spec.md の K10 と、各 Risk の「plan の mac 実機検証」を実行する。plan-1.md の実装がすべて commit されてから着手する。spec R3 の確認は plan-1 の T0 で行い、その結果を ADR-0020 に写す。行番号は master `85a60fe` のもの。

順序の理由: 実機検証（T1）を最初に行う。文書（ADR、`docs/agent-vm.md`）も git の tracked file なので staging に入る。先に編集すると staging hash が変わり、T1 の「golden の更新を飛ばす経路」を検証できなくなる（`home/dot_local/bin/executable_agent-vm:154` の `git ls-files`）。ADR と文書は実測値を見てから書く。session の成果物のコピーは、内容が確定した最後に行う。

## Files

```
# 新規作成
docs/decisions/0020-agent-vm-golden-clone.md
docs/plans/agent-vm/golden-clone/research.md
docs/plans/agent-vm/golden-clone/spec.md
docs/plans/agent-vm/golden-clone/plan-1.md
docs/plans/agent-vm/golden-clone/plan-2.md

# 編集
docs/decisions/0018-agent-vm-orbstack.md
docs/agent-vm.md
```

## Tasks

### T1: mac 実機で検証する

**前提:**
- plan-1 が commit 済みで、`chezmoi apply` により `~/.local/bin/agent-vm` が新しい版になっている
- `git status --short` が空である（作業ツリーが clean。staging hash を検証中に動かさない）
- `agent-vm fetch-browsers` を実行して、host の browser store に browser がある（`ensure_browsers` は新しい machine を作るたびに store から配るので、V19 の B を作る前に要る。V19 の所要時間もこの配布を含めて測る）

使い捨ての repo は `mktemp -d` で作り、表示されたパスをそのまま書いて `git init` する（以下 A〜D と書く）。既存の `agent-*` machine には触れない。golden（`agent-vm-golden`）には `orb -m` で入らない（spec R8。golden を起動すると、次の判定で更新を飛ばせなくなる）。

**Files:**

- 記録: `.tmp/sessions/e97e04f7/research.md`（「plan-2 T1 の結果」節）
- 参照: `docs/agent-vm.md:147-170`（V1〜V17 の表の形）、`home/dot_local/bin/executable_agent-vm`（plan-1 の `ensure_golden` が出す `updating the golden machine` の文言）

- [ ] **Step 1: V18 最初の 1 台（golden の作成を含む）**

golden があれば `printf 'y\n' | agent-vm golden rm` で消す。A で `time agent-vm prewarm` を実行する。
期待: 成功する。`orb list` に `agent-vm-golden`（stopped）と A の machine（running）がある。所要時間を記録する（参考値: create 249s + bootstrap 252s）

- [ ] **Step 2: V19 2 台目（dotfiles 不変、golden の更新を飛ばす経路）**

host で `date +%s` を記録してから（以下 T_B）、B で `time agent-vm prewarm` を実行する。
期待: 出力に `updating the golden machine` が出ない。所要時間が 30 秒以下（clone 先の bootstrap の `install_browser_deps` が `apt-get update` を走らせる数秒を含む）。30 秒を超えた場合も spec は書き換えない（承認済みの spec を編集すると hash が動き、plan の承認が外れる）。実測値を ADR-0020 の Consequences と `docs/agent-vm.md` に書き、超えたことをユーザーに報告する。golden を作る bootstrap（Step 1）が出す「no headless shell」の警告は想定どおり（golden には browser を配らない）なので、記録だけする

- [ ] **Step 3: V20 dotfiles の変更後（golden の差分更新の経路）**

tracked file を 1 つ編集してから（例: `docs/agent-vm.md` の末尾に空行を足す）、C で `time agent-vm prewarm` を実行する。終わったら `git checkout -- <編集したファイル>` で戻す。
期待: `updating the golden machine` が出る。所要時間を記録する。golden は編集後の内容で seal されるので、戻した後の次の新規作成では差分更新がもう 1 回走る（Step 5 の `golden refresh` がこれを兼ねる）

- [ ] **Step 4: V22 clone 先の初回起動（spec R2・K7・K2）**

`orb list` で A と B が running であることを確かめる（`agent-vm prewarm` は machine を起動したまま終わる。止まっていれば `orb start <machine>`。repo 用の machine なので起動してよい）。

```bash
orb -m <A の machine> cat /etc/machine-id
orb -m <B の machine> bash -c 'hostname; cat /etc/machine-id; ls /var/lib/cloud/instances; ls /var/lib/cloud/instances/*/sem; grep CLAUDE_COMPUTER_NAME= ~/.shell_common/env.sh; jq -c ".mcpServers | keys" ~/.claude.json; jq -r ".mcpServers.playwright.args | join(\" \")" ~/.claude.json; ls -l /opt/agent-vm/browsers/current/bin/headless_shell'
```

sem の一覧から、package の導入に当たるファイル（`config_package_update_upgrade_install` などの名前）を選び、`orb -m <B の machine> stat -c %Y /var/lib/cloud/instances/<instance>/sem/<選んだファイル>` で時刻を取る。

期待:
- hostname が B の machine 名になる
- B の machine-id が 32 桁の 16 進で、A の値と違う
- `/var/lib/cloud/instances` には instance が 1 つだけあり、その名前は golden の machine 名（research の実測で、instance_id は複製元の machine 名のまま引き継がれる）。2 つ以上あった場合は、clone 先の起動で cloud-init が新しい instance として走ったことになる（spec R2 が顕在化した）。一覧と各 instance の sem を記録し、ADR-0020 の Consequences に書く
- 選んだ sem ファイルの時刻が T_B より前になる（clone 先の起動で per-instance の module が再実行されていない）。T_B は host の時刻、sem の時刻は VM の時刻だが、OrbStack の machine は host と時刻を同期しているので、比較は数秒の範囲で成り立つ。golden の作成から T_B までは数分以上あくので、この程度のずれは判定に影響しない
- `CLAUDE_COMPUTER_NAME` が B の machine 名になる（clone 先の bootstrap が hostname を描画し直した）
- mcpServers の key に `playwright` と `chrome-devtools` が含まれ、playwright の args に `--executable-path /opt/agent-vm/browsers/current/bin/headless_shell` が入る（golden に空の browsers を mount したことで、browser 系 MCP が clone 先まで残った。spec K6）。`headless_shell` が存在する（T1 の前提で store に入れた browser を、`ensure_browsers` が clone 先の browsers に配った）

- [ ] **Step 5: V23 clone 先での認証の独立（spec K6・ADR-0018 K7）**

人手の手順を含む。B で `agent-vm claude` を起動し、mac のブラウザで承認してログインする。続けて `agent-vm codex` でも device 認証を済ませる。その後 `agent-vm golden refresh` を実行してから、D で `agent-vm prewarm` を実行し、次を確かめる。

```bash
orb -m <D の machine> bash -c 'for f in .claude/.credentials.json .codex/auth.json; do test ! -e ~/$f && echo "absent $f"; done; if [ -f ~/.claude.json ]; then jq -r "has(\"oauthAccount\")" ~/.claude.json; else echo "no claude.json"; fi'
```

期待: `absent` が 2 行出て、最後の行が `false` か `no claude.json`（B でログインした後に golden を更新しても、D に B の認証が入らない。golden の中身は seal の検査が見るので、この Step は clone 先への漏れが無いことだけを確かめる）

- [ ] **Step 6: V21 clone 先が golden から独立していること（spec R4 の未計測分）**

A と B で `agent-vm shell` を開き、`echo x > ~/v21` を書いて抜ける。`orb stop <A> <B>` で両方を止めてから、`printf 'y\n' | agent-vm golden rm` を実行する。A と B で `agent-vm shell` を開いて `cat ~/v21` を実行する。
期待: どちらも起動し、`x` が出る。続けて `agent-vm golden refresh` が golden を作り直す

- [ ] **Step 7: 片付けと記録**

A〜D について `agent-vm rm <repo>` を実行し、使い捨てのディレクトリを消す。golden は残す（日常で使うため）。各 Step の出力と所要時間を research.md の「plan-2 T1 の結果」節に書く。

### T2: ADR-0020 を書き、ADR-0018 から参照する

**Files:**

- 新規: `docs/decisions/0020-agent-vm-golden-clone.md`
- 編集: `docs/decisions/0018-agent-vm-orbstack.md:73-77`（`## Amended by` に 1 行）、`:82`（References の「V1〜V17」を「V1〜V23」に）
- 参照: `docs/decisions/0018-agent-vm-orbstack.md:1-84`（節の構成: Status / Context / Decision / 却下した代替案 / Consequences / References）

- [ ] **Step 1: ADR-0020 を書く**

先に `ls docs/decisions | sort` で番号を確かめる。0018 は 2 本、0019 は `0019-codex-config-toml-merge.md` が使っている。0020 が空いていれば 0020 を使い、埋まっていれば空いている次の番号を使って、この plan の以降の `0020` を読み替える。日付は、この Step を行う日（`date +%F` の出力）を書く。節の構成は ADR-0018 に合わせ、各節に次を書く。

- **Status**: `accepted (<date +%F の出力>)`
- **Context**: 新規作成の実測（5〜8 分の内訳、research.md「計測」）、ADR-0018 が Docker 案を却下した理由、OrbStack の clone が設定を受け継ぐという実測
- **Decision**: spec の K1〜K12 を 1 項目 1〜3 行で書く。冒頭に、支配軸はエルゴノミクスで隔離は固定制約であることを書く（ADR-0018 と同じ）
- **却下した代替案**: 次の 6 つ
  - export/import
  - 予備 machine の pool
  - 差分最小案
  - repo 用 machine を直接 `orb create` する経路を残す案（検査を全 machine に通せなくなる）
  - 起動後の VM 内 mountinfo による検査（VM の出力は VM が偽れる）
  - golden の許可リスト方式の検査（保守できない）
- **Consequences**: 次の 17 点を書く
  1. R1: `config set` が効かなくなると、新規作成が全面停止する。これは経路を 1 本にしたことのトレードオフで、回復は `AGENT_VM=off`
  2. `:` を含む repo path は使えない（今の `--mount` でも区切りがずれるので、新たに使えなくなる repo は無い見込み）
  3. OrbStack がキーを足したときは、`MACHINE_CONFIG_KEYS` の更新が保守作業になる。今の 10 キーは OrbStack 2.2.3 の `orb config show` で、起動中・停止中・clone 直後の machine について実測したもの
  4. golden を信頼できる前提は「golden に手で入らないこと」。更新を飛ばす経路では VM 内の検査が走らないので、手で入って停止し直した golden は検知できない。手で入ったときの一次手順は `agent-vm golden rm`、次善は `agent-vm golden refresh`
  5. 古い launcher に戻す前に、`$AGENT_VM_STATE_DIR/creating/` が空であることを確かめる
  6. golden-seal.sh の版は meta に入れない（seal は更新のたびに走り直す）
  7. 鮮度の判定は dotfiles 基準で、apt・mise・APM の上流の更新は `golden refresh` で取り込む
  8. R5: golden の claude 本体は作ったときの版のまま残る。clone 先は autoUpdates で上がる見込み（未検証）で、困ったら `golden rm` で作り直す
  9. plan-1 T0 の R3 の結果（claude の識別子を消したか、全 clone で共有されるか）
  10. golden-seal.sh の追加と bootstrap.sh のコメントで staging hash が変わるので、既存の machine は次の起動で 1 度だけ再 bootstrap される（冪等）
  11. 範囲外として残す課題: repo の root が `$AGENT_VM_STATE_DIR` の祖先（例: `~` そのものが repo）だと、VM から state dir（golden の meta と staging を含む）を書き換えられる。ADR-0018 の時点からある性質で、golden はその影響を広げる。別の課題として扱う
  12. T1 の実測値（V18〜V20 の所要時間）
  13. golden の record が欠けているか壊れていると、launcher は `agent-vm-golden` という名前の machine を消して作り直す。利用者が同じ名前で作った machine があれば消える。repo 用の machine の名前の形（`agent-<base>-<6 桁の 16 進>`）とは重ならない
  14. golden と bootstrap の契約: golden は空の browsers を mount し、repo 用の machine と同じ mount の形を bootstrap に見せる。bootstrap の `claude_keep` が mount の有無で browser 系 MCP を残すか決めるためで、golden で外れた MCP は clone 先で戻らない。この契約は `claude_keep` のコメントと run-bootstrap.sh のテストで守る。seal で MCP 名を決め打ちして検査する案は、利用者がサーバーを外すと seal が毎回落ちるので採らなかった。golden の bootstrap が出す「no headless shell」の警告は想定どおり
  15. golden の信頼の対象には、`install_browser_deps` が golden のホームに置く `~/.local/lib/agent-vm-browser` も含まれる（clone 先の headless shell が `LD_LIBRARY_PATH` で読む）。clone 先の bootstrap は browsers の mount があると毎回 `apt-get update` を走らせるので、2 台目以降の作成にもその数秒が含まれる
  16. 識別子: clone 先の machine-id は、空にした `/etc/machine-id` から初回起動で作られる（実測）。first boot の扱いで失敗する unit は増えない（失敗する 2 つは既存の machine と同じ）。golden に SSH の host key は無い（image に sshd が無い）
  17. 失敗時の扱い: `orb clone` が失敗しても名前で machine を消さない（同名の machine を誤って消さないため）。sentinel が残り、次の起動が回収する。golden の作成直後の検査が恒常的に落ちる環境（OrbStack の設定の扱いが変わった場合など）では、起動のたびに golden の作り直しを試みて同じところで止まる。止まるたびに回復手順（`agent-vm golden rm` または `AGENT_VM=off`）を示す。`agent-vm golden rm` は `cmd_rm` と同じく確認を求める
- **References**: `docs/plans/agent-vm/golden-clone/` の 4 ファイル、`home/dot_local/bin/executable_agent-vm`、`agent-vm/golden-seal.sh`、ADR-0018

- [ ] **Step 2: ADR-0018 を更新する**

`## Amended by` に次を足す（日付は Step 1 と同じ）。

```markdown
- `docs/decisions/0020-agent-vm-golden-clone.md` (<date +%F の出力>) — repo 用の machine は `orb create` ではなく、bootstrap 済みの golden machine（`agent-vm-golden`）の clone で作る。K1 の「repo ごとの isolated machine」という境界は変わらない。R5 の初回の待ちは、最初の 1 台（golden の作成）を除いて、T1 で測った値（V19）になる
```

References の `docs/agent-vm.md（導入ガイド、mac 実機検証項目 V1〜V17）` を `V1〜V23` にする。

- [ ] **Step 3: 確認する**

実行: `grep -c '0020-agent-vm-golden-clone' docs/decisions/0018-agent-vm-orbstack.md` と、ADR-0020 の参照先がすべて `git ls-files` に出ること（`docs/plans/agent-vm/golden-clone/` は T4 で追加するので、T4 の後に確認する）
期待: `1`（Step 2 で 0020 のファイル名を含めるのは `## Amended by` の 1 行だけで、References の行には足さない。`grep -c` は一致した行の数を数える）

### T3: docs/agent-vm.md を更新する

**Files:**

- 編集: `docs/agent-vm.md:30-32`（§3）、`:127-133`（§7）、`:134-146`（§8）、`:147-170`（§9 の表）、`:171-`（確認結果の節の後）
- 参照: `docs/agent-vm.md:32`（prewarm の説明）、`home/dot_local/bin/executable_agent-vm:10`（`AGENT_VM_STATE_DIR` の既定値 `~/.local/share/agent-vm`）

- [ ] **Step 1: §3 を書き換える**

`:30-32`（「初めてその repo で起動したときだけ、machine の作成を待つ」から prewarm の説明まで）を、次の内容にする。
- 最初の 1 台だけ golden machine の作成を待つ（T1 Step 1 の実測値）
- 2 台目以降は golden の clone から起動する（T1 Step 2 の実測値）
- dotfiles を変えた後の最初の新規作成は、golden の差分更新の分だけ待つ（T1 Step 3 の実測値）
- `agent-vm golden refresh` で、これらの待ちを前もって済ませられる。初回セットアップの最後に実行しておくことを勧める
- `agent-vm prewarm` は今までどおり使える

- [ ] **Step 2: §7 に注意を 5 つ足す**

- golden machine（`agent-vm-golden`）には手で入らない。golden の中身は全 clone に配られる。入った場合は `agent-vm golden rm` で作り直す
- golden の作成と更新のときに出る「no headless shell」の警告は想定どおり（golden には browser を配らない。browser は repo 用の machine に配られる）
- apt・mise・APM の上流の更新は、dotfiles を変えない限り golden に入らない。取り込むには `agent-vm golden refresh` を実行する
- golden の claude 本体は、golden を作ったときの版のまま残る。clone 先の claude が古くて困る場合は `agent-vm golden rm` で作り直す
- dotfiles を古い版に戻すときは、先に `~/.local/share/agent-vm/creating/` が空であることを確かめる

- [ ] **Step 3: §8 に golden の操作を足す**

- `agent-vm golden refresh`: golden を今すぐ更新する（dotfiles が同じでも bootstrap と seal をやり直す）
- `agent-vm golden rm`: golden を削除する。確認を求められる。既存の repo 用 machine はそのまま動く（V21）。次の新規作成で作り直される

- [ ] **Step 4: §9 に V18〜V23 を足し、確認結果の節を書く**

T1 の各 Step の「やること」と「期待する結果」を表に足す。`### <date +%F の出力> の確認結果（golden clone）` の節を足し、T1 の実測値と合否を書く。

- [ ] **Step 5: 確認する**

実行: `grep -n 'golden' docs/agent-vm.md | head -30` と `/verify-doc docs/agent-vm.md`
期待: §3・§7・§8・§9 に golden の記述がある。`/verify-doc` の要約で、初回の待ち、2 台目以降、refresh、rm の説明が spec と矛盾しない

### T4: session の成果物を置き、commit する

`.tmp/sessions/` は 7 日で GC されるので、ADR から参照する設計記録を tracked な場所に移す（`home/dot_claude/rules/workflow.md`「Session Artifact Retention」）。内容が確定した最後に行う。

**Files:**

- 新規: `docs/plans/agent-vm/golden-clone/{research,spec,plan-1,plan-2}.md`
- 参照: `docs/plans/agent-vm/vm-allowlist/`（前例。`spec.md` / `plan-1.md` / `research.md` を同じ形で置いている）

- [ ] **Step 1: コピーして確かめる**

`.tmp/sessions/e97e04f7/` の 4 ファイルを `docs/plans/agent-vm/golden-clone/` にコピーする。中身は変えない（Reviewer Outputs と marker も記録として残す）。
実行: `for f in research spec plan-1 plan-2; do cmp .tmp/sessions/e97e04f7/$f.md docs/plans/agent-vm/golden-clone/$f.md; done`
期待: 出力なし

- [ ] **Step 2: ADR の参照先を確かめて commit する**

```bash
git add docs/decisions/0020-agent-vm-golden-clone.md docs/decisions/0018-agent-vm-orbstack.md docs/agent-vm.md docs/plans/agent-vm/golden-clone
git ls-files docs/plans/agent-vm/golden-clone agent-vm/golden-seal.sh   # ADR-0020 の References がすべて出る
git commit -m "docs(agent-vm): record the golden clone design and how to use it"
```

## ISO 25010 具体テストケース

### 性能効率性（時間効率性）

- **入力**: dotfiles 不変で 2 台目の `agent-vm prewarm` → **期待**: `updating the golden machine` が出ず、所要時間が 30 秒以下（T1 Step 2）。超えたら ADR と文書に実測値を書き、ユーザーに報告する
- **入力**: 最初の 1 台の `agent-vm prewarm` → **期待**: 成功し、所要時間が記録される（T1 Step 1）

### セキュリティ（機密性）

- **入力**: B で claude と codex にログインした後、`agent-vm golden refresh` を実行し、D を作る → **期待**: D に `~/.claude/.credentials.json` と `~/.codex/auth.json` が無く、`oauthAccount` は `false`（T1 Step 5）
- **入力**: A と B の `/etc/machine-id` → **期待**: どちらも 32 桁の 16 進で、互いに違う（T1 Step 4）

### 信頼性（回復性）

- **入力**: 書き込みのある clone 先 A・B を停止し、`agent-vm golden rm` を実行 → **期待**: A・B とも起動でき、書き込んだファイルが残っている（T1 Step 6）

### 対象外

- 保守性（試験性）: plan-1 の自動テストで扱う。この plan は手動の実機検証と文書だけを扱う

## Approval

- Plan Status: complete
- Review Status: pass
- Approval Status: approved

## Reviewer Outputs (Round 1)

### logic-validator
- verdict: needs-work
- 主指摘: 承認済みの spec を実測に合わせて直す指示は、hash を動かして実装をブロックする（blocker）。「大きく超える」は曖昧語。ADR を実測より前に断定で書いている。docs の編集で staging hash が変わり、V19 の skip 経路を検証できなくなる。V22 の machine-id と cloud-init の確認方法が判定にならない。V23 の順序（ログイン → refresh → 新規作成）が逆。V21 は停止してから試す。コピーは commit の直前に行う

### scope-justification-reviewer
- verdict: needs-work
- 主指摘: R5（golden の claude が古い版のまま残ること）が文書の更新に入っていない。T0 が plan-1 にあることを明記する。承認日は実装時に埋める

<!-- auto-review: pending -->
<!-- intent-triage: pending -->

## Reviewer Outputs (Round 2)

### logic-validator
- verdict: needs-work
- 主指摘: V23 は D に `~/.claude.json` が無いと jq が失敗して判定が壊れる。V22 の sem ファイル名は未検証なので先に一覧を取る。B が起動中である前提を確かめる。V20 で golden が編集後の内容になることの影響を書く。ADR の採番を `ls` で確かめる。grep の件数の根拠を書く

### scope-justification-reviewer
- verdict: pass
- 主指摘: round 1 の指摘は反映された。grep の期待値は文言とそろえる。Consequence 11 に spec の根拠を添えるとよい

<!-- auto-review: verdict=needs-work; hash=a25b296255ce21afebf6d0107094577a277a86646be4f669bc0e79a4640a4498; design-hash=ef3a7e7f707f04a3be0818c8b07ab386021ca25546f622f3c774000ba1545752; round=1; parent-spec-hash=0ec071c55ebe2b34b3d91c54eb27f21f1348b7cc9648df2dd9a0f97828b8421c; at=2026-10-01T14:43:10.426Z; reviewers=logic-validator+scope-justification-reviewer -->

## Reviewer Outputs (Round 3)

### logic-validator
- verdict: needs-work
- 主指摘: round 2 の指摘は反映された。軽微な点が 4 つある。V22 で instance が 1 つでなかった場合の扱いを書く。sem の時刻と host の時刻を比べるので、時刻のずれを許す旨を書く。Consequences の件数が「12 点」のままで、実際は 13 項目ある。V23 の判定は D への漏れが無いことを見るもので十分

### scope-justification-reviewer
- verdict: pass (carried from Round 2)
- 主指摘: Round 2 で pass、再実行なし

<!-- auto-review: verdict=needs-work; hash=f6c46f73d60f768c4a310816484a5b5b68a59e9bea623bacf1ee8768b20ee111; design-hash=b211f028042e8e94b60e3edc90ff5270c38e9ae8e97399e2871227f0c94ae934; round=2; parent-spec-hash=0ec071c55ebe2b34b3d91c54eb27f21f1348b7cc9648df2dd9a0f97828b8421c; at=2026-10-01T14:52:46.192Z; reviewers=logic-validator+scope-justification-reviewer -->

## Reviewer Outputs (Round 4)

### logic-validator
- verdict: pass
- 主指摘: round 3 の 4 指摘はすべて反映された。T1 の順序、spec を編集しない方針、V20 の後の golden の状態、採番の確認、grep の期待値は整合している

### scope-justification-reviewer
- verdict: pass (carried from Round 3)
- 主指摘: Round 3 で pass、再実行なし

<!-- auto-review: verdict=needs-work; hash=a0e3e5ef27d2f148aa341e4d09dbd02eeea33d2f8c250a1fdd28bd8131047768; design-hash=12964e6199c008a45c5cbb9c761f1093b1ce4185bf7a5f4acd8fd29004730aee; round=3; parent-spec-hash=0ec071c55ebe2b34b3d91c54eb27f21f1348b7cc9648df2dd9a0f97828b8421c; at=2026-10-01T14:56:28.309Z; reviewers=logic-validator -->

## Reviewer Outputs (Round 5)

### logic-validator
- verdict: pass
- 主指摘: 行番号は HEAD と一致し、0020 は空いている。`fetch-browsers` を T1 の前提に移す（B を作るときに配られるため。反映済み）

### scope-justification-reviewer
- verdict: pass
- 主指摘: spec が ADR・文書・実機検証に送った項目は網羅されている。10 キーの実測の根拠、unit と sshd の記録を Consequences に足す（反映済み）

<!-- auto-review: verdict=pass; hash=a5e092d259b186285f201b3bc483970d937ba26a7c04b2322f99cc03a2a4f5dd; design-hash=977ad8e3afd4e7bb465ff2003dc1ae52ba29d669101699e405e1dcbf9166ba99; round=4; parent-spec-hash=0ec071c55ebe2b34b3d91c54eb27f21f1348b7cc9648df2dd9a0f97828b8421c; at=2026-10-01T14:58:01.526Z; reviewers=logic-validator -->
<!-- intent-triage: adopted=24; excluded=0; at=2026-10-01T14:58:20.041Z -->

<!-- auto-review: verdict=pass; hash=9bc25c3f49028a3e8889a9ea83131515deb174aa1463bc96a6b261701c32b9ea; design-hash=4a1075d782047d308375ef84dbdebadbec4433afcac99423b11efbc69ecc68de; round=5; parent-spec-hash=d192e68e8b7ad4531624f3058511e027074b8bbd145fe3ef3d4ecaa901fedf6d; at=2026-10-01T15:37:08.654Z; reviewers=logic-validator+scope-justification-reviewer -->
<!-- intent-triage: adopted=9; excluded=0; at=2026-10-01T15:38:33.221Z -->
