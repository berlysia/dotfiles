# Research: 依存更新まわりの放置状態の解消（APM install script / Renovate）

## 発端

mizchi/explainer を APM で導入した際（commit `db1c28e`, `b4655a6`）に、次の 3 つが見つかった。APM 本体は `242fa36` で 0.13.0 → 0.31.0 に上げ済み。

1. APM の skill install script が一度も実行されておらず、APM 管理の外部 skill が全く入っていなかった
2. APM 本体（mise 管理）が 2026-05-01 の追加以来 0.13.0 のまま更新されていなかった
3. `apm install` が `9 dependencies unpinned` を警告する

## 事実 1: APM install script の恒久 skip

- `home/.chezmoiscripts/run_onchange_after_install-claude-skills-11.sh.tmpl`
  - `# Hash: {{ include "dot_apm/apm.yml" | sha256sum }}` で gate
  - `command -v apm` が無ければ WARNING を出して `exit 0`
  - `mise env` / `mise activate` を呼ばない（他の `run_after_` installer と異なる）
- chezmoi は exit 0 でハッシュを記録する。apm が PATH に無い状態で一度走ると、`apm.yml` が変わるまで二度と走らない。
  - 本マシンでは `~/.apm/apm.lock.yaml` が存在せず、`apm.yml` を編集した 2026-09-30 の apply で初めて "First APM run detected" が出た（観測）。
- ADR-0017 K2 がこの欠陥クラスそのものを記述している:「chezmoi は exit 0 のときにハッシュを記録するため、失敗が exit 0 で返る mise install を gate すると、一度の失敗が恒久的な skip に変わる」
- ADR-0017 の型（`docs/decisions/0017-provisioning-after-deploy.md` K1-K5）
  - `run_after_` の帯: `00-` toolchain / `10-` 依存ツリー / 接頭辞なし 消費者 / `zz-` verifier
  - `10-` installer は毎回実行、`mise env --shell bash` を eval してから実行、失敗は exit 0 + marker（`home/.chezmoitemplates/record-provisioning-failure.sh`）、`run_after_zz-verify-provisioning.sh.tmpl` が marker を stat して復旧コマンドを固定文字列で表示
  - textlint installer（`run_after_10-install-textlint-deps.sh.tmpl`）は成功時の入力を `.install-state` に保存する
  - smoke テスト `scripts/smoke-provisioning-invariants.sh` が帯の順序（assertion A）、marker の衛生（D/E/J）を検査
- ADR-0018 K22 はこの script を `run_onchange_after_` に改名した（mise が apm を入れた後に走らせるため）。VM allowlist `home/.chezmoiignore:91` がターゲット名 `.chezmoiscripts/install-claude-skills-11.sh` を参照する。
- 消費者 `run_after_sync-skills.sh.tmpl` は `~/.apm/apm.lock.yaml` から除外リストを作る。現状の順序（`install-claude-skills-11` < `sync-skills`）は名前の偶然に依存している。
- APM 0.31.0 の lockfile は skill ディレクトリ行に加えてファイル単位の行も持つ。ディレクトリ行が残るので除外は機能する（2026-10-01 に apply して `~/.claude/skills` 59 件・`docx/scripts` 6 件が残ることを確認）。
- `apm install -g` の所要: 全 dependency cached で約 3.4-4.6s（ネットワークで ref を解決する）。

## 事実 2: Renovate がほとんどの更新 PR を作っていない

- Renovate は hosted（Mend）。`renovate.json` は `github>berlysia/renovate-config` を extends。preset は `config:recommended` + `schedule:weekly` + `:timezone(Asia/Tokyo)` + `group:allNonMajor` + npm の `minimumReleaseAge: 7 days` + `internalChecksFilter: strict`。
- `home/dot_config/mise/config.toml(.tmpl)` への renovate[bot] コミットは deno と yarn のみ（2026-02 〜 2026-09-20）。node / bun / pnpm / uv / `github:` 系（safe-chain 1.5.3 vs 最新 1.5.23、mo 1.5.5 vs v1.6.9、apm 0.13.0 vs 0.32.0）は更新されていない。
- `renovate/all-minor-patch` の PR は #90（2026-05-17 merged）以降 1 件も作られていない。Dependency Dashboard（issue #2）では当該グループを含む 10 ブランチが "Awaiting Schedule"、2 ブランチが "Pending Status Checks"。
- deno の PR は日曜 16:54-18:00 UTC（= 月曜 01:54-03:00 JST）に作られている。
- 2026-09-29 `4ae1d84`（agent-vm）で `home/dot_config/mise/config.toml` が `config.toml.tmpl` に変わり、`{{- if not (dig "agent_vm" false .) }}` ブロックが入った（ADR-0018 K5: VM の global mise ツールを軽量セットに絞る）。以後 Dashboard の mise 欄は `.mise.toml` のみ。
- `renovate.json` の `mise.managerFilePatterns` は `^dot_config/mise/config\.toml$`（`.chezmoiroot` 導入 `0ee3c6e` 前のパス）で、現在のどのファイルにも一致しない。rename 前に検出されていたのはデフォルトパターン `**/{,.}mise/config{,.*}.toml` 経由（下の「外部仕様の調査結果」で確定）。

## 事実 3: APM dependency の未固定

- `home/dot_apm/apm.yml` の依存はすべて ref なし（`#tag` / `#sha` 無し）で各 repo の `main` を追う。
- Renovate には `apm` マネージャがあり `home/dot_apm/apm.yml` を検出しているが、依存は 0 件扱い（Dashboard の apm 欄が空）。

## 外部仕様の調査結果（renovatebot/renovate・jdx/mise の main を 2026-10-01 に `gh api` で読んだ）

### Renovate mise manager

- デフォルト `managerFilePatterns`（`lib/modules/manager/mise/index.ts`）に `**/{,.}mise/config{,.*}.toml` がある。`**` が `home/dot_config` に一致するので `home/dot_config/mise/config.toml` は検出される（rename 前に deno PR が出ていた事実と整合）。`config.toml.tmpl` は `.toml` で終わらないので一致しない → **検出停止の原因は `.tmpl` 化で確定**。
- `.config/mise/conf.d/*.toml` のデフォルトは `**/.config/mise/conf.d/*.toml` で、`dot_config` には一致しない。
- パースは厳格な TOML（`schema.ts` の `Toml.pipe(...)`、失敗時 `parseTomlFile` が null を返す）。`{{- if ... }}` 行を含むファイルはパターンを足しても依存 0 件になる。
- バックエンド: `github:`（GitHub releases、2026-02-13 #40706 で追加）、`npm:`、`cargo:`、`go:` などに対応。
- repo の `mise.managerFilePatterns` の 2 項目は正規表現区切り `/.../` を持たないので glob として扱われ、`^dot_config/...` は何にも一致しない。`.mise.toml` と `home/dot_config/mise/config.toml` はデフォルトで検出される。

### mise の conf.d と disable_tools（手元で実測）

- `MISE_CONFIG_DIR=<tmp>` に `config.toml` と `conf.d/agent-vm.toml` を置くと `mise config ls` が両方を列挙し、conf.d の `[settings] disable_tools = [...]` が効いた（`cargo:zizmor` / `rust` / `go:...` が `mise ls --current` から消えた、3 件 → 0 件）。
- ただし `disable_tools` は global に限らず全 config（プロジェクトの `mise.toml` 含む）に効く（settings.toml の説明 "Tools defined in mise.toml that should be ignored"、`src/toolset/mod.rs` の `versions.retain(|_, tvl| !self.is_disabled(...))`）。VM 内の Rust プロジェクトが自前で宣言した rust まで無効化される。
- conf.d の fragment は `~/.config/mise/conf.d/*.toml` としてアルファベット順に読み込まれ、tools は config.toml とマージされる（上の実測で確認）。

### Renovate apm manager

- `lib/modules/manager/apm/` に存在。`dependencies.apm` の **文字列** エントリ `[host/]owner/repo[/subpath]#<ref>` のみ抽出。readme: "Only entries that pin an exact `#<ref>` are updated. Entries without a `#<ref>` are skipped." SHA pin は `# vX.Y.Z` のタグコメントが付く場合のみ更新。
- `git:` + `skills:` のオブジェクト形式は schema（`LooseArray(z.string())`）で落ちる。本 repo の依存 9 件のうち 6 件がオブジェクト形式。

### Renovate schedule と PR 作成レート

- `schedule:weekly` = `schedule:earlyMondays` = `* 0-3 * * 1`（timezone Asia/Tokyo で月曜 0:00-3:59）。
- `prHourlyLimit` のデフォルトは 2、`prConcurrentLimit` は 10（`config:recommended` は上書きしない）。Mend hosted は "usually hourly" に実行。
- 「最初に処理されたグループ以外が永久に作られない」という既知の報告は見つからなかった（UNCONFIRMED）。
- 現在 open の Renovate PR は 0 件、`renovate/*` ブランチも 0 件（残骸ブランチによる阻害は無い）。

## 影響を受ける既存の検査

- `tests/agent-vm/run-templates.sh`
  - `test_mise_full_set_outside_vm` / `test_mise_light_set_in_vm` / `test_mise_template_works_without_agent_vm_key` / `test_host_render_equals_template_without_vm_guards`: `config.toml.tmpl` をレンダリングして行の有無を検査
  - `test_install_scripts_hash_the_rendered_template`: safe-chain のハッシュ行が VM と host で異なることを検査
  - `test_skills_install_runs_after_mise_tools_and_before_sync`: `install-claude-skills-11.sh` の順序を検査
  - `test_vm_manages_exactly_the_allowlist`: `tests/agent-vm/fixtures/vm-managed.txt`（`.config/mise/**`、`.chezmoiscripts/install-claude-skills-11.sh` を含む）と一致を検査
- `scripts/smoke-provisioning-invariants.sh`: assertion A3（10- 帯の membership）、C（verifier は mise/bun を呼ばない）、D（marker ごとの復旧コマンド）
- CI: `.github/workflows/ci-agent-vm.yml`（paths に `home/dot_config/mise/**`）が `tests/agent-vm/run-templates.sh` を実行
