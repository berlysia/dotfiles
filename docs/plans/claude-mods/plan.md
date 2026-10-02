# Plan: Mod を chezmoi 管理に載せる（mods/ + CLAUDE_CODE_PLUGIN_DIRS）

## Goal

`workflow-band` Mod をリポジトリで管理し、`chezmoi apply` だけでどの Claude Code session でも読み込まれるようにする。後から作る Mod（#2〜#4）も、`mods/` にフォルダを足して apply するだけで載る経路にする。

前提: Mod の機能自体が有効であること。rollout 設定の保存値が off だと Mod は読み込まれない。この session で一度発生し、`claude` を一度起動すると解消した。この前提は本 plan の外にあり、制御できない。

## Experience Delta

- 変更前: Mod は session 用の `~/.claude/dev-mods/<session>/` にあり、片付けられると消える。別 session で使うには毎回 `claude --plugin-dir <path>` を付ける必要がある
- 変更後: `mods/<name>/` を追加して `chezmoi apply` すれば、フラグなしで起動したすべての session で読み込まれる。Mod を開発中は `claude --plugin-dir mods/<name>` で起動すれば、リポジトリ上のソースが hot reload され、apply を待たずに反復できる

## Architecture

```
<repo>/mods/<name>/            # Mod のそのままの形。claude plugin test/validate をここで実行する
   │
   │  home/.chezmoitemplates/claude-mod-names   ← 「何が Mod か」の唯一の定義
   │    = mods/*/.claude-plugin/plugin.json を持つフォルダのうち、名前が ^[a-z0-9][a-z0-9._-]*$ のもの
   │    （合わない名前は fail で apply 全体を止める）
   │  home/.chezmoitemplates/claude-mods-dir    ← 配布先の唯一の定義（HOME からの相対 ".claude/mods"）
   │      ├─ run_after_sync-mods.sh.tmpl      … "$HOME/<相対>" へ各 Mod を rsync、Mod でなくなったものを消す
   │      └─ .settings.base.json.tmpl         … env.CLAUDE_CODE_PLUGIN_DIRS を toJson で生成
   │         （run_onchange_update-settings-json の # Hash 行は、このテンプレートの展開結果の sha256 を既に含む。
   │           名前の集合が変われば展開結果が変わり、settings は再生成される）
   ▼
~/.claude/mods/<name>/  ←── ~/.claude/settings.json の env.CLAUDE_CODE_PLUGIN_DIRS（":" 区切りの絶対パス）
   ▲
Claude Code（起動時に読み込み、対話 session では監視して hot reload）
```

- **Mod の定義を 1 か所に置く**: 判定は共有テンプレート `claude-mod-names` だけが持つ。配布先は `claude-mods-dir` が HOME からの相対パス（`.claude/mods`）として持つ。スクリプトは実行時の `$HOME` と、settings は `.chezmoi.homeDir` とつないで使う。相対パスにするのは、展開時のホームディレクトリをスクリプトに埋め込まないためで、smoke テストが隔離した HOME で動けるのはこのおかげ（`run_after_sync-skills` が `$HOME` を実行時に参照するのと同じ理由）。こうすると、settings に書いたパスと実際に配布したフォルダがずれない。名前の許可リストは、JSON への埋め込みとパス区切り `:` への混入を防ぐためのもの。文字列は `toJson` で出力する
- **許可リスト違反の止まり方**: `fail` は展開エラーなので、apply では `run_before_10-validate-json-templates-unix` が `.settings.base.json.tmpl` を展開する段で止まり、`Template error` の下に名前を示す。CI の validate-json ジョブも同じく落ちる
- **0 件のとき**: `CLAUDE_CODE_PLUGIN_DIRS` のキー自体を出さない。空文字列のパス要素をエンジンがどう扱うかは確認できないため。settings のマージは `env` ブロックごと置き換える（`run_onchange_update-settings-json.sh.tmpl:140` の `. + $template`）ので、キーを出さなければ古い値も残らない
- **Hash 行は編集しない**: `run_onchange_update-settings-json.sh.tmpl:16` の Hash 行は、`includeTemplate "dot_claude/.settings.base.json.tmpl" . | sha256sum` から始まる。ベーステンプレートの展開結果に Mod 名が入るので、名前の集合が変われば Hash も変わり、settings は再生成される。Mod の中身の変更は settings に影響しないので Hash に関係なく、run_after が apply のたびに rsync する
- **配布するもの・しないもの**: `*.test.ts` は配布しない。テストはリポジトリ上で `claude plugin test` を実行するためのもので、読み込み時には不要だから。エンジンが書き出す `.claude-plugin/types/` と `tsconfig.json` は `--delete` から除外する（実行中の session が読み込んでいるものを apply で消さないため）。symlink は複製しない（`--no-links`。リポジトリ外を指すリンクを Mod 経由で読ませない）。配布先から他ユーザーの書き込み権限を外す（`--chmod=go-w`）
- **Windows**: 配布スクリプトと同じく、settings の `env` 生成も `ne .chezmoi.os "windows"` で囲む
- **実行順**: `run_onchange_update-settings-json` は run_after より先に走る。Mod を足した apply の途中では、settings が一瞬だけまだ無いフォルダを指すことがある。その間に起動した session では読み込みエラーになりうるが、apply が終われば解消する

## Alternative Approaches (Greenfield View)

### 差分最小案 (Incremental)

`.skills/workflow-band/` に置く（research の案 A）。既存の `run_after_sync-skills` が `~/.claude/skills/` に配り、skills フォルダのプラグイン自動読み込みで有効になる。追加するスクリプトも settings もゼロ。ただし同じ rsync で `~/.codex/skills/` にも複製され、Codex 側に `SKILL.md` の無いフォルダが現れる。スキルと Mod が同じ場所に混ざり、`lint:oxlint` の `.skills/` 除外にも Mod が巻き込まれる。

### 白紙設計案 (Greenfield)

ゼロから設計するなら、Mod は「Claude Code が直接読むプラグインフォルダ」なので、エンジンが公式に用意している経路（`CLAUDE_CODE_PLUGIN_DIRS`）に、Mod 専用のディレクトリを 1 つ対応させる。起源: reference.md:68 が `--plugin-dir` 相当の常設版として `CLAUDE_CODE_PLUGIN_DIRS` を settings の `env` から読むと明記している。marketplace（案 C）は他人に配る手段で、自分用の常設には不要。CLI のキャッシュにコピーされるので、ソースを直しても YAML を変えない限り反映されない。ソースはリポジトリ上でも Mod の形を保ち、`claude plugin test` / `validate` をそのまま実行できるようにする。`home/` 配下に置くと `.claude-plugin` を `dot_claude-plugin` と書く必要があり、この性質を失う（案 B1）。

### 採用案と理由

白紙設計案（research の案 B2）を採用する。根拠:

- 配布の前例がある: `.skills/` を workingTree から rsync で配る `run_after_sync-skills.sh.tmpl` と同じ形で、smoke テストの規約（`tests/smoke/<script>/<scenario>/setup.sh`）もそのまま使える
- テストを実行できる: ソースが Mod の形なので、`claude plugin test mods/workflow-band` が 3 件 pass する今の状態を保てる（B1 では実行できない）
- 反復速度とゲートを両立できる: 開発中は `claude --plugin-dir mods/<name>` でリポジトリ上のソースを hot reload し、全 session への反映は `chezmoi apply` を経る。B3（settings がリポジトリを直接指す）は反復速度では同等だが、編集途中のファイルが全 session に即時反映される。またエンジンの生成物がリポジトリ内に書かれる
- 増えるものは、スクリプト 1 本、共有テンプレート 1 つ、settings テンプレートの数行にとどまる

## Key Decisions

| 判断 | 採用 | 却下した代替案 |
|---|---|---|
| ソースの場所 | リポジトリ直下 `mods/<name>/`（Mod のそのままの形） | `home/dot_claude/mods/`（`dot_claude-plugin` 表記になり、テストを実行できない）、`.skills/`（Codex にも複製される） |
| 読み込み経路 | settings の `env.CLAUDE_CODE_PLUGIN_DIRS` | ローカル marketplace（前例なし、キャッシュへのコピーで更新が反映されない） |
| 配布 | 新規 `run_after_sync-mods.sh.tmpl` で Mod ごとに rsync | B3: リポジトリを直接指す（apply のゲートを失う） |
| 何が Mod か | 共有テンプレート 1 か所: `.claude-plugin/plugin.json` を持ち、名前が許可リストに合うフォルダ | 各所で `mods/*` を glob する（README 等も拾い、3 か所の判定がずれる） |
| 名前の扱い | 許可リスト `^[a-z0-9][a-z0-9._-]*$`、違反は `fail` で apply を止める | 黙って飛ばす（足したつもりの Mod が読み込まれず気づけない） |
| テストの配布 | しない（リポジトリ上で `claude plugin test`） | 配布する（読み込みに不要） |
| CLAUDE.md への追記 | する。#2〜#4 も同じ手順を踏むので、経路と開発時の `--plugin-dir` を 3-4 行で残す | 書かない（次の Mod を作るたびに経路を調べ直すことになる） |
| dev-mods の旧コピー | 触らない（session 用で、エンジンが片付ける） | 削除する手順を足す |

## Risks

- **settings の `env` 経由で読み込まれるかは未確認**: reference.md の記述に依存している。T0 で、apply 前にプロセスの環境変数として渡して確かめる。読み込まれなければ実装に進まず、案 A（`.skills/` 経由）での再計画に戻る。hot reload の確認ダイアログが出るかも T0 で記録する。T0 は通ったが F1（settings の `env` 経由）で読み込まれない場合も、同じく案 A での再計画に戻る。その場合、生成した `CLAUDE_CODE_PLUGIN_DIRS` は `mods/` を空にして apply すれば消える
- settings.json は session 起動時に読まれるので、通しの確認（F1）は新しい session で行う
- **CI は Mod を検証しない**: Mod の型チェック（`tsc -p`）はエンジンが書き出す型が必要なので、CI には載せられない。`bun run test` も `home/dot_claude/hooks/tests` だけが対象。ルートの typecheck と oxlint から `mods/**` を外し、Mod の検証はローカルの `claude plugin validate` と `claude plugin test` に任せる。フォーマット検査（`oxfmt --check`）は `mods/` にもかける
- **信頼の境界**: Mod は Claude Code の中で `$.process.run` や `$.fs` を使えるコードで、すべての session・すべてのプロジェクトで読み込まれる。リポジトリの master に入った `mods/` 配下のコードは、次の apply 以降すべての session で動く。これは `run_after` スクリプトや `~/.claude/hooks/` と同じ信頼領域で、新しい種類のリスクではない。`~/.claude/rules/autonomous-lane.md` の C3 ブロックリストに `mods/**` を加えるかは、この plan の範囲外とし、別途判断する（追跡項目: 自律レーンの対象を広げるときに、`mods/**` をコード実行面として扱うかを決める）
- **配布先への書き込み**: `~/.claude/mods/**` に対する Write/Edit は許可ルールに無く、file-access-guard が settings の permissions に従って止める（`~/.claude` で許可されているのは `~/.claude/plans/**` だけ）。`~/.claude/hooks/` と同じ扱いなので、新しい禁止ルールは足さない
- rollout 設定の保存値が off だと、`claude plugin test` と新しい session の Mod が無効になる（Goal の前提）

## Files

```
# 新規作成（dev-mods から移すソース）
mods/workflow-band/.claude-plugin/plugin.json
mods/workflow-band/hooks/hooks.json
mods/workflow-band/hooks/register.tsx
mods/workflow-band/hooks/parse.ts
mods/workflow-band/hooks/register.test.ts
mods/workflow-band/types/index.d.ts

# 新規作成（Mod の定義、配布、smoke テスト）
home/.chezmoitemplates/claude-mod-names
home/.chezmoitemplates/claude-mods-dir
home/.chezmoiscripts/run_after_sync-mods.sh.tmpl
tests/smoke/run_after_sync-mods/fresh-home/setup.sh

# 編集
home/dot_claude/.settings.base.json.tmpl
tsconfig.json
package.json
.gitignore
CLAUDE.md
```

## Tasks

### T0: settings の env 経由で読み込まれるかを先に確かめる（ユーザー操作）

- 参照: reference.md:68（`CLAUDE_CODE_PLUGIN_DIRS` の仕様）

- [ ] **Step 1**: ユーザーに次の起動を依頼する（dev-mods のコピーを使う。リポジトリには何も書かない）:
  `cd ~/.local/share/chezmoi && DOCUMENT_WORKFLOW_DIR=.tmp/sessions/02f36229 CLAUDE_CODE_PLUGIN_DIRS=/home/berlysia/.claude/dev-mods/1ec067a4-9987-4ec4-ab30-b00e281a6313/workflow-band claude`
- [ ] **Step 2**: 期待: `--plugin-dir` なしで ✓ 7 項目と `[pinned]` の帯が出る。確認ダイアログが出たかを記録する。帯が出なければここで止め、案 A で再計画する
- 注: これはプロセスの環境変数で渡す確認で、settings の `env` ブロック経由ではない。reference.md:68 はどちらも同じく読むと書いているので、ここで代用する。settings 経由は F1 で確かめる

### T1: Mod のソースを mods/ に移す

**Files:** 新規 `mods/workflow-band/**`（上の 6 ファイル）。コピー元は `~/.claude/dev-mods/1ec067a4-9987-4ec4-ab30-b00e281a6313/workflow-band/`（`.claude-plugin/types/` と `tsconfig.json` は生成物なので除く）

- [ ] **Step 1**: 6 ファイルをコピーする
- [ ] **Step 2**: `bunx oxfmt --check mods/` → 差分が出たら `bunx oxfmt mods/` で整形する。期待: 再度の `--check` が終了コード 0
- [ ] **Step 3**: `claude plugin validate mods/workflow-band` → 期待: `✔ Validation passed`（警告は `author` 未設定の 1 件のみ）
- [ ] **Step 4**: `claude plugin test mods/workflow-band` → 期待: `3 pass, 0 fail`

### T2: ルートの typecheck と lint から mods/ を外し、生成物を無視する

**Files:**

- 編集: `tsconfig.json:3`（`exclude` に `"mods/**"` を追加）
- 編集: `package.json:29`（`lint:oxlint` に `--ignore-pattern 'mods/'` を追加。`.skills/` と同じ扱い）
- 編集: `.gitignore`（`mods/*/.claude-plugin/types/` と `mods/*/tsconfig.json` を追加）
- 参照: `package.json:29` の既存 `--ignore-pattern '.skills/'`

- [ ] **Step 1**: T1 の後、T2 の変更前に `bun run typecheck 2>&1 | head -5` を実行し、最初のエラーを記録する（Red。`mods/workflow-band/hooks/` 配下のファイルを指すエラーであることだけを期待し、文言は観測した内容で記録する）
- [ ] **Step 2**: 3 ファイルを編集する
- [ ] **Step 3**: `bun run typecheck` と `bun run lint:oxlint` → 期待: どちらも終了コード 0（Green）
- [ ] **Step 4**: `git check-ignore mods/workflow-band/.claude-plugin/types/x mods/workflow-band/tsconfig.json` → 期待: 2 行とも出力される

### T3: Mod の定義、配布スクリプト、smoke テスト

**Files:**

- 新規: `home/.chezmoitemplates/claude-mod-names`、`home/.chezmoitemplates/claude-mods-dir`、`home/.chezmoiscripts/run_after_sync-mods.sh.tmpl`、`tests/smoke/run_after_sync-mods/fresh-home/setup.sh`
- 参照: `home/.chezmoiscripts/run_after_sync-skills.sh.tmpl:1-12,45-46`（Windows 除外、workingTree、rsync の形）、`home/.chezmoitemplates/ccstatusline-settings.tmpl`（共有テンプレートの前例）、`scripts/smoke-chezmoi-scripts.sh:88-99`（harness は終了コードだけを判定する）

- [ ] **Step 1**: 名前判定のテストを先に書く（Red）。scratchpad に `ok-mod/.claude-plugin/plugin.json`、`Bad:x/.claude-plugin/plugin.json`、`README.md`、`notamod/` を作り、次を実行する:
  `printf '{{ includeTemplate "claude-mod-names" (dict "root" "<scratch>") }}' | chezmoi execute-template --source home`
  期待: テンプレートが無いので失敗する
- [ ] **Step 2**: `claude-mod-names` を書く。入力は `dict "root" <dir>`、出力はスペース区切りの名前。この session で同じ式を `/tmp/tmp.AY55GbzDYO` に対して展開し、`Bad:x` で fail、`ok-mod` のみで `ok-mod` が出ることを確認済み:

```
{{- /* Mods under .root: folders holding .claude-plugin/plugin.json. The name becomes a path element
       in settings.json's CLAUDE_CODE_PLUGIN_DIRS (":"-separated) and in rsync targets, so anything
       outside the allowlist stops the apply rather than being skipped silently. */ -}}
{{- $names := list -}}
{{- range glob (print .root "/*/.claude-plugin/plugin.json") -}}
{{-   $name := base (dir (dir .)) -}}
{{-   if not (regexMatch "^[a-z0-9][a-z0-9._-]*$" $name) -}}
{{-     fail (printf "mods/%q: a mod name must match ^[a-z0-9][a-z0-9._-]*$" $name) -}}
{{-   end -}}
{{-   $names = append $names $name -}}
{{- end -}}
{{- join " " $names -}}
```

  `claude-mods-dir` は 1 行: `.claude/mods`（配布先の唯一の定義。HOME からの相対パスにして、展開時のホームディレクトリをスクリプトに埋め込まない。ファイル末尾の改行が混ざらないよう、呼び出し側は `| trim` を付ける）
- [ ] **Step 3**: Step 1 のコマンドを再実行する → 期待: `Bad:x` を含む状態では終了コード 1 で `mods/"Bad:x": a mod name must match` を含む。`Bad:x` を消すと `ok-mod` だけを出力し、終了コード 0
- [ ] **Step 4**: smoke fixture `fresh-home/setup.sh` を書く（空の HOME がシナリオ。`empty-env` と同じ書き方）。`bun run smoke:chezmoi` → 期待: `run_after_sync-mods` のテンプレートが無いので FAIL（Red）
- [ ] **Step 5**: 配布スクリプトを書く。配布後の状態をスクリプト自身が検証し、満たさなければ非 0 で終わる。smoke の harness は終了コードしか見ないので、この検証が smoke の実質の検査になる:

```bash
{{ if ne .chezmoi.os "windows" -}}
#!/bin/bash
# Sync repo-root mods/ to ~/.claude/mods/. Which folders count as mods, and where they go, are
# defined once in .chezmoitemplates/claude-mod-names and claude-mods-dir; settings.json's
# env.CLAUDE_CODE_PLUGIN_DIRS is generated from the same two templates.
set -euo pipefail

MODS_SOURCE="{{ .chezmoi.workingTree }}/mods"
# $HOME at run time, not .chezmoi.homeDir at render time: the smoke test runs this under an isolated HOME.
CLAUDE_MODS="$HOME/{{ includeTemplate "claude-mods-dir" . | trim }}"
MOD_NAMES=({{ includeTemplate "claude-mod-names" (dict "root" (print .chezmoi.workingTree "/mods")) }})

mkdir -p "$CLAUDE_MODS"

for name in ${MOD_NAMES[@]+"${MOD_NAMES[@]}"}; do
  # --no-links skips links inside a mod; a mod folder that is itself a link would be followed.
  test ! -L "$MODS_SOURCE/$name"
  # Tests run from the repo with `claude plugin test`; the engine writes .claude-plugin/types/ and
  # tsconfig.json into every mod it loads, so --delete leaves them for a running session.
  rsync -a --delete --no-links --chmod=go-w \
    --exclude="*.test.ts" \
    --exclude="/.claude-plugin/types/" \
    --exclude="/tsconfig.json" \
    "$MODS_SOURCE/$name/" "$CLAUDE_MODS/$name/"
  test -f "$CLAUDE_MODS/$name/.claude-plugin/plugin.json"
  test -f "$CLAUDE_MODS/$name/hooks/hooks.json"
done

# A folder no longer in mods/ is no longer a mod: settings.json stops naming it on this apply.
# ~/.claude/mods is owned by this script, so anything else placed there is removed too. $name is the
# basename of a glob match under $CLAUDE_MODS: it holds no "/" and the glob skips "." and "..".
for dest in "$CLAUDE_MODS"/*/; do
  [ -d "$dest" ] || continue
  name=$(basename "$dest")
  case " ${MOD_NAMES[*]-} " in *" $name "*) ;; *) rm -rf "$CLAUDE_MODS/$name" ;; esac
done

echo "✅ Mods synced to $CLAUDE_MODS: ${MOD_NAMES[*]-none}"
{{ end -}}
```

- [ ] **Step 6**: `bun run smoke:chezmoi` → 期待: `run_after_sync-mods / fresh-home` が PASS（`mods/workflow-band` を実際に rsync し、`plugin.json` と `hooks.json` の存在検査を通過した結果）
- [ ] **Step 7**: `mktemp -d` の出力（リテラルのパス）を HOME にして、展開済みスクリプトを 2 回実行し、R2 と除外を確かめる。展開は `chezmoi execute-template --source home < home/.chezmoiscripts/run_after_sync-mods.sh.tmpl` で行い、展開結果に本物のホームディレクトリの絶対パスが入っていないことを先に確かめる: `grep -c '^CLAUDE_MODS="\$HOME/.claude/mods"$'` が `1`、`grep -cF '/home/berlysia/.claude/mods'` が `0`。1 回目の後に `<HOME>/.claude/mods/workflow-band/.claude-plugin/types/x` と `tsconfig.json`、`<HOME>/.claude/mods/stale-mod/` を作り、2 回目の後に検査する → 期待: `types/x` と `tsconfig.json` は残る、`stale-mod/` は消える、`hooks/register.test.ts` は存在しない、`stat -c %A <HOME>/.claude/mods/workflow-band/hooks/register.tsx` の 6 文字目と 9 文字目が `-`（グループと他ユーザーに書き込み権限が無い）。symlink の検査（S3）はこの手順で手作業で行い、スクリプトには入れない

### T4: settings.json の env を共有テンプレートから生成する

**Files:**

- 編集: `home/dot_claude/.settings.base.json.tmpl:14-16`
- 参照: `home/.chezmoiscripts/run_onchange_update-settings-json.sh.tmpl:16`（Hash 行がベーステンプレートの展開結果の sha256 を含む。編集しない）、同 140 行目のマージ `. + $template`

- [ ] **Step 1**: `chezmoi execute-template --source home < home/dot_claude/.settings.base.json.tmpl | jq -c '.env'` → 期待: `{"CLAUDE_CODE_NO_FLICKER":"0"}`（Red）
- [ ] **Step 2**: `env` ブロックを次の形にする:

```
  "env": {
    "CLAUDE_CODE_NO_FLICKER": "0"
    {{- if ne .chezmoi.os "windows" }}
    {{- $modsDir := print .chezmoi.homeDir "/" (includeTemplate "claude-mods-dir" . | trim) }}
    {{- $names := includeTemplate "claude-mod-names" (dict "root" (print .chezmoi.workingTree "/mods")) | splitList " " | compact }}
    {{- if $names }},
    "CLAUDE_CODE_PLUGIN_DIRS": {{ $dirs := list }}{{ range $names }}{{ $dirs = append $dirs (print $modsDir "/" .) }}{{ end }}{{ join ":" $dirs | toJson }}
    {{- end }}
    {{- end }}
  },
```

- [ ] **Step 3**: Step 1 を再実行する → 期待: `{"CLAUDE_CODE_NO_FLICKER":"0","CLAUDE_CODE_PLUGIN_DIRS":"/home/berlysia/.claude/mods/workflow-band"}`
- [ ] **Step 4**: 0 件の分岐を確かめる: `sed 's|"/mods"|"/mods-empty-probe"|' home/dot_claude/.settings.base.json.tmpl | chezmoi execute-template --source home | jq -c '.env'` → 期待: `{"CLAUDE_CODE_NO_FLICKER":"0"}`
- [ ] **Step 5**: 2 件で区切りを確かめる: `mktemp -d` の出力 `<probe>` に `a/.claude-plugin/plugin.json` と `b/.claude-plugin/plugin.json` を作り、式 `(print .chezmoi.workingTree "/mods")` 全体をリテラル `"<probe>"` に差し替えて展開する: `sed 's|(print .chezmoi.workingTree "/mods")|"<probe>"|' home/dot_claude/.settings.base.json.tmpl | chezmoi execute-template --source home | jq -c '.env'` → 期待: `CLAUDE_CODE_PLUGIN_DIRS` が `/home/berlysia/.claude/mods/a:/home/berlysia/.claude/mods/b`、jq がパースに成功する
- [ ] **Step 6**: Hash が名前の集合に追従することを確かめる（Hash 行は編集しない）。展開後の Hash 行は行番号では取らず `grep '^# Hash:'` で取る（テンプレート冒頭のアクションで行番号がずれ、展開後の 16 行目は `#` だけの行になるため）:
  - (a) T4 の編集前、Step 1 の時点で `chezmoi execute-template --source home < home/.chezmoiscripts/run_onchange_update-settings-json.sh.tmpl | grep '^# Hash:' > /tmp/claude-1000/-home-berlysia--local-share-chezmoi/1ec067a4-9987-4ec4-ab30-b00e281a6313/scratchpad/hash-before.txt` で保存する
  - (b) 編集後に同じコマンドの出力を `hash-after.txt` に保存し、`cmp` で比べる → 期待: 異なる（ベーステンプレートの展開結果に `CLAUDE_CODE_PLUGIN_DIRS` が加わったため）
  - (c) 名前の集合への追従: Step 5 の `<probe>`（`a` と `b`）を使い、Step 5 と同じ `sed` を通した `chezmoi execute-template --source home` の出力全体（jq を通す前）の `sha256sum` と、Step 3 の `chezmoi execute-template --source home` の出力全体の `sha256sum` を比べる → 期待: 異なる。Hash 行のこの部分は `includeTemplate "dot_claude/.settings.base.json.tmpl" . | sha256sum` そのものなので、展開結果の sha が変われば Hash 行も変わる

### T5: 適用と CLAUDE.md の追記

**Files:**

- 編集: `CLAUDE.md`（「Claude Code Skills Management」の後に「Claude Code Mods」節を 3-4 行で追加: ソースは `mods/<name>/`（名前は `^[a-z0-9][a-z0-9._-]*$`）、apply で `~/.claude/mods/` へ rsync、settings の `CLAUDE_CODE_PLUGIN_DIRS` は自動生成、開発中は `claude --plugin-dir mods/<name>`、検証は `claude plugin validate|test mods/<name>`。CI は Mod を検証しない）

- [ ] **Step 1**: `chezmoi apply`（引数なし。run_after は引数付き apply では走らない）
- [ ] **Step 2**: `jq -r '.env.CLAUDE_CODE_PLUGIN_DIRS' ~/.claude/settings.json` → 期待: `/home/berlysia/.claude/mods/workflow-band`。`ls ~/.claude/mods/workflow-band/hooks` → 期待: `hooks.json parse.ts register.tsx`
- [ ] **Step 3**: `bun run test`、`bun run typecheck`、`bun run lint`、`bun run smoke:chezmoi` → 期待: すべて終了コード 0
- [ ] **Step 4**: 下の F1 をユーザーに依頼する（新しい session が必要なため）

## テスト計画 (ISO 25010)

### 機能適合性（Functional suitability）

- **F0（apply 前の読み込み経路）**: T0 → 期待: env で渡した Mod が `--plugin-dir` なしで読み込まれ、✓ 7 項目と `[pinned]` の帯が出る
- **F1（配布の通し確認）**: `chezmoi apply` の後、フラグなしで新しく `claude` を起動し `/plugin` を開く → 期待: `workflow-band` が一覧にある。続けて `DOCUMENT_WORKFLOW_DIR=.tmp/sessions/02f36229 claude`（`--plugin-dir` なし）で起動 → 期待: 1 行目 `WF plan.md [pinned] ✓research ✓plan ✓review ✓approval ✓verdict ✓hash ✓ledger`、2 行目 `Next: The gate conditions are satisfied.`
- **F2（0 件）**: 有効な Mod が 0 件 → 期待: `env` は `{"CLAUDE_CODE_NO_FLICKER":"0"}` だけで、jq でパースできる（T4 Step 4）
- **F3（2 件）**: Mod 2 件 `a`、`b` → 期待: `CLAUDE_CODE_PLUGIN_DIRS` が `…/mods/a:…/mods/b`（T4 Step 5）。名前の集合が変わると Hash 行の値も変わる（T4 Step 6）

### 保守性（Maintainability）

- **M1**: `claude plugin test mods/workflow-band` → 期待: `3 pass, 0 fail`
- **M2**: `bun run typecheck` / `bun run lint` → 期待: 終了コード 0（`mods/` は typecheck と oxlint の対象外、`oxfmt --check` の対象）

### 信頼性（Reliability）

- **R1**: smoke `run_after_sync-mods / fresh-home`（`~/.claude` すら無い HOME）→ 期待: 終了コード 0。スクリプト内の `test -f` が `plugin.json` と `hooks.json` の配布を検査している
- **R2**: 配布先に `.claude-plugin/types/x`、`tsconfig.json`、`mods/` に無い `stale-mod/` がある状態で再実行 → 期待: 前 2 つは残り、`stale-mod/` は消え、`register.test.ts` は配布されていない（T3 Step 7）

### セキュリティ（Security）

- **S1（名前の注入）**: `Bad:x`（大文字とパス区切り）を含む root → 期待: `chezmoi execute-template` が終了コード 1 で、`mods/"Bad:x": a mod name must match` を出す（T3 Step 3）。実際の apply では、`run_before_10-validate-json-templates-unix` がベーステンプレートを展開する段で止まり、settings は書き換えられない
- **S2（Mod 以外）**: root に `README.md` と `plugin.json` の無い `notamod/` → 期待: 名前の一覧に出ない（T3 Step 3）
- **S3（symlink）**: rsync に `--no-links` を付ける → 期待: T3 Step 7 の隔離 HOME で、`mods/workflow-band/` 内に一時的に置いた symlink が配布先に現れない。確認後、その symlink は削除する

対象外: 性能効率性（数ファイルの rsync とテンプレート展開のみ）、互換性・使用性・移植性（Windows は既存スクリプトと同じく除外）。

## Approval

- Plan Status: complete
- Review Status: pass
- Approval Status: approved

## Reviewer Outputs (Round 1)

### logic-validator
- verdict: needs-work
- 主指摘: smoke harness は終了コードしか見ず、スクリプトも `mods/` 不在で exit 0 するため、R1/R2 を検証できない。`*.test.ts` の除外が設計節に無く、T2 の Red は予想した文言で観測に基づかない。rollout 設定が Goal の前提になっているのに書かれていない

### scope-justification-reviewer
- verdict: pass
- 主指摘: 各変更の根拠は十分。smoke が実際に何を検査するかを明記し、CLAUDE.md 追記には理由を 1 行書くこと

### decision-quality-reviewer
- verdict: pass
- 主指摘: 支配軸（運用性・変更容易性）は妥当。反復速度とゲートのトレードオフを明記し、settings の env 経由で読み込まれるかを apply 前に安く確かめ、読み込まれない場合の代替を Risks に書くこと

### greenfield-perspective-reviewer
- verdict: pass
- 主指摘: 白紙から設計し直しても B2 になる。テストを配布しない規則を設計として記録し、`mods/*` の glob を Mod（`.claude-plugin/plugin.json` を持つフォルダ）に絞ること

### architecture-boundary-analyzer
- verdict: needs-work
- 主指摘: `oxfmt --check` が `mods/` を対象に含むのに扱いを決めていない。`~/.claude/mods` と `mods/*` の知識がスクリプト・settings テンプレート・Hash 行の 3 か所に重複している。settings テンプレート側には Windows 除外の条件が無い

### security-vulnerability-analyzer
- verdict: needs-work
- 主指摘: ディレクトリ名をエスケープせず JSON に埋め込むため、`"` や `:` を含む名前で settings が壊れたりキーが注入されたりする（名前の許可リストと `toJson` で直す）。rsync は symlink をそのまま複製し、権限も保つ。信頼の境界（リポジトリの master に入ったコードが全 session で動く）を明記すること

<!-- auto-review: pending -->
<!-- intent-triage: pending -->

## Reviewer Outputs (Round 2)

### logic-validator
- verdict: needs-work
- 主指摘: `claude-mods-dir` が展開時の `.chezmoi.homeDir` をスクリプトに埋め込むため、smoke と T3 Step 7 が隔離 HOME ではなく本物の `~/.claude/mods` に rsync と削除を行う。Round 1 の指摘は解消。Hash 行の追加理由は誤り、T4 Step 5 の sed の置換対象が曖昧

### scope-justification-reviewer
- verdict: pass
- 主指摘: 追加分はすべて根拠があり、スコープの逸脱もない。`--chmod=go-w` は検査が無く、古い Mod を消す `rm -rf` には安全な理由をコメントで添えるとよい

### decision-quality-reviewer
- verdict: pass
- 主指摘: 支配軸は合っている。重いのは仕組みより検証手順。F1 が失敗した場合も案 A に戻ると明記し、C3 ブロックリストの件は追跡項目として残すこと

### greenfield-perspective-reviewer
- verdict: pass
- 主指摘: Round 1 の 2 点は解消し、白紙設計と一致する。対症療法も新たな野心ギャップも無い

### architecture-boundary-analyzer
- verdict: needs-work
- 主指摘: Hash 行 16 行目はすでにベーステンプレートの展開結果の sha256 を含むので、名前の集合が変われば Hash も変わる。Hash 行の編集と「加えないと再生成されない」の説明は誤り。名前の `fail` は apply では run_before の JSON 検証の段で止まり、CI の validate-json も落とす。これを明記すること

### security-vulnerability-analyzer
- verdict: pass
- 主指摘: Round 1 の 6 点は解消か受け入れ可能。`mods/` 直下の symlink のフォルダは glob も rsync もたどるので、ループに `test ! -L` を足すとよい。Risks から autonomous-lane.md を参照すること

<!-- auto-review: verdict=needs-work; hash=c0897a5ad87b76507c805525efb1fb90d79c83347982823684a5b78417ee7888; design-hash=ceed00032d7d976edca3956ec297bb7435a294c73bd0d137567ba7adbbbfd401; round=1; at=2026-10-02T21:19:29.255Z; reviewers=logic-validator+scope-justification-reviewer+decision-quality-reviewer+greenfield-perspective-reviewer+architecture-boundary-analyzer+security-vulnerability-analyzer -->

## Reviewer Outputs (Round 3)

### logic-validator
- verdict: needs-work
- 主指摘: Round 2 の HOME 埋め込みは解消（展開結果が `CLAUDE_MODS="$HOME/.claude/mods"` になることを実行で確認）。T4 Step 6 の `sed -n 16p` は展開後の 16 行目（`#` だけの行）を見ており、Hash 行ではない。`grep '^# Hash:'` を使い、編集前の値はファイルに保存すること

### architecture-boundary-analyzer
- verdict: pass
- 主指摘: Round 2 の指摘はすべて解消。HOME 相対への分割も定義は 1 か所のまま。任意: T4 Step 6 で、Mod 名の集合が変わったときにも Hash が変わることを probe で確かめるとよい

### scope-justification-reviewer
- verdict: pass (carried from Round 2)
- 主指摘: Round 2 で pass、再実行なし

### decision-quality-reviewer
- verdict: pass (carried from Round 2)
- 主指摘: Round 2 で pass、再実行なし

### greenfield-perspective-reviewer
- verdict: pass (carried from Round 2)
- 主指摘: Round 2 で pass、再実行なし

### security-vulnerability-analyzer
- verdict: pass (carried from Round 2)
- 主指摘: Round 2 で pass、再実行なし

<!-- auto-review: verdict=needs-work; hash=9291aaa738140aa151f2b6bea31ff392c29b2b74d0fe9f66d943d41b849ca89d; design-hash=ff673dc5791733063bdb46ed843e87f408ed692fd13c84b35f4bfc593f43ffd0; round=2; at=2026-10-02T21:23:08.869Z; reviewers=logic-validator+scope-justification-reviewer+decision-quality-reviewer+greenfield-perspective-reviewer+architecture-boundary-analyzer+security-vulnerability-analyzer -->

## Reviewer Outputs (Round 4)

### logic-validator
- verdict: pass
- 主指摘: T4 Step 6 は展開後に 1 行だけ一致する `# Hash:` 行を取り、(c) の論証も成り立つ（Hash 行の先頭がベーステンプレート展開結果の sha256 そのもの）。T3 Step 7 の grep は実行して期待どおり。軽微: sha を取る対象が jq の前の出力全体だと明記すること（反映済み）

### architecture-boundary-analyzer
- verdict: pass (carried from Round 3)
- 主指摘: Round 3 で pass、再実行なし

### scope-justification-reviewer
- verdict: pass (carried from Round 3)
- 主指摘: Round 3 で pass、再実行なし

### decision-quality-reviewer
- verdict: pass (carried from Round 3)
- 主指摘: Round 3 で pass、再実行なし

### greenfield-perspective-reviewer
- verdict: pass (carried from Round 3)
- 主指摘: Round 3 で pass、再実行なし

### security-vulnerability-analyzer
- verdict: pass (carried from Round 3)
- 主指摘: Round 3 で pass、再実行なし

<!-- auto-review: verdict=needs-work; hash=304440bf6b5fa5270e7bb1997bf4a11f0add047079e63ecc1542b71d31dda212; design-hash=a90fd07e87caa66baa16744f229fbfce3f2b49b17a75b987949fd6ef4d584a9a; round=3; at=2026-10-02T21:25:46.537Z; reviewers=logic-validator+architecture-boundary-analyzer -->

<!-- auto-review: verdict=pass; hash=73a31dd44e372ccc833eb664e4f3e66d115a6420b19321cd04405088ec2c429b; design-hash=3cb367b65ebd2166e2a18abbc7194c4f1b86a46511cea81aa2ffe3c79033428e; round=4; at=2026-10-02T21:26:44.775Z; reviewers=logic-validator -->
<!-- intent-triage: adopted=14; excluded=0; at=2026-10-02T21:27:04.174Z -->
