# Spec: 依存更新の停止箇所を塞ぐ（APM skill installer / mise 設定の Renovate 検出 / Renovate の PR 作成レート）

## Goal

dotfiles の依存宣言（APM の `apm.yml`、mise のツール、npm 依存）について、(1) 宣言を変えたら次の apply で実際に反映され、host では失敗すれば apply が復旧手順付きで失敗する、(2) Renovate が追跡できる宣言（mise のツールと npm 依存）は上流の更新が PR として届く、状態へ戻す。

APM skill の中身の更新（各 skill repo の `main` の新しいコミットを取り込むこと）は対象外とする。`apm install -g` は `~/.apm/apm.lock.yaml` の SHA に従うため（2026-10-01 に 0.31.0 で再実行し、全 dependency が `(cached)`・同一 SHA だった）、installer をいつ走らせても中身は変わらず、取り込みには `apm update` が要る。この経路の扱いは K8 に書く。

## Experience Delta

- 変更前: apm が PATH に無い apply が一度あると APM skill の install が以後ずっと走らない（本マシンで 5 ヶ月間 0 件だった）。mise の global ツールは 2026-09-29 の `config.toml` → `config.toml.tmpl` 化（`4ae1d84`）以降 Renovate の検出対象外で、それ以前も deno/yarn 以外の更新 PR が 2026-05-17 以降作られていない。
- 変更後: `apm.yml` か apm 本体の版を変えると次の apply で `apm install -g` が走り、host では失敗や apm 不在が apply の最後に `[apm-skills]` の復旧コマンド付きで非ゼロ終了として出る。mise の global ツール（`github:` バックエンドの apm / safe-chain / mo を含む）が Renovate の Dashboard に再び載り、非 major 更新のグループ PR が週次で作られる。

## Architecture

3 つの修正を 1 つの spec にまとめ、2 つの plan で実装する。共通点は「宣言はあるのに反映経路が黙って止まっていた」ことで、発見経路が同じ調査（`research.md`）である。APM 本体の 0.31.0 への更新は `242fa36` で完了済みで、本 spec の作業には含まない。

- **plan-1: APM skill installer を ADR-0017 の 10- 帯へ移す**（installer・verifier・smoke テスト・`home/.chezmoiignore:91` の VM allowlist の script 名・VM fixture・run-templates の順序テスト・ADR-0017 追記・ADR-0018 K22 追記・`docs/agent-vm.md` の R21 の記述への追記）
- **plan-2: mise 設定の分割と Renovate 設定**（mise ファイル・`home/.chezmoiignore:56` の VM allowlist の mise 行・agent-vm テスト・safe-chain の hash 行・`renovate.json`・ADR-0018 K5/K17 追記）。mise の分割と `renovate.json` の conf.d パターンは、conf.d ファイルが存在して初めて意味を持つので同じ plan に置く。K6 は plan-2 の中で 2 つの commit（schedule / prHourlyLimit と、mise の `minimumReleaseAge`）に分け、どちらも単独で revert できるようにする。

plan-1 は急ぐ。VM の bootstrap は host の作業ツリーを rsync して apply する（`agent-vm/bootstrap.sh:157-160`）。bootstrap は apply の前に `$HOME/.local/share/mise/shims` を PATH に足すので（`agent-vm/bootstrap.sh:134`）、`mise env` を呼ばない旧 script でも VM では apm に届く。今日 `apm.yml` を 2 回変えたので、旧 script は次の VM bootstrap で再実行され、R21 の失敗に apm 0.31 が exit 1 を返して（下の K9 の実測）bootstrap が止まる見込みである。

### 1. APM skill installer（plan-1）

- `run_onchange_after_install-claude-skills-11.sh.tmpl` → `run_after_10-install-apm-skills.sh.tmpl`。毎 apply で実行し、`mise env --shell bash` を eval してから apm を探す。
- 手順:
  1. `~/.apm/apm.yml` が無ければ WARNING を出して exit 0（chezmoi の配置の問題で、apm では直せない）。
  2. apm が PATH に無ければ marker（`reason=apm-not-found`）を書いて exit 0。
  3. state key を計算する: `apm.yml` の sha256 と、`apm --version` の出力から取り出した `version X.Y.Z` の部分を空白区切りで 1 行にしたもの。全出力を使わないのは、新しい版があると `[!] A new version of APM is available` の通知が混ざり、通知の有無だけで key が変わるため（2026-09-30 に 0.13.0 で観測）。`apm --version` が非ゼロ終了か、`version X.Y.Z` を含まなければ key は空とし、state は「不一致」扱い。
  4. `~/.apm/.install-state` の内容が key と完全一致し、key が空でなく、`~/.apm/apm.lock.yaml` が存在し、marker が無ければ、install を省いて exit 0。marker があれば省かずに手順 5 へ進む（前回の失敗から回復する唯一の経路を塞がないため）。
  5. それ以外は旧 script の legacy 移行処理（`~/.apm/apm.lock.yaml` が無く `~/.claude/.external-skills-installed` があるときに列挙された skill ディレクトリを消す）をそのまま行い、`apm install -g` を実行する。
  6. exit 0 かつ lockfile があれば、key が空でない場合に限り `mktemp "$HOME/.apm/.install-state.tmp.XXXXXX"`（mode 600 で作られる）に key を書いて `mv -f` で `~/.apm/.install-state` に置く。`mktemp` か `mv` が失敗したら一時ファイルを消して WARNING を出し、state は無いまま続ける（次の apply で install をやり直すだけ）。install 自体は成功しているので、どちらの場合も marker を消す。marker を消すのはこの成功経路だけ。
  7. 失敗したら（`apm install -g` が非ゼロ、または exit 0 でも lockfile が無い）`~/.apm/.install-state` を消し（消せなければ ERROR を出して続行）、marker（`reason=apm-install-failed`）を書いて exit 0。marker を書けなければ exit 1（既存 installer と同じ例外）。state を消せなかった場合も、marker があるので次の apply の手順 4 は install を省かず、成功すれば手順 6 で marker が消える。state の削除と marker の書き込みが両方失敗した場合だけは、その apply が exit 1 で止まったうえで古い state が残る（`~/.apm` と `~/.claude` の両方に書けない状態で、apply の失敗として目に見えるので許容する）。
- VM（`agent_vm` が真）では手順 2 と 7 で marker を書かず、WARNING だけ出して exit 0 する（K9）。state は書かないので毎 bootstrap で再試行される。VM ではどの分岐も exit 0 で、marker の書き込み失敗による exit 1 も起きない（marker を書かないため）。
- marker は `~/.claude/.apm-skills-install-failed`。書き込みは既存 partial `record_provisioning_failure`（固定 3 フィールド、mode 600、コマンド出力を写さない）。
- `run_after_zz-verify-provisioning` に `report_marker ... "apm-skills" ... "mise install github:microsoft/apm && apm install -g"` を足す。復旧コマンドは既存 2 件と同じく固定文字列。mise 自体が無いときは `00-install-mise-tools` が apply を exit 1 で止める（smoke K2）ので、この復旧コマンドが mise 不在で詰まる経路は無い。
- 新しい smoke assertion M が見る分岐: 失敗で marker 600・固定フィールド・state 無し / 成功で state が書かれ marker が消える / 同じ key の 2 回目は `apm install` を呼ばない / state が一致していても marker があれば `apm install` を呼び、成功で marker が消える / `apm.yml` を変えると再 install / lockfile が無いと再 install / `apm --version` が空だと state を書かない / apm 不在で marker（`reason=apm-not-found`）/ VM データでレンダリングすると install 失敗でも apm 不在でも marker を書かず exit 0 / marker を書けないと exit 1。具体的な入力と期待値は plan-1 に書く。

### 2. mise 設定（plan-2）

- `home/dot_config/mise/config.toml.tmpl` → `home/dot_config/mise/config.toml`（VM と host の共通セット、素の TOML、テンプレート行なし）
- 新規 `home/dot_config/mise/conf.d/host-toolchains.toml`: 現テンプレートの `agent_vm` ガード内側の 6 エントリ（`go`、`rust`、`cargo:similarity-ts`、`cargo:zizmor`、`go:github.com/syou6162/git-sequential-stage`、`cargo:octorus`）を、元のコメントごと移す。
- `home/.chezmoiignore` の VM ブロック: `!.config/mise/**` を `!.config/mise/config.toml` に置き換える（`!.config/mise` は残す）。

### 3. Renovate（plan-2）

- `mise.managerFilePatterns` を `/(^|/)dot_config/mise/conf\.d/[^/]+\.toml$/` の 1 本にする。
- 別 commit で `prHourlyLimit: 0` と `schedule: ["* * * * 1"]` を足す。
- さらに別 commit で、mise マネージャへの `minimumReleaseAge: "7 days"` の packageRule を足す。

### 変更・削除する既存の検査

- `tests/agent-vm/run-templates.sh`
  - 削除して置き換え: `test_mise_full_set_outside_vm` / `test_mise_light_set_in_vm` / `test_mise_template_works_without_agent_vm_key` / `test_host_render_equals_template_without_vm_guards` / `test_install_scripts_hash_the_rendered_template`（どれも `config.toml.tmpl` のレンダリング結果か、VM と host で hash が違うことを前提にしている）
  - 追加: VM の managed 集合に `.config/mise/config.toml` があり `.config/mise/conf.d/host-toolchains.toml` が無いこと、host の managed 集合には両方あること。`conf.d/host-toolchains.toml` の `[tools]` のキーが `go` / `rust` / `cargo:*` / `go:*` だけであること、`config.toml` にそれらが 1 つも無く `github:AikidoSec/safe-chain` があること。
  - 改名に追従: `test_skills_install_runs_after_mise_tools_and_before_sync` の期待値を `00-install-mise-tools.sh 10-install-apm-skills.sh sync-skills.sh` にする。
- `tests/agent-vm/fixtures/vm-managed.txt`: `.config/mise/**` → `.config/mise/config.toml`、`.chezmoiscripts/install-claude-skills-11.sh` → `.chezmoiscripts/10-install-apm-skills.sh`
- `scripts/smoke-provisioning-invariants.sh`: A3 の membership に `10-install-apm-skills` を足す。C で apm marker も置き、stub に `apm` を足して verifier が呼ばないことを見る。D に apm marker 単独の報告を足す。新 assertion M で installer の分岐（下の plan-1 テスト計画）を見る。

## Alternative Approaches (Greenfield View)

### 差分最小案 (Incremental)

- installer: 既存 script に `mise env` の 3 行を足し、apm 不在時を `exit 1` にしてハッシュを記録させない。
- mise: `renovate.json` の `managerFilePatterns` に `config.toml.tmpl` を足す。または、テンプレートのまま Renovate の正規表現 custom manager で `"<backend>:<name>" = "<version>"` 行を抜き出す。
- schedule: 何もしない（Dashboard のチェックボックスで都度作らせる）。

却下理由:
- installer の `exit 1` は apply 全体を止める。ADR-0017 K4 が root/hook deps で「exit 0 + marker、最後に verifier」を選んだのと同じ理由で、APM だけ apply を途中で止める根拠が無い。
- `.tmpl` をパターンに足しても、Renovate の mise manager は厳格な TOML パーサ（`Toml.pipe`）で読むため `{{- if ... }}` 行で失敗し依存 0 件になる（`research.md`「Renovate mise manager」）。custom manager は、mise manager が持つバックエンドごとの datasource 対応（`github:` → github-releases、`cargo:` → crate、`go:` → go、`npm:` → npm、core ツール → 各 datasource）を正規表現と `datasourceTemplate` で手書きし直すことになり、ツールを足すたびに対応の漏れがありうる。
- schedule を放置すると、Dashboard の Awaiting Schedule 10 件が今後も溜まり続ける。

### 白紙設計案 (Greenfield)

ゼロから作るなら、「宣言ファイルは各ツール（mise / Renovate / APM）がそのまま読める形式で置き、環境差はファイル単位の配置有無で表す」。chezmoi のテンプレートは環境差を 1 ファイル内の条件分岐で書けるが、その代償として外部ツールがファイルを読めなくなる。環境差が「あるツール群を入れるか否か」だけなら、ファイル分割 + `.chezmoiignore` で同じことが素の TOML のまま書ける。installer は ADR-0017 が確立した「10- 帯・毎回実行・marker・verifier」の型に揃える。

### 採用案と理由

白紙設計案を採用する。根拠:

- mise: Renovate のパーサが厳格な TOML であることがソースで確認できており（`research.md`）、テンプレートのまま検出させる手段は正規表現 custom manager（バックエンドごとに datasource を手書き対応）しかない。ファイル分割なら既存のデフォルト検出がそのまま効く。
- mise の VM 差分を `disable_tools` で書く案は、実測で動作はしたが、プロジェクトの `mise.toml` が宣言した rust まで無効化する（`research.md`「mise の conf.d と disable_tools」）。ファイル分割なら VM の挙動は現在と同一（global に宣言が無いだけ）。
- installer: ADR-0017 の型には smoke テスト（assertion A-L）と verifier が既にあり、新しい installer はそこに assertion を足すだけで同じ保証を得る。ただし K2 の「毎回そのまま実行」は `apm install -g` の所要（3.4-4.6s、ネットワークで ref を解決）に合わないので、成功時だけ書く state で省く。これは ADR-0017 に名前付きの例外として追記する（K10）。

## Key Decisions

- **K1: APM installer を `run_after_10-install-apm-skills` にし、成功時だけ書く `~/.apm/.install-state` で install を省く** — ADR-0017 K2 は「ハッシュ gate + exit 0 の失敗 = 恒久 skip」を欠陥クラスとして名指ししている。`run_after_` は毎回走り、state は成功した install の後にしか書かれず、失敗時には消されるので、失敗や apm 不在の後は次の apply で必ず再試行される。state の入力に apm の版を含めるのは、0.13→0.31 で lockfile の形式が変わった実例があるため。state の形式は「`apm.yml` の sha256」「`apm --version` の出力から取り出した `X.Y.Z`（Architecture §1 手順 3）」の 2 フィールドを空白区切りで書いた 1 行とし、script の header に書く（textlint installer の `.install-state` は package.json のコピーで、別ディレクトリ・別形式）。`apm install -g` に timeout は付けない（既存の `bun install` / `mise install` にも無く、macOS には `timeout` が標準で無い）。
  - 参照: `home/.chezmoiscripts/run_onchange_after_install-claude-skills-11.sh.tmpl:5,14-18,25-39,43-48`
  - 参照: `home/.chezmoiscripts/run_after_10-install-root-deps.sh.tmpl:33-70`（marker・mise env の型）
  - 参照: `docs/decisions/0017-provisioning-after-deploy.md`（K2, K4, K5）
- **K2: apm が PATH に無いときは marker を書く** — root-deps の J3（bun 不在は marker なしで skip）とは扱いを変える。今回の 5 ヶ月の沈黙はまさに「apm が無いので黙って抜けた」経路で、bun と違い apm の不在は他の場所で目に見える失敗を起こさない。復旧コマンドは `mise install github:microsoft/apm && apm install -g`。この script は Windows では空にレンダリングされ（`{{ if ne .chezmoi.os "windows" }}`）、VM では marker を書かない（K9）。apm は mise の global 設定（共通セット）に宣言されているので、それ以外の host で apm が無いのは常に異常である。
  - 参照: `home/.chezmoiscripts/run_after_10-install-root-deps.sh.tmpl:47-51`
  - 参照: `scripts/smoke-provisioning-invariants.sh:399-408`（J3）
- **K3: mise 設定を `config.toml`（共通）と `conf.d/host-toolchains.toml`（host のみ）に分割する** — ADR-0018 K5 の「VM の global mise ツールを軽量セットに絞る」を、配置の有無で同じ結果に保つ。mise は `~/.config/mise/conf.d/*.toml` を global 設定として config.toml とマージする（`research.md` の実測）。
  - 参照: `home/dot_config/mise/config.toml.tmpl:13-15,18-20,29-37,45-47`（ガード位置）
  - 参照: `docs/decisions/0018-agent-vm-orbstack.md:24`（K5）
- **K4: VM の allowlist を `!.config/mise/**` から `!.config/mise/config.toml` に狭める** — `.chezmoiignore` の VM ブロックは `**` で全無視し `!` で戻す構成で、`!.config/mise/**` のままだと後の行で `conf.d/host-toolchains.toml` を無視しても配置される。2026-10-01 に一時ディレクトリの source で `chezmoi managed` を実行して確認した: 広い allowlist + 後続の無視行では `host-toolchains.toml` が managed に残り、`!.config/mise/config.toml` に狭めると `config.toml` だけになった。ADR-0018 K17 の「script 以外はディレクトリ単位で戻す」から外れるが、同じディレクトリに VM へ入れてはいけないファイルができるため。今後 `~/.config/mise/` 配下にファイルを足すと VM には入らない（allowlist の fail-closed 側）。
  - 参照: `home/.chezmoiignore:55-56`
  - 参照: `docs/decisions/0018-agent-vm-orbstack.md:40`（K17）
- **K5: `renovate.json` の `mise.managerFilePatterns` を conf.d 用の正規表現 1 本にする** — 現行 2 項目は `/.../` 区切りが無く glob 扱いで何にも一致しない。repo の `managerFilePatterns` はデフォルトを置き換えずに追加される: Renovate の `docs/usage/configuration-options.md` に "Patterns in the user config are _added_ to the default values, they do not replace the default values." とある（2026-10-01 に main を確認）。PR #180（deno、2026-09-20）が変更したのは `home/dot_config/mise/config.toml` で、デフォルトの glob で検出されていたことと整合する。`home/dot_config/mise/config.toml` と `.mise.toml` はデフォルトの `**/{,.}mise/config{,.*}.toml` / `**/{,.}mise{,.*}.toml` で検出される。conf.d はデフォルト（`**/.config/mise/conf.d/*.toml`）が `dot_config` に一致しないので足す。`github:` バックエンドは Renovate #40706（2026-02-13）で対応済み。
  - 参照: `renovate.json:31-36`
- **K6: `prHourlyLimit: 0` と `schedule: ["* * * * 1"]` を repo の `renovate.json` で上書きする（仮説に基づく変更、単独 commit）。mise マネージャへの `minimumReleaseAge: "7 days"` は独立した変更として別 commit にする** — 観測事実: 2026-05-17 以降、週 1 本前後の PR（deno / yarn）しか作られず、10 ブランチが Awaiting Schedule のまま。`schedule:weekly` の窓は月曜 0:00-3:59（timezone は preset の `:timezone(Asia/Tokyo)` を継承）の 4 時間で、`prHourlyLimit` のデフォルトは 2。原因候補は (a) 窓内の実行回数 × 2 の上限、(b) `internalChecksFilter: strict` と `minimumReleaseAge` によるブランチ作成の保留、(c) その他で、Mend のジョブログを見ないと確定できない（Open Questions）。(a) を外す変更として 2 つを緩め、`prConcurrentLimit`（10）は残して同時に開く PR の数を抑える。効果は次の月曜に `renovate/all-minor-patch` の PR が作られるかで判定する（作られれば (a) を裏付ける成功、作られなければ (b) を調べる）。この commit を revert するのは、(a) が原因でないと判明し、緩めておく理由がなくなったときに限る。mise の `minimumReleaseAge` は (a) の仮説とは無関係のセキュリティ上の追加で、npm にしか掛かっていない 7 日の待ちを mise の更新にも掛ける（手元の mise の `install_before = "7d"` と値を揃えるが、こちらは PR を遅らせるだけで手元の install とは独立）。release の日時を返さない datasource では効かないことがあるので、「掛かる見込み」として push 後に mise の PR に minimum release age の status が付くかを見る。(b) が真因だった場合に判定が交絡しないよう、commit を分けて片方ずつ revert できるようにする。共有 preset `berlysia/renovate-config` の変更は他 repo に波及するので本 spec では repo 上書きに留める。
  - 参照: `renovate.json:1-4`
  - 参照: 共有 preset `berlysia/renovate-config/default.json` の `schedule:weekly` / `minimumReleaseAge`
- **K7: safe-chain の hash 行を `include "dot_config/mise/config.toml"` にする** — safe-chain は共通セット側にあるので hash の入力は `config.toml` だけで足りる（conf.d を含めないのは設計上の選択で、safe-chain の再実行契機は自分の版の変化だけだから）。safe-chain が `config.toml` にあることは run-templates のテストで固定する（将来 conf.d に移すとテストが落ちる）。行の文字列が変わるため safe-chain script は次の apply で 1 回再実行される（rc ファイルを退避・復元するだけで、ADR-0017 K2 が許容した挙動）。
  - 参照: `home/.chezmoiscripts/run_onchange_after_install-safe-chain.sh.tmpl:11`
- **K8: APM 依存の固定（`#sha` / `#tag`）は行わず、`main` 追従を受容したリスクとして記録する** — Renovate の apm manager は文字列形式かつ `#<ref>` 付き、SHA ならタグコメント付きのものしか更新しない。本 repo の 9 件中 6 件は `git:` + `skills:` のオブジェクト形式で抽出対象外、skill repo の多くはタグを切っていない。固定すると更新が完全に手作業になる。受容するリスク: 新しいマシンで初回 install したときは、その時点の各 repo の `main` を取り込む（上流が侵害されていれば、そのまま入る）。既存マシンでは `~/.apm/apm.lock.yaml` が SHA を固定し、`apm update` を手で打つまで中身は変わらない。この lockfile はマシンごとのファイルで chezmoi の管理外なので、固定は新しいマシンや VM には伝わらない。lockfile を chezmoi で配るには、APM が install のたびに書き換える `generated_at` などをどう扱うかと、`apm update` 後の SHA の差分を誰がレビューするかを決める必要があり、本 spec の範囲を超える。`apm update` を打ったときは、lockfile の SHA の変化を目で確かめることを勧める。skill の中身を新しくするのは手作業（`apm update`）で、それを促す仕組みは本 spec では作らない（鮮度の維持は Goal の対象外）。`apm install` の `N dependencies unpinned` 警告はこの受容の結果として出続ける。
  - 参照: `home/dot_apm/apm.yml:4-45`
- **K9: VM でも新 installer を実行するが、VM では失敗を marker にせず WARNING に留める** — VM の bootstrap は `set -euo pipefail` の下で `chezmoi init --apply` を実行し（`agent-vm/bootstrap.sh:5,160`）、verifier は VM の allowlist に入っている（`home/.chezmoiignore:87`）ので、marker があると apply が非ゼロになり起動が止まる。2026-10-01 に一時ディレクトリで、存在しない repo を 1 件混ぜた `apm.yml` に `apm install`（0.31.0）を実行したところ、残りの依存は配置されたが exit 1 だった（`Installation failed with 1 error(s)`）。ADR-0018 R21 のとおり VM では 9 件中 5 件が入らないので、host と同じ扱いにすると毎回の bootstrap が止まる。R21 は `docs/agent-vm.md` に既知の制約として書かれており、VM は入った分の skill で動いてきた。VM での扱いはこの状態を保つ: 失敗も apm 不在も WARNING を出して exit 0、state は書かず次の bootstrap で再試行する（R21 が解消すれば自然に成功する）。代償として、R21 が続く間は毎 bootstrap で `apm install -g` の数秒と WARNING 1 行が出る。この WARNING は既知の状態を示すものなので、`docs/agent-vm.md` の R21 の記述に「VM では apm の失敗が WARNING に留まり、`~/.apm/.install-state` が無いことで判別できる」と書き足す。分岐は installer テンプレート内の `dig "agent_vm" false .`（ADR-0018 K4 のガード）で書く。
  - 参照: `agent-vm/bootstrap.sh:5,160`
  - 参照: `home/.chezmoiignore:87,91`
  - 参照: `docs/decisions/0018-agent-vm-orbstack.md:23,45,69`（K4, K22, R21）
- **K10: ADR-0017 と ADR-0018 に `Amended by` 節を足す** — ADR-0017: 10- 帯の installer のうち、成功時だけ書く state で重い処理を省くもの（本件）を名前付きの例外として認め、verifier の marker が 3 つになったことを記す。ADR-0018: K5 の実現方法がテンプレートからファイル分割に変わったこと、K17 の mise だけファイル単位になったこと、K22 の script が `run_after_10-install-apm-skills` になったこと。書式は ADR-0017 K7 と同じく ADR-0001 に合わせる。
  - 参照: `docs/decisions/0017-provisioning-after-deploy.md`（K7）

## Risks

- **R1**: K6 で溜まっていた 10 ブランチ分の PR が次の月曜にまとめて作られ、`:automergeMinor` 等により CI が通ったものは自動 merge される → node / bun / pnpm / uv / safe-chain 等 4 ヶ月分の非 major 更新が 1 日に入る。自動 merge は既存の preset 方針で、本 spec では変えない。自動 merge は CI が通った PR にだけ掛かり、CI が落ちた PR は open のまま残る。npm は 7 日、mise は K6 の別 commit で 7 日の release age が掛かる見込み。`prConcurrentLimit: 10` で同時数は抑えられる。影響が最も大きいのは package manager を包む safe-chain と、install 時に動くツールの更新なので、月曜の PR 一覧は merge 前に目を通すことを勧める。ただし PR は月曜未明に作られ、CI が通れば人が見る前に merge されうるので、これは努力目標に留まる。自動 merge の方針そのものを変えるかは本 spec の範囲外として残す。
- **R2**: `conf.d/host-toolchains.toml` を VM に誤配置すると VM に rust/go が入る → run-templates の managed 集合テストで検出する。
- **R3**: host で conf.d が読まれないと host から rust/go が消える → plan-2 の commit 前に、本マシンで apply 後 `mise config ls` に `conf.d/host-toolchains.toml` が出て `mise ls --current` に rust / go / `cargo:zizmor` があることを確認する（gate）。Windows（`run_install-packages-7-windows.ps1.tmpl`）は本マシンで確認できないため未検証として残す。
- **R4**: state が一致したまま skill ディレクトリが手で消された場合、install が省かれる → lockfile の存在も条件にする。lockfile に載る skill ディレクトリの欠落までは見ない（`apm install -g` を手で打てば戻る）。
- **R5**: host では一時的なネットワーク障害でも marker が書かれ、次に apply が成功するまで apply が非ゼロで終わる。再実行で消えるので許容する。旧 script は `apm.yml` が変わったときしか走らなかったので、失敗が目に見える回数は増える（それがこの変更の目的）。
- **R6**: VM では APM の失敗が目に見えないまま残る（K9）。R21 の既知の制約と同じ扱いで、VM の中で `~/.apm/.install-state` が無いことで判別できる。

## ISO 25010 次元選択

- **信頼性（障害許容性・回復性）**: installer の失敗や apm 不在が以後の apply を黙らせないこと、失敗が最後に復旧手順付きで出ること。
- **機能適合性（機能正確性）**: VM と host で配置される mise ツール集合が変更前と同一であること、Renovate が mise ファイルを検出すること。
- **保守性（試験性）**: VM の軽量セットと host 専用セットの境界、safe-chain の置き場所が、テストで機械的に検査されること。
- **セキュリティ（完全性）**: K6 の一斉更新に mise でも release age を掛けること、K8 の `main` 追従を受容リスクとして記録すること、marker と state が固定形式・mode 600・原子的な置き換えで書かれること。
- **対象外**: 性能効率（installer は state 一致時に `apm install` を呼ばないので、apply 時間は `apm --version` 1 回分の増加に留まる）。

## 完了の定義

- ローカル（push 前）: `bash tests/agent-vm/run-templates.sh` と `bash scripts/smoke-provisioning-invariants.sh` が全件 PASS。本マシンで `chezmoi apply` が exit 0、R3 の確認が通る、`~/.apm/.install-state` が書かれ 2 回目の apply で `apm install` が省かれる。
- push 後（Open Question 2 で push が承認された場合）: Dependency Dashboard の mise 欄に `home/dot_config/mise/config.toml`・`home/dot_config/mise/conf.d/host-toolchains.toml`・`.mise.toml` が並び、`github:microsoft/apm` / `github:AikidoSec/safe-chain` / `github:k1LoW/mo` が載る（次の Renovate 実行後）。次の月曜に `renovate/all-minor-patch` の PR が作られる（K6 の判定）。`github:` の 3 ツールが Dashboard に載らなければ、Goal (2) は未達として別途調べる。

## Open Questions

1. **溜まっている Renovate 更新をいつ PR にするか**: (A) push 後に Dashboard の「Create all awaiting schedule PRs」にチェックを入れて即時作成する（自動 merge が即座に走る）/ (B) 次の月曜を待つ。推奨は (B)。K6 が効いたかをそのまま観測でき、4 ヶ月分の一斉更新を人が見られる曜日に寄せられるため。
2. **push してよいか**: Renovate 側の効果は master への push 後にしか観測できない。
3. **（任意）Mend のジョブログ確認**: developer.mend.io で 2026-09-21 03:00 JST 前後の実行ログに "hourly limit" / "concurrent" / "pending" の記録があるかを見ると、K6 の原因候補 (a)(b) を判別できる。

## Approval

- Plan Status: complete
- Review Status: pass
- Approval Status: approved

## Reviewer Outputs (Round 1)

### logic-validator
- verdict: needs-work
- 主指摘: Goal の「上流更新が反映される」と K1/K8（skill は `main` 追従だが再 install は `apm.yml`/apm 版の変化時のみ）が矛盾。K5 はデフォルトと独自パターンのマージを前提にしているのに明記がない。`test_install_scripts_hash_the_rendered_template` など壊れる既存テストが列挙されていない。

### scope-justification-reviewer
- verdict: needs-work
- 主指摘: `github:` バックエンドが検出対象に戻ることの根拠と push 後の確認が無い。K8 は未固定警告の扱いを明言すべき。plan の分け方の理由、ローカルでの完了条件と push 後の観測の区別、ADR-0017/0018 の追記が抜けている。

### decision-quality-reviewer
- verdict: pass
- 主指摘: 主軸（信頼性・運用性）と判断は整合。K6 は原因未確定のまま 2 つを緩めるので単独で revert できる形にすること、R3 の host 確認を commit 前の gate にすることを推奨。

### greenfield-perspective-reviewer
- verdict: needs-work
- 主指摘: Goal と APM skill の鮮度が食い違う（K1 の「今と同じ頻度」は今の不具合と同じ）。K6 は仮説に基づく変更と明記すべき。safe-chain が将来 conf.d に移ると hash が拾わない。

### architecture-boundary-analyzer
- verdict: needs-work
- 主指摘: 毎回走る installer が失敗すると VM の bootstrap（`set -e` 下の `chezmoi init --apply`）が止まりうる（ADR-0018 R21）。ADR-0017（gate 付き 10- installer、3 つ目の marker）と ADR-0018（K5/K17/K22）の追記、旧名を参照するテスト・fixture の更新が作業項目に無い。

### security-vulnerability-analyzer
- verdict: needs-work
- 主指摘: K6 で溜まった更新が一斉に自動 merge される。npm 以外（mise の github/crate/go）には release age の gate が無い。K8 の `main` 追従は受容リスクとして明記すべき。ISO の「セキュリティ対象外」は誤り。

### resilience-analyzer
- verdict: needs-work
- 主指摘: apm 不在で marker を書かないと 5 ヶ月の沈黙と同じ経路が残る。state の書き込み順序（install 前に key を計算、成功かつ lockfile ありのときだけ原子的に書く、失敗時は削除）と、`apm --version` が空・失敗のときの扱いを規定すること。

<!-- auto-review: pending -->
<!-- intent-triage: pending -->

## Reviewer Outputs (Round 2)

### logic-validator
- verdict: needs-work
- 主指摘: K5 の加算前提の根拠が deno PR の間接証拠だけ。K6 の mise release age は原因 (b) と交絡するので commit を分けること。K9 の「条件は変わらない」は新設計（exit 0 + marker → verifier）では不正確。assertion M の参照先が無い。

### scope-justification-reviewer
- verdict: needs-work
- 主指摘: `github:` が載らなかった場合の扱いが無い。K5 の加算前提は push 前に文書で確かめられる。Goal の「上流の更新が PR として届く」は mise/npm に限ると明記すること。push 後の完了条件は push 承認が前提と書くこと。

### decision-quality-reviewer
- verdict: pass
- 主指摘: apm 不在 marker が apm を持たない正当なホストで出うる（範囲を書く）。K6 の revert 条件。K9 の推測は commit 前に一度確かめること。

### greenfield-perspective-reviewer
- verdict: needs-work
- 主指摘: skill の中身の鮮度が手作業で、促す仕組みが無いことを明記すること。K7 の hash が config.toml だけなのは設計上の選択と書くこと。mise release age は別 commit に。差分最小案に custom manager を挙げること。

### architecture-boundary-analyzer
- verdict: pass
- 主指摘: `home/.chezmoiignore:91` を plan-1 の Files に明記すること。VM でも mise が apm を入れられない場合（R22 の類）に marker が出て bootstrap が止まる挙動変化を K9 に書くこと。一時的な失敗で bootstrap が止まるコストを R5 に。

### security-vulnerability-analyzer
- verdict: needs-work
- 主指摘: mise の release age は datasource が日時を返す場合にしか効かないので「見込み」とし push 後に確認すること。lockfile がマシンローカルで伝播しないことを K8 に。state の一時ファイルの mode を明記。月曜の一斉更新（特に safe-chain）は merge 前の目視を勧めること。

### resilience-analyzer
- verdict: needs-work
- 主指摘: 失敗時に state を消せないと手順 4 が一致して再試行されない。marker を消すのは成功経路だけにすること。mise 不在時の復旧コマンドの扱い。K9 は verifier 経由で bootstrap が止まる実態を正確に書くこと。

<!-- auto-review: verdict=needs-work; hash=bcf9193098febe209a1d24e42ac23d64ae9f26cc04428da35003484ffc170015; design-hash=1352e910723a18a8e4accebf67400f96d82be841a13b76ca4d64d83e10f5d12f; round=1; at=2026-09-30T18:33:13.486Z; reviewers=logic-validator+scope-justification-reviewer+decision-quality-reviewer+greenfield-perspective-reviewer+architecture-boundary-analyzer+security-vulnerability-analyzer+resilience-analyzer -->

## Reviewer Outputs (Round 3)

### logic-validator
- verdict: needs-work（軽微）
- 主指摘: 旧 script は `mise env` を呼ばないので VM で apm に届いていたかが未確認（→ `bootstrap.sh:134` が shims を PATH に足すことを確認し反映）。Experience Delta の「host では」。VM の毎回の WARNING が常態化する代償。state を消せない失敗後の回復経路。

### scope-justification-reviewer
- verdict: pass
- 主指摘: Round 2 の指摘はすべて解消。Experience Delta に VM を除く旨を足すと整合する。plan-1 を先に進めるのは妥当。

### decision-quality-reviewer
- verdict: pass
- 主指摘: K6 の成功判定と revert 条件を 1 行で。R1 の目視の勧めは努力目標と明記。skill の鮮度の手作業を記録された判断として残すこと。

### greenfield-perspective-reviewer
- verdict: pass
- 主指摘: lockfile を chezmoi で配らない理由を K8 に 1 行。

### architecture-boundary-analyzer
- verdict: pass
- 主指摘: VM の apm 不在分岐も assertion M で見ること、VM では state 書き込み失敗でも exit 0 と明記、VM の WARNING を `docs/agent-vm.md` に書くこと。

### security-vulnerability-analyzer
- verdict: pass
- 主指摘: 手順 6 の state 書き込み失敗時の扱い。`apm update` 後の SHA 差分の確認を勧めること。safe-chain の確認を具体的に。

### resilience-analyzer
- verdict: needs-work
- 主指摘: P0: state を消せずに marker が残ると、手順 4 が install を省き続け marker が永久に消えない（→ 手順 4 に「marker が無いこと」を条件として追加し、assertion M に対応ケースを追加して反映）。

Round 3 の指摘は上記「→」のとおり反映済み。反映後の再レビューはラウンド上限のため未実施。

<!-- auto-review: verdict=needs-work; hash=79cc2cd79d7d9ea2a4e8ed796dc9fc14398d6adfa935f5fb5ec7ec4ecbe64b8a; design-hash=f60460efeb751bcff8d9a4b679513d54cfe959870e87b6e653341e77c3d91d38; round=2; at=2026-09-30T18:38:00.028Z; reviewers=logic-validator+scope-justification-reviewer+decision-quality-reviewer+greenfield-perspective-reviewer+architecture-boundary-analyzer+security-vulnerability-analyzer+resilience-analyzer -->

## Reviewer Outputs (Round 4)

### logic-validator
- verdict: pass
- 主指摘: Round 3 の 4 件は解消。軽微: `docs/agent-vm.md` を plan-1 の範囲に明記、state 削除と marker 書き込みの二重失敗の扱いを 1 行（→ 反映）。

### resilience-analyzer
- verdict: pass
- 主指摘: P0 は解消。軽微: exit 0 でも lockfile が無い場合を失敗と明記（→ 反映）。state を失っても再 install 1 回の費用で済む。

Round 4 の軽微指摘は反映済み。あわせて、state key の apm 版を `apm --version` の全出力から `version X.Y.Z` の部分に絞った（更新通知の有無で key が変わるのを避ける自己指摘）。

### scope-justification-reviewer
- verdict: pass (carried from Round 3)
- 主指摘: Round 3 で pass、再実行なし

### decision-quality-reviewer
- verdict: pass (carried from Round 3)
- 主指摘: Round 3 で pass、再実行なし

### greenfield-perspective-reviewer
- verdict: pass (carried from Round 3)
- 主指摘: Round 3 で pass、再実行なし

### architecture-boundary-analyzer
- verdict: pass (carried from Round 3)
- 主指摘: Round 3 で pass、再実行なし

### security-vulnerability-analyzer
- verdict: pass (carried from Round 3)
- 主指摘: Round 3 で pass、再実行なし

<!-- auto-review: verdict=needs-work; hash=73d3e40982dea35d14b75e70dba669df7bd1e9f7dc5a640016d321214db9b44e; design-hash=6fb9dfa7cce054f8f9669473058aabc5dc60ac4f2503c87a64afe87a5f96e90f; round=3; at=2026-09-30T18:39:28.684Z; reviewers=logic-validator+scope-justification-reviewer+decision-quality-reviewer+greenfield-perspective-reviewer+architecture-boundary-analyzer+security-vulnerability-analyzer+resilience-analyzer -->
<!-- intent-triage: adopted=82; excluded=1; at=2026-09-30T18:39:50.524Z -->

<!-- auto-review: verdict=pass; hash=e73c41e644ef3811bdeef6738da09c72f771eecf99e46e4b5d8f2cd3c4682e6b; design-hash=6fb9dfa7cce054f8f9669473058aabc5dc60ac4f2503c87a64afe87a5f96e90f; round=4; at=2026-09-30T18:50:19.326Z; reviewers=logic-validator+resilience-analyzer -->
<!-- intent-triage: adopted=86; excluded=1; at=2026-09-30T18:50:19.342Z -->
