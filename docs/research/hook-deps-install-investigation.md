# 調査: chezmoi apply で hooks 依存が 1 回で入らない欠陥

2026-09-05 の調査記録。結論と判断は `docs/decisions/0014-hook-deps-install-phase.md`
に、不変条件の機械検査は `scripts/smoke-hook-deps-invariants.sh` にある。
本ファイルはそれらの根拠となった実測の手順と生の結果を残すためのもの。

## 1. 症状（ユーザー実測、2026-09-05）

`home/dot_claude/package.json` に `ccstatusline: 2.2.27` を追加して `chezmoi apply`:

- `~/.claude/package.json` には追加済み
- `~/.claude/node_modules/ccstatusline` は不在、`~/.claude/bun.lock` にも不在
- `run_onchange_install-packages-7c-hook-deps.sh.tmpl` のログは正常終了（`Successfully installed hook dependencies`, 3 packages installed）
- 手動 `cd ~/.claude && bun install` で `+ ccstatusline@2.2.27` が入った

## 2. 実測: chezmoi の適用順（未確認 1 の回答）

chezmoi v2.72.1 で、本番と同じ命名の最小再現環境を作って計測した
（`$CLAUDE_JOB_DIR/tmp/order-test` 〜 `order4`、隔離 HOME + `--source` / `--destination`）。

### 2.1 規則

**chezmoi は全エントリ（ファイル target もスクリプトも）を「target path の辞書順」で適用する。**
スクリプトは順番待ちの一員に過ぎず、特権はない。

計測 (`order4`): source に `dot_claude/package.json` と 3 つの probe スクリプトを置き、
各スクリプトが実行時点で `~/.claude/package.json` を読めるかを出力させた。

| source                                  | target path                | 実行時に見えた `~/.claude/package.json` |
| --------------------------------------- | -------------------------- | --------------------------------------- |
| `.chezmoiscripts/run_onchange_probe.sh` | `.chezmoiscripts/probe.sh` | `NONE`（未配置）                        |
| `dot_claude/run_onchange_aa-before.sh`  | `.claude/aa-before.sh`     | `NONE`（未配置）                        |
| `dot_claude/run_onchange_zz-after.sh`   | `.claude/zz-after.sh`      | `v1`（配置済み）                        |

`.claude/aa-before.sh` < `.claude/package.json` < `.claude/zz-after.sh` の辞書順と完全に一致する。

### 2.2 `.chezmoiscripts/` が常に先に走る理由

target path が `.chezmoiscripts/…` であり、`.ch` < `.cl` なので
**`~/.claude/` 配下のあらゆるファイルより辞書順で必ず前に来る**。
これは設計上の保証ではなく **ディレクトリ名の偶然**（`.chezmoiscripts` と `.claude` の 3 文字目 `h` < `l`）。

`run_before_` / `run_after_` プレフィックスのみがこの辞書順から抜ける
（`order-test` で `run_before` → 辞書順スクリプト群 → 全 target → `run_after` を確認済み）。

### 2.3 欠陥の再現（`order-test`, apply #2 / #3）

既存デプロイに依存 1 つを追加した状態で apply:

```
=== 7c RUNS NOW ===
7c sees deployed package.json: {"dependencies":{"NEWDEP":"1.0.0"}}   ← 旧内容
--- deployed after apply#2 ---
{"dependencies":{"NEWDEP":"1.0.0","ccstatusline":"2.2.27"}}          ← 配置は後
```

続けて変更なしで apply #3 → 7c は再実行されない（onchange hash 不変）。**恒久的に入らない。**

これがユーザー実測の症状（ログは正常、package.json は新しい、node_modules と bun.lock は古い、
「3 packages installed」= 旧依存集合）を完全に説明する。

## 3. 7c は意図した相では機能していないという帰結

（§3.1 に、無関係な後続変更が hash を再発火させた場合に限り 7c が正しく install する
偶発経路を記載する。「全シナリオで無効」ではなく「設計が意図した経路では常に無効」が正確。）

| 状況                                        | 7c の挙動                                                     | 実際に install するのは             |
| ------------------------------------------- | ------------------------------------------------------------- | ----------------------------------- |
| 新規マシン（`~/.claude/package.json` 不在） | L17-20 の early exit（`No package.json ... skipping`）        | `run_after_ensure-hook-deps` の net |
| 既存マシン（依存追加）                      | **旧 package.json に対して** `bun install` → 新依存は入らない | 誰も入れない（恒久欠落）            |

つまり 7c は「新規では何もせず、既存では古い内容で走る」。意図した仕事を一度もしていない。

### 3.1 見かけ上動いていた理由（1 apply 遅れの収束）

7c の onchange hash は **`home/dot_claude/package.json` と root `bun.lock` の両方**を追跡している
（7c L5-L6）。root 依存を触ると 7c の hash が変わり再実行され、そのとき
`~/.claude/package.json` は前回 apply で新しくなっているため正しく install される。

`order-test` apply #4 で確認: hash 入力だけを変えて再 apply すると
`7c sees deployed package.json: {"NEWDEP":"1.0.0","ccstatusline":"2.2.27"}`（現行内容）になった。

**系は「1 apply 遅れ」で収束するが、収束は無関係な後続変更に依存しており保証がない。**

## 4. セーフティネットの欠陥（ユーザー指摘の確認）

`run_after_ensure-hook-deps.sh.tmpl:9`

```bash
if [ ! -f "$CLAUDE_DIR/package.json" ] || [ -d "$CLAUDE_DIR/node_modules" ]; then exit 0; fi
```

`node_modules` ディレクトリの **存在** のみを見ており中身の充足を見ない。
新規マシン（不在）では働くが、既存マシンへの依存追加は検出できない。ユーザー指摘のとおり。

## 5. 実測: no-op `bun install` のコスト（未確認 2 に対する決定的データ）

`~/.claude` で充足済み状態の計測（bun 1.4.0）:

```
$ time bun install
Checked 120 installs across 133 packages (no changes) [10.00ms]
bun install  0.01s user 0.00s system 43% cpu  0.012 total

$ time bun install --dry-run
... [1.00ms] done
bun install --dry-run  0.00s user 0.00s system 102% cpu  0.003 total
```

**充足済みの `bun install` は 12ms、ネットワークアクセスなし。**

これは未確認 2（「充足検査をどう実装するか。全依存走査 / `--dry-run` 差分 / `bun pm ls` 突合」）を
**問いごと消す**。`bun install` 自身が最速かつ最も正確な充足検査であり、
別途検査器を書く必要がない（検査器のほうが遅く、誤検知の面が増える）。

## 6. 配置先 `~/.claude/bun.lock` の現状

- `~/.claude/bun.lock` は存在する（30030 bytes, 2026-09-05 03:37 = 手動 install 時刻）。chezmoi 非管理
- source 側は root `bun.lock` に sha512 込みで追跡済み（ユーザー指摘どおり）
- `home/dot_claude/bun.lock` は**存在しない**（workspace メンバーなので lockfile は root に集約）
- `home/dot_claude/node_modules/` は存在し、hook 依存はここに配置される
  （root `node_modules/cc-hooks-ts` は**不在** — bun は workspace メンバー依存をメンバー側に置いている）

### 6.1 却下理由の訂正確認

ユーザーの訂正は正しい。root は既に「追跡された `bun.lock` + `--frozen-lockfile`」の形で運用されている
（`run_onchange_install-packages-7b-node-modules.sh.tmpl:30`）。
`--frozen-lockfile` は bun に lockfile を書かせないためのフラグなので「衝突する」は誤り。

実際の障害はユーザーの言うとおり workspace 構造:
`package.json:workspaces = ["home/dot_claude"]` であり、root `bun.lock` は workspace lockfile で、
`~/.claude` に単体で置いても standalone lockfile として機能しない。

## 7. 影響範囲（重大度の確認）

- `home/dot_claude/.settings.base.json.tmpl:5`:
  `"command": "bun {{ .chezmoi.homeDir }}/.claude/node_modules/ccstatusline/dist/ccstatusline.js"`
  → デプロイ先 node_modules の実体パスを直接叩く。欠落 = statusline 死亡（直前コミット c759df3 の事故）
- `renovate.json:13`: cc-hooks-ts は Claude Code の hook 入力スキーマを version-for-version で追随するため
  pin が古いと hooks が本体実行前に死ぬ（2026-07 に SessionStart source=fork で実際に発生）
- したがって「hook 依存が黙って入らない」は同じ重大度クラス。**サイレント失敗である点でむしろ悪い**
  （ログは SUCCESS を出す）

## 8. option (c) の影響範囲（workspace 離脱）

- CI は `.github/actions/setup-node-bun/action.yml` で root 一回の `bun install --frozen-lockfile` のみ。
  離脱すると `home/dot_claude` 用の 2 回目の install ステップが必要
- `bun run test` = `node --test home/dot_claude/hooks/tests/**/*.test.ts`。
  依存解決は `home/dot_claude/node_modules` からの上方探索なので、そこに install されていれば動く
- `tsc --noEmit` は root から hook ソースを含めて型検査しており、同じ解決経路に乗る
- Renovate が管理する lockfile が 2 つになる（`bun.lock` と `home/dot_claude/bun.lock`）
- `bunfig.toml` の `minimumReleaseAge` は root にあり、メンバー側にも同等設定が要る可能性

## 9. 既存の検証手段

`scripts/smoke-chezmoi-scripts.sh` + `tests/smoke/<script-name>/<scenario>/setup.sh` の
smoke 基盤が既にある（現在は `run_after_sync-skills` の 2 シナリオのみ）。
隔離 HOME を作り、`chezmoi execute-template` してレンダリング結果を実行し、exit 0 を判定する。
CI は `ci-smoke-chezmoi.yml`。本件の回帰テストはこの基盤に乗る。

ただし現行 smoke は「単一スクリプトの exit 0」しか見ず、**apply 全体の順序**は検証できない。
順序の回帰を捕まえるには apply 単位の検証が別途必要。

## 10. 追加実測（レビュー中に確認）

### 10.1 `bunfig.toml` は cwd のみ・上方探索しない（§6 の未検証事項の解消）

壊れた値 `minimumReleaseAge = "NOT_A_NUMBER"` を置いた bunfig.toml で検証（bun 1.4.0）:

| 配置                 | `bun install` の結果                                    |
| -------------------- | ------------------------------------------------------- |
| cwd に配置           | `Invalid Bunfig: failed to load bunfig` でエラー → 読む |
| 親ディレクトリに配置 | 正常終了 → **上方探索しない**                           |
| どこにも無し         | 正常終了                                                |

`~/.claude` にも `~` にも bunfig.toml は存在しない（実測）ため、
**デプロイ時 `bun install` には root の `minimumReleaseAge = 604800`（1 週間隔離）と
`exact = true` が一切効いていない。** D2 の C2 案の前提は成立する。

### 10.2 実リポジトリでの target path とスクリプト順序（`chezmoi apply --dry-run --verbose`）

書き込みなしの dry-run で実物の適用順を確認した。

- スクリプトの target path は **`.chezmoiscripts/<プレフィックス除去後の名前>.sh`**。
  例: `run_after_ensure-hook-deps.sh.tmpl` → `.chezmoiscripts/ensure-hook-deps.sh`。
  §2.2 の「`.ch` < `.cl` だから `~/.claude/` より前」という説明が実データで裏付けられた
- `run_after_` 群の出現順:
  `analyze-mistakes` → `distill-insights` → `ensure-hook-deps` → `gc` →
  `refresh-go-latest-tools` → `sync-skills`。**辞書順**であり、
  `distill-insights` < `ensure-hook-deps` が確定
  （KD3 の前提。distill-insights は hook 依存 `@anthropic-ai/claude-agent-sdk` を使う）

### 10.3 既存 plan が `ensure-hook-deps` を「apply を落とさない参照実装」として引用している

`docs/plans/unmanaged-file-drift-detection.md:42`:

> 非ゼロ終了すると `chezmoi apply` 全体が exit 1 になり、後続の `run_after_` も実行されない。
> 参照実装は `run_after_ensure-hook-deps.sh.tmpl`（`set -e` を使わず `exit 0`）、
> 反例は `run_after_gc.sh.tmpl`（`set -euo pipefail`）

**`run_after_` スクリプトの非ゼロ終了は、後続の `run_after_` を全て止める。**

これは KD2（失敗時に非ゼロ終了して fail-loud にする）と
KD3（`run_after_` 群の先頭にソートさせる）を**同時に満たすと衝突する**:
先頭で hard fail すると `sync-skills` / `gc` / `refresh-go-latest-tools` が実行されなくなる。

取りうる形:

| 形                                    | 得るもの                               | 失うもの                                       |
| ------------------------------------- | -------------------------------------- | ---------------------------------------------- |
| 先頭 + 非ゼロ終了                     | 依存が先に入る + fail-loud             | install 失敗時に後続 `run_after_` が全て止まる |
| 先頭 + `exit 0`（現行の作法）         | 依存が先に入る + 後続を止めない        | fail-loud を失う（サイレント失敗の再発）       |
| 先頭で install(`exit 0`) + 末尾で検証 | 両方（`run_after_zz-verify-...` 追加） | スクリプトが 2 本になる                        |

3 番目は「作業を早く実行する」責務と「失敗を最後に大きく報告する」責務を分離する形。
改訂時に Key Decision として決着させる必要がある。

### 10.4 KD4 の CI 前提は充足済み

`.github/workflows/ci-smoke-chezmoi.yml` は `./.github/actions/install-chezmoi` で
chezmoi を導入済み。apply レベルの回帰テストはこの job に載せられる
（`paths:` フィルタが `home/.chezmoiscripts/**` と `tests/smoke/**` を既に対象にしている）。

### 10.5 既存の連番規約は stem をまたぐと順序を与えていない（prior art）

target path から prefix を除いて辞書順に並べた実際の実行順（`home/.chezmoiscripts/` 全件）:

**辞書順フェーズ（`run_onchange_` / `run_` = before/after 以外）**

```
1  install-claude-plugins-8.sh      ← 連番 8
2  install-claude-skills-11.sh      ← 連番 11
3  install-packages-0-prepare-windows.ps1
4  install-packages-0-prepare.sh    ← 連番 0
5  install-packages-1-darwin.sh
...
11 install-packages-7c-hook-deps.sh
14 update-claude-json.sh
15 update-settings-json.sh
```

**`run_after_` フェーズ**

```
1 analyze-mistakes.sh
2 distill-insights.sh    ← hook 依存 (@anthropic-ai/claude-agent-sdk) を使う
3 ensure-hook-deps.sh    ← 依存を入れる側。利用者より後
4 gc.sh
5 refresh-go-latest-tools.sh
6 reload-mcp-launchd.sh
7 sync-skills.sh
```

**発見**: 末尾埋め込みの連番（`-8`, `-11`, `-0`, `-7c`）は **stem が違うと機能しない**。
`install-claude-plugins-8` は `install-claude-skills-11` の次、そして `install-packages-0-prepare`
**より前**に走る（`install-c` < `install-p`）。連番が示唆する 0 → 8 → 11 とは異なる。

同じ stem 内（`install-packages-0/1/7/7b/7c`）でのみ意図どおり働いている。
つまり「連番で順序を与える」という既存規約は、このリポジトリで**すでに誤解を招く名前を生んでいる**。
先頭桁プレフィックス（`00-`）は数字 (0x30) が英小文字より必ず前に来るため、
この既存様式より無条件に頑健である一方、正しさを綴りに預ける点は同じ。

### 10.6 marker file の配置可否と `zz-` の位置（KD4 の前提確認）

- `~/.claude` は chezmoi 管理下のディレクトリ（`chezmoi managed` に `.claude` が出る）で、
  配下に 149 件の管理対象エントリがある
- ただし**管理ディレクトリ内の非管理ファイルは apply で削除されない**。
  実証: `~/.claude/node_modules`（47M）と `~/.claude/bun.lock` は非管理のまま
  apply をまたいで存続している（本調査の全期間で観測）。
  したがって `~/.claude/.hook-deps-install-failed` を marker として置ける
- `run_after_` 群の現在の最大名は `sync-skills`。`s` < `z` なので
  `run_after_zz-verify-hook-deps` は末尾に来る

### 10.7 §8 に欠けていた測定値（install root の実体サイズと symlink 構成）

`du -sh` と `find -type l` の実測:

| 対象                           | サイズ | 構成                               |
| ------------------------------ | ------ | ---------------------------------- |
| `home/dot_claude/node_modules` | 44K    | 実体なし。上位 10 件すべて symlink |
| `node_modules`（root）         | 7.5G   | 実体。dev ツール込み               |
| `~/.claude/node_modules`       | 47M    | 実体。デプロイ先の独立 install     |

symlink の向き先は**相対パス**（`cc-hooks-ts` は root の `node_modules/.bun/` 配下を
`../../../` 経由で指す）。

この測定は「workspace 離脱（install root を分離する方向、D2/C3）」の評価のために取ったもので、
「symlink 統合（install root を 1 つにする方向）」を否定する証拠ではない。両者は別の代替案。

### 10.8 §5 の 12ms は計器を誤っていた（実行コンテキストの取り違え）

§5 は対話シェルで `time bun install` を測ったが、`run_after_` スクリプトは
**rc を読まない非対話シェル**として実行される。実測:

- 素の PATH（`/usr/bin:/bin:/usr/local/bin` のみ）では `bun` が見つからない。
  **`bun` は素の PATH に存在しない**
- `mise env --shell bash` の所要時間: 0.07s / 0.07s / 0.07s（3 回とも）

各スクリプトは mise で環境を起こしてからでないと `bun` を呼べない
（ensure-hook-deps の L16-21）。さらに現行スクリプトは `-d node_modules` ガード（L9）が
mise ブロック（L16）**より前**にあり、充足時はこの bootstrap ごと skip している。

| 状態                 | 現行（ガードあり）   | KD2 適用後（無条件）               |
| -------------------- | -------------------- | ---------------------------------- |
| 充足済み（定常状態） | ほぼ 0（L9 で exit） | mise 約 70ms + bun install 約 12ms |

**無条件化の真の限界コストは 1 apply あたり約 80-90ms** であり、§5 の 12ms ではない。
12ms は `bun install` サブプロセス単体の値。

補足: この約 70ms 自体はコードベースにとって新規ではない
（distill-insights は既に無条件で mise bootstrap を払っている）。
新規なのは「ガードが成功系で抑制していた分」。

**分母について（比率を語る場合の注意）**: `chezmoi apply --dry-run` の実測は 0.68s / 0.58s。
ただし dry-run は**スクリプトを実行しない**ため、実 apply の所要時間はこれより必ず長い
（13 本前後のスクリプトが走り、うち少なくとも distill-insights は mise bootstrap を払う）。
したがって 0.58-0.68s は実 apply 所要時間の**下限**であり、
「80-90ms が実 apply に占める割合」の**上限**を与えるにすぎない
（上限で約 15%、実際はそれより小さい）。実 apply 自体は計測していない
（gc / distill-insights が LLM 呼び出しや knip を走らせるため副作用が大きい）。

### 10.9 verifier 到達性（KD4 の残余リスクの前提確認）

`00-install` と `zz-verify` の間の `run_after_` スクリプトが hard fail すると、
chezmoi はチェーンを止め `zz-verify` が実行されない。実際の挙動:

| スクリプト         | 失敗時                                                   |
| ------------------ | -------------------------------------------------------- |
| `distill-insights` | bun 実行失敗を捕捉して `exit 0` する。チェーンを止めない |
| `gc`               | `set -euo pipefail`（L9）。**止めうる**                  |

したがって「`gc` が hook 依存と無関係な理由で落ちると、その apply では
hook 依存の診断と復旧手順が出ない」経路が実在する。
marker は残るため次の clean な apply で自己回復するが、当該 apply では診断が隠れる。

### 10.10 `~/.claude/bunfig.toml` を root から生成できる（D2/C2 の内容決定）

chezmoi テンプレートで root の `bunfig.toml` をそのまま埋め込める。
`chezmoi execute-template` に `output "cat" (joinPath .chezmoi.workingTree "bunfig.toml")` を
渡すと root の `[install]` セクション 4 行がそのまま出力されることを確認した。
**前例の正確な範囲**（誇張しないための整理）:

| 用法                                                        | 前例                                                                                                                                               |
| ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| target ファイルが workingTree の内容から本文を作る          | **あり**。`home/Library/LaunchAgents/com.berlysia.mcp-*.plist.tmpl` が `output "jq"` で root `package.json` からバージョンを引いて本文に埋めている |
| `output "cat"` + workingTree                                | **あり**。ただし 7b / 7c / update-claude-json のハッシュコメント用途のみ                                                                           |
| `output "cat"` で target ファイルの**本文を丸ごと**生成する | **なし**。本件が初出                                                                                                                               |

機構自体は `chezmoi execute-template` で個別に実測確認済み（上記）。

**含意**: 「`minimumReleaseAgeExcludes` を複写するか」という未決事項は、
「root の `bunfig.toml` を単一の SSoT として参照する」ことで消える。

複写しない選択（隔離をより厳格にする）は**新しい失敗様式を作る**:
root は `minimumReleaseAgeExcludes = ["dax", "@berlysia/*"]` で `dax` を隔離の外に置いている。
`dax` は実際の hook 依存（`home/dot_claude/package.json` L10, `0.46.1`）であり、
`package.json` が公開 7 日未満の `dax` を pin した状態でデプロイ側だけ厳格にすると、
デプロイ側の解決だけが該当バージョンを拒否し、CI が通った構成が apply で失敗する。

### 10.12 `minimumReleaseAge` の効き方（実測、bun 1.4.0）

対象は実行時に選定した `typescript@7.1.0-dev.20260904.1`（公開から約 1 日）。

**前提 1: exact pin されたバージョンも隔離対象になるか → 真**

`bunfig.toml` に `minimumReleaseAge = 604800` を置き、当該バージョンを exact pin して install:

```
error: No version matching "typescript" found for specifier "7.1.0-dev.20260904.1"
       (blocked by minimum-release-age: 604800 seconds)
```

range 解決のみのフィルタではなく、**exact pin も拒否される**。
したがって §10.10 が述べた失敗様式（デプロイ側だけ厳格にすると
CI が通った構成が apply で失敗する）は実在する。`minimumReleaseAgeExcludes` の複写は必須。

**前提 2: 既に `bun.lock` にあるバージョンは隔離を通過するか → 真**

隔離なしで解決して `bun.lock` を作り（9 箇所に当該バージョンが記録された）、
`package.json` と `bun.lock` だけを新しいディレクトリへ持ち込んで
隔離ありで install したところ、`+ typescript@7.1.0-dev.20260904.1` が 4ms で入った。

**C2 の効果範囲への含意**:

- 隔離が効くのは**各バージョンの初回解決時のみ**。lockfile に入った後は素通りする
- これは狙いどおりの箇所で効いている（悪意ある新規公開が lock に**入る**のを止める）
- ただし **C2 導入前に既に `~/.claude/bun.lock` に入っているエントリは遡って検査されない**。
  C2 が守るのは今後の解決であって、既存 lock の内容ではない

### 10.11 C2 の成立条件: `~/.claude/bunfig.toml` は installer より前に配置される

`~/.claude/bunfig.toml` の target path は `.claude/bunfig.toml` であり、
**target ファイル**である。§2.1 / §10.2 で確立した相の順序
（run*before → ASCII 順フェーズ（スクリプトと target が混在）→ 全 target 配置完了 → run_after）
により、target は必ず `run_after*` フェーズより前に配置される。

installer は `run_after_00-install-hook-deps` に置かれるため、
`bun install` が走る時点で `~/.claude/bunfig.toml` は既に存在する。C2 は機能する。

（`.chezmoiscripts/` に置いた場合は逆に機能しない。`.ch` < `.cl` により
bunfig 配置より前に走ってしまう。これは 7c が壊れているのと同じ理由。）
