# Research: agent-vm で共有される node_modules とプラットフォーム別ネイティブパッケージ

## 問題

agent-vm は repo を同じパスで OrbStack isolated machine にマウントする（`home/dot_local/bin/executable_agent-vm:365-369` の `vm_mounts`、`"$2:$2,"`）。
`node_modules` は mac（darwin-arm64）と VM（linux-arm64, glibc）で物理的に同じディレクトリになる。

TS7 などは、プラットフォーム別のバイナリを optionalDependencies の別パッケージとして配布し、実行時に選ぶ。
`node_modules/typescript/lib/getExePath.js:22` は `"@typescript/typescript-" + process.platform + "-" + process.arch` を解決し、無ければ `Unable to resolve` で落ちる。
package manager は install したプラットフォームの optionalDependencies しか置かないので、mac で install した `node_modules` は VM で使えない（逆も同じ）。
oxlint / oxfmt / oxc-parser / oxc-resolver の binding も同じ方式（このリポジトリの `node_modules/.bun` で確認）。

対象は agent-vm で作るすべての machine と、それに対応する host の repo。repo 側に設定を足す作業は要求しない。

## 環境の前提（コードで確認）

- PM のグローバル設定は chezmoi 管理で、host と VM に同じ内容が届く。host/VM の分岐は無い。
  - `home/dot_config/pnpm/rc`（static）、`home/dot_yarnrc.yml`（static）、`home/modify_private_dot_npmrc`（固定ヘッダ + 既存 `_authToken` 行のみ保持）
  - VM 許可リスト: `home/.chezmoiignore:62-65`
  - bun のグローバル設定（`$XDG_CONFIG_HOME/.bunfig.toml`）は配っていない。`home/dot_claude/private_bunfig.toml.tmpl` は `~/.claude` 専用。
- install 時スクリプトは全体で無効: pnpm `ignore-scripts=true`、yarn `enableScripts: false`、npm `ignore-scripts=true`。
  したがって node-gyp や postinstall で現在のプラットフォーム向けの成果物を作る依存は、今の環境ではもともと install 時に何も作られない。
  `node_modules` の中身のプラットフォーム依存は、実質「どの optionalDependencies を置いたか」だけで決まる。
- VM の PM は host と同版（`home/dot_config/mise/config.toml`）: node 24.15.0、npm 12.1.0、pnpm 12.1.0、yarn 4.18.0、bun 1.4.0。
- VM ユーザーはパスワードなし sudo を持つ（ADR-0018 R6、`docs/decisions/0018-agent-vm-orbstack.md:74`）。
- VM の claude / codex は `orb -m $m bash -lc` で起動する（`executable_agent-vm` `session_exec`）。login shell なのでシェルの profile で export した環境変数が届く。
- 起動時の通知は `run_tool` 内、`notice_gh_token_expiry`（`executable_agent-vm:1217` 付近）の後が既存の `notice_*` と同じ並び。
  書式は `step()` による 1 行 `agent-vm: <状況>; recover: <コマンド>`、非致命（`return 0`）。docs の警告表は `docs/agent-vm.md:57-67`（場面 / 条件 / 回復手順）。

## 実験（PM ごと）

条件: 使い捨てディレクトリで typescript 7.0.2 + oxlint 1.81.0 を install。グローバル設定は `XDG_CONFIG_HOME` / `NPM_CONFIG_USERCONFIG` / 親ディレクトリの rc で再現し、実際のユーザー設定と `HOME` には触れていない。
Linux 側は OrbStack の docker（`node:lts-slim`、aarch64、Debian glibc 2.36）に同じディレクトリを同じパスでマウントして実行した。

| PM | ユーザー単位で両 OS を入れる手段 | 結果 | lockfile | repo 側設定との関係 | 既存 node_modules への追加 |
|---|---|---|---|---|---|
| yarn 4.18.0 | グローバル `.yarnrc.yml` の `supportedArchitectures` | 成立 | 不変 | 配列は連結。repo の `os: [current]` は linux を消せない | 普通の `yarn install` 1 回で追加 |
| pnpm 12.1.0 | 環境変数 `pnpm_config_supported_architectures`（JSON）または CLI `--os/--cpu/--libc` | 成立 | 不変 | 環境変数が repo の `pnpm-workspace.yaml` を丸ごと置き換える（連結しない） | 普通の `pnpm install` 1 回で追加 |
| bun 1.4.0 | CLI の `--os=darwin --os=linux --cpu=arm64`（`=` 付きの繰り返し） | 成立 | 不変 | — | 追加的。以後の普通の `bun install` でも消えない |
| npm 12.1.0 | なし | 不成立 | 不変 | repo の `.npmrc` の `os` が優先 | 指定した 1 プラットフォームに入れ替わる |

すべての成立ケースで、同じ `node_modules` から mac と Linux の両方で `tsc --version`（7.0.2）と `oxlint --version`（1.81.0）が通った。
対照として、darwin のみの `node_modules` は Linux で落ちた（bun 実験）。

### PM ごとの詳細

- **yarn**: 未設定時は `['current']`。グローバル rc は ancestor rc と同様にマージされる。既定の nodeLinker が pnp かどうかは未検証（pnp なら `node_modules` を作らず本問題の対象外）。
- **pnpm**: グローバル設定ファイルでは書けない。`pnpm config set -g supported-architectures` は `ERR_PNPM_CONFIG_SET_UNSUPPORTED_YAML_CONFIG_KEY`。`config.yaml` / `rc` に手書きした 5 通りの書式は警告なしに無視された。`npm_config_supported_architectures` は効かない。libc で絞っても musl 版も入る（1 パッケージ余分、無害）。
- **bun**: bunfig の `[install]` に os/cpu キーは無い（1.4.0 バイナリの文字列から確認）。`--os=linux,darwin` はエラー、`--os linux --os darwin`（`=` なし）は 2 つ目が無視される。`--os='*' --cpu='*'` は 629M（基準 44M）、`darwin+linux arm64` は 97M。libc を区別しない（gnu と musl の両方）。新規の単一パッケージ project の既定は hoisted。
- **npm**: `os`/`cpu`/`libc` は `[null, String]` 型で単一値。配列・カンマは無効、繰り返しは最後が勝つ。linux 指定の install は darwin を消して linux に入れ替える（"added 2, removed 2"）。`--no-save --force <linux pkgs>` で一時的に共存できるが、次の普通の `npm install` で消える。

## 分析

### 解決の方向

1. **A'（PM ごとのグローバル設定で両 OS を置く）**: yarn（rc）、pnpm（環境変数）、bun（install 時のフラグ、ラッパーが必要）は成立。npm は不成立。
   - 仕組みが PM ごとに 3 種類（rc / 環境変数 / ラッパー）に分かれる。
   - 環境変数とラッパーはシェルを経由しない起動（エディタのタスク等）に届かない。
   - pnpm は repo の `supportedArchitectures` を置き換えてしまう。
   - bun は libc を区別せず、新しく追加した依存は次のフラグ付き install まで片側だけになる。
   - 非 VM の repo にも適用される（ディスク増、bun で約 2 倍の例）。
2. **B'（VM 側だけ `node_modules` を VM ローカルに差し替える）**: PM に依存しない。VM の中で `sudo mount --bind` を起動ごとに行う。
   - host と VM が同じ lockfile から別々に install する。両側で install が要る。
   - workspace の各パッケージの `node_modules` の扱いが未調査。pnpm / bun isolated は実体がルートのストアにあり各パッケージ側は相対 symlink なので、ルートだけ差し替えれば足りる可能性がある（未検証）。npm / yarn の hoisted で入れ子にコピーされる場合は別途扱いが要る。
   - セッション中に VM で新しく作られた入れ子の `node_modules` は host に漏れる。
   - PM のユーザー設定を変えないので、非 VM の repo に影響しない。
3. **検出と通知**: どちらの方向でも、起動時に「VM で使えない `node_modules`」を検出して回復手順を出す層が別に要る（グローバル規約「Recoverable State Must Announce Itself」）。

## B' の成立性検証（2026-10-02、ユーザーの選択: B'）

条件: scratchpad に pnpm workspace の試験用 repo を作った。ルートの devDependencies は oxlint 1.81.0、`packages/a` の devDependencies は typescript 7.0.2。
`agent-vm prewarm` で使い捨ての machine（`agent-bindtest-1729ff`、golden から clone）を作り、検証後に `agent-vm rm` で削除した。

1. host で `pnpm install` した。`packages/a/node_modules/typescript` は `../../../node_modules/.pnpm/typescript@7.0.2/node_modules/typescript` への相対 symlink で、実体はルートの `.pnpm` にだけある。
2. VM 内で `sudo mount --bind /var/lib/agent-vm/nm/bindtest <repo>/node_modules` を実行した（このコマンドは Claude の保護フックが `node_modules` への権限操作として拒否したため、ユーザーが `!` で実行した）。
   `findmnt` の結果、差し替え先は VM 自身のディスク（`/dev/vdb1`、btrfs）だった。
3. 別の `orb -m` 呼び出しからも mount が見えた（中身は空）。起動のたびの `orb -m ... bash -lc` で作られるセッションにも効く。
4. VM で `pnpm install` すると、VM ローカルのルートに `typescript-linux-arm64` と `binding-linux-arm64-gnu` が入った。VM で `tsc --version`（`packages/a` から）は 7.0.2、`oxlint --version` は 1.81.0 で通った。
5. VM の install 後も、host の `node_modules/.pnpm` は darwin の 2 つのままだった。`packages/a/node_modules/typescript` の symlink は時刻も先も変わらず、host でも `tsc` と `oxlint` が通った。
   相対 symlink はプラットフォームに依存しないため、ルートだけを差し替えれば workspace の各パッケージにも効く（pnpm で確認）。

## hoisted workspace の追加実験（2026-10-02、host のみ）

条件: workspace のルートと `packages/a`、`packages/b` を作った。
- Case A: a と b が同じ版（typescript 7.0.2、oxlint 1.81.0）。
- Case B: b だけ別の版（typescript 7.0.1-rc、oxlint 1.80.0）。typescript の安定版の 7.x は 7.0.2 しか無いため、rc を使った。

| PM / linker | Case A | Case B |
|---|---|---|
| npm workspaces | ルートにだけ実体。`packages/*/node_modules` は無い | ルートに実体 ＋ `packages/b/node_modules` に実体（`@typescript/typescript-darwin-arm64` など） |
| yarn berry（node-modules） | npm と同じ | npm と同じ |
| bun 既定（isolated） | ルートの `.bun` にだけ実体。各パッケージは symlink | 同左（版ごとに `.bun` に実体） |
| bun `--linker hoisted` | ルートにだけ実体 | ルートに実体 ＋ `packages/b/node_modules/typescript/node_modules/@typescript/...` に実体 |
| pnpm 既定 | ルートの `.pnpm` にだけ実体。各パッケージは symlink | 同左 |

- yarn berry の既定の nodeLinker は `pnp` だった（`.yarnrc.yml` の無い新規 project で `yarn config get nodeLinker`）。
- プラットフォーム別パッケージは、通常のパッケージと同じ規則（バージョンの衝突で入れ子になる）で置かれる。

### 未検証

- npm / yarn の lockfile を Linux で作った場合の配置。
- 旧記載: npm / yarn の hoisted workspace で、入れ子の `node_modules` に実体（プラットフォーム別パッケージを含む）がコピーされる場合の扱い。bun isolated も未確認（pnpm と同じ構造の見込み）。
- machine の再起動後に mount が消えるか（消える前提で、起動のたびに張り直す設計にする）。
- host 側に `node_modules` が無い repo では、mount 先のディレクトリを作る必要がある。host 側で `rm -rf node_modules` したときに、VM 側の mount がどうなるか。
- Claude の保護フックは、VM 内の `node_modules` への mount を拒否する。agent-vm のスクリプトの中で実行するぶんにはフックの対象外だが、VM の Claude が手で張り直すことはできない。
- alpine / musl、x64 Linux（現 VM は arm64 glibc のみなので対象外の見込み）。

## V1 / V2 の結果（plan-1 T0、2026-10-02）

条件: scratchpad の試験用 repo（`.../scratchpad/v1`）に対して、`agent-vm prewarm` で machine `agent-v1-11b482` を作った。ユーザーが `!` で plan-1 T0 の `v1.pl` を実行し、検証後に `agent-vm rm` で machine を削除した。

| 項目 | 観測 | 判定 |
|---|---|---|
| V1（fd 経由の mount） | `mount exit: 0`。readlink src / dst は期待どおり。mountinfo の mountpoint 欄は `<R>/pkg/node_modules` | 合格。`FD_MOUNT = 1` |
| V2（mount 後の device:inode） | dst `64:113843` = src `64:113843` | 合格 |
| root 欄の形式 | `/scon/containers/01M3XFQBE6BYMPFZTZD8ZDXMJP/rootfs/var/lib/agent-vm-v1/data`（subvolume の接頭辞の後に、パスが丸ごと現れる） | 合格（末尾一致で判定できる） |
| `/var/lib` のファイルシステム | `/dev/vdb1[/scon/containers/<id>/rootfs] btrfs`（rootfs と同じ） | 合格 |
| major:minor と st_dev | mountinfo の第 3 欄は `0:37`、`stat` の st_dev は 64（= `0:64`）。一致しない | plan-1 で `DEV_CHECK` を廃止した判断を裏付ける |
| host が作った `node_modules` の uid | 501。VM の `id -u` も 501 | 合格（所有者の検査が通る）。**訂正**: VM のユーザーで測った値で、root の perl の検査とは別の量だった。下の「V3 の中断」を参照 |
| `/var/lib/agent-vm` | 存在しない | `prepare` が root 所有で作る |

## V3 の中断: 共有 mount の所有者は「見る側の uid」で返る（plan-3 T5、2026-10-02）

条件: scratchpad の試験用 repo（`.../scratchpad/nm check`、npm workspace）に、`agent-vm prewarm` で machine `agent-nm-check-660f1b` を作った。plan-1〜3 を `chezmoi apply` した後である。

| 観測 | 結果 |
|---|---|
| `agent-vm node-modules-sync <R>` | 終了コード 1。`some packages could not be mounted` |
| VM でヘルパーを直接実行 | ルートと `packages/a` の両方で「mount 先が VM のユーザーの所有でない」という警告 |
| VM のユーザーで `stat` | `501:501` |
| `sudo -n stat`（root） | `0:0` |
| 普段の repo（`agent-chezmoi-23810b`、`/Users/berlysia/.local/share/chezmoi`、virtiofs） | VM のユーザーは `501:501`、root は `0:0`。同じ |
| root の perl で、開いた fd を `fstat` | `$> = 0` では 0。`$> = SUDO_UID` に切り替えると 501。戻すと 0。inode は同じ |

結論:
- OrbStack の virtiofs は、所有者を「見ている側の実効 uid」として返す。
- ヘルパーの root の perl が行う所有者の検査（`PRIV_PL` の `mount` の `(stat $dst)[4] == $uid`）は、共有 mount の上で必ず失敗する。どの repo でも、差し替えは一度も成立していなかった。
- 上の表の「host が作った `node_modules` の uid 501（所有者の検査が通る）」は、VM のユーザーで測った値で、root の perl の検査とは別の量を測っていた（計器の側の誤り）。
- plan-1 の統合テストは、fixture を VM ローカルの btrfs（`mktemp -d`）に置くので、この挙動を再現しない。
- 実効 uid を VM のユーザーにして fd を `fstat` すると 501 が返る。ただし次の実測のとおり、これは実際の所有者ではない。

追加の実測（plan-4 Round 1 の指摘を受けて、`agent-chezmoi-23810b`、repo の `.tmp/owner-probe/f`）:

| 操作 | 結果 |
|---|---|
| VM で `sudo chown 1234:1234 f` | 終了コード 0 |
| VM のユーザーで `stat` | `501:501` |
| root で `stat` | `0:0` |
| root の perl で `$> = 501` にして `stat` | 501 |
| root の perl で `$> = 1234` にして `stat` | 1234 |
| host で `stat` | `501:20`（chown は host に反映されない） |

結論: virtiofs の上の所有者は、見ている側の実効 uid の写しで、ファイルの属性として観測できない。共有 mount の上では、どの uid の目で見ても「mount 先の所有者」の検査は情報を持たない。

## V3〜V6 の結果（plan-3 T5、plan-4 の修正の後、2026-10-02）

条件: 同じ試験用 repo と machine `agent-nm-check-660f1b`。plan-4（cf660b6）を `chezmoi apply` して `agent-vm prewarm` で machine に届けた後。docs の V26〜V29 に当たる。

| 項目 | 観測 | 判定 |
|---|---|---|
| V3 の 1〜2 | sync は 0。ルートと `packages/a` の 2 行。root 欄は `/scon/containers/<id>/rootfs/var/lib/agent-vm/node_modules/<key>/data` | 合格 |
| V3 の 3〜4 | ユーザーが host で `node_modules` を消して作り直した。VM の mountinfo の行は `//deleted` にならず、元のパスのまま | plan-1 の前提（`//deleted` になる）は成り立たない |
| V3 の 5 | sync は 0。ルートの行が一覧の末尾に移り（張り直したと読める。前の mount id は控えていない）、device:inode は `data` と一致 | 合格 |
| V3 の 6 | host で worktree を足して sync すると、mount 4 本と保存先 4 つ。host の `git worktree remove` は 0 で、VM の行は元のパスのまま。次の sync（0）で行が外れ、保存先は 2 に回収 | 合格 |
| V4 | host: `npm install`、`tsc` 7.0.2、`oxlint` が 0（darwin-arm64）。sync は install を促す 1 行と 0。VM: `npm install`、`tsc`、`oxlint` が 0（linux-arm64）。その後の host も 0（darwin-arm64 のまま）。host の `packages/a/node_modules` は npm の実物で、install のやり直しも 0 | 合格 |
| V5 | `npm ci`、`pnpm@10 install --force`、`yarn@1 install`、`bun install --force`（VM の mise の bun 1.4.0）がすべて 0。4 パッケージとも mount は保たれた。`npx bun@1` は postinstall が走らずに失敗（mount と無関係）したので、VM の bun に差し替えた | 合格 |
| V6 | VM の Claude の `git-worktree-create v6` は、保護フックに止められずに 0。6 パッケージ分の mount。`git-worktree-cleanup v6` は、commit の無い worktree なので端末の無い Claude からは残した（仕様）。`agent-vm shell` で `y` と答えると消え、mount の行も保存先（12 から 6）も残らなかった | 合格 |

`//deleted` について: host 側で mount 先を消しても、virtiofs では VM の mountinfo の行は元のパスのまま残る。sync はそのパスで失効を検出して外し、張り直す（回収もできる）。自分の行の判定の「`//deleted` を除く」条件は、この経路では使われなかった。判定は誤った振る舞いをしていないので、変えない。
