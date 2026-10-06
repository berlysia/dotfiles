# ADR-0017: ツールチェーンと root 依存の install を配置後フェーズへ移し、`run_after_` に帯の命名を導入する

## Status

accepted (2026-09-29)

## Context

2026-08-31 から 2026-09-12 まで、`chezmoi apply` は同じ場所で止まり続けた。`bun` の pin 変更と `bun.lock` の形式更新が同じ apply に届き、`run_onchange_install-packages-7b-node-modules.sh.tmpl` が古い bun で lockfile を読めずに失敗したためである。その結果 `~/.config/mise/config.toml` も `~/.claude/` 配下も配置されず、以後のすべての apply が同じ失敗を繰り返した。詳細は `.tmp/sessions/01723582/research.md`「詰まりの機序」に記録してあり、観測は次の 8 点である。

1. chezmoi の適用順は「`run_before_` → 全 target エントリを target 名の ASCII 順 → `run_after_`」である。before/after の付かないスクリプトは、ファイルと混ざって ASCII 順で走る
2. `.chezmoiscripts/` 配下のスクリプトの target 名は `.chezmoiscripts/<名前>` として並ぶ。`.ch` < `.cl` < `.co` なので、`~/.claude/` と `~/.config/` より必ず先に走る（v2.72.1 の実験と `chezmoi apply --dry-run --verbose` の diff 順で確認）
3. 旧 script 7 は source 側の `dot_config/mise/config.toml` をハッシュする一方、`mise install` が読むのは配置前で古いままの `~/.config/mise/config.toml` である
4. chezmoi は `run_onchange_` のハッシュを exit 0 のときだけ記録する。記録はスクリプトごとに独立したトランザクションなので、後続のスクリプトが apply を中断しても取り消されない
5. script 7 は `mise install` が失敗しても WARNING を出して exit 0 で終わる。失敗したインストールも「実行済み」として記録される
6. 旧 7b は `mise env` 経由で bun を得る。`bun install --frozen-lockfile` が失敗すると exit 1 になる
7. apply は非ゼロ終了したエントリで残りをすべて打ち切る（`--keep-going` がない場合）
8. 以上の結果、script 7 は古い config で成功扱いになりハッシュが記録される → 7b が古い bun で失敗して apply が止まる → config が配置されない → 次の apply でも script 7 は再実行されず 7b がまた失敗する、というループになる

これは ADR-0014 が `~/.claude/package.json` について解いた問題と同じ種類である。ADR-0014 は hook 依存の install を `run_after_` へ移したが、同じ性質を持つ `~/.config/mise/config.toml` 依存のスクリプト（mise install の 7、root の `node_modules` の 7b、safe-chain）は ASCII 順フェーズに残っていた。

## Decision

設計の詳細は `.tmp/sessions/01723582/spec.md` の Key Decisions K1-K8 にあり、要点は次のとおりである。

### K1. ツールチェーンと依存ツリーの install を `run_after_` へ移す

ASCII 順フェーズのスクリプトは、同じ apply が配置する `~/.config/mise/config.toml` を読めない。ADR-0014 と同じく、条件ではなく相の問題として扱う。mise install を `run_after_00-install-mise-tools`、root の依存 install を `run_after_10-install-root-deps` に移し、旧 script 7 と 7b は削除する。旧 script 7 の後半にあった PATH・GOPATH・cargo 環境の export は持ち込まない。chezmoi はスクリプトごとに別プロセスを起こすので、export は後続スクリプトに届かないからである。

### K2. mise install と root deps install はハッシュで gate せず毎回実行する

chezmoi は exit 0 のときにハッシュを記録するため、失敗が exit 0 で返る mise install を gate すると、一度の失敗が恒久的な skip に変わる。実測コストは mise 0.02-0.05s、root bun 0.01-0.09s で、インストール済みの `latest` 指定ツールは再解決されない。safe-chain は `run_onchange_after_` に据え置く。実行のたびにシェル rc ファイルを退避・復元する副作用があり、再実行が必要になる契機は config 上の safe-chain バージョン変更だけで、`run_after_` 相では source と配置先の config が一致しているためハッシュがその契機を正確に表すからである。

### K3. `run_after_` に帯の命名を導入し、ADR-0014 の `00-`/`zz-` 予約を置き換える

`run_after_` の中の順序を決める唯一の手段は名前なので、次の帯を定める。

| 帯         | 役割                                                         |
| ---------- | ------------------------------------------------------------ |
| `00-`      | ツールチェーン（後続のスクリプトが実行するバイナリを入れる） |
| `10-`      | 依存ツリー（後続のスクリプトが読み込むパッケージを入れる）   |
| 接頭辞なし | 消費者（`reload-mcp-launchd`、`sync-skills` など）           |
| `zz-`      | 最終判定（verifier）                                         |

ADR-0014 の「`00-` と `zz-` は本機構専用に予約する」規則は、この帯の定義に置き換える。`00-install-hook-deps` は `10-install-hook-deps` に改名する。帯に属する installer は後段の消費者に対して互いに順序を持たないので、`10-` 帯の中の並びは検査しない。smoke テストの assertion A3 は「2 番目から連続する `10-` の entry の中に `10-install-hook-deps` と `10-install-root-deps` がある」を検査する。位置の完全一致にすると、無関係な依存ツリー installer である `10-install-textlint-deps` が帯に加わった時点で、帯の意味を守ったままでも失敗するからである。

### K4. root deps の失敗は exit 0 + marker とし、verifier を汎用化する

ユーザーが 2026-09-12 に選んだ方針である。root deps の失敗は `~/.claude/.root-deps-install-failed` に記録して exit 0 とし、`run_after_zz-verify-provisioning` が hook-deps と root-deps の marker をどちらも検査して、marker ごとに症状と復旧コマンドを固定文字列で出す。`mise install` の失敗は現状どおり WARNING のままとし、fail-loud にはしない（同日のユーザー選択）。この非対称性は Consequences に残余として記録する。

### K5. marker の書き込みを `.chezmoitemplates` の partial に共通化し、一時ファイルを `mktemp` で作る

`home/.chezmoitemplates/record-provisioning-failure.sh` に書き込み手順（`mktemp` で同じディレクトリに新しい一時ファイルを作る、固定 3 フィールドを書く、`chmod 600`、`mv -f`）をまとめ、2 つの installer が include する。別々に書くと、「mode 600 / stderr を写さない」がどちらか一方でずれうる。旧来の `${MARKER_FILE}.tmp.$$` という予測できる名前は、noclobber を組み合わせても FIFO や `/dev/null` への symlink では書き込みが通ること、PID の再利用で残骸と衝突して soft failure が exit 1 に変わることが再現されたため使わない。marker のパスがディレクトリの場合は、`mv -f` がその中へ移して成功を返すため、書き込み前に失敗として扱う。

### K6. assertion F を「ASCII 順フェーズで mise や bun を呼ばない」に汎用化する

検出対象は `mise install` / `mise env` / `mise activate` / `bun install` の呼び出しで、対象は `.sh.tmpl` だけである。`log` / `echo` / `printf` で始まる行は呼び出しではないので除外する。

### K7. 設計記録は本 ADR とし、ADR-0014 は supersede せず amend する

ADR-0014 の KD1-KD4 と KD6 は有効なまま残る。変わるのは予約規則と、verifier・installer・smoke テストの名前だけである。ADR-0014 には `Amended by` 節を足す（書式は ADR-0001 に合わせる）。番号は当初 0016 を予定したが、`0016-hook-telemetry-wrapper.md` が先に使ったため 0017 に振り直した。

### K8. smoke テストを `scripts/smoke-provisioning-invariants.sh` に改名し、CI の paths に `home/.chezmoitemplates/**` を足す

assertion J（root deps）と K（ツールチェーン）が加わると、ファイル名の「hook-deps」は中身と一致しない。partial は smoke テストが実行するので、partial だけを変えたときにも CI が走るよう paths に加える。レンダリングは `render_script` ヘルパーにまとめ、テンプレートが無い、または描画に失敗したときは FAIL を記録して `exit 97` の代替スクリプトを出す。`set -euo pipefail` の下で 1 ファイルの欠落がスクリプト全体を止めないようにするためである。

## Consequences

spec.md の Risks R1-R11 を、本 ADR の時点で受け入れた残余として引き継ぐ。

- **R1**: `10-` と `zz-` の間にある `run_after_` が hard fail すると（`gc` は `set -euo pipefail`）、verifier に届かず、その apply では root-deps の失敗も報告されない。marker は残るので次の clean な apply で報告される。ADR-0014 が受け入れたものと同じ条件である
- **R2**: `mise install` の失敗は WARNING だけで marker を書かない。bun が入らないと `10-install-hook-deps` と `10-install-root-deps` は「bun not found」の WARNING で skip し、verifier も何も報告しない。今回の事故と同じ「失敗が apply の終了コードに現れない」形がツールチェーン層に残る。緩和しているのは、install が毎回再試行されること（K2）と WARNING が apply のたびに出ることだけである
- **R3**: safe-chain のバイナリが無い状態で `run_onchange_after_install-safe-chain` が exit 0 で skip すると、ハッシュが記録され、config が次に変わるまで再試行されない。発生するのは mise install が safe-chain の導入に失敗した場合に限られ、そのとき R2 の WARNING が出る。復旧手段は `safe-chain setup` の手動実行である
- **R4**: 改名で古い名前への参照が残りうる。`docs/plans/unmanaged-file-drift-detection.md` と textlint installer のコメントは更新した。ADR-0014 と `docs/research/hook-deps-install-investigation.md` は当時の記録なので書き換えない
- **R5**: 詰まった状態のマシンに変更が届いても、変更後の ASCII 順フェーズには 7b が無いのでファイル配置は止まらない。chezmoi state に残る旧 7/7b のハッシュ記録は、同じ内容のスクリプトがもう存在しないので参照されない
- **R6**: apply ごとに約 0.03-0.14s が増える。ADR-0014 が受け入れた hook-deps の約 80-90ms と同じ桁である
- **R7**: `00-install-mise-tools` は mise 本体が無いと exit 1 で終わり、verifier を含む以降の `run_after_` をすべて止める。旧 script 7 と同じ判断を引き継ぐが、旧来は全エントリの配置まで止めていたので、止まる範囲は狭くなる。mise 本体の不在は bootstrap が終わっていないことを意味し、chezmoi 自身のエラー出力で即座に目に見える
- **R8**: `run_after_` 内の帯の順序を保証するのは chezmoi ではなく CI の assertion A1-A3 である。assertion A は実際のディレクトリから順序を導出するので、追加や改名は必ず検査されるが、CI を通すまで気づかない
- **R9**: Linux の初回 bootstrap で、`curl https://mise.run | sh` が入れた `~/.local/bin/mise` が同じ apply の `run_after_` プロセスの PATH に載っていない場合は R7 の経路で止まる。旧 script 7 も別プロセスで `command -v mise` を見ていたので、PATH の継承条件は変更の前後で同じである。Linux 実機での初回 bootstrap は本件で検証していない
- **R10**: safe-chain は、改名とコメントの追加でスクリプトの内容ハッシュが変わるため、変更後の最初の apply で一度だけ再実行される。rc ファイルの退避と復元は配置済みの rc ファイルに対して行われるので、失われるものはない
- **R11**: marker を書けないとき installer が exit 1 で終わり、verifier を含む以降の `run_after_` をすべて止める経路が、2 つの installer にまたがる。発火するのは install の失敗 **かつ** `~/.claude` に書き込めない二重障害に限られ、復旧コマンドを ERROR ログに出してから止まる
- Windows の `run_install-packages-7-windows.ps1.tmpl` は移さない（非提供）。plain `run_` でハッシュ gate が無く apply のたびに `mise install` を実行するため、config 変更は次の apply で反映される。後段の 7b と hook-deps は `ne .chezmoi.os "windows"` で除外されていて詰まりの連鎖が起きない。Windows で bun に依存する後段スクリプトが加わった時点で見直す。検証環境も CI ジョブも無い
- `mktemp` と `mv` の間で強制終了されると、`~/.claude` に `*.tmp.XXXXXX` が残りうる。verifier は marker の正確なパスしか見ないので、残骸が失敗や成功と誤読されることはなく、判定には影響しない（片付けの問題に留まる）
- `home/.chezmoitemplates/` の partial は chezmoi にテンプレートとして描画される。`#` はコメントとして扱われないため、partial の中に、コメントの中であっても `{{ }}` の区切りを書いてはならない。使い方の例を実際の区切り付きで書くと partial が自分自身を include し続け、`exceeded maximum template depth` で描画に失敗する（Round 5 で実際に発生した）。partial 内の使い方の説明は、区切りを含めない文章で書く
- 本 ADR の不変条件は `scripts/smoke-provisioning-invariants.sh` で機械的に守られ、`.github/workflows/ci-smoke-chezmoi.yml` に配線されている

## Amended by

- `git show 52dc6fd447:docs/plans/dependency-update-paths/spec.md` (2026-10-01) — APM の skill installer（旧 `run_onchange_after_install-claude-skills-11`）を `run_after_10-install-apm-skills` として 10- 帯に加えた。K2 の「ハッシュで gate せず毎回実行する」に対し、成功した install の後にだけ書く `~/.apm/.install-state` で `apm install -g` を省く installer を名前付きの例外として認める。失敗時は state を消し、marker がある間は省かないので、一度の失敗が恒久的な skip に変わることはない。verifier が見る marker は `.hook-deps-install-failed`・`.root-deps-install-failed`・`.apm-skills-install-failed` の 3 つになった。K4 の installer と異なり、apm が PATH に無いことも marker にする（bun と違い、apm の不在は他の場所で目に見える失敗を起こさない）。K1-K8 の決定は supersede しない
- スキル許可リスト管理（Skill auto-approve checklist）— `Skill(...)` の許可を `skill-approvals.md` と供給源から `scripts/skill-inventory.sh` で計算する変更（2026-10-03、計画の題は「グローバルスキルの Skill 許可をチェックリスト md で管理する」）。次の 3 点を足した。(1) verifier が見る marker は 5 つになった（`.skill-allow-failed`、`.skill-approvals-sync-failed` を追加。textlint-deps の marker は従来どおり verifier の対象外）。(2) `run_onchange_update-settings-json` は `skill-inventory.sh allow` の失敗を fail-soft にする。K4（run_after の installer が exit 0 + marker）の対象外の段への例外で、理由はこの段が `~/.claude` の配置より前に走るため、ここで止めると本 ADR が防ぐ「以降の配置の打ち切り」を再現するから。失敗時は既存の `settings.json` にある `Skill(...)` を引き継ぎ（許可が前回から減らない）、marker を書いて exit 0 とする。fail-soft の exit 0 でハッシュが記録されても失敗が恒久的な skip に変わらないよう（K2 の趣旨）、marker の内容を Hash 行に入れ、失敗が続く間は次の apply でも再実行させる。復旧した apply が marker を消すと Hash は marker 無しの値に戻る。marker は run_onchange 用と run_after 用（`run_after_update-skill-approvals`、`sync-md` の失敗）で分け、毎回走る run_after の成功が run_onchange の失敗報告を消さないようにした。(3) K5 の partial `record-provisioning-failure.sh` の include 先は 6 つになった（既存の hook-deps、root-deps、apm-skills、textlint-deps に、settings-json と update-skill-approvals が加わる。実装時に `grep -rl record-provisioning-failure home` で数え直した）。K1-K8 の決定は supersede しない

## References

- `home/.chezmoitemplates/record-provisioning-failure.sh` — marker 書き込みの共有 partial
- `home/.chezmoiscripts/run_after_00-install-mise-tools.sh.tmpl` — ツールチェーン installer
- `home/.chezmoiscripts/run_after_10-install-hook-deps.sh.tmpl` — hook 依存 installer（旧 `run_after_00-install-hook-deps.sh.tmpl`）
- `home/.chezmoiscripts/run_after_10-install-root-deps.sh.tmpl` — root 依存 installer（旧 `run_onchange_install-packages-7b-node-modules.sh.tmpl` の後継）
- `home/.chezmoiscripts/run_after_zz-verify-provisioning.sh.tmpl` — 両 marker を検査する verifier（旧 `run_after_zz-verify-hook-deps.sh.tmpl`）
- `home/.chezmoiscripts/run_onchange_after_install-safe-chain.sh.tmpl` — 配置後フェーズへ移した safe-chain（旧 `run_onchange_install-safe-chain.sh.tmpl`）
- `scripts/smoke-provisioning-invariants.sh` — 不変条件のテスト（旧 `scripts/smoke-hook-deps-invariants.sh`）
- `.github/workflows/ci-smoke-chezmoi.yml` — 上記テストの CI 配線
- `docs/decisions/0014-hook-deps-install-phase.md` — 同じ種類の問題を hook 依存について解いた ADR。本 ADR が予約規則を置き換える
- 改名前のパス: `home/.chezmoiscripts/run_after_00-install-hook-deps.sh.tmpl`、`home/.chezmoiscripts/run_after_zz-verify-hook-deps.sh.tmpl`、`home/.chezmoiscripts/run_onchange_install-safe-chain.sh.tmpl`、`scripts/smoke-hook-deps-invariants.sh`。verifier は本文を書き換えたため `git log --follow` では辿れない。旧パスで `git log -- <旧パス>` を使う
