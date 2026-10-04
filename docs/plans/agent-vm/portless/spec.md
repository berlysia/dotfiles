> **WIP・未承認**: #207 の Document Workflow の途中成果物。レビューは途中で、承認を受けていない。実装の根拠にしない（引き継ぎ先でレビューと承認をやり直す）。

# Spec: agent-vm の dev server のポートを portless で割り当てる（#207）

## Goal

VM で動かす dev server を、machine 間でも worktree 間でもポートが衝突しない形で、mac のブラウザから開けるようにする。ポートの選択を人と agent の判断から外し、launcher と portless の仕組みで決める。

## Experience Delta

- **変更前**
  - VM の dev server は、各自が選んだポート（5173 など）で loopback に bind する。
  - 2 台の machine が同じポートを使うと、mac の `localhost:<port>` は先に bind した machine に固定される。そのサーバーを止めると、どちらにも届かなくなる（#207）。
  - docs は「ポートを変える」と書くだけで、どのポートにするかは決まらない。
  - 同じ repo の worktree 同士も、1 台の machine の中でポートを取り合う。
- **変更後**
  - VM では `portless run <dev コマンド>` で起動し、`http://<app>.localhost:<machine の proxy のポート>` を開く。worktree なら `http://<branch>.<app>.localhost:<同じポート>` になる。
  - proxy のポートは launcher が machine ごとに重ならないように割り当てる。`agent-vm list` で確かめられる。
  - mac に転送されるのは machine ごとの proxy のポートだけになる。#207 の「同じポートを 2 台が bind する」状況は、portless を通す限り起きない。
  - VM の Claude は、`PORTLESS_PORT` があれば `portless run` を使うよう、global の CLAUDE.md で指示される。

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
- **VM**
  - portless は mise で入る（host と共有の `config.toml`）。
  - proxy は最初の `portless run` で daemon として自動起動し、VM の loopback に bind する。
  - アプリのポート（4000〜4999）は VM の中で閉じ、mac に転送されなくても proxy 経由で届く。

## Alternative Approaches (Greenfield View)

### 差分最小案 (Incremental)

launcher は変えない。docs に「machine ごとに 5170 + n のように手で決めたポートを使う」と表を書き、`8a6c0af` の注意書きを残す。

- 割り当ての台帳が人の記憶と docs にしかなく、新しい machine で何番を使うかは決まらない。#207 のコメント（「結局ぶつかる」）がこの案を退けている。
- worktree 同士の衝突も解けない。

### 白紙設計案 (Greenfield)

ゼロから設計するなら、mac に 1 つの reverse proxy を置き、URL からポートを消す（案 B）。

- origin: 人が覚えるのは名前だけにしたい。ポートは機械が持つ情報で、URL に出る必要はない。
- ただし、この構成は次の 3 点で成り立たない（research「案 A と案 B の判定」）。
  1. VM の portless が mac の proxy に経路を登録するには、VM から host への書き込みの通路が要る。ADR-0018 K23 はこれを作らないと決めている。
  2. mac の proxy から VM のアプリへは、OrbStack の localhost 転送を通るしかない。アプリのポートが machine 間で重なると、#207 がそのまま残る。
  3. 443 で待ち受けるには mac の sudo が要る。
- 白紙でも、境界の制約（VM → host の通路なし）を守るなら、「mac に見えるポートを machine ごとに 1 つに絞り、その 1 つを host が配る」構成になる。これは案 A と同じ形である。

### 採用案と理由

案 A（VM ごとの proxy と、launcher によるポートの割り当て）を採る。

- **根拠 1（#207 の原因の除去）**: OrbStack の転送は「同じポートを 2 台が bind する」ときに壊れる（research O2）。mac に転送されるポートを machine ごとに 1 つにし、host が重複なく配れば、この前提が起きない。案 B は、アプリのポートの重複（4000〜4999 の乱数）を残す。
- **根拠 2（境界）**: 割り当ての台帳は、VM がマウントしない `machines/` に置く（research F2）。VM は自分のポートを書き換えて他の machine の転送を奪えない。
- **根拠 3（既存の仕組みの再利用）**: meta は `rm` / `gc` で消える（research F3）。解放の処理を新たに作らなくてよい。

## Key Decisions

- **K1: 案 A（VM ごとの portless proxy）を採る。** 理由は上の「採用案と理由」に書いた。
  - 参照: `docs/decisions/0018-agent-vm-orbstack.md:51`（K23: VM から host への通信路は作らない）
  - 参照: `docs/agent-vm.md:305`（先に bind した machine に転送が固定される観測）
- **K2: proxy のポートの範囲は 17300〜17399（100 枠）にする。**
  - 1024 以上なので sudo が要らない。
  - portless のアプリの範囲（4000〜4999）と fallback（1355）を避ける。
  - よく使う dev server のポート（3000、5173、8000、8080 など）、Linux と macOS の ephemeral 範囲（32768〜）、WHATWG の blocked ports も避ける。
  - 100 は、machine を作り続けても `gc` 前に溢れない余裕として選んだ。範囲は launcher の定数にする。
  - 参照: research C3
- **K3: 割り当ては meta の `proxy_port` に記録し、専用の lock の下で決める。**
  - lock は `$AGENT_VM_STATE_DIR/ports.lock` を fd 6 で持つ。保持するのは、空き枠を数えて meta を書くまでの間だけにする。この間に orb は呼ばない。
  - 規則（決定的）:
    1. 自分の meta の `proxy_port` が範囲内で、ほかのどの meta も同じ値を持たなければ、それを使い続ける。
    2. それ以外は、ほかの meta が持たない最小の枠を選ぶ。
    3. 空きが無ければ `proxy_port` を書かない。launcher は警告を出し、起動は続ける。
  - meta は一時ファイルと `mv` で置き換える。ほかの launcher が書き込み途中の meta を読まないようにするためである。
  - 範囲外・数字以外の値は、自分のものでもほかのものでも、無いものとして扱う。
  - 参照: `home/dot_local/bin/executable_agent-vm:66-70`（`write_machine_meta`。起動のたびに 2 行で上書きする）
  - 参照: `home/dot_local/bin/executable_agent-vm:1500-1507`（`prepare_machine` が repo lock の前に meta を書く）
  - 参照: `home/dot_local/bin/executable_agent-vm:107`（`orb_q` が lock の fd を閉じる理由）
- **K4: 空きが無いとき、起動を止めない。**
  - ポートは dev server のための補助で、Claude / Codex の起動の前提ではない。止めると、無関係な作業までできなくなる。
  - 警告には回復手順（`agent-vm gc`、`agent-vm rm <repo>`）を書く。
  - `PORTLESS_PORT` が無いと、VM の portless は 80 を使おうとし、TTY なしでは失敗する（research P3）。dev server を起動したときに失敗として見えるので、黙って衝突するよりよい。
  - 参照: `home/dot_local/bin/executable_agent-vm:1578-1604`（`run_tool`。起動の流れ）
- **K5: VM には `PORTLESS_PORT` と `PORTLESS_HTTPS=0` を launch script の `export` で渡す。**
  - 置く位置は env file の source の後にする。repo の env file に古い `PORTLESS_PORT` があっても、host の割り当てが勝つ。
  - `claude` / `codex` / `shell` はすべて `build_launch_script` を通るので、1 か所で済む。
  - `forward_env_exports`（host の値を名前で転送する allowlist）は使わない。値は host の環境ではなく meta から来る。
  - `PORTLESS_SYNC_HOSTS` は渡さない。非 root の proxy では /etc/hosts の書き込みが失敗し、`proxy.log` に残るだけである（research P8、U5 で確認）。
  - 参照: `home/dot_local/bin/executable_agent-vm:1472-1484`（`build_launch_script`）
- **K6: `agent-vm list` に `proxy_port` を 4 列目として出す。**
  - mac で開く URL のポートを、VM に入らずに確かめられるようにする。
  - `gc` は 1・2 列目しか読まないので影響しない。
  - 参照: `home/dot_local/bin/executable_agent-vm:1707-1714`（`machine_rows`）、`cmd_gc` の awk
- **K7: portless は、host と共有の `home/dot_config/mise/config.toml` に `portless = "0.15.6"` で入れる。**
  - 0.15.6 にする理由: 0.15.7 は 2026-10-02 の公開で、`minimum_release_age = "7d"` に掛かる。以後の更新は Renovate の mise manager に任せる。
  - VM 専用の mise ファイルにしない理由: `.chezmoiignore` の host 側と VM 側の両方と、`run-templates.sh` の期待リストを変える必要がある（research F7）。host に入っても、portless は自分からは起動しない。
  - npm の install（`npm i -g`）にしない理由: VM のツールは mise で宣言管理している（ADR-0018 K5）。npx での実行は portless が拒否する（research P1）。
  - 参照: `home/dot_config/mise/config.toml:19-45`
- **K8: VM の Claude への指示を、global の `home/dot_claude/CLAUDE.md` の Key Commands に 1 行足す。**
  - 文言: 「**Dev server**: `PORTLESS_PORT` が設定されているとき（agent-vm）は `portless run <dev コマンド>` で起動し、表示された URL を使う。ポートを自分で選ばない」
  - 条件付きなので、host（`PORTLESS_PORT` なし）の動作は変わらない。
  - これが無いと、VM の Claude は今までどおり固定のポートで起動し、仕組みが使われない（research C6）。
  - 参照: `home/dot_claude/CLAUDE.md:13-21`
- **K9: 記録は docs と ADR-0018 に残す。**
  - `docs/agent-vm.md`「VM でブラウザを使う」の「同じポートの衝突」を、portless の使い方に書き換える。`8a6c0af` の観測（先に bind した machine を止めても移らない）は残す。
  - mac の実機での確認項目 V24〜V27 を足す（research U1〜U5）。
  - ADR-0018 の Amended by に 1 項を足し、Consequences の「`localhost` は先に bind した machine に届く」の項に、portless で避けることを追記する。
  - spec / plan / research は `docs/plans/agent-vm/portless/` に移す。
  - 参照: `docs/agent-vm.md:50-52`、`docs/decisions/0018-agent-vm-orbstack.md:85-89`
- **K10: `scripts/smoke-provisioning-invariants.sh` と `agent-vm/bootstrap.sh` は変えない。**
  - smoke は chezmoi script の名前・順序・内容の不変条件を検査する。mise の `[tools]` に 1 行足しても、検査の対象は変わらない。
  - bootstrap は apt と installer を扱い、mise のツールの一覧を持たない（research「変更が要らないもの」）。
  - 参照: `scripts/smoke-provisioning-invariants.sh:3-12`

## Risks

- **R1**: mac の `::1` に向かう接続を、OrbStack が VM に転送するかどうかが分からない（research O3）。Chrome が `app.localhost` を `::1` で試して失敗すると、つながらないように見えうる。→ V24 で確かめる。届かない場合は、docs に `http://127.0.0.1:<port>` と Host ヘッダの代替、または `localhost` の扱いを書き、別 issue にする。
- **R2**: mac 側で 17300〜17399 を別のプログラムが使っていると、そのポートの machine には届かない。launcher は mac 側の使用を検知しない。→ docs に書く。`agent-vm list` でポートが分かるので、該当 machine を `rm` して作り直せば別の枠になる。
- **R3**: 割り当てが変わったとき（重複の解消。手で meta を編集した場合にしか起きない）、VM で動いている proxy は古いポートのまま残る。portless は state dir の `proxy.port` を見て、既に動いている proxy を使う。→ docs に `portless proxy stop` での回復を書く。
- **R4**: mise が週ダウンロードの閾値で portless を拒否するかもしれない（research U4。この環境では数を確かめられなかった）。→ 人が mac で `mise install` を確かめる（V27）。拒否されたら、`@mizchi/readability` と同じく `allow_low_downloads = true` を付ける。
- **R5**: portless の `engines.node` は `>=24` で、mise の node は 24.15.0 なので満たす。node を 24 未満に下げると壊れうる。→ 実行時には強制されない（research P1）。今は対処しない。
- **R6**: 既存の machine の meta には `proxy_port` が無い。→ 次の起動で `write_machine_meta` が割り当てる。移行処理は要らない。

## Phase 1 で意図的に提供しない体験 (任意)

### 例: portless を通さない dev server の衝突の検知

- **代替経路確認**: `portless run` が、アプリのポートを `PORT` と `--port` で上書きする（research P5）。portless を通せば、アプリのポートは VM の中で閉じる。
- **非提供対象**: portless を使わずに直接 bind したサーバー同士の衝突（#207 の状況そのもの）を、launcher が検知・警告すること。VM の中の bind を host から監視する仕組みが要り、OrbStack の転送の内部状態は観測できない。
- **将来の予定**: 恒久的に非提供。docs で「portless を通す」と案内する。

### 例: URL からポートを消す（TLS / 443）

- **代替経路確認**: `PORTLESS_PORT` で任意の 1024 以上のポートを使える（research P3）。
- **非提供対象**: `https://<app>.localhost`（ポートなし）での閲覧。mac の sudo と CA の信頼登録が要り、案 B の問題も残る。
- **将来の予定**: 恒久的に非提供。

## ISO 25010 次元選択

- **機能適合性（正確性）**: 割り当てが重ならないこと、同じ machine で同じ値が続くこと、範囲外の値と空きが無い場合の扱い。launcher の関数の単体テストで確かめる。
- **互換性（共存性）**: 既存の meta の読み手（`repo_path` だけを読む）と `gc` が、`proxy_port` の追加で変わらないこと。既存のテストと、追加するテストで確かめる。
- **信頼性（障害許容性）**: 空き枠がないときも起動が止まらないこと。lock が他の lock から独立し、orb に fd が漏れないこと。
- **セキュリティ（完全性）**: VM が自分のポートを書き換えられないこと（meta は VM から見えない、既存の性質）。repo の env file の `PORTLESS_PORT` が host の割り当てに勝たないこと。
- **対象外**
  - 性能効率: 割り当ては meta の数（最大で数十）を 1 回読むだけで、計測するほどの差がない。
  - 使用性: URL の開きやすさは mac の実機の確認（V24〜V27）で見る。自動テストの対象にしない。
  - 保守性・移植性: bash 3.2 互換の維持は、既存の CI（macOS の `/bin/bash`）がそのまま確かめる。

## Approval

- Plan Status: complete
- Review Status: pending
- Approval Status: pending

## Reviewer Outputs (Round 1)

### logic-validator

- verdict:
- 主指摘:

### scope-justification-reviewer

- verdict:
- 主指摘:

### decision-quality-reviewer

- verdict:
- 主指摘:

### greenfield-perspective-reviewer

- verdict:
- 主指摘:

<!-- auto-review: pending -->
<!-- intent-triage: pending -->
