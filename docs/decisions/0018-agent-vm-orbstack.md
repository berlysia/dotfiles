# ADR-0018: claude / codex を repo ごとの OrbStack isolated machine で隔離起動する

## Status

accepted (2026-09-28)

## Context

mac 上で `claude` / `codex` はそのまま host のホームディレクトリで動く。agent は `~` 全体、1Password デスクトップ連携、host のコマンドに到達できる状態にある。

OrbStack の通常の machine（isolated 指定なし）は `/Users` 全体への読み書きと、`mac` コマンドによる host コマンド実行を持ち、これらを選択的に無効化できない。隔離を機構として持たせるには、通常 machine ではなく isolated machine（`--isolated --isolate-network --forward-ssh-agent`）を使う必要がある。

設計の全文は `docs/plans/agent-vm/spec.md`（K1〜K16、7 名 × 8 ラウンドのレビューと intent triage を経て verdict=pass）と、それに続く plan-1〜plan-4（各 5〜7 名 × 複数ラウンドで verdict=pass）にある。ここには骨子と、却下した代替案を記す。

## Decision

支配軸はエルゴノミクスである（ユーザー明示）。安全境界（isolated machine）はユーザー決定済みの制約であり、その内側で普段の打鍵・待ち時間・手作業を増やさないことを優先する。

### 境界と機構（K1〜K16 の骨子）

- **K1**: 境界は repo ごとの isolated machine。machine 名は repo basename の正規化と repo 絶対パスの sha256 先頭 6 桁から導出する。同一 machine への並行アクセスは `flock(2)` による排他（bash 3.2 と標準 perl だけで実現）で守る。
- **K2・K3**: 「読み込み限定」は、host 側の VM から見えない領域で tracked files を毎回コピーし直し、mount された staging へ `rename(2)` で置き換える方式で実現する。内容 hash が変われば VM 内で再適用する。
- **K4**: VM 向けの分岐は chezmoi データ `agent_vm` の 1 つに絞り、既存 host は無変更で動く（`dig` によるガード）。
- **K5**: VM の global mise ツールは軽量セットに絞る。
- **K6**: 秘密は host 所有の `op://` 参照ファイルだけを host 側で解決し、tmpfs 経由で VM に渡す。repo 内の `.env` は解決しない。
- **K7**: Claude・Codex とも machine ごとに初回ログインし、認証は VM の中にだけ置く。長期 token の注入も、認証の VM 間共有も行わない。
- **K8**: git の SSH 認証・署名は agent forwarding だけで行い、gitconfig は変更しない。
- **K9**: セッションログは常時 outbox に置き、起動時・終了時・`agent-vm sync` で host に取り込む。取り込みは追記専用を前提にした検証を伴う。
- **K10**: 既定で VM を経由し、opt-out（`AGENT_VM=off`、`~/.config/agent-vm/config`）は host 側にしか置けない。OrbStack が使えない・応答しないときは host に自動で切り替えず、fail closed する。
- **K11・K12**: host 側ファイルは darwin にのみ配布する。OrbStack は Homebrew cask で宣言管理する。
- **K13**: repo は VM から rw で mount されるため、`.git/hooks` や `.git/config` の実行系設定を VM が書き換える余地が残る。launcher は起動・終了のたびにこれらのスナップショットを取り、差分を検知・報告する。人間が `agent-vm accept-git` で `.git/hooks` 直下のファイルの内容を確認して承認した場合に限り、その項目の baseline を更新する。
- **K14**: machine の一覧・掃除（`list` / `gc` / `rm`）を提供する。
- **K15**: 初回の待ちを前倒しする `agent-vm prewarm` を提供する。自動 prewarm は行わない。
- **K16**: VM の claude は host と同じ公式 installer で導入し、bootstrap が未導入時だけ実行する。

### VM に配るもの（K17〜K22、2026-09-30 追記）

原則: host と共有するテンプレートには VM 分岐を入れない。VM との差分は `.chezmoiignore` の VM ブロックと `agent-vm/bootstrap.sh` の 2 か所だけで表す。共有部分に分岐を置くと、その分岐が host に影響しないことを毎回証明する仕組みが要るが、差分を VM 専用の場所に寄せれば host への影響が無いことは構造上明らかになる。

- **K17**: VM に配置・実行するものは `.chezmoiignore` の VM ブロック（`agent_vm` が真のときだけ有効）の allowlist で決める。`**` で全除外し、ターゲットパスの `!` 行で必要なものだけ戻す。script はファイル単位、それ以外は粗いディレクトリ単位で戻す。
- **K18**: VM 用のツール（apt の `jq` `bat` `fd-find` `ripgrep` `shellcheck`、mise、starship、bat / fd のリンク）は、host の `install-packages-1-linux` の代わりに bootstrap が apply の前に無いものだけ非対話で入れる。apt は推奨依存を入れず、postfix の debconf で止まる経路を避ける。
- **K19**: apply の後、bootstrap が走るたびに、`settings.json` から音声通知の hook を、`~/.claude.json` と `~/.codex/config.toml` から残す MCP（readability、context7、excalidraw。Claude はさらに playwright と chrome-devtools を残す。K23〜）以外を取り除く。変換は同じディレクトリの一時ファイル経由で行い、失敗したら元のファイルも `applied-hash` も変えない。取り除いた結果は、フィルタより緩い条件で自己検査し、残っていれば bootstrap を失敗させる。codex の後処理と自己検査の実装は、ADR-0019 で TOML の解釈に置き換えた。
- **K20**: host に影響が無いことは、VM が管理する対象と script の完全一致テスト（期待リストとの比較）と、VM ブロックを除いた `.chezmoiignore` の host 描画が変わらないことのテストで固定する。
- **K21**: 既存 VM への移行処理は作らない。古い構成の VM が残った場合は `agent-vm rm` で作り直す。
- **K22**: `install-claude-skills-11` を `run_onchange_after_` 帯へ改名し、mise が apm を入れた後に走らせる。ターゲット名と内容は変わらないので、既存の host では再実行されない。

### VM のブラウザ（K23〜K28、2026-10-01 追記）

VM の Claude から playwright と chrome-devtools の MCP を使えるようにする（`docs/plans/agent-vm/vm-browsers/spec.md` の K1〜K6）。VM から host へ向かう通信路は増やさず、VM ごとの容量増は dpkg の Installed-Size の合計で 40 MB 以下に収める。

- **K23**（spec K1）: ブラウザは VM の中で headless で動かし、host のブラウザは操作させない。人の閲覧は既存の host から VM への `localhost` 転送で行う。VM から host への通信路は作らない。
- **K24**（spec K2）: ブラウザ本体（linux-arm64 の headless shell）は、host の 0700 のストアに `@playwright/mcp` の版ごとに 1 部だけ置く。取得は `agent-vm fetch-browsers` が行い、`chezmoi apply`（darwin のみ）が呼ぶ。取得物のハッシュは repo に固定せず、取得直後の記録を複製の前に比べる方式（TOFU）にとどめる。
- **K25**（spec K3）: machine ごとの複製は launcher が APFS の clonefile で作り、専用のマウントで固定パスに見せる。ストアを直接マウントすると 1 つの VM の書き換えが他の VM に及ぶので取らない。複製の要否は host 側の記録で判定し、マウントの中身は解釈しない。古い世代は VM の稼働中には消さない。
- **K26**（spec K4）: VM 側の差分は `bootstrap.sh` と、同じディレクトリの VM 専用の jq フィルタに閉じる。K19 の残す MCP の定数を Claude 用と Codex 用に分け、Codex には playwright を残さない。
- **K27**（spec K5）: VM ごとの apt は、mesa を除いたブラウザの依存ライブラリとフォント 2 種に絞る。headless shell が要る `libgbm.so.1` だけは、apt から取り出して VM 専用のディレクトリに置く。`libgbm1` を apt で入れると 178 MB 増える。
- **K28**（spec K6）: 古い machine（マウントが無い）とブラウザの欠落は、害が出る場面で警告と回復手順を出す。どの場面でも起動は失敗させない。既存 machine への移行処理は K21 と同じく作らず、`agent-vm rm` で作り直す。

### 却下した代替案

- **通常 machine + bubblewrap**: 通常 machine は `/Users` 全体 rw と `mac` コマンドを持ち、bubblewrap で追加の隔離層を作っても、OrbStack 自体が持つ mount と host 到達性を打ち消せない。isolated machine が標準機能として同等以上の隔離を提供する。
- **Docker container**: agent が対話的に使うツールチェイン一式（mise、chezmoi、各言語ランタイム）を container image として保守するコストが、VM 全体を repo ごとに使い捨てる方式より高い。OrbStack の isolated machine は VM でありながら起動が軽く、この用途に対して container の利点が薄い。
- **共有 staging（machine 間で 1 つの staging を使う）**: 1 つの VM が staging を書き換えられると、他の VM もその内容を読み込む経路になる。machine ごとに staging を分けることで、VM 間の書き込み経路そのものをなくす。
- **repo 内の `.env` を秘密解決の対象にする**: repo は VM から書き換えられる。そこに任意の `op://` 参照を書かれると、host 側の認証済み `op` が無関係な秘密まで解決して VM に渡してしまう。解決対象を host 所有のファイル 2 つに固定することで、この経路を閉じる。
- **認証（Codex の `auth.json` など）を全 VM で共有する**: 1 つの VM の侵害が全 repo 分の認証に及ぶ。VM ごとに個別の認証を持たせることで、侵害の影響をその VM だけに閉じる。
- **長期 token（`claude setup-token` 等）を 1Password から毎回注入する**: 同じ token を全 VM の環境変数に載せることになり、1 つの VM の侵害で全 repo 分の資格情報が漏れる。VM ごとの初回ログインのほうが、Codex と手順がそろい、被害範囲も machine 単位に閉じる。
- **mkdir + pid によるロック**: stale lock の回収手順が競合を繰り返し生んだ。`flock(2)` は open file description に属し、保持するプロセスが落ちれば OS が自動で解放するため、回収手順そのものが要らない。

## Consequences

- **R1**: OrbStack の実際の挙動は、この設計を作った WSL 上のセッションでは検証できない。依存する挙動は V1〜V17 として mac 実機での確認に委ねる（`docs/agent-vm.md` の該当節）。launcher 自体のロジック（名前導出・引数組立・opt-out 判定・hash 比較・取り込みフィルタ・git 面検査）は `orb` / `op` を stub にした smoke test で Linux 上でも検証している。
- **R2・R3**: 1Password agent forwarding と OrbStack の組み合わせ（1Password の承認粒度、agent forwarding 自体の相性）は V3 で確認する。gitconfig を変更しないため、問題が起きた場合は VM 内の署名エラーとして顕在化し、黙って未署名にはならない。
- **R4**: 侵害された machine はその machine の認証を持ち出せるが、影響は machine 単位に閉じる。失効手順（claude.ai / ChatGPT のセッション管理からの取り消しと `agent-vm rm`）は `docs/agent-vm.md` に記載した。
- **R5**: 初回プロビジョニングの待ち時間は K5（mise 軽量セット）と K15（`prewarm`）で抑える。実測は V4 に委ねる。
- **R6**: VM 内の default user は passwordless sudo を持つが、isolated machine の外には及ばない。VM 内 root が書ける host パスは repo・staging・outbox・`browsers/<m>`（K25 のブラウザの複製）に限られ、いずれも元々 rw で渡している範囲と同じである。host は `browsers/<m>` の中身を実行も解釈もしない。
- **R7**: outbox からの取り込みは VM 由来のデータを host に書き込む唯一の経路である。通常ファイルの jsonl 以外と symlink を除外し、取り込み先を 2 箇所に固定し、既存ファイルへは先頭一致を確認した追記しか行わない設計にすることで、host 側の完全性を保っている。
- **R8**: K13 の git 面検査は事後検知であり、VM セッション実行中に host で同じ repo の git を使うと、検査の前に改変が実行されうる。この運用ルール（VM セッション中は host の git を使わない）は `docs/agent-vm.md` に明記した。完全な防止には `.git` を mount から外す必要があるが、それでは VM 内で commit できなくなり、オーダー（repo で作業する）を満たさない。
- **R9**: Codex 内蔵 sandbox（Landlock + seccomp）が OrbStack のカーネルで動くかどうかは V9 で確認する。動かない場合は VM 境界を sandbox とみなし、VM 内の Codex だけ `sandbox_mode` を緩める設定を別 plan とする。
- Phase 1 で意図的に提供しない体験（egress の許可リスト制御、mac クリップボード画像の貼り付け、1Password 以外の host 資格情報ストアとの連携）は spec.md に記録し、`docs/agent-vm.md` には現状の制約として明記した。
- **K17〜K22 の帰結**: drawio MCP と音声通知は VM には提供しない（playwright と chrome-devtools は K23〜K28 で提供する）。VM の中で手で `chezmoi apply` すると、次の bootstrap まで音声通知の hook と除外した MCP が戻る。codex の設定の自己検査は、`[mcp_servers]` の直下に `playwright.command = …` のようにネストした書き方を対象にしない（今のテンプレートは出力しない）。VM の mise と starship の installer は、host と同じくチェックサムで検証しない。
- **R21**: VM では APM の skills のうち、既定ブランチの解決が要る GitHub のリポジトリ（9 件中 5 件）が入らない。VM の `~/.gitconfig` の SSH への書き換えと、VM に GitHub のトークンを置かない設計の組み合わせが原因と推測している（推測。host で成功する理由は未検証）。今回の変更が原因ではなく、別の課題として `docs/agent-vm.md` に既知の制約として書いた。
- **R22**: VM の mise で `npm:@mizchi/readability` がサプライチェーン対策の閾値に拒否されて入らない。host と共有する設定の問題で、別の課題とする。`e4fd84a` で `allow_low_downloads` を指定して解消した。
- **K18 の帰結（dasel）**: VM は codex の設定のマージのために、ソースの `.mise.toml` を信頼して dasel を入れる。マージを dasel や mise に依存させない作り替えは host にも影響する別の課題とする。ADR-0019 でマージを chezmoi の TOML 関数に移し、VM はソースの `.mise.toml` を信頼しなくなった。
- **K23〜K28 の影響（ブラウザ）**:
  - `--isolate-network` を付けても、isolated machine 同士は IP で互いに届く（実機で確認、#200 で別に扱う）。docs の記述と食い違う既存の性質で、ブラウザの追加で生じたものではない。VM のブラウザは、ほかの VM が `0.0.0.0` に bind したサービスに届きうる。loopback に bind したサーバーは、loopback の性質上 IP では届かないと考えられるが、VM 間では確かめていない。
  - mac の `localhost:<port>` は、同じポートを複数の machine が使うと、先に bind した machine に届く。これは OrbStack の転送の既存の性質で、`docs/agent-vm.md` に注意を書いた。
  - VM の Codex にはブラウザの MCP を提供しない。利用頻度が低いため別 issue とし、代わりに同じ VM の Claude を使う。
  - VM の MCP の引数（headless と実行パス）は、host と共有するテンプレートに VM 分岐を入れず、bootstrap の jq の後処理で設定している。

## Amended by

- `docs/plans/dependency-update-paths/spec.md` (2026-10-01) — K22 の script は `run_after_10-install-apm-skills`（ADR-0017 の 10- 帯）になった。K22 本文の「ターゲット名と内容は変わらない」はこの改名で上書きされる。VM では APM の失敗を marker にせず WARNING に留める。R21 の状態では apm 0.31 が exit 1 を返し、verifier が毎回の bootstrap を止めるためである
- `docs/plans/dependency-update-paths/spec.md` (2026-10-01) — K5 の軽量セットはテンプレートの条件分岐ではなくファイルの配置で実現するようにした。host 専用のツールチェーンは `~/.config/mise/conf.d/host-toolchains.toml` に分け、VM には配置しない。これに伴い K17 の allowlist のうち mise だけはディレクトリ単位（`!.config/mise/**`）からファイル単位（`!.config/mise/config.toml`）になった。`.chezmoiignore` の除外（`!`）は後続の無視行より優先されるので、同じディレクトリの一部だけを VM から外すにはファイル単位で戻すしかない
- `docs/plans/agent-vm-gh-token/spec.md` (2026-10-01) — gh の token は K7（全 VM 共通の長期 token は注入しない）の例外として、repo ごとの fine-grained PAT を tool の起動時に `GH_TOKEN` で注入する。token は repo ごとに分かれ、権限は pull_requests / issues の write と contents / actions の read に絞る。残るリスクは、VM の中の agent が期限（Personal 90 日、Formal 30 日）まで token を読めることである。R21 は bootstrap の話なので変わらない
- `docs/decisions/0021-agent-vm-golden-clone.md` (2026-10-02) — repo 用の machine は `orb create` ではなく、bootstrap 済みの golden machine（`agent-vm-golden`）の clone で作る。K1 の「repo ごとの isolated machine」という境界は変わらない。R5 の初回の待ちは、最初の 1 台（golden の作成）を除いて 6 秒になる
- #194 (2026-10-02) — R21 の原因は「既定ブランチの解決」ではなく、`https://github.com/` を SSH に書き換える `insteadOf` だった。VM の SSH は転送された agent の承認を毎回要し、承認のない取得は拒否されるか止まる（`git://` への書き換えも VM からは届かない）。VM の `~/.gitconfig` では取得の書き換えを外し、`url."git@github.com:".pushInsteadOf` だけを残す。取得は匿名の HTTPS、push は SSH になり、VM に GitHub の token を置かない方針は変わらない。ただし、上流の frontmatter が読めない `mizchi/explainer` が lockfile のない VM で `apm install` 全体を中止させ、private の `berlysia/shiori` も token なしでは取れないので（#231）、APM の失敗を WARNING に留める扱いは続く

## References

- `docs/plans/agent-vm/spec.md` / `research.md` / `plan-1.md` / `plan-2.md` / `plan-3.md` / `plan-4.md`
- `docs/plans/agent-vm/vm-browsers/`（K23〜K28 の spec / research / plan-1〜3）
- `docs/agent-vm.md`（導入ガイド、mac 実機検証項目 V1〜V23）
- `home/dot_local/bin/executable_agent-vm`, `agent-vm/cloud-init.yaml`, `agent-vm/bootstrap.sh`, `home/dot_shell_common/agent_vm.sh`
- https://docs.orbstack.dev/machines/isolated
