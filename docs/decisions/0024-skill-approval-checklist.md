# ADR-0024: Skill の自動許可を、apply が追記するチェックリストで管理する

## Status

accepted (2026-10-03)

## Context

`Skill(...)` の許可は、`home/dot_claude/.settings.permissions.json` に手で並べた 61 件で決めていた。スキルの供給源は 4 つあり（`.skills/` の自作スキル、`home/dot_claude/commands/` の自作コマンド、chezmoi external で取り込む private-skills、apm と chezmoi external で入れる外部スキル）、どれも追加のたびにこのリストを直す必要があった。実際には、導入済みの約 20 件（`tanteki`、`explainer`、`pr-description` など）が欠けていて、毎回の呼び出しで許可を求められた。逆に、もう存在しない名前も残っていた。

ユーザーの要求は次のとおり。

- グローバルにインストールしたスキル、とくに自作のものはすべて自動許可にする
- 自動で列挙したチェックリストの md で管理し、許可しない理由も同じ行に書けるようにする
- 自作は初期状態で許可、外部は未許可で載せる。md は git で管理する
- private-skills の名前は公開リポジトリに載せず、常に許可する

設計の議論とレビューの記録（7 名のレビュアーで 6 ラウンド）は、作業セッションの plan（`.tmp/sessions/02f36229/`）にあった。`.tmp/sessions/` は 7 日で GC されるので、今後の変更を縛る判断はこの ADR に書き切る。実装はコミット `083f32e`（機構）と `dc50228`（外部 13 件のチェック）。

## Decision

支配軸は運用性（スキルを足すたびに許可リストを直す作業をなくす）で、次に安全性（誤って許可する側に倒れる経路を作らない）である。

- **K1（判定は 1 本の bash スクリプト）**: md の文法解釈、供給源の分類、許可名の計算は `scripts/skill-inventory.sh` だけが持つ。settings の生成（`allow`）と md への追記（`sync-md`）が同じスクリプトを呼ぶ。settings の生成は run_onchange 段で走り、bun が入る前の可能性があるので、bash と jq だけで書く。
- **K2（許可は settings.json の静的ルールに出す）**: 許可する名前 = md でチェックされた名前 ∪ md に未掲載の自作 ∪ private。名前ごとに `Skill(<name>)` を `permissions.allow` に足す。2 項目めは、`sync-md`（run_after）より前に走る settings の生成でも「自作は初期状態で許可」を成り立たせるためにある。
- **K3（分類は宣言元から取る）**: 外部スキルは apm の lock（`.claude/skills/<name>` の行）と `.chezmoiexternal.toml.tmpl` の宣言から列挙する。`~/.claude/skills/` の中身は分類に使わない。private-skills の clone に失敗していても、overlay 済みの private 名が「外部」として git 管理の md に書かれることがない。自作と apm が同名なら apm（sync-skills が rsync から外し、apm 版が置かれる）、自作と private が同名なら private（overlay で上書きされる）として扱う。
- **K4（md は追記だけ）**: apply は未掲載のスキルを節の末尾に足すだけで、既存の行を変えず、消さない。マシンごとにインストール済みの集合が違っても、他のマシンで付けたチェックや理由が消えない。追記で生じる git の差分は、「チェックするか決めるもの」が増えたという通知として扱う。
- **K5（崩れた行は許可しない側に倒す）**: チェックボックスに見えるのに文法に合わない行が 1 行でもあると、未掲載の自作の自動許可を止め、`sync-md` は md を書き換えない。崩れた行から名前を推測しない。チェック済みの名前と private の許可は続ける。名前の文法は先頭と末尾を英数字に限り（`s.` や `s-` は名前にならない）、`Skill(...)` への注入を防ぐ。
- **K6（`allowed-tools` は注記に留める）**: frontmatter に `allowed-tools` を持つスキルは、md の行末にその値を注記する（外部由来の値は無害化する）。自作と private については、これを理由に許可を外さない（「自作はすべて」「private は常に」という要求どおり）。チェック済みの外部スキルの `allowed-tools` が変わったら、`sync-md` が警告する。
- **K7（settings 生成段の fail-soft）**: `allow` が失敗しても apply は止めず、既存の settings.json にある `Skill(...)` を引き継ぎ、`~/.claude/.skill-allow-failed` を書く。marker の中身を run_onchange の Hash に入れて、失敗が続く間は apply のたびに再実行させる。ADR-0017 K4 の例外で、その理由は ADR-0017 の Amended by に書いた。

### 却下した代替案

- **静的リストに足りない名前を手で足す**: 1 ファイルの変更で済むが、スキルを足すたびに同じ陳腐化が起きる。今回の問題はこの運用から生じた。
- **PermissionRequest hook が呼び出しのたびに md を読んで判定する**: 判定時点の状態を見るので、反映の遅延が無い。採らなかった理由は 3 つある。settings の allow は hook より前に評価されるので、許可済みのスキルで hook の起動が要らない。許可された名前が `/permissions` に現れる。hook の案では md を `~/.claude` に配置するか、hook に作業ツリーのパスを渡す必要がある。
- **生成器を TypeScript、settings 側を bash で別々に書く**: 同じ文法を 2 か所に実装すると、ずれたときに許可側へ倒れうる（Round 1 のレビューで指摘）。
- **`~/.claude/skills/` を列挙して分類する**: private-skills が欠けた環境で private 名が md に漏れる（Round 1 のレビューで指摘）。
- **apply が md を毎回書き直し、インストールされていない名前を消す**: マシンごとに差分が出続け、他のマシンのチェックと理由が消える（Round 1 のレビューで指摘）。
- **`allowed-tools` を持つ自作・private を自動許可から外す**: 要求の範囲を狭めるので採らない。現時点で該当する自作は無い。

## Consequences

1. **外部スキルのチェックは次の apply で反映される**: md を編集しただけでは許可されない。新しいマシンや private の追加直後は、external と apm lock が run_onchange より後に用意されるので、2 回目の apply で揃う。
2. **md の `[x]` は任意の名前を許可する**: 供給源に無い名前（プラグインや組み込みのスキル）も書けば許可される。md へのコミットが許可の付与になる。
3. **静的リストに 18 件が残る**: `:` を含むプラグイン由来の 8 件と、組み込みの `keybindings-help`、供給源を確認できなかった 9 件。後者は消しても許可が増えないので、根拠なく消さなかった。
4. **`*.md` の ignore はルート直下にしか効かない**: `home/.chezmoiignore` の `*.md` は配置先のパスに対して照合され、`*` は `/` をまたがない。md を配置しないために `.claude/skill-approvals.md` を別に足した。
5. **fail-soft の再試行が止まる条件が 2 つある**: marker を書けないとき（`~/.claude` に書き込めない）と、同じ秒の中で 2 回失敗して marker の中身が同じになったとき。前者は WARNING で復旧手順を出す。chezmoi の `scriptState` は描画した内容の sha256 をキーにした集合なので、復旧して Hash が既出の値に戻ると再実行されない。
6. **プロジェクト側の同名スキル**: `Skill(name)` がプロジェクトの `.claude/skills/` にある同名スキルにも効くかは確かめていない。以前の静的リストも同じ性質なので、この変更による退行ではない。

## References

- `docs/decisions/0017-provisioning-after-deploy.md`（Amended by に、run_onchange 段の fail-soft と marker の追加を記録）
- 実装: `scripts/skill-inventory.sh`、`home/dot_claude/skill-approvals.md`、`home/.chezmoiscripts/run_onchange_update-settings-json.sh.tmpl`、`home/.chezmoiscripts/run_after_update-skill-approvals.sh.tmpl`
- テスト: `home/dot_claude/hooks/tests/unit/skill-inventory.test.ts`、`scripts/smoke-provisioning-invariants.sh`（C、D6a、D6b、N1、N2）
- コミット: `083f32e`、`dc50228`
