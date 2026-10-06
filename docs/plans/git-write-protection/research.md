# Research: .git まわりの権限と保護

対象: `home/dot_claude/.settings.permissions.json`（→ `~/.claude/settings.json`）と `home/dot_claude/hooks/`。
Claude Code 2.1.291（Bun single-file executable）、git 2.54.0（Apple Git-157）で調べた。

凡例: **[確認]** = 手元で実行・一次資料で確かめた / **[読解]** = コードを読んだだけ / **[未検証]** = 確かめていない。

## 1. 評価器は 3 層ある

依頼文では評価器を 2 つとしていたが、実際は本体の中にもう 1 層あり、判定は次の順に重なる。

| 層                        | 実体                                                                                                                                          | 書式 / 判定の材料                                                                                                                                                                             | realpath                                                                                                                                     |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| A. 本体の規則             | settings の allow / ask / deny                                                                                                                | gitignore 書式。ライブラリは `ignore` v7 系と見られる（バイナリの文字列 `_strictPathCheck` `allowRelativePaths` と v7 のエラー文言。間接証拠）                                                | 照合する。deny は「要求されたパス」か「解決後のパス」の一方に当たれば効く。allow は両方に当たる必要がある [確認: permissions.md「Symlinks」] |
| B. 本体の protected paths | 本体に組み込み                                                                                                                                | 保護されるディレクトリ: `.git` `.config/git` `.claude`（例外あり）`.vscode` ほか。保護されるファイル: `.gitconfig` `.gitmodules` `.zshrc` など [確認: permission-modes.md「Protected paths」] | symlink の解決後に protected path に当たれば確認を求める [確認]                                                                              |
| C. このリポジトリのフック | PreToolUse の `auto-approve.ts` と `file-access-guard.ts`、PermissionRequest の `permission-auto-approve.ts` と `permission-llm-evaluator.ts` | 自前の glob（`lib/pattern-matcher.ts`）。ディレクトリに当たる規則が中身に広がらない。相対パスはツール呼び出しごとの cwd で解決する                                                            | `auto-approve` はしない。`file-access-guard` はする（`lib/path-containment.ts` の `resolvePhysicalPath`） [読解 + 確認: §5]                  |

優先関係 [確認: permissions.md「Extend permissions with hooks」]:

- PreToolUse フックの deny（exit 2 も同じ）は、規則の評価より前に呼び出しを止める。
- フックが allow を返しても、A の deny と ask は評価される（deny が勝つ）。
- フックの allow は確認の省略（skip the prompt）として働く。
- `permissions.allow` では B を事前承認できない。protected paths の確認は allow 規則の評価より前に走る。
- **[確認] U1: PreToolUse フックの allow は B の確認を飛ばす。** ドキュメントには書かれていないので実験した。
  - 手順: scratchpad に `git init` したリポジトリで `claude -p --permission-mode default --model haiku` を動かし、Write ツールで書かせた。
  - フックありの結果: `.git/worktree/feat/probe.txt` と `.config/git/probe.txt` は、どちらも書けた。`auto-approve` が `Edit(//tmp/**)` と `Edit(//**/.git/worktree/**)` で allow を返したため。
  - 対照（`--settings '{"disableAllHooks":true}'`）の結果:
    - 同じ 2 か所は "Claude requested permissions to edit ... which is a sensitive file" で拒否された。`-p` では確認に答えられないため、拒否になる。
    - 同じリポジトリの通常のパスは書けた。
  - 結論:
    - settings の allow（`Edit(//tmp/**)`）だけでは B は事前承認されない。これはドキュメントどおり。
    - **確認を飛ばしているのはフックの allow である。**
    - 帰結として、`auto-approve` の allow の範囲（`~/workspace/**`、`~/.config/**`、`~/.local/share/chezmoi/**`、`//tmp/**`）の中では、本体の protected paths がすべて無効になっている。対象は `.git`、`.config/git`、`.claude`、`.vscode`、`.husky`、`.envrc`、`.npmrc` など。
    - 同時に、worktree（`.git/worktree/**`）の編集が確認なしで通っているのも、この迂回に依存している。

## 2. 本体の照合の細部（`ignore` 7.0.5 で再現）[確認]

scratchpad の `t.cjs` で、`ignore` 7.0.5 に gitignore 書式の照合をさせた結果（5.2.4 でも同じ）。

- 親ディレクトリが当たれば、その中身もすべて当たる。`ignores('repo/.git/config')` は `**/.git` でも true。
- 除外された親の中身を `!` で取り戻すことはできない（gitignore の仕様どおり）。
  - したがって「`.git` 全体を deny し、`.git/worktree/**` だけを allow で開ける」構成は、A の層では原理的に作れない。deny が勝つうえに、中身へ広がるため。
- 末尾が `/` の規則（`**/.git/`）はディレクトリにだけ当たる。ただし本体がディレクトリを末尾 `/` 付きで渡しているかは不明 [未検証]。
  - 本体ドキュメントにディレクトリだけに当てる書式は載っていない。
  - いずれにせよ、`.git` がファイルかディレクトリかを本体が知る手段は、書式の上にはない。
- `ignore` は絶対パスを受け付けない（`path.relative()`d string を要求する）。本体はアンカー（`//` `~/` `/` cwd）からの相対パスに直してから渡していると推測する [未検証]。

テストへの含意:

- `ignore@7` を devDependency に入れれば、A の層の「書式としての照合」は再現できる見込み。
- ただし、アンカーの解決（`//` `~/` `/`）と symlink の二重照合は、自前で書く必要がある。
- 現在の `settings-permissions-compat.test.ts` は C の層の照合器（`checkPattern`）だけで検証している [読解]。

## 3. 現在の規則（`.settings.permissions.json`）[確認: grep]

- allow（Edit）: `//**/.git/worktree/**` `.tmp/sessions/*/*.md` `//tmp/**` `~/.config/**` `~/.local/share/chezmoi/**` `~/workspace/**` `~/.claude/plans/**`
- deny（Edit）: `//**/.git/config` `//**/.git/config.worktree` `//**/.git/worktrees/*/config.worktree` `//**/.git/hooks/**` `//**/.git/modules/**/config` `//**/.git/modules/**/hooks/**` `//**/.git/worktree/*/.git`
- allow（Bash）の関連分:
  - L49 `Bash(tee *)`
  - L83 `Bash(git -c *)`
  - L99 `Bash(gh config *)`
  - L76-78 `git checkout|switch|worktree *`
  - L147-148 `chezmoi apply`
- `git config`、`ln`、`cp`、`mv` の規則は allow にも deny にもない。ask リストもない。

## 4. git がコマンドを実行する経路 [確認: 手元の man]

### 4.1 config として読まれるファイル

| scope        | パス（この機械）                                                                                                                                                                                                        |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| system       | `/Applications/Xcode.app/Contents/Developer/usr/share/git-core/gitconfig`（`/etc/gitconfig` は無い）                                                                                                                    |
| global       | `~/.config/git/config`（現在は無い）、`~/.gitconfig`                                                                                                                                                                    |
| include の先 | `~/.gitconfig_local`、`~/.gitconfig_gpg_ssh`、`includeIf gitdir:~/.local/share/mise/` → `~/.gitconfig-auto`（chezmoi のソースは `home/dot_gitconfig.tmpl` `home/dot_gitconfig_gpg_ssh.tmpl` `home/dot_gitconfig-auto`） |
| local        | `$GIT_DIR/config`                                                                                                                                                                                                       |
| worktree     | `$GIT_DIR/config.worktree`、`$GIT_DIR/worktrees/<id>/config.worktree`（`extensions.worktreeConfig` が有効なとき）                                                                                                       |
| command      | `git -c`、`GIT_CONFIG_COUNT/KEY_n/VALUE_n`、`GIT_CONFIG_PARAMETERS`、`GIT_CONFIG_GLOBAL/SYSTEM`（ファイルの差し替え）                                                                                                   |

include の先も、config と同じ権限で読まれる。相対パスは include を書いたファイルを基準に解決し、`~` は展開される。

### 4.2 実行につながるキー

local の `.git/config` に書いても無視されるキー（protected config 専用）は、`safe.directory` `safe.bareRepository` `uploadpack.packObjectsHook` の 3 つだけ。それ以外は local でも効く。実行につながるキー:

- `core.hooksPath`
- `hook.<name>.command`（2.54 の config で定義する hook）
- `core.fsmonitor`（`status` で発火する）
- `core.sshCommand` `core.gitProxy` `core.pager` `pager.<cmd>` `core.editor` `sequence.editor` `core.askPass` `core.alternateRefsCommand`
- `diff.external`
- `diff.<drv>.command|textconv`、`filter.<drv>.clean|smudge|process`、`merge.<drv>.driver`（いずれも attributes の指定と組み合わせて発火）
- `alias.*` の `!`
- `credential.helper`
- `gpg.program` `gpg.<fmt>.program` `gpg.ssh.defaultKeyCommand`
- `remote.<n>.uploadpack|receivepack`
- `ext::` URL（`protocol.ext.allow` と組み合わせる）
- `submodule.<n>.update=!cmd`
- `init.templateDir`
- `core.worktree`
- `gc.recentObjectsHook`
- `trailer.*.cmd`
- `difftool|mergetool|guitool.*.cmd`、`browser|man.*.cmd`
- `include.path`、`includeIf.*.path`

結論: 値の検査で塞ぐのは非現実的。**config として読まれうるファイルを書かせない**方向が正しい。

### 4.3 config 以外のファイル

| ファイル                                                                 | 実行につながる条件                                                                                                                | 現在の deny                                        |
| ------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| `$GIT_DIR/hooks/*`                                                       | 実行ビットが必要（Edit ツールでは付けられない。Bash の `chmod` が要る）                                                           | あり                                               |
| `$GIT_DIR/commondir`                                                     | 書けば、config と hooks を読む先を任意の dir へ向けられる                                                                         | **なし**                                           |
| gitfile（作業ツリーの `.git` ファイル: worktree、サブモジュール）        | 指す先を `$GIT_DIR` として、その config と hooks を読む                                                                           | worktree の直下だけ（`//**/.git/worktree/*/.git`） |
| `$GIT_DIR/info/attributes`、`.gitattributes`、`~/.config/git/attributes` | 単独では実行に至らない。driver の定義が既にあれば発火する（この機械の global に filter driver は無い [読解: dot_gitconfig.tmpl]） | なし                                               |
| `.gitmodules`                                                            | `update=!cmd` は拒否される。URL の `ext::` は `protocol.allow` の既定で止まる                                                     | なし（害は小さい）                                 |
| `$GIT_DIR/modules/<n>/{config,hooks}`                                    | 通常のリポジトリと同じ                                                                                                            | あり                                               |

- サブモジュールの `.git` は、中身が `gitdir: ../../.git/modules/vendor/sub` のテキストファイル [確認: scratchpad の実験]。
- `safe.directory` は、所有者が同じなら何も緩和しない。

## 5. 穴の検証結果

フックの判定は、`bun implementations/<hook>.ts` に PreToolUse の JSON を流して確かめた（書き込みはしていない）。

| #   | 経路                                                                                                                                                               | C: フックの判定                                                                                   | A と B: 本体の判定                                                                                             | 評価                                                                                                                                                                                  |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| H1  | `git -c core.fsmonitor=/tmp/evil status`（Bash）                                                                                                                   | allow（`Bash(git -c *)`）[確認]                                                                   | 本体も `Bash(git -c *)` で allow [確認: 規則]                                                                  | **確認なしで任意のコマンドが実行される。最優先**                                                                                                                                      |
| H2  | Write `~/.config/git/config`                                                                                                                                       | `auto-approve`: allow（`Edit(~/.config/**)`）。`file-access-guard`: 素通し [確認]                 | A: allow 規則に当たり、deny は無い。B: `.config/git` は protected だが、フックの allow で飛ばされる [確認: U1] | **確認なしで global config を書ける**                                                                                                                                                 |
| H3  | chezmoi のソース `home/dot_gitconfig.tmpl` `home/dot_gitconfig_gpg_ssh.tmpl` `home/dot_config/git/*` を Edit → `chezmoi apply`（`Bash(chezmoi apply *)` は allow） | allow（`Edit(~/.local/share/chezmoi/**)`）                                                        | A: allow。B: パス名が `.gitconfig` ではないので protected に当たらない                                         | **確認なしで global config を変えられる。** 同じ構造で、chezmoi のソースは `dot_zshrc` や `run_*` スクリプトの配布路にもなる（§7 の論点）                                             |
| H4  | worktree の中のサブモジュールのポインタ `.git/worktree/feat/vendor/sub/.git`                                                                                       | allow（`Edit(//**/.git/worktree/**)`）[確認]                                                      | A: deny に当たらない。B: protected だが、フックの allow で飛ばされる [確認: U1]                                | **確認なしで書ける。** worktree の外の通常のサブモジュール（`~/workspace/x/vendor/sub/.git`）も、`Edit(~/workspace/**)` でフックが allow を返すので同じ [U1 から推論。個別には未検証] |
| H5  | `$GIT_DIR/commondir`                                                                                                                                               | 規則の外 → `auto-approve` は ask                                                                  | A: deny なし。B: `.git` の中                                                                                   | 規則の網羅の漏れ。deny に足すべき                                                                                                                                                     |
| H6  | `sed -i ... .git/config`（Bash）                                                                                                                                   | allow（`inferSedInPlaceAllow` は Edit の allow だけを見て、deny を見ない）[確認]                  | A: 本体は `sed` を認識するファイルコマンドとして Edit の deny を当てる [確認: permissions.md の Warning]       | 本体が止める。ただしフックの判定が本体とずれていること自体は不具合                                                                                                                    |
| H7  | `tee .git/hooks/x`（Bash）                                                                                                                                         | allow（`Bash(tee *)`）[確認]                                                                      | A: `tee` の書き込み先には Edit の deny が当たる（v2.1.269 以降）[確認: docs]                                   | 本体が止める                                                                                                                                                                          |
| H8  | symlink 経由（`/tmp/.../lib -> ~/Library`、`lib/LaunchAgents/x.plist` へ Write）                                                                                   | `auto-approve`: allow（字句で照合）。`file-access-guard`: **deny**（physical パスが範囲外）[確認] | A: allow は両方のパスに当たる必要がある。Edit/Write は、パス自体が symlink のときは拒否する                    | 塞がっている（`file-access-guard` と本体の二重）                                                                                                                                      |
| H9  | `git config core.hooksPath x`（Bash、`--global` なし）                                                                                                             | `auto-approve`: pass。`permission-auto-approve`: 静的には未定で、LLM の評価器に回る [読解]        | 規則なし → 確認                                                                                                | LLM の評価器が allow を返しうるかは [未検証]。プロンプトに git config への言及は無い [読解]                                                                                           |
| H10 | `permission-auto-approve.ts:122,124` の正規表現 `^git\s+(-[cC]\s+\S+\s+)*(status                                                                                   | ...                                                                                               | commit                                                                                                         | ...)`                                                                                                                                                                                 | `-c` の値を検査せずに allow | H1 と同じ | H1 の別経路。`Bash(git -c *)` を外しても、ここが残れば通る（PermissionRequest の段で通る） |

| H11 | PreToolUse で allow されない protected path（`/private/tmp/.../repo/.git/pr-probe.txt`。字句では `//tmp/**` に当たらない）への Write | PreToolUse: ask → 本体が確認を出す → PermissionRequest で `permission-auto-approve` の Layer 2a が allow（`permission-auto-approve.ts:569` の `filePath.startsWith(cwd)`）。Layer 2b の LLM も "File write to user's project .git directory. Within project scope..." で allow [確認: `~/.claude/logs/decisions.jsonl` 2026-10-06T05:06:05Z と 05:06:19Z] | B の確認が、PermissionRequest の段のフックによって自動で承認される | **PreToolUse を直しても、この段から同じ穴が開く。** 両方の段で protected path を人間に回す必要がある |

H11 の付記: 同じ実行で、通常のパス `pr-plain.txt` は "No patterns matched" で拒否された。PermissionRequest の記録が無く、理由は分かっていない（観察のみ。設計には使わない）。

H8 の補足: 依頼文の論点 3（照合器は realpath しない）は、`auto-approve` については事実です。ただし同じ Edit 系の呼び出しには `file-access-guard` が必ず走り、physical パスで deny を出します。本体も両方のパスを照合します。全体として見れば、穴にはなっていない。

## 6. フック自身の git 呼び出し

`-c core.fsmonitor=`（`workflow-bash-sync.ts:299`、`compaction-testament.ts:428`、`executable_agent-vm`）は、いずれも child_process から直接 git を起動している [読解]。Bash ツールを経由しないので、`Bash(git -c *)` を外しても影響しない。

`executable_agent-vm` L794 の `EXEC_CONFIG_RE` は、実行につながる config キーの正規表現。agent-vm はこれで `.git/config` と hooks を監視している。先行実装として参照できる。

## 7. 設計上の論点（spec で決める）

1. **worktree の置き場所と `.git` の保護の衝突。** A の層では「`.git` 全体を deny して worktree だけを開ける」構成が作れない（§2）。そのため deny は個別ファイルの列挙になり、漏れが続く（commondir、gitfile）。
   - 白紙で考えると、worktree を `.git` の外（例: `<repo>/.worktrees/`。gitignore に追記が要る）に置けば、`Edit(//**/.git)` と `Edit(//**/.git/**)` の deny 1 組で、ポインタファイルまで含めて閉じられる。
   - ただし、現在の規約（`.git/worktree/<branch>`、`developer-experience.md`）と `git-worktree-create` の変更を伴う。
2. **ファイルの種類と実体を見る判定をどこに置くか。** gitfile を守るには、名前が `.git` で中身が `gitdir:` のファイルを見分ける必要がある。これは書式では書けず、PreToolUse のフックで `lstat` するしかない。
   - フックの deny は、本体の規則より前に効く（§1）。
3. **global の git config。** `Edit(~/.config/**)` の中の `~/.config/git/**` と、chezmoi のソースの git 関連ファイル（`dot_gitconfig*`、`dot_config/git/**`）を deny に入れるか。include の先は、名前の列挙（`~/.gitconfig*`）で足りるか。
4. **Bash の経路。**
   - `Bash(git -c *)` の削除。
   - `permission-auto-approve.ts` の `-c` を許す正規表現の修正。
   - `git config` の書き込み形の扱い（ask に固定するか、LLM の評価器に任せるか）。
   - `sed -i` の推論に Edit の deny を見せる。
5. **chezmoi のソースが配布路になっている件**（H3 を一般化したもの）。`dot_zshrc`、`run_*` も同じ構造。今回の範囲（git）を越えるので、範囲の外として記録するか、git 関連ファイルだけを塞ぐかを決める。
6. **テスト。** `ignore@7` を devDependency に入れて、A の層の照合を再現する compat テストを足すか。C の層だけのテストでは、04df6bb の種類の誤りは原理的に検出できない。
7. **フックの allow と本体の protected paths（U1 で確認）。** 根本の構造はこうなっている。
   - フックが allow を返すと、本体の protected paths の保護が消える。
   - その消えた保護を補うために、deny を 1 つずつ列挙してきた。
   - 白紙で考えると、フックは本体の protected paths に当たるパスには allow を返さない（判定を本体に委ねる）。worktree の中身だけを、実体（gitfile の指す先が `<repo>/.git/worktrees/<name>` であること）を確かめたうえで開ける。
   - 本体の protected paths の一覧は、ドキュメントにしか無い。フック側に写す必要があり、本体の版が上がって一覧が増えたときの追従が課題になる。

## 8. 範囲外として観察したこと

- `Bash(gh config *)` の allow で、`gh config set editor <cmd>` ができる（gh がコマンドを実行する経路）。git ではないが、同じ種類の問題。
- `~/workspace/agent-orchestrator/AGENTS.md` の symlink の先は確認していない。
