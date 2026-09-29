# Spec: agent-vm に配る dotfiles を allowlist にする

## Goal

agent-vm の isolated machine で、`chezmoi apply` が VM に必要なものだけを配置・実行し、初回 bootstrap が非対話のまま最後まで通るようにする。

## Experience Delta

- 変更前: 新規マシンの初回起動は、`jq` が無いため `run_before_10-validate-json-templates-unix` で rc=1 になる。jq を補っても、host 用の apt 一覧に含まれる何らかのパッケージの推奨依存で postfix が入り、その debconf ダイアログで永久に止まる。VM には emacs、音声ライブラリ、distill-insights、MCP の launchd 用依存など、host 専用のものも入る。さらに、完走しても APM の skills は初回に入らない（`install-claude-skills-11` が mise より先に走って `exit 0` し、実行済みとして記録される）。
- 変更後: 新規マシンの初回起動は、VM 用のツールの導入から claude / codex の起動まで非対話で完了し、APM の skills も初回から入る。VM で配置・実行されるのは allowlist に載ったファイルと script だけで、音声通知の hook とブラウザ・GUI を要する MCP は VM の設定から取り除かれる。host と共有するテンプレートの中身には VM 分岐を入れないので、host で `chezmoi apply` したときの描画結果と実行結果は変わらず、再実行される script も無い（host 側のソースで変わるのは、host では何も出力しない `.chezmoiignore` の VM ブロックと、内容とターゲット名が同じ K22 の改名だけである）。

## Architecture

**原則: host と共有するテンプレートには VM 分岐を入れない。VM との差分は、VM の入口（`agent-vm/bootstrap.sh`）と `.chezmoiignore` の VM ブロックの 2 か所だけで表す。**

```
host の chezmoi source（git 追跡ファイル全体を staging に複製: K2、変更なし）
   │
   ▼ VM 内 bootstrap.sh（launcher との引数の契約は変わらない: BOOTSTRAP_CONTRACT=1 のまま）
   ├─ [新] VM 用ツールの導入（K18）… apt（jq ほか）、mise、starship、bat/fd のリンク。無いものだけ非対話で入れる
   ├─ claude の導入（K16、変更なし）
   ├─ chezmoi init --apply
   │     data: agent_vm = true（/etc/agent-vm、K4 の data キーは 1 つのまま）
   │     .chezmoiignore の VM ブロック（[新] K17）… `**` で全除外し、`!` で要るものだけ戻す
   │     戻したテンプレートは host と同じ内容で描画される（mise の既存分岐 K5 だけが例外）
   ├─ [新] VM 用の後処理（K19）… settings.json から音声通知の hook を、~/.claude.json と
   │     ~/.codex/config.toml から「残す MCP」以外を取り除き、結果を自分で検査する。bootstrap のたびに走らせる
   └─ applied-hash の記録（後処理が成功した後）
```

この原則を採る理由は、共有部分（テンプレート）に VM 分岐を置くと、その分岐が host に影響しないことを毎回証明する仕組み（ガード記法、描画の比較、分岐の一覧）が要るからである。差分を VM 専用の場所に寄せれば、host と共有するテンプレートの中身は変わらないので、host への影響が無いことは構造上明らかになる（`.chezmoiignore` の VM ブロックだけは K20 で検査する）。VM で起きることは `bootstrap.sh` を読めば追え、既存の `tests/agent-vm/run-bootstrap.sh` の流儀でテストできる。

VM で dotfiles 由来のものが起動される経路は、settings.json に登録された hook、chezmoi の script、Claude が使う skills とプラグインの 3 つである。script は K17 の allowlist で、hook は K19 の後処理で VM 用に絞る。skills とプラグインは、ユーザー判断により host と同じに持ち込む。

受け入れる非対称: host に今後足すもののうち、トップレベルの新しいパスと新しい script は VM に入らない。MCP サーバーも、K19 で「残す 3 キー」以外を取り除くので VM に入らない。一方、`~/.claude/**` などの戻したディレクトリの中に足したファイルは VM にも置かれ、host 専用の hook を新しく登録するとそれも VM で登録される。そうした hook を VM で外すには、K19 の除去対象に足す。

## Alternative Approaches (Greenfield View)

### 差分最小案 (Incremental)

denylist を増やす。jq を cloud-init に足し、host 用 apt 一覧に `DEBIAN_FRONTEND=noninteractive` を付け、問題の出た script（validate、gc、distill、textlint、root-deps、refresh-go）と音声 hook・MCP に `agent_vm` ガードを個別に足す。差分は小さいが、host 側に今後足した script や設定は、ガードを付け忘れる限り黙って VM に入る。今回の 2 件（jq、postfix）はどちらも「付け忘れ」の型の不具合である。

### 白紙設計案 (Greenfield)

VM 専用の最小構成を dotfiles とは別に持つ（例: `agent-vm/home/` に VM 用ファイルだけを置き、bootstrap が rsync する）。起源: 隔離境界の中身は「明示的に持ち込んだものだけ」にするのが隔離の原則であり、host と VM で同じ source を共有する必然性はない。ただし、ユーザー判断により hooks・指示・プラグイン・skills は host と同じにする。それらは chezmoi のテンプレートと script（`update-settings-json` による合成、`install-claude-plugins-8`、`sync-skills`）で生成されるので、別系統にすると生成ロジックごと複製することになる（hooks だけで `home/dot_claude/hooks/implementations` と `lib` の 60 ファイルを超える）。

### 採用案と理由

同じ source を使いつつ、VM では `.chezmoiignore` の allowlist で「明示的に戻したものだけ」にし、VM 固有の差分はすべて bootstrap に置く。

- 隔離の原則（既定で持ち込まない）は白紙案と同じく満たせる。host に足したトップレベルのパスと script は、allowlist に載せない限り VM に入らない。
- hooks・settings・プラグイン・skills の生成は、chezmoi の source をそのまま使うので複製が要らない。
- 共有テンプレートに VM 分岐を入れる案（この spec の Round 1〜3 の版）は、JSON のカンマ、`{{-` の空白の削り方、分岐の一覧と、host 不変の証明の仕組みが膨らみ続けた。差分を bootstrap に寄せる版では、その仕組みがそもそも要らない。代わりに失うのは「VM では最初から作らない」という性質で、hook と MCP は「作ってから消す」になる（K19 の不変条件と R17 で扱う）。
- `.chezmoiignore` で allowlist が組めることは、chezmoi v2.72.1 で実験して確認した（`**` による全除外、`!` による再包含、script は属性を除いた名前でマッチ）。

## Key Decisions

- **K17: VM に配るものを `.chezmoiignore` の allowlist で決める** — `agent_vm` が真のときだけ有効なブロックを `.chezmoiignore` の末尾に足し、`**` の後に `!` で必要なものを戻す。このブロックの中は**ターゲットパスだけ**で書く（同じファイルの既存行には `dot_claude/...` のようなソース名の行もあるが、それらは真似しない）。戻す単位は、実行されるもの（script と `~/.local/bin` の実行ファイル）はファイル単位、それ以外は粗いディレクトリ単位とする。ユーザー判断により、hooks・CLAUDE.md・rules・agents・commands・templates・プラグイン・skills（private-skills を含む）・safe-chain・statusLine・worktree 系の小道具・starship の設定は host と同じに持ち込む。
  - 参照: `home/.chezmoiignore:30-38`（既存の OS 別ブロック）
  - 参照: `home/.chezmoi.toml.tmpl:10`（`agent_vm` の導出）
  - 戻すターゲット: `.bashrc`、`.bash_profile`、`.zshenv`、`.zsh/**`、`.shell_common/**`、`.gitconfig`、`.gitconfig_gpg_ssh`、`.config/git/**`、`.config/mise/**`、`.config/starship.toml`、`.config/ccstatusline/**`、`.config/uv/**`、`.config/pnpm/**`、`.npmrc`、`.yarnrc.yml`、`.aikido/**`、`.apm/**`、`.claude/**`、`.codex/**`、`.local/bin/{hook-timing,workflow-cli,git-worktree-create,git-worktree-cleanup,claude-task-list-id}`、`.local/share/private-skills/**`
  - パッケージマネージャの設定（`.config/uv`、`.config/pnpm`、`.npmrc`、`.yarnrc.yml`、`.aikido`）を戻す理由: 中身はどれもサプライチェーン対策（公開から 7 日未満のパッケージを入れない、`ignore-scripts=true`）で、VM 内でエージェントが依存を入れる場面こそ効かせたい。秘密情報は含まない（`modify_private_dot_npmrc` は既存の `_authToken` を**配置先から**引き継ぐだけで、新しい VM では何も引き継がない）。
    - 参照: `home/dot_config/pnpm/rc`、`home/dot_yarnrc.yml`、`home/dot_config/uv/uv.toml`、`home/dot_aikido/config.json`、`home/modify_private_dot_npmrc`
  - 戻す script（10 本、属性と `.tmpl` を除いたターゲット名。期待リストとの完全一致テストもターゲット名で比べる）: `install-packages-0-prepare.sh`、`00-install-mise-tools.sh`、`10-install-hook-deps.sh`、`zz-verify-provisioning.sh`、`update-settings-json.sh`、`update-claude-json.sh`、`install-claude-plugins-8.sh`、`install-claude-skills-11.sh`（K22 で移動後も同じターゲット名）、`sync-skills.sh`、`install-safe-chain.sh`
  - 戻さない script（根拠）: `install-packages-1-linux`（host 用の apt 一覧を入れる。VM 用のツールは K18 で bootstrap が入れる）、`10-validate-json-templates-unix`（テンプレートの lint。host で担保済み）、`gc`（host の `.tmp/sessions` の整理）、`10-install-root-deps`（launchd の MCP 用）、`10-install-textlint-deps`、`refresh-go-latest-tools`（VM には go ツールが無い: K5）、`register-distill-insights-schedule`（host の定期ジョブ）。linux では中身が空になる script（`install-packages-1-darwin`、`reload-mcp-launchd`、`install-wsl-notify-send`、Windows 用の `.ps1` の `install-packages-0-prepare-windows`・`install-packages-1-windows`・`install-packages-7-windows`・`10-validate-json-templates-windows`）も、戻さないので既定どおり除外される。
  - 受け入れる副作用: 再包含が勝つので、既存の除外（先頭の `*.md`、`**/*.test.ts`、`dot_claude/hooks/scripts/test_*` など）は、戻したディレクトリの中では VM で効かない。どれも実行されないファイルである。
  - VM に戻さなくても VM で使われるもの: `sync-skills` は chezmoi のソース側の `.skills/`（`{{ .chezmoi.workingTree }}/.skills`）を読む。これはターゲットではなく、bootstrap が staging から rsync するソースの一部なので、allowlist の対象外である（K2 の staging に含まれ続ける必要がある）。
  - `only_private` の hook（discord / slack の通知）: `only_private` はホスト名が CITRINE / BIXBITE のときだけ真で、VM のホスト名はマシン名（`agent-…`）なので、VM では最初から登録されない（`home/.chezmoi.toml.tmpl:9`）。
  - 受け入れる露出: `private-skills` は forwarded SSH agent で clone される。VM はもともと agent を使えるので新しい権限ではないが、非公開 repo の中身を VM に置くことになる（`--isolate-network` は外向きのインターネットを塞がない）。ユーザー判断（skills は host と同じ）として受け入れる。
  - host への影響: VM ブロックは `{{- if dig "agent_vm" false . }}` の行で始まり `{{- end }}` の行で終わる 1 つのブロックで、`agent_vm` が偽またはキーが無いときは何も出力しない。
- **K18: VM 用のツールは bootstrap が chezmoi の適用前に入れる** — host の `install-packages-1-linux` が担っていることのうち、VM で要るものを bootstrap の 1 つの関数にまとめる。どれも「無ければ入れる」形で冪等にする。
  - apt: `jq`、`bat`、`fd-find`、`ripgrep`、`shellcheck`。host の一覧のうち入れないものは、cloud-init がすでに入れるもの（`git`、`curl`、`build-essential`、`unzip`、`zsh`）か、host でしか使わないもの（`age`、`wget`、`emacs`、`libnotify-bin`、`pulseaudio-utils`、`dunst`、`patchutils`、`sox`）である。`dpkg -s` で入っていないものだけを、`sudo apt-get update` の後で `sudo DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends` で入れる（`sudo` は環境をリセットするので、変数は `sudo` の後ろに置く）。jq は、apply の中で `install-claude-plugins-8`（jq で登録済みかを判定する）と `update-*-json`（jq で合成する）が使い、K19 の後処理も使う。`ripgrep` と `shellcheck` は host と同じ作業（検索、hook の quality-loop）のため。一覧は `bootstrap.sh` の中の定数とし、環境変数や staging のデータからは読まない。
  - mise: `~/.local/bin/mise` が無ければ `https://mise.run` の installer で入れる。`00-install-mise-tools` は mise が無いと exit 1 になるので、apply より前に要る。シェルの初期化も `~/.local/bin/mise` を見る。
  - starship: 無ければ `https://starship.rs/install.sh` の installer で `~/.local/bin` に入れる（シェルの初期化は starship が無くても動くが、host と同じプロンプトにするため）。
  - installer は、パイプで直接 `sh` に流さず、いったん一時ファイルに落としてから実行する。途中で切れたダウンロードが部分的に実行されるのを避けるためである。URL は `bootstrap.sh` の中の定数とする。
  - dasel（ソースの rsync の後、apply の前）: VM の中の chezmoi のソース（`~/.local/share/chezmoi`）の `.mise.toml` を `mise trust` し、そのディレクトリで `mise install dasel` を実行する。codex の設定のテンプレート（`home/dot_codex/private_config.toml.tmpl`）は、配置先がすでにあるとき（2 回目以降の apply）に `merge-config.ts` でマージし、その処理は「dasel などのツールを mise に解決させるため」working tree に移動してから dasel を呼ぶ。host では開発者がリポジトリの `.mise.toml` を信頼して `mise install` 済みなので通るが、VM では dasel が無く、dotfiles を変えた後の再 bootstrap が必ず失敗する（2026-09-30 の実機検証の R20 で観測）。dasel を mise のインストール先に入れるだけでは足りない（実機で確認）。`merge-config.ts` は最初に `which dasel` で mise の shim を見つけ、shim は working tree の未信頼の `.mise.toml` を読んでエラーになるためである。VM でも host と同じく「リポジトリの `.mise.toml` を信頼し、そこから dasel を入れる」状態にする（実機で、この手順の後に codex の設定の apply が rc=0 で通ることを確認した）。信頼の対象は VM 自身が持つソースの複製で、信頼の記録は VM の中の mise の状態にだけ残り、rsync は host から VM への一方向なので VM の外には及ばない。ただし中身は host が作ったもので、host が今後 `.mise.toml` に `[env]` や `[tasks]` を足せば、それも VM で有効になる（host の chezmoi の script を VM で走らせるのと同じ信頼の水準）。ファイルが rsync で書き換わった後も信頼が保たれるかは未確認で、毎回の bootstrap で信頼し直す。`.mise.toml` の他の道具（`actrun`）は入れない（dasel だけを指定して install する）ので、そのディレクトリで mise を呼ぶと「未導入の道具がある」という警告が出うるが、想定内である。この手順は初回の bootstrap でも走り（初回は dasel を使わない）、ネットワークへの依存が 1 つ増えるが、冪等なので、2 回目以降の apply に確実に間に合わせるために毎回走らせる。これは、codex の設定のマージが開発用ツール（dasel）に依存しているという既存の構造への対処で、マージを dasel や mise に依存させない作り替えは host にも影響する別の課題とする。
    - 参照: `home/dot_codex/private_config.toml.tmpl`（`cd to working tree so mise can resolve .mise.toml and find tools like dasel`）、`home/dot_codex/private_dot_merge-config.ts:16-38`（dasel の探し方）、`.mise.toml:9`（`dasel = "latest"`）、`agent-vm/bootstrap.sh` の rsync と `chezmoi init --apply`
  - bat / fd: Ubuntu のパッケージは `batcat` / `fdfind` という名前で入るので、`~/.local/bin/bat` / `~/.local/bin/fd` のシンボリックリンクを host の script と同じ形で作る。
  - これらは host の `install-packages-1-linux` の対応物であることを関数のコメントに書き、テストで「VM の apt 一覧は `packages.linux.apt` の部分集合である」「mise と starship の導入元 URL が host の script と同じである」を確かめる。
  - 失敗したら非 0 で終わり、`applied-hash` を書かないので、次回起動で再試行される（K16 と同じ扱い）。launcher との引数の契約は変わらないので `BOOTSTRAP_CONTRACT` は 1 のままにする。
  - cloud-init には足さない。cloud-init はマシン作成時にしか走らず、既存マシンに届けるには bootstrap 側が必要になるので、2 か所の同期を避けて bootstrap に一本化する。
  - 参照: `home/.chezmoiscripts/run_onchange_install-packages-1-linux.sh.tmpl:8-39`（対応する host の処理）
  - 参照: `agent-vm/bootstrap.sh:25-37`（claude 導入の冪等パターンと PATH）
  - 参照: `home/dot_shell_common/init.sh:81`、`home/dot_zsh/dot_zshrc:42`（mise と starship のガード）
- **K19: apply の後に VM 用の後処理をかける** — 後処理は `agent-vm/` 配下の 3 つのプログラムで、bootstrap が apply の直後、`applied-hash` を書く前に、**bootstrap が走るたびに**実行する。書き込みは対象と同じディレクトリの一時ファイルに出し、元のファイルのモードを引き継いでから `mv` で置き換える（`~/.claude.json` はトークンを含みうるので 600 のまま保つ）。変換が失敗したら一時ファイルを消して非 0 で終わり、元のファイルは変わらず、`applied-hash` も書かれない。
  - `~/.claude/settings.json`（jq）: `hooks` の中から、`command` が `/.claude/hooks/implementations/speak-notification.ts` の直後に空白か引用符が続く文字列を含む hook を取り除き、hook が空になった matcher のまとまりと、まとまりが空になったイベントも取り除く。`hooks` 以外のキー（`enabledPlugins`、`permissions` など）には触れない。
  - `~/.claude.json`（jq）: top-level の `mcpServers` を `readability`、`context7`、`excalidraw` のキーだけに絞る（キー名の完全一致の allowlist）。3 つとも `update-claude-json` のテンプレートが定義する MCP で、excalidraw は URL で接続する http 型である。`mcpServers` 以外のキー（project スコープの `projects[...].mcpServers` を含む）には触れない。
  - `~/.codex/config.toml`（awk）: `[mcp_servers.<名前>]` とその下位の表のうち、名前が同じ allowlist に無いものを、次の表見出し（`[…]` または `[[…]]`）の手前まで取り除く。見出しの名前は、引用符付き（`[mcp_servers."x"]`）と前後の空白も扱う。codex の設定は TOML で jq では扱えず、VM には TOML を書き換える道具が無いので、Ubuntu の既定の awk（mawk）で動く書き方にする。host の codex 設定は context7、playwright、readability を定義し、VM では playwright が取り除かれる。扱わない書き方は、ドット区切りのキー（`mcp_servers.x.command = …`）とインライン表（`mcp_servers = { … }`）で、今のテンプレート（`home/dot_codex/.config.toml`）はどちらも出力しない。テンプレートがこれらの書き方に変わった場合は、自己検査が止める（下記）。
  - 残す MCP の一覧（`readability`、`context7`、`excalidraw`）は `bootstrap.sh` の 1 つの定数に置き、jq（`--args`）、awk（`-v`）、自己検査の 3 か所にそこから渡す。3 か所で一覧がずれないようにするためである。
  - 自己検査: 後処理の後に bootstrap 自身が次を確かめ、外れたら非 0 で終わる。hook-timer の包み方が変わったり script が改名されたりして後処理が何も取り除かなくなった場合に、黙って成功しないようにするためで、除去と同じ厳密な条件ではなく、よりゆるい条件で探す（除去の条件と同じ理由で見逃さないように）。
    - settings.json のどこにも `speak-notification` という文字列が無い。
    - `~/.claude.json` の top-level `mcpServers` のキーが、残す一覧に含まれるものだけである。
    - codex の設定に、行頭の空白を除いて `mcp_servers` で始まる行（見出し・ドット区切りのキー・インライン表のどれでも）のうち、`mcp_servers.` の直後（引用符を挟んでもよい）の名前が残す一覧の名前と完全に一致しないものが無い（`[mcp_servers]` という空の親見出しだけは許す）。値の中に残す名前が現れるだけの行（`mcp_servers.x.command = "context7"` など）は一致とみなさない。
    - 自己検査が保証するのは「残す一覧の外のものが無い」ことだけで、「3 つが残っている」ことは保証しない。後者は実機検証の接続確認で見る。
  - 不変条件: 後処理が「bootstrap のたびに」走ることが正しさの前提である。`update-settings-json` は `hooks` を丸ごと書き換え、`update-claude-json` は MCP を追記し、codex の設定もテンプレートから作り直されるので、再生成されるたびに取り除いたものが戻る。bootstrap は dotfiles が変わったときに走り、そのとき apply と後処理が必ず続けて走る。apply が失敗すると後処理は走らないが、`applied-hash` が書かれず、launcher は bootstrap の失敗で止まって claude を起動しない（`tests/agent-vm/run.sh:180-184`）ので、絞られていない設定で claude が動くことは無い。
  - 参照: `home/.chezmoiscripts/run_onchange_update-settings-json.sh.tmpl:36-41,97-98`（hook-timer による包み方と、`hooks` の丸ごと置き換え）
  - 参照: `home/.chezmoiscripts/run_onchange_update-claude-json.sh.tmpl:118-120`（`mcpServers` の追記型マージ）
  - 参照: `home/dot_claude/.settings.hooks.json.tmpl:198,220`（speak-notification の登録）
  - 参照: `home/dot_codex/.config.toml:9-20`（codex の MCP 定義）
- **K20: host への影響が無いことを 2 つの検査で固定する** — host のテンプレートは変えないので、検査は次の 2 つで足りる。
  1. `.chezmoiignore` を `agent_vm=false`、および `agent_vm` キー無しで描画した結果が、VM ブロック（開始行から `{{- end }}` の行まで）を取り除いたテンプレートの描画とバイト単位で一致する。
  2. 管理対象の比較: VM（`agent_vm=true`、linux）で `chezmoi managed --include all` した結果が期待リストと一致し、host（`agent_vm=false`、linux）では host 専用のもの（`.chezmoiscripts/gc.sh`、`.config/emacs` など）が含まれる。比べるときは、粗く戻すディレクトリの中身を根元の 1 行にまとめる。期待リストは allowlist と同じ粒度に保たれ、`~/.claude` などにファイルを足すたびに更新する必要はない。
  - 既存の mise の分岐（K5）とそのテスト（`tests/agent-vm/run-templates.sh:48-54`）は変えない。
- **K21: 既存 VM への移行処理は作らない** — この PR はまだマージされておらず、これまでに作られた VM は今回の実機検証で作って削除した 2 台だけである。移行処理の対象が存在しない。今後、何らかの理由で古い構成の VM が残った場合（例: 初回 bootstrap が途中で止まって dpkg が中断状態になった VM）は、`agent-vm rm` で作り直す。この手順を `docs/agent-vm.md` に書く。
- **K22: `install-claude-skills-11` を配置後の帯へ移す** — `run_onchange_install-claude-skills-11.sh.tmpl` を `run_onchange_after_install-claude-skills-11.sh.tmpl` に改名する。現状では mise（apm を入れる）より前に走り、apm が無いと `exit 0` で終わって「実行済み」と記録されるので、新しいマシンでは `apm.yml` が変わるまで APM の skills が入らない。`run_after_` 帯は `00-install-mise-tools` の後に名前順で走るので、apm が入った後に実行される。後続の `sync-skills`（`run_after_`）は名前順でさらに後に走るので、skills の導入 → 同期の順も保たれる。master の ADR-0017 が safe-chain を同じ理由で `run_onchange_after_` に移したのと同じ直し方である。
  - host への影響は無い: chezmoi は `run_onchange_` の実行記録を「ターゲット名 + 内容の SHA256」で持つ（公式ドキュメント「developer-guide/architecture」）。改名してもターゲット名（`install-claude-skills-11.sh`）と内容は変わらないので、既存の host では再実行されない。
  - VM での前提: この script は `command -v apm` で apm を探し、mise を自分では有効にしない。VM では bootstrap が PATH の末尾に `~/.local/share/mise/shims` を足しているので、`00-install-mise-tools` が apm を入れれば shim 経由で見つかる。
  - 参照: `home/.chezmoiscripts/run_onchange_install-claude-skills-11.sh.tmpl:5,14-18`
  - 参照: `docs/decisions/0017-provisioning-after-deploy.md`
  - 参照: `agent-vm/bootstrap.sh:30`（PATH への shims の追加）

## Risks

- **R10**: allowlist の戻し忘れで、VM の中で hook や skill が欠ける → K20 の管理対象の比較テストと、実機での初回 bootstrap の完走確認で検出する。
- **R11**: script 名を属性付きのソース名で書くと、マッチせずに黙って除外される（実験で確認済み）→ K20 の比較に script の一覧も含める（`chezmoi managed --include all`）。
- **R12**: `chezmoi managed` は、中身が空になるテンプレートも一覧に出すので、apply で実際に走る集合とずれる → 戻す 10 本はどれも `ne windows` の条件で linux では中身を持つことを、テンプレートの先頭行で確認した。apply で実際に走ったかは、実機検証で apply のログと突き合わせる。
- **R13**: 戻したディレクトリの中にある、実行されないファイル（テスト用ファイル、`.md`、音声用のファイル）も VM に置かれる → 実行経路（hook 登録と script）を K17 と K19 で絞るので、受け入れる。
- **R14**: postfix を持ち込んだパッケージは特定していない。VM では host 用の apt 一覧を入れず、K18 の 5 つを推奨依存なしで入れるので避けられる見込みだが、未確認 → 実機検証で `dpkg -s postfix` が「未導入」を返すことを確かめる。
- **R15**: 新しい VM での `mise install` が、`github:` バックエンドのツール（apm、safe-chain など）で GitHub の未認証レート制限に当たると、`00-install-mise-tools` は警告だけで先に進み、apm や safe-chain が黙って欠ける（未確認の推測）。apm が欠けると、K22 の skills の script も `exit 0` で終わって実行済みと記録される → 実機検証で `mise ls --missing` が空であること、`command -v apm` が見つかること、`~/.apm` 配下に `apm install -g` の結果（lock ファイル）があることを確かめる。
- **R16**: agent-vm の CI（`.github/workflows/ci-agent-vm.yml`）は path フィルタで起動し、今回触る `home/.chezmoiignore` を含まない（しかも rebase で古い script 名を指したまま）→ `home/.chezmoiignore`、`home/.chezmoiscripts/**`、`home/.chezmoidata/**` を push / pull_request の両方に加える（`.chezmoidata` は K18 の部分集合テストのため）。
- **R17**: VM の中でエージェントや利用者が手で `chezmoi apply` し、しかもテンプレート側に変更があった場合、次の bootstrap までは音声通知の hook と取り除いた MCP が戻る。戻るのは鳴らない音声 hook と起動に失敗する MCP で、害は小さい → `docs/agent-vm.md` に書く。
- **R18**: K19 の MCP の絞り込みは、VM の中で user スコープ（`~/.claude.json` の top-level `mcpServers`）や codex の設定に足した MCP も、次の bootstrap で取り除く。`claude mcp add` の既定のスコープは project 単位で、`projects[...]` の下に書かれるので対象外 → 意図した挙動として `docs/agent-vm.md` に書く。
- **R20**: 後処理で中身を変えた `~/.codex/config.toml` は chezmoi の管理対象なので、次の apply で描画結果との差分になる。bootstrap の apply は `--force` 付きなので確認なしに上書きし、その後にまた後処理がかかる → 実機検証の 2 回目の bootstrap（dotfiles を 1 か所変えて起こす）で、止まらずに通ることを確かめる。
- **R21**: VM では APM の依存のうち、既定ブランチの解決が要る GitHub のリポジトリ（9 件中 5 件）が `refs/heads/.invalid` で失敗する（2026-09-30 の実機で観測、再現あり）。VM の `~/.gitconfig` の `url."git@github.com:".insteadOf https://github.com/` を無効にすると公開リポジトリは入るので、この書き換えと、VM に GitHub のトークンを置かない設計の組み合わせで apm 0.13.0 が失敗していると推測する（host で成功する理由は未検証）。今回の変更（K22）が原因ではなく、K22 により apm は初回に実行されている → 別の課題として扱い、`docs/agent-vm.md` に既知の制約として書く。
- **R22**: VM の mise で `npm:@mizchi/readability` がサプライチェーン対策（週間ダウンロード数の閾値）に拒否されて入らない。host と共有する mise の設定の問題で、今回の変更が原因ではない → 別の課題として扱う。
- **R19**: mise と starship の installer は、固定されていないスクリプトをネットワークから取得して実行する。host の `install-packages-1-linux` と同じ取得元・同じ信頼である。ただし VM には forwarded SSH agent があるので、installer が汚染されていれば、承認済みの間は agent の鍵も使われうる → 取得元と信頼は host と同じなので受け入れる。途中で切れたダウンロードの実行だけは K18 で避ける。

## Phase 1 で意図的に提供しない体験

### VM 内でのブラウザ操作（chrome-devtools / playwright の MCP）

- **代替経路確認**: `docs/agent-vm.md` 9 節の V8（mac の `localhost:<port>` または `<machine>.orb.local` から VM 内の dev server に到達できるか）は未検証。VM 内にブラウザを入れる経路も未実装。
- **非提供対象**: VM 内の Claude がブラウザを操作する MCP（chrome-devtools、playwright）。Web フロントエンド開発での画面確認がしにくくなる（ユーザーからの懸念として記録）。
- **将来の予定**: 別の plan で扱う。候補は (a) VM 内に headless Chromium を入れて playwright MCP を VM で有効にする（K19 の残すキーに加える）、(b) V8 を検証して mac のブラウザから確認する。

### VM からの完了通知（音声・デスクトップ通知）

- **代替経路確認**: 通知は host の音声・通知基盤（`home/dot_claude/lib/unified-audio-engine.ts`）に依存し、VM には届かない。
- **非提供対象**: VM 内のセッションの Stop / Notification 時の音声通知。
- **将来の予定**: 必要になれば、outbox 経由で host に通知を渡す仕組みを別途検討する。

### 本物の VM での apply を CI で自動実行すること

- **代替経路確認**: `tests/agent-vm/run-bootstrap.sh` は chezmoi と claude を stub にしており、apply の中身は検査しない。本物の apply には sudo、apt、ネットワーク、mise のダウンロードが要る。
- **非提供対象**: CI 上で Ubuntu コンテナに対して bootstrap と apply を実際に走らせる自動テスト。
- **将来の予定**: 今回は実機検証（plan-1 の最終タスク）で代える。今回の発見（前提ツールの欠落、対話プロンプト）の型が再発するようなら、CI ジョブとして追加を検討する。

## ISO 25010 次元選択

- **機能適合性（機能完全性）**: VM に必要なもの（hooks、settings、MCP 3 種、プラグイン、skills、git 署名）がすべて揃うこと。
- **信頼性（回復性・可用性）**: 非対話で bootstrap が完走すること、ツールの導入や後処理の失敗で次回に再試行されること、後処理が毎回走ること。
- **互換性（共存性）**: host の結果が変わらないこと（K20）。既存の host で再実行される script が無いこと（K22）。
- **保守性（試験性・修正性）**: 今後 host に足したトップレベルのパス・script・MCP が VM に入らないこと。VM 固有の処理が bootstrap に集まり、単体でテストできること。
- **対象外**: 性能効率（初回時間は V4 として実機検証で記録するが、合否の基準は置かない。目的は完走で、速度ではない）、セキュリティ（隔離の仕組み自体は変えない。持ち込むものは減る方向で、増えるものは無い。private-skills の露出は K17、installer の取得は R19 で受け入れた）、使用性（利用者の操作は変わらない）。

## 成果物（コード以外）

- `docs/decisions/0018-agent-vm-orbstack.md` に K17〜K22 を追記する（spec は承認時の原本として `docs/plans/agent-vm/` に固定されているので、ADR を最新の記録とする）。
- `docs/agent-vm.md` の 1 節に VM が受け取るもの、6 節に `agent-vm rm` による作り直し（K21）と、手で apply したときの戻り（R17）・user スコープの MCP（R18）、9 節に実機検証の結果を書く。forwarded agent が private-skills 以外の鍵も使わせることも 2 節に一言書く。
- PR #191 の本文（ADR のパス、実機検証の結果、今回の変更）を更新する。

## Approval

- Plan Status: complete
- Review Status: pass
- Approval Status: approved

## Reviewer Outputs (Round 1)

### logic-validator
- verdict: needs-work
- 主指摘: K18 の hooks 変更はカンマの扱いを書いておらず、そのままでは JSON が壊れると読める（→ 具体形を明記）。K20 の「update-* も apt より先に走る」は誤りで、先に走るのは install-claude-plugins-8 だけ（→ 根拠を修正）。install-claude-skills-11 は mise より前に走って初回に skills が入らない（→ K22 を追加）。`{{-` は直前の空白をすべて削る（→ 制約として明記）。

### scope-justification-reviewer
- verdict: needs-work
- 主指摘: K19 の記法統一と mise の書き換えが必要である根拠が無い（→ 他の `end` と区別するための印が必要なことを明記）。パッケージマネージャ設定を戻す理由が無い（→ サプライチェーン対策と秘密の不在を明記）。ドキュメント更新を成果物として明示すべき（→ 成果物の節を追加）。

### decision-quality-reviewer
- verdict: needs-work
- 主指摘: 支配軸は「隔離境界の安全側への倒れ方」で概ね整合。ただし粗い再包含（`.claude/**` など）の中では付け忘れが VM に入る側に倒れるので、実行経路の検査を置くか主張を狭めるべき（→ 受け入れる非対称と K19 の検査 3 を明記）。

### greenfield-perspective-reviewer
- verdict: needs-work
- 主指摘: 白紙案の drift の主張が未計測で、採用案も 3 か所の同期を要する（→ 同期対象の大きさで比較）。jq の置き場は run_before_ script という選択肢もある（→ 採らない理由を明記）。本物の apply の自動テストが無い（→ 意図的に提供しない体験として記録）。

### architecture-boundary-analyzer
- verdict: needs-work
- 主指摘: VM ブロックはターゲット名だけで書くと明記すべき。jq が 2 つの一覧に重複している（→ bootstrap に一本化）。ガード付きなのに VM に含まれないテンプレート（死んだガード）を検出すべき（→ K19 の検査 2）。`range` / `with` の中では `.` が変わる（→ 最上位だけで使うと明記）。

### security-vulnerability-analyzer
- verdict: pass
- 主指摘: host 側に新しい実行経路は生じない。private-skills は新しい権限ではないが非公開の中身を VM に置く露出として明記すべき（→ K17 に記載）。前提パッケージの一覧は bootstrap.sh の定数にし、環境変数や staging から読まない（→ K20 に記載）。

### data-contract-evolution-evaluator
- verdict: needs-work
- 主指摘: 引数の契約は変わらないので BOOTSTRAP_CONTRACT は据え置きと明記すべき。apt script のハッシュ行は host では変えず、VM では VM 用の一覧から計算すべき（→ K18 に記載）。既存 VM では `~/.claude.json` の MCP が追記型のマージで残る（→ K21 で、既存 VM が存在しないことと作り直しの手順を明記）。

<!-- auto-review: pending -->
<!-- intent-triage: pending -->

## Reviewer Outputs (Round 2)

### logic-validator
- verdict: needs-work
- 主指摘: K22 の「改名で host が 1 回再実行される」は誤り（run_onchange の記録はターゲット名 + 内容のハッシュ。→ 公式ドキュメントで確認し修正）。K19 の行内ガードは行をまたぐのでファイル全体から取り除く必要があり、行単位の終了行と取り違えない順序が要る（→ 2 段階を明記）。検査 3 の「登録パスが管理対象にある」は `.claude/**` では自明に真（→ 実効は speak-notification 不在の検査と明記）。hooks のカンマ・Notification・MCP の JSON 妥当性は確認済み。

### scope-justification-reviewer
- verdict: pass
- 主指摘: K17〜K22 はすべて根拠あり。K22 は範囲内で、実行順を確かめるテストを plan-1 に置くこと。

### decision-quality-reviewer
- verdict: pass
- 主指摘: Round 1 の主指摘（粗い再包含）は受け入れる非対称の明記と検査 3 で解消。skills とプラグインも実行経路の 1 つだと文言で補うこと（→ 反映）。

### greenfield-perspective-reviewer
- verdict: pass
- 主指摘: 差分案（allowlist）は妥当。postfix が残った場合の次の手を plan に書くこと（→ plan-1 へ）。

### architecture-boundary-analyzer
- verdict: needs-work
- 主指摘: 手書きのブロックと独立した期待リストの完全一致は双方向の drift 検出になるので妥当。K22 の host 再実行の記述が誤り（→ 修正）。完全一致テストはターゲット名で比べると明記すること（→ 反映）。

### data-contract-evolution-evaluator
- verdict: needs-work
- 主指摘: K22 は host では再実行されない（ターゲット名と内容が同じ）ので「1 回の例外」は不要（→ 修正）。Round 1 の指摘（契約番号の据え置き、ハッシュ行、`{}` の検査、既存 VM）は反映済み。

<!-- auto-review: verdict=needs-work; hash=876d32ff37fd62b4f31098df38bcd1f0dee7f6351b8aa45fcf680d7bbc434f92; design-hash=d9fa5709eba860982fb64fb24754d1102a73046f184302ab84066c06129c6112; round=1; at=2026-09-29T14:46:32.365Z; reviewers=logic-validator+scope-justification-reviewer+decision-quality-reviewer+greenfield-perspective-reviewer+architecture-boundary-analyzer+security-vulnerability-analyzer+data-contract-evolution-evaluator -->

## Reviewer Outputs (Round 3)

### logic-validator
- verdict: pass
- 主指摘: Round 2 の 4 点はすべて解消。K19 の 2 段階の理由（部分一致を避けるため）は誤りで、`{{-` と `{{` は互いの部分文字列にならない（→ 文言を修正）。

### scope-justification-reviewer
- verdict: pass
- 主指摘: 今回の変更はどれも文言の訂正で、スコープの逸脱は無い。K22 と検査 3 は plan-1 に残すこと。

### decision-quality-reviewer
- verdict: pass
- 主指摘: 支配軸（隔離境界の安全側への倒れ方）との整合は保たれている。検査 3 の限界は明示的に受け入れられている。

### greenfield-perspective-reviewer
- verdict: pass
- 主指摘: 新しい野心ギャップは無い。postfix が残った場合の次の手は plan-1 に委ねる。

### architecture-boundary-analyzer
- verdict: needs-work
- 主指摘: 検査 2 は `dot_claude/.settings.hooks.json.tmpl`（ソース側で `.` から始まる部品で、ターゲットにならない）で成り立たない（→ 対応表の形に修正）。

### security-vulnerability-analyzer
- verdict: pass
- 主指摘: 新しい P0/P1 は無い。forwarded agent は private-skills 以外の鍵も使わせる点を利用ガイドに一言書くこと、host 専用 hook の denylist 検査を将来検討すること（どちらも P2）。

### deployment-readiness-evaluator
- verdict: needs-work
- 主指摘: agent-vm の CI の path フィルタが今回のテンプレート群を含まず、rebase で古い名前も指している（→ R16 を追加し plan-1 で修正）。mac の host で `chezmoi diff` を取って K22 と host 不変を実地で確かめること、実機検証に 2 回目の bootstrap の冪等性などを足すこと（→ plan-1 へ）。

### 方針の切り替え（Round 3 の後、ユーザー指示）

Round 1〜3 の往復の大半が「共有テンプレートに VM 分岐を入れ、host 不変を証明する仕組み」（旧 K18 の hooks・MCP・apt 分岐と旧 K19）に集中したため、ユーザーの問いかけを受けて問題を変形した。「host のテンプレートには触らず、VM との差分は allowlist と bootstrap だけで表す」。logic-validator による切り替えの検証は「条件付きで妥当」で、条件 (a) 後処理を毎回無条件に走らせる、(b) 手で apply したときの戻りを文書化する、(c) host の apt script との対応を 1 関数にまとめて突き合わせテストを置く、(d) 後処理の jq を fixture でテストする、(e) 除去は厳密に（MCP はキーの完全一致、hook は script のパス）、を新しい K18・K19・R17・R18 に組み込んだ。ユーザーが切り替えを了承した。

<!-- auto-review: verdict=needs-work; hash=4db6f4dc0fa3d87784a21d95224dc7e9c5333fba616e0d8d0599c83b499a043b; design-hash=6f9adc95d3c51b2868997e585dacc9238146d5e05ea700ee9ff679ee233ac07a; round=2; at=2026-09-29T14:49:08.941Z; reviewers=logic-validator+scope-justification-reviewer+decision-quality-reviewer+greenfield-perspective-reviewer+architecture-boundary-analyzer+data-contract-evolution-evaluator -->

## Reviewer Outputs (Round 4)

### logic-validator
- verdict: needs-work
- 主指摘: codex の `~/.codex/config.toml` にも playwright の MCP があり、K19 は Claude 側しか絞らない（→ codex 用の後処理を追加）。apply が失敗すると後処理が飛ぶが、launcher は bootstrap 失敗で止まり claude を起動しない（`tests/agent-vm/run.sh:180-184` で確認）。discord / slack の hook が残るという指摘は、VM では `only_private` が偽（ホスト名で決まる）なので当たらない。K18 で入れない apt パッケージの理由、`.skills` への依存を明記すること。

### scope-justification-reviewer
- verdict: pass
- 主指摘: K17〜K22、R16〜R19 はすべて目的に結びつき、スコープの逸脱は無い。excalidraw の出どころ（`update-claude-json` の http 型の MCP）を明記すること。host での `chezmoi diff` による確認を plan-1 に入れること。

### decision-quality-reviewer
- verdict: pass
- 主指摘: 静的保証を動的保証に替えたのは、害の小さい要素（音声 hook、MCP）に限られ、支配軸（隔離境界の安全側への倒れ方）に沿う。hook の除去は denylist なので、将来の host 専用 hook の足し忘れには弱い（受け入れた非対称として明記済み）。

### greenfield-perspective-reviewer
- verdict: pass
- 主指摘: 差分案は妥当。hook を生成時ではなく後処理で絞るのは軽い対症療法だが、理由付きで受け入れられている。

### architecture-boundary-analyzer
- verdict: needs-work
- 主指摘: 後処理は生成ファイルの形に暗黙に依存し、形が変わると「何も除去せずに成功する」（→ 後処理の後に、speak-notification が残っていないこと・残す MCP のキーが期待どおりであることを bootstrap 自身で確かめ、外れたら非 0 にする）。`mv` でファイルのモードが変わる（→ 元のモードを引き継ぐ）。applied-hash が後処理の後に書かれることをテストすること。

### security-vulnerability-analyzer
- verdict: pass
- 主指摘: P0/P1 は無い。installer はパイプで直接実行せず、いったんファイルに落としてから実行すること（途中で切れたスクリプトの実行を避ける）。forwarded agent があるので installer の汚染の影響が VM の外の鍵にも及ぶことを R19 に書くこと。`~/.claude.json` のモードを保つこと。

### deployment-readiness-evaluator
- verdict: needs-work
- 主指摘: mac の host で `chezmoi diff` を取り、`install-claude-skills-11` が再実行対象に出ないことを実地で確かめること。後処理の jq が失敗したときに元のファイルが変わらず applied-hash も書かれないことをテストすること。実機検証に、2 回目の bootstrap の冪等性、`dpkg --audit`、apply で走った script が 10 本であること、MCP の接続を足すこと。

<!-- auto-review: verdict=needs-work; hash=e66551bddb820f7d727fb5171ff86977e749e533fd16b391cde30832d1100e5c; design-hash=d26b054f7813df39b92ca9b273df277c27195b1d8ba02dbe35b48160243c4944; round=3; at=2026-09-29T14:53:02.381Z; reviewers=logic-validator+scope-justification-reviewer+decision-quality-reviewer+greenfield-perspective-reviewer+architecture-boundary-analyzer+security-vulnerability-analyzer+deployment-readiness-evaluator -->
<!-- intent-triage: adopted=19; excluded=0; at=2026-09-29T14:53:24.577Z -->

## Reviewer Outputs (Round 5)

### logic-validator
- verdict: needs-work
- 主指摘: Round 4 の修正はすべて実物と整合（codex の設定は合成時に `mcp_servers` を毎回テンプレートから作り直す、`only_private` はホスト名で決まる、launcher は bootstrap の失敗で止まる）。軽微な点: 「host のテンプレートは 1 つも変えない」は不正確（→ 描画結果と実行結果が変わらない、と修正）、自己検査は除去より緩い条件で探すべき、awk の扱う書き方と扱わない書き方を明記すべき、残す一覧を 1 つの定数にすべき、自己検査は「余計なものが無い」だけを保証すると明記すべき、後処理済みの codex 設定の上書きを実機で確かめるべき（→ すべて反映、R20 を追加）。

### architecture-boundary-analyzer
- verdict: pass
- 主指摘: Round 4 の指摘（自己検査、モードの維持、applied-hash の順序）は反映済み。awk の見出しの書き方（引用符、`[[…]]`）と、扱わない書き方の fixture を plan-1 で押さえること。

### deployment-readiness-evaluator
- verdict: pass
- 主指摘: spec は安全な展開に必要なことを述べている。plan-1 に、後処理の失敗・自己検査の失敗・モードの維持・mawk での awk のテスト、実機での 2 回目の bootstrap・`dpkg --audit`・走った script の数・MCP の接続・`~/.claude.json` のモードの確認を入れること。

### scope-justification-reviewer
- verdict: pass (carried from Round 4)
- 主指摘: Round 4 で pass、再実行なし

### decision-quality-reviewer
- verdict: pass (carried from Round 4)
- 主指摘: Round 4 で pass、再実行なし

### greenfield-perspective-reviewer
- verdict: pass (carried from Round 4)
- 主指摘: Round 4 で pass、再実行なし

### security-vulnerability-analyzer
- verdict: pass (carried from Round 4)
- 主指摘: Round 4 で pass、再実行なし

<!-- auto-review: verdict=needs-work; hash=80e0666a7d03a7b0fde3e15883f66a70348dcf91ebd6768933ccbb1e09f64ae5; design-hash=2ee8720a35b31c18ddcbfe0054f1b77e8da60ddf30e4623f2eb12e14c471b76a; round=4; at=2026-09-29T15:14:22.763Z; reviewers=logic-validator+scope-justification-reviewer+decision-quality-reviewer+greenfield-perspective-reviewer+architecture-boundary-analyzer+security-vulnerability-analyzer+deployment-readiness-evaluator -->

## Reviewer Outputs (Round 6)

### logic-validator
- verdict: pass
- 主指摘: Round 5 の修正後の spec に矛盾は無い（host 不変の文言、自己検査、残す一覧の単一定数、R20、script 10 本・apt 5 つの数）。codex の自己検査の「名前を含まない」は部分一致とも読めるので完全一致と明記すること（→ 反映、値に名前が現れるだけの行は一致とみなさないと追記）。

### architecture-boundary-analyzer
- verdict: pass (carried from Round 5)
- 主指摘: Round 5 で pass、再実行なし

### deployment-readiness-evaluator
- verdict: pass (carried from Round 5)
- 主指摘: Round 5 で pass、再実行なし

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

<!-- auto-review: verdict=needs-work; hash=0ccdc88525cb2f4e29f1ded8bf597f14a097be52b6ca97e4bf5feceae3bf90a7; design-hash=d85fba0dba652335d5252c888652353d67ddd0bed91ba5996bb846fbaf985413; round=5; at=2026-09-29T15:18:35.709Z; reviewers=logic-validator+architecture-boundary-analyzer+deployment-readiness-evaluator -->

## Reviewer Outputs (Round 7)

### logic-validator
- verdict: pass（ただし実機の証拠で覆った）
- 主指摘: dasel を mise のインストール先に入れれば `merge-config.ts` の 3 番目の探し方で見つかる、と判定。実機で試すと、`which dasel` が mise の shim を返し、shim が working tree の未信頼の `.mise.toml` を読んでエラーになり、3 番目まで到達しなかった（→ K18 の dasel の項を「ソースの `.mise.toml` を信頼し、そこで dasel を入れる」に改め、実機で apply が通ることを確認）。

### architecture-boundary-analyzer
- verdict: pass (carried from Round 6)
- 主指摘: Round 6 で pass、再実行なし

### deployment-readiness-evaluator
- verdict: pass (carried from Round 6)
- 主指摘: Round 6 で pass、再実行なし

### scope-justification-reviewer
- verdict: pass (carried from Round 6)
- 主指摘: Round 6 で pass、再実行なし

### decision-quality-reviewer
- verdict: pass (carried from Round 6)
- 主指摘: Round 6 で pass、再実行なし

### greenfield-perspective-reviewer
- verdict: pass (carried from Round 6)
- 主指摘: Round 6 で pass、再実行なし

### security-vulnerability-analyzer
- verdict: pass (carried from Round 6)
- 主指摘: Round 6 で pass、再実行なし

<!-- auto-review: verdict=pass; hash=2c6415d31631369762ab6156634434ef3bdf69a2f654dc3d6ff29cee67e20561; design-hash=c53f8a4e5d7b217f16fc060273d303d4b2eb880277d14529ac8ece1890dcbdef; round=6; at=2026-09-29T15:19:30.912Z; reviewers=logic-validator+scope-justification-reviewer+decision-quality-reviewer+greenfield-perspective-reviewer+architecture-boundary-analyzer+security-vulnerability-analyzer+deployment-readiness-evaluator -->
<!-- intent-triage: adopted=27; excluded=0; at=2026-09-29T15:19:44.492Z -->

## Reviewer Outputs (Round 8)

### logic-validator
- verdict: pass
- 主指摘: K2・K16・K18 の順序、host 不変の原則と矛盾しない。信頼すると host が後で `.mise.toml` に足した `[env]` なども VM で有効になる、`actrun` は入れないので警告が出うる、dasel の手順は初回にも走る、を明記すること（→ 反映）。

### scope-justification-reviewer
- verdict: pass
- 主指摘: 実機の証拠と、却下した単純な案の実機確認があり、根拠は十分。R22 にも既知の制約としての記録を付けること（→ T9 で反映）。

### decision-quality-reviewer
- verdict: pass
- 主指摘: 支配軸（host と共有するテンプレートに VM 分岐を入れない）と整合。却下した 3 案（インストール先だけ、PATH へのリンク、グローバル設定への追加）の理由も軸と合っている。

### greenfield-perspective-reviewer
- verdict: pass
- 主指摘: 既存の「codex のマージが開発用ツールに依存する」構造への対症療法だが、今回の範囲では妥当。マージを dasel や mise に依存させない作り替えを別の課題として記録すること（→ K18 と T9 に反映）。

### architecture-boundary-analyzer
- verdict: pass
- 主指摘: VM の差分は bootstrap に閉じ、host は変わらない。依存している 2 つのファイル（テンプレートと `merge-config.ts`）を bootstrap のコメントで名指しすること、ファイル単位で信頼すること（→ 反映）。

### security-vulnerability-analyzer
- verdict: pass
- 主指摘: host 側への露出は無く、VM 側のリスクも広がらない（VM はもともとそのファイルを書き換えられる）。今の `.mise.toml` には `[env]`・hook・`[tasks]` が無い。

### deployment-readiness-evaluator
- verdict: pass（条件付き）
- 主指摘: 失敗した既存マシンでは初回の dasel の取得を確かめられないので、新しいマシンで初回の prewarm からやり直すこと、`mise which dasel` の確認を足すこと（→ plan-1 の T7 に反映）。

<!-- auto-review: verdict=needs-work; hash=101450a553b1969344c25fe302bbd850f0eb7057eb126eec5bddb5a015f1fccf; design-hash=27d4038a91c7f126f9d2a9f0fbac97970314b25cd26d2595386d1550bf6adf1b; round=7; at=2026-09-29T16:15:25.116Z; reviewers=logic-validator -->

<!-- auto-review: verdict=pass; hash=692c1cf55cde37b98f871d38882b4d9da53b34241f35d1a200b06db3ae4eccee; design-hash=a6ed8c266f2e398d82c981aa18930a3ee06387eef2cf80b7017e08c114624e0a; round=8; at=2026-09-29T16:17:33.236Z; reviewers=logic-validator+scope-justification-reviewer+decision-quality-reviewer+greenfield-perspective-reviewer+architecture-boundary-analyzer+security-vulnerability-analyzer+deployment-readiness-evaluator -->
<!-- intent-triage: adopted=9; excluded=0; at=2026-09-29T16:17:33.274Z -->
