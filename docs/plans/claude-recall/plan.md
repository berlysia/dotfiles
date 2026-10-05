# Plan: claude-recall を導入する

調査結果: `research.md`

## Goal

`chezmoi apply` だけで claude-recall（`recall` バイナリと Claude Code plugin）が入り、Claude Code のセッションから過去のセッションを MCP で検索でき、セッション終了時に `~/.claude/vault.db` へ取り込まれる状態にする。

## Experience Delta

- 変更前: 過去のセッションを探すには `~/.claude/projects/**/*.jsonl` を grep するしかなく、Claude Code が削除した JSONL は戻らない
- 変更後: 新しいセッションで `recall_search` などの MCP tool と `/recall` skill が使える。各セッションは終了時に vault.db へ取り込まれ、JSONL が削除された後も検索できる。ターミナルでは `recall` で TUI が開く

## Architecture

| 部品                                              | 置き場所                                                                          | 配布経路                                                                                                                   |
| ------------------------------------------------- | --------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `recall` バイナリ 1.5.0                           | mise installs（PATH は `mise activate` が通す）                                   | `home/dot_config/mise/config.toml` の `"github:babarot/claude-recall" = { version = "1.5.0", bin = "recall" }`             |
| plugin（MCP / SessionEnd hook / `/recall` skill） | `~/.claude/skills/claude-recall/` → `claude-recall@skills-dir` として読み込まれる | `home/.chezmoiexternal.toml.tmpl` の archive external。版と sha256 を固定し、mise の版と食い違えばテンプレートで fail する |
| skills の rsync からの保護                        | `run_after_sync-skills` の `TOOL_OWNED_EXCLUDE_ARGS`                              | `--exclude="/claude-recall"` を足す（Claude と Codex の両 rsync が同じ配列を使う）                                         |

配布範囲: macOS・Linux ホストと agent-vm。Windows は対象外（external を `ne .chezmoi.os "windows"` で囲む。Windows 向けのバイナリ asset もない）。

## Alternative Approaches (Greenfield View)

- **差分最小案**: 上流の curl installer を一度だけ手で実行する。`~/.local/bin/recall` に入り、`claude mcp add -s user` で MCP が登録される。repo の変更はない。ただし chezmoi の管理外なので別マシンでは再現できず、バージョンも固定されない。hook と skill も付かない
- **白紙設計案**: 上流が marketplace.json を出していれば、`home/.chezmoidata/claude_plugins.yaml` に marketplace と plugin を 1 行ずつ足すのが一番素直な形になる（他の plugin はこの経路で入っている）。バイナリだけ mise で入れる。起源: この repo は Claude Code plugin を marketplace で宣言的に管理しており、ゼロから設計すればそこに合わせる。ただし上流には marketplace.json がないので、この案は今は取れない
- **Mods として vendor する案**: `plugin/` を `mods/claude-recall/` にコピーする。既存の Mods 配布に乗るが、上流のファイルを repo に複製するので、バージョンを上げるたびに手で同期することになる
- **採用案**: mise + skills-dir external。理由:
  - (1) README が `~/.claude/skills/` 配下の plugin ディレクトリを `claude-recall@skills-dir` として読み込むと書いている。リリースの tar.gz をそのまま使えるので vendor が要らない
  - (2) `~/.claude/skills/` 配下に external を置き、rsync の exclude で守る先例（ui-skills）がある。ただし ui-skills は `type = "file"` で、`type = "archive"` は repo で初めて使う。archive の展開は使い捨ての chezmoi source で実際に確かめた（research.md「archive external の実測」）
  - (3) 白紙案が使えるようになったら（上流が marketplace.json を出したら）、external と exclude を消して `claude_plugins.yaml` に移すだけで済む
- **skills-dir で読み込まれなかったときの撤退先**: T4 の確認で `claude-recall@skills-dir` が出なければ、実装を止めて、Mods として vendor する案で plan を改訂する

## Key Decisions

1. **年齢ゲートは明示 pin で通す**（ユーザー決定）。`minimum_release_age = "7d"` は残し、`minimum_release_age_excludes` にも入れない。曖昧な指定を解決するときだけゲートが効くので、`1.5.0` と書けば入る（dry-run と実インストールで確認済み）。ユーザー判断でゲートを迂回したことを config.toml のコメントに書く。却下: 7 日待つ、excludes で恒久的に外す
2. **plugin の tar.gz は版と sha256 を固定し、mise の版との一致をテンプレートで検査する**。
   - plugin の `hooks.json`（SessionEnd で `recall import`）と `.mcp.json`（`recall mcp`）は、Claude Code に起動するコマンドを渡す。asset が差し替えられると、過去の会話をすべて読める環境で任意のコマンドが走る。
   - バイナリ側は、mise が 1 度入れたものを使い続けるので、取得時の 1 回しか差し替えの機会がない。plugin 側も、固定 URL と sha256 で同じ扱いにする。
   - 版が mise と食い違う（Renovate が config.toml を上げた）と、テンプレートが復旧手順付きで `fail` する。そのため、ずれたまま黙って動くことはない。
   - config.toml が変わると、ci-agent-vm（paths に `home/dot_config/mise/**` を含む）が `chezmoi managed` でこのテンプレートを評価するので、Renovate の PR の時点で CI が落ちる。
   - 却下: 版を config.toml から読んで checksum を固定しない案。ずれは防げるが、差し替えを検知できない
3. **external は `exact = true`、`stripComponents = 1`、`refreshPeriod` なし**。
   - tar は `./` で始まるので、`stripComponents` がないと chezmoi が `inconsistent state` で止まる（実測）。
   - `exact` は、版を上げて上流がファイルを消したときに古いファイルを残さないため。
   - URL に版が入って中身が変わらないので、定期的な再取得は要らない。版が変わったときだけ取りに行く
4. **MCP の登録は plugin の `.mcp.json` に任せる**。`~/.claude.json` の MCP 管理（package.json 由来）には足さない。両方に足すと `claude-recall` が二重に登録される
5. **agent-vm にも配る**。
   - config.toml は host と VM で共有し、VM 用に外す置き場（`conf.d/host-toolchains.toml`）は go / rust 系だけに限ると決まっている（ファイル冒頭のコメントと `tests/agent-vm/run-templates.sh`）。
   - VM の vault.db は VM 内のセッションだけを持ち、ホストのものとは別になる。
   - 却下: VM から外す案。外すには、上の取り決めを変えるか、VM 用に新しい仕組みを作る必要がある

## Files

```
# 編集
home/dot_config/mise/config.toml
home/.chezmoiexternal.toml.tmpl
home/.chezmoiscripts/run_after_sync-skills.sh.tmpl
renovate.json
.github/workflows/ci-agent-vm.yml
```

## Tasks

### T1: mise に recall を pin する

**Files:** 編集 `home/dot_config/mise/config.toml`（`"github:babarot/gomi"` の行の後）。参照: 同じファイルの `"npm:@mizchi/readability"`（table 形式とコメントの先例）

追記する内容:

```toml
# Session archive with MCP search (claude-recall). Every release was under a week old when it was
# added, so minimum_release_age hid them all; pinning an exact version, which the gate does not
# filter, was a deliberate choice to take it anyway. Keep the table form: the plugin external in
# .chezmoiexternal.toml.tmpl reads .version from it and fails the apply if the two disagree.
"github:babarot/claude-recall" = { version = "1.5.0", bin = "recall" }
```

確認: `mise install` の後、`mise which recall` → `/home/berlysia/.local/share/mise/installs/github-babarot-claude-recall/1.5.0/recall`。`recall --version` → `recall 1.5.0`

### T2: plugin を external で置く

**Files:** 編集 `home/.chezmoiexternal.toml.tmpl`（ui-skills の項の後）。参照: 同じファイルの `.claude/skills/ui-skills/SKILL.md` の項と、`ne .chezmoi.os "windows"` で囲んだ ni.zsh の項

```
{{ if ne .chezmoi.os "windows" }}
{{/* claude-recall plugin: loads from ~/.claude/skills as claude-recall@skills-dir (no marketplace upstream). */}}
{{/* Excluded from the skills rsync. Its hooks and MCP entry launch `recall`, so the tarball is pinned by */}}
{{/* checksum, and its version must match the binary pinned in mise. */}}
{{- $recallTool := index (include "dot_config/mise/config.toml" | fromToml).tools "github:babarot/claude-recall" }}
{{- $recallPluginVersion := "1.5.0" }}
{{- $recallPluginSha256 := "6923106dae0fd63972cf138eb6546caca16508111b89b91e58900b12e706f34f" }}
{{- if not (and (kindIs "map" $recallTool) (eq (toString (index $recallTool "version")) $recallPluginVersion)) }}
{{-   fail (printf "claude-recall: mise pins %v but the plugin in .chezmoiexternal.toml.tmpl is %s. recovery: keep the mise entry in table form ({ version = ..., bin = \"recall\" }), set $recallPluginVersion to the mise version and $recallPluginSha256 to the claude-recall-plugin.tar.gz line of `gh release download <version> -R babarot/claude-recall -p checksums.txt -O -`" $recallTool $recallPluginVersion) }}
{{- end }}
[".claude/skills/claude-recall"]
type = "archive"
url = "https://github.com/babarot/claude-recall/releases/download/{{ $recallPluginVersion }}/claude-recall-plugin.tar.gz"
stripComponents = 1
exact = true
checksum.sha256 = "{{ $recallPluginSha256 }}"
{{ end }}
```

確認:

- `chezmoi execute-template < home/.chezmoiexternal.toml.tmpl | grep -A6 claude-recall` → URL に `/1.5.0/` が入り、`stripComponents = 1` と sha256 が出る
- `chezmoi apply --dry-run -v ~/.claude/skills/claude-recall` → `.claude-plugin/plugin.json`、`.mcp.json`、`hooks/hooks.json`、`skills/recall/SKILL.md` の 4 ファイルが `~/.claude/skills/claude-recall/` の直下に出る
- `tests/agent-vm/run-templates.sh` → 終了コード 0（VM と host の両データで external テンプレートが評価できる）。キャッシュが空でも `chezmoi managed --refresh-externals=never` は archive を取りに行き、中身を列挙して終了コード 0 になることを、使い捨ての source で実測済み（research.md）。ここで失敗したら T3 以降に進まない

### T3: skills の rsync から除外する

**Files:** 編集 `home/.chezmoiscripts/run_after_sync-skills.sh.tmpl`（`TOOL_OWNED_EXCLUDE_ARGS` とその上のコメント）。参照: 同じ行の `--exclude="/ui-skills"`

- コメントに `# - claude-recall: Claude Code plugin placed by chezmoi external` を足す
- 配列に `--exclude="/claude-recall"` を足す

確認:

- `./scripts/smoke-chezmoi-scripts.sh` → 終了コード 0。既存 fixture は exclude の効果を見ないので、これは描画と実行が壊れていないことの確認にとどまる
- exclude が効くことは、テスト計画の「apply を 2 回」で確認する

### T3b: 版ずれの検知を Renovate と CI に閉じる

**Files:** 編集 `renovate.json`（`packageRules` の末尾）、`.github/workflows/ci-agent-vm.yml`（`push.paths` と `pull_request.paths`）。参照: `renovate.json` の「claude hook runtime」ルール（専用の `groupName` で週次 group から外す先例）

- Key Decision 2 の fail は、Renovate が claude-recall の版を上げた PR で CI を落とす。preset の週次 group に入ると、他の更新まで巻き込んで止まる。そのため、専用の group に分け、automerge を外す:

```json
{
  "description": "claude-recall: the plugin external in home/.chezmoiexternal.toml.tmpl pins its own version and sha256 and fails the templates when they disagree with mise, so a bump needs a hand-edited checksum. Keep it out of the weekly group so that failure blocks only this PR",
  "matchPackageNames": ["/claude-recall/"],
  "groupName": "claude-recall",
  "automerge": false
}
```

- `ci-agent-vm.yml` の両 `paths` に `"home/.chezmoiexternal.toml.tmpl"` を足す。external 側だけを変えた PR でも run-templates.sh が走るようにするため

確認: `npx --yes --package renovate@latest renovate-config-validator renovate.json` → `Config validated successfully`（npm の年齢ゲートで最新が取れない場合は、取れた版の名前を報告する）。`git diff .github/workflows/ci-agent-vm.yml` で 2 か所だけ増えている

### T4: 適用と動作確認

1. apply の前に、既存の vault.db がないことを確認する（`test ! -e ~/.claude/vault.db`。2026-10-04 の調査時点ではない）。apply 後は SessionEnd hook が作りうるので、確認は apply より先に行う。あれば `sqlite3 ~/.claude/vault.db ".backup '/home/berlysia/.claude/vault.db.bak-<実行日 YYYYMMDD>'"` を取ってから進める（`/usr/bin/sqlite3` はある）
2. `chezmoi apply`（引数なし）
3. `(umask 077; recall import)` を一度実行して、既存のセッションを取り込む（初回作成の時点から 600 にする）。続けて `chmod 600 ~/.claude/vault.db*` → `stat -c '%a %n' ~/.claude/vault.db*` がすべて `600`。テスト計画の probe の後にもう一度同じ stat を見て、すべて `600` のまま
4. **撤退ゲート**: 別のターミナルで新しい Claude Code セッションを起動し、`claude plugin list` に `claude-recall@skills-dir` があるか確認する（実装中のセッションでは plugin が読み込まれていないため）。なければ T5 に進まず、変更をコミットしないまま plan を Mods vendor 案で改訂する
5. 下記テスト計画の確認をすべて実行する

### T5: コミット

`feat(claude): install claude-recall for searching past sessions`（Contextual Commits の action line で Key Decisions 1・2・5 を書く）

## テスト計画 (ISO 25010)

- **機能適合性**
  - `chezmoi apply` → `recall --version` が `recall 1.5.0` を出す
  - `chezmoi apply` → `~/.claude/skills/claude-recall/.claude-plugin/plugin.json` があり、`"version": "1.5.0"` を含む
  - 新しい Claude Code セッションで `claude plugin list` → `claude-recall@skills-dir` がある。`claude mcp list` → `claude-recall` が connected になっている
  - `recall import` → 終了コード 0。`~/.claude/vault.db` ができる。`recall stats` のセッション数が 1 以上
  - hook の経路: Claude Code の Bash ツールから `command -v recall` → mise installs のパスが返る（hook と MCP は Claude Code の環境変数を継ぐので、Claude Code が `mise activate` 済みのシェルから起動されていれば解決できる）。`claude -p 'Reply with exactly: recall-probe-<実行時刻 HHMMSS>'` を 1 回実行して終了させ、数秒後に `recall search recall-probe-<同じ時刻>` → そのセッションが 1 件出る（件数の増減は並行セッションでも動くので判定に使わない）。出なければ、対話セッションを起動して同じ文字列を送り `/exit` で終了し、同じ検索をする。そこで出れば `-p` では SessionEnd が来ないと記録し、出なければ hook の失敗として T5 に進まない
- **セキュリティ（機密性）**
  - `recall ui`（バックグラウンドで起動する）→ `ss -ltnp | grep 6276` がループバック（`127.0.0.1:6276` または `[::1]:6276`）だけを出す。`0.0.0.0`、`*`、`[::]` が出たら失敗 → `recall ui stop` → 同じ grep が何も出さない
- **セキュリティ（完全性）**
  - `$recallPluginSha256` の 1 文字を変えて、使い捨ての source と destination で apply する → chezmoi が checksum の不一致で止まる（実装時に research.md と同じ使い捨てディレクトリの手順で確認する。repo には反映しない）
- **保守性（版のずれの検知）**
  - config.toml の version を一時的に `1.4.0` に変えて `chezmoi execute-template < home/.chezmoiexternal.toml.tmpl` → 終了コードが 0 以外になり、`claude-recall: mise pins` と `recovery:` を含むメッセージが出る（確認後に戻す。apply はしない）
  - 同じ状態で `tests/agent-vm/run-templates.sh` → 失敗する（Renovate の PR の CI で止まることの確認）
- **信頼性（rsync の回帰と冪等性）**
  - `chezmoi apply` を 2 回続けて実行 → 2 回目の後も `~/.claude/skills/claude-recall/` に 4 ファイル（`.claude-plugin/plugin.json`、`.mcp.json`、`hooks/hooks.json`、`skills/recall/SKILL.md`）が残り、`chezmoi diff ~/.claude/skills/claude-recall` が空。`~/.codex/skills/claude-recall` はない
- **対象外**:
  - 性能効率: 取り込みは上流の実装の範囲で、この変更は影響しない
  - 移植性: darwin では mise が darwin の asset を選ぶ。この Linux 環境では確かめられないので、確かめていないと報告する。macOS ホストで初めて apply したら `recall --version` を見る
  - agent-vm 内での動作: この環境に VM がないので、テンプレートの評価（T4-1）までを確認する

## ロールバック

`home/.chezmoiexternal.toml.tmpl` の claude-recall の項と config.toml の行を消す と、T3 の exclude、T3b の packageRule と paths を戻す → `chezmoi apply` → `rm -rf ~/.claude/skills/claude-recall`（external を消しても chezmoi はディレクトリを消さない）→ `mise uninstall github:babarot/claude-recall@1.5.0`。`~/.claude/vault.db` は消さない（JSONL がすでに消えたセッションの唯一のコピー）。

## Risks

- 初リリースから 5 日で 10 リリース、star は 6。作者は gomi などを出している 2013 年からのアカウント。`recall` は過去のセッションの記録を全部読み、vault.db にまとめる。MCP の結果は過去の会話そのもので、web fetch の結果などに混じった指示も含みうる。そのため、指示ではなくデータとして扱う。`recall_*` の MCP tool を auto-approve の許可リストに入れない
- Web UI（`recall ui`、`/recall` skill が起動する）は `127.0.0.1:6276` に bind する。ただし Host / Origin の検証は見当たらず（security reviewer が上流を grep した結果）、起動中は DNS rebinding で全会話を読まれうる。UI は使うときだけ起動し、終わったら `recall ui stop` する（`/recall` skill から起動した UI も同じ。skill の `/recall stop` でも止まる）
- vault.db は JSONL が消えた後も会話を残すので、会話に混じった秘密が残る期間が延びる。`~/.claude` は 755 で、JSONL も同じ条件で置かれている。この plan では `~/.claude` の権限は変えず、vault.db だけを 600 にする（T4）
- バイナリの checksum を repo で固定する手段として mise の lockfile がある。ただしこの repo はどのツールにも lockfile を使っておらず、入れると全ツールの運用が変わるので、この plan では見送る
- 年齢ゲートを明示 pin で通すので、1.5.0 に問題があっても 7 日の猶予による防御は効かない（ユーザーが受け入れ済み）
- vault.db は、Claude Code が JSONL を消した後に残る唯一のコピーになる。上流がスキーマを自動で移行する場合、版を戻しても古いバイナリで読めなくなるおそれがある（未確認）。版を上げる前に手で `sqlite3 ~/.claude/vault.db ".backup '<path>'"` を取る。この plan ではバックアップを自動化しない
- SessionEnd hook は `2>/dev/null` かつ async で動くので、`recall` が見つからない環境（`mise activate` を通らずに起動した Claude Code）では、取り込みが黙って失敗する。MCP サーバーの起動中も取り込まれるので、検索できる範囲は残る。agent-vm 内で `recall` が PATH にあるかは確かめていない（この環境に VM がない）
- バイナリは mise が取得時に入れたものを使い続ける。repo に sha256 を固定しているのは plugin だけ。1.5.0 のバイナリの sha256 が上流の checksums.txt と一致することは、導入時に一度だけ手で確かめた（research.md）
- 版を上げるときの手順: (1) `sqlite3 ~/.claude/vault.db ".backup '<path>'"` の後に `chmod 600 '<path>'` (2) config.toml の version と external の `$recallPluginVersion`・`$recallPluginSha256` を同じ commit で更新し、`mise install` 後のバイナリの sha256 を同じ release の checksums.txt と照合する (3) apply 後に `recall stats` の件数が減っていないことを確認 (4) 異常があれば版を戻し、退避した vault.db を戻す
- Renovate の mise manager が `github:` backend の table 形式を更新するかは確かめていない。更新しなければ 1.5.0 に留まり、バイナリと plugin の版はそろったままになる。更新すれば、上の Key Decision 2 で CI が止まり、checksum の更新を人が行う
- 初回の apply をオフラインで行うと、external の取得で apply が止まる。2 回目以降は、版が変わるまで取りに行かない。キャッシュが空なら `--refresh-externals=never` でも取得する（実測）ので、`tests/agent-vm/run-templates.sh` も GitHub への接続を要するようになる

## Reviewer Outputs (Round 1)

### logic-validator

- verdict: needs-work
- 主指摘: 「plugin は実行コードを含まない」が不正確（hooks.json / .mcp.json が起動コマンドを定義する）。T3 の smoke 確認が未確定の記述で、exclude の効果も検証しない。`.version` 参照は table 形式の前提に依存する。

### scope-justification-reviewer

- verdict: pass
- 主指摘: 全タスクが目的に直結している。T3 の smoke パスの曖昧さと `refreshPeriod` の理由が未記載である点だけが軽微な指摘。

### decision-quality-reviewer

- verdict: needs-work
- 主指摘: checksum を固定しない判断は保守性を優先して供給網のリスクを落としており、年齢ゲートの迂回と合わさって防御層が二つとも消える。版のずれ防止と checksum の固定は両立できる。

### greenfield-perspective-reviewer

- verdict: needs-work
- 主指摘: hook と MCP の `recall` の PATH 解決が未検証で、SessionEnd hook による取り込みを実セッションで確認していない。skills-dir で読み込まれなかったときの撤退先がない。

### architecture-boundary-analyzer

- verdict: needs-work
- 主指摘: ui-skills は `type = "file"` の先例で archive の先例ではない。`stripComponents` を plan 段階で確定すべき。agent-vm と Windows への配布の扱いが未記載。

### data-contract-evolution-evaluator

- verdict: needs-work
- 主指摘: vault.db のスキーマ移行とダウングレードの経路が未定義で、初回取り込み前と版上げ前のバックアップ手順がない。hook の無言失敗が JSONL 喪失につながる。

### deployment-readiness-evaluator

- verdict: needs-work
- 主指摘: hook の PATH 依存、agent-vm 配布の未記載、テンプレートが table 形式やキー不在で全ホストの apply を止める脆さ、ロールバック手順の欠如。

## Approval

- Plan Status: complete
- Review Status: pass
- Approval Status: approved

<!-- auto-review: pending -->
<!-- intent-triage: pending -->

## Reviewer Outputs (Round 2)

### logic-validator

- verdict: pass
- 主指摘: T2 テンプレートを execute-template で実測し、table / 文字列 / キー不在の分岐が意図どおりと確認。軽微: fail 文面に table 形式の前提を足す、vault.db の有無確認を apply より前に置く。

### scope-justification-reviewer

- verdict: pass
- 主指摘: 追加分（checksum 固定、agent-vm / Windows、ロールバック）はすべて根拠があり、スコープの逸脱はない。

### decision-quality-reviewer

- verdict: pass
- 主指摘: 版ずれの防止と checksum の固定を両立し、支配軸と整合した。

### greenfield-perspective-reviewer

- verdict: needs-work
- 主指摘: `claude -p` 後の件数の増加は SessionEnd の証拠として弱い。撤退ゲートが T4 の手順に入っていない。agent-vm の PATH 未検証を明記すべき。

### architecture-boundary-analyzer

- verdict: needs-work
- 主指摘: キャッシュが空のとき `--refresh-externals=never` で archive を評価できるかが未確認。ci-agent-vm の paths に external テンプレートがない。

### data-contract-evolution-evaluator

- verdict: pass
- 主指摘: 導入を止める blocker はない。バックアップのファイル名の日付と、版上げの手順を Risks に足すとよい。

### deployment-readiness-evaluator

- verdict: needs-work
- 主指摘: 版ずれの fail が Renovate の週次 group PR 全体を止める。archive を空キャッシュで評価できるかが未確認。バイナリ側の完全性が非対称なことを明記すべき。

<!-- auto-review: verdict=needs-work; hash=e54e9588cf800cc9a34accf7e6426243b7e054cd3b2752f737e50a363db35eea; design-hash=990ddab7e10fdf8a5323d3543e49cd850fdda701b75d1657d333babefc824a45; round=1; at=2026-10-04T07:49:27.639Z; reviewers=logic-validator+scope-justification-reviewer+decision-quality-reviewer+greenfield-perspective-reviewer+architecture-boundary-analyzer+data-contract-evolution-evaluator+deployment-readiness-evaluator -->
<!-- intent-triage: adopted=17; excluded=0; at=2026-10-04T07:49:27.657Z -->

## Reviewer Outputs (Round 3)

### logic-validator

- verdict: pass
- 主指摘: `recall search` は上流 README に実在する。T3b のルールと paths の追加は既存の構造と整合し、新しい矛盾はない。

### greenfield-perspective-reviewer

- verdict: pass
- 主指摘: Round 2 の 3 指摘（agent-vm の PATH、probe による SessionEnd 確認、撤退ゲート）はすべて閉じた。

### architecture-boundary-analyzer

- verdict: pass
- 主指摘: 空キャッシュの実測と CI paths の追加で閉じた。軽微: `automerge: false` はこの repo では初めて使う。

### deployment-readiness-evaluator

- verdict: pass
- 主指摘: Round 2 の 6 指摘はすべて閉じた。`/claude-recall/` が他の名前にも当たりうる点は軽微。

### security-vulnerability-analyzer

- verdict: needs-work
- 主指摘: Web UI に Host / Origin の検証が見当たらず、起動中は DNS rebinding で読まれうる。vault.db のファイル権限が未確認。MCP の結果を auto-approve しない方針を書くべき。

### scope-justification-reviewer

- verdict: pass (carried from Round 2)
- 主指摘: Round 2 で pass、再実行なし

### decision-quality-reviewer

- verdict: pass (carried from Round 2)
- 主指摘: Round 2 で pass、再実行なし

### data-contract-evolution-evaluator

- verdict: pass (carried from Round 2)
- 主指摘: Round 2 で pass、再実行なし

<!-- auto-review: verdict=needs-work; hash=2ea8178c92b00abe9fac58caa516ab486679e9375ebeefce36a880d2f336257d; design-hash=a541007cf748f9fd8f5e7399b33a2e3e413e71764165ede3709973df44c78bae; round=2; at=2026-10-04T07:51:40.101Z; reviewers=logic-validator+scope-justification-reviewer+decision-quality-reviewer+greenfield-perspective-reviewer+architecture-boundary-analyzer+data-contract-evolution-evaluator+deployment-readiness-evaluator -->
<!-- intent-triage: adopted=14; excluded=0; at=2026-10-04T07:51:40.116Z -->

## Reviewer Outputs (Round 4)

### logic-validator

- verdict: pass
- 主指摘: SQLite は -wal / -shm に本体の権限を引き継ぐので、chmod 600 の主張は成り立つ。軽微: 初回作成から chmod までの窓、バックアップの権限、`[::1]` の扱い（反映済み）。

### security-vulnerability-analyzer

- verdict: pass
- 主指摘: Round 3 の 5 件は閉じた。軽微: skill から起動した UI の停止、probe 後の stat 再確認、版上げ時のバイナリ sha の照合（反映済み）。

### greenfield-perspective-reviewer

- verdict: pass (carried from Round 3)
- 主指摘: Round 3 で pass、再実行なし

### architecture-boundary-analyzer

- verdict: pass (carried from Round 3)
- 主指摘: Round 3 で pass、再実行なし

### deployment-readiness-evaluator

- verdict: pass (carried from Round 3)
- 主指摘: Round 3 で pass、再実行なし

### scope-justification-reviewer

- verdict: pass (carried from Round 3)
- 主指摘: Round 3 で pass、再実行なし

### decision-quality-reviewer

- verdict: pass (carried from Round 3)
- 主指摘: Round 3 で pass、再実行なし

### data-contract-evolution-evaluator

- verdict: pass (carried from Round 3)
- 主指摘: Round 3 で pass、再実行なし

<!-- auto-review: verdict=needs-work; hash=a8a19abc63deb79730fa7df4d3fbd86eace6d2f409d2a15ead21b4c39ac18079; design-hash=fdbedac2f46a90eb322af8f06f235cacd61b040bfb90adc82d96973073dd19ff; round=3; at=2026-10-04T07:53:44.294Z; reviewers=logic-validator+scope-justification-reviewer+decision-quality-reviewer+greenfield-perspective-reviewer+architecture-boundary-analyzer+data-contract-evolution-evaluator+deployment-readiness-evaluator+security-vulnerability-analyzer -->
<!-- intent-triage: adopted=6; excluded=0; at=2026-10-04T07:53:44.310Z -->

<!-- auto-review: verdict=pass; hash=2a7b2693efccf970b38448a443146b5655618f323f9bd41a67d7f911acbfbd73; design-hash=17147b6b11ca5912da8881d9e1a2b627ce624da5e4cf3dfe3af69a9700dd425d; round=4; at=2026-10-04T07:54:48.398Z; reviewers=logic-validator+scope-justification-reviewer+decision-quality-reviewer+greenfield-perspective-reviewer+architecture-boundary-analyzer+data-contract-evolution-evaluator+deployment-readiness-evaluator+security-vulnerability-analyzer -->
<!-- intent-triage: adopted=6; excluded=0; at=2026-10-04T07:54:48.415Z -->
