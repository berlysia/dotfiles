# ADR-0027: hook は権限のパスパターンを Claude Code 本体と同じ規則で読む

## Status

accepted (2026-10-06)

amended (2026-10-06): `/x` の基準。末尾の Amendment を参照

## Context

Claude Code の権限の設定（`permissions.allow` / `permissions.deny`）は、本体と hook の両方が読む。
hook は `auto-approve`（PreToolUse）と `file-access-guard`（PreToolUse）で、`Edit(~/.config/**)` のような規則のパスの部分を自前の関数でパスと比べていた。
この ADR の前は、同じ行の意味が本体と hook で違っていた。

きっかけは、`claude -p` で Document Workflow を実行したとき、workflow dir の `research.md` への Write が `No patterns matched` で 6 回拒否されたことである。
原因を調べると、次の 4 つの事実が見つかった。

1. hook は Write を `Write(...)` の規則でだけ判定していた。設定に `Write(...)` の規則は 1 件も無い。
2. hook は相対パターンを部分文字列として比べていた。`Write(.tmp/sessions/**)` を足すと、`<repo>/.tmp/sessions/../../x` や `<repo>/x.tmp/sessions/y` も allow になった。
3. allow の `Edit(!.git/**)` など 7 件が、1 件ごとに「そこ以外のすべての Edit を許可」として働いていた。`Edit(!.git/**)` の 1 件だけで、`/etc/hosts` への Edit が allow になった。
4. `*` を含まない絶対パターン（`Edit(~/.zshrc)`、`Edit(/etc/passwd)`）は、hook では 1 件も一致していなかった。

本体の規則は公式ドキュメント（References）に書かれている。
変更前の hook との違いは次のとおりである。

| 項目             | 本体                                               | 変更前の hook                                        |
| ---------------- | -------------------------------------------------- | ---------------------------------------------------- |
| 相対パターン     | 現在のディレクトリの下だけ。区切り単位             | 部分文字列。現在のディレクトリの外にも一致           |
| ファイル名だけ   | 現在のディレクトリ配下の任意の深さ                 | 設定の文字列から作った正規表現を、ファイル名に当てる |
| `./x/**`         | `<cwd>/x/**`                                       | 一致しない                                           |
| `./**`、`**`     | `<cwd>/**`                                         | `./**` は絶対パスに一致しない。`**` は全パスに一致   |
| `*` なしの `~/x` | そのパス                                           | 一致しない                                           |
| allow の `!`     | 意味なし                                           | 結果を反転                                           |
| Write ツール     | Edit の規則で判定。`Write(...)` の規則は参照しない | `Write(...)` の規則だけで判定                        |
| symlink          | allow は解決先も一致が要る                         | `auto-approve` は字句だけ                            |

## Decision

### D1: hook はパスの規則を本体と同じ規則で比べる

設定の 1 行は、本体と hook で同じ場所を指すようにする。
比べる手順は 2 段に分ける。
規則のパスの部分を「文字どおりの基準ディレクトリ」と「そこからの相対の glob」に解決し、対象のパスを正規化した絶対パスに解決してから、区切り単位で比べる。

解決の規則は次のとおりである。
`grant` は allow の規則と比べる場合、`restrict` は deny の規則と比べる場合を指す。

| 本体の形                          | 基準             | glob（grant） | glob（restrict）              |
| --------------------------------- | ---------------- | ------------- | ----------------------------- |
| `//x`                             | `/`              | `x`           | 同じ                          |
| `/x`                              | `<settingsRoot>` | `x`           | 同じ                          |
| `~/x`                             | `<home>`         | `x`           | 同じ                          |
| `./x`                             | `<cwd>`          | `x`           | 同じ                          |
| `<名前>` または `**/<名前>`       | `<cwd>`          | `**/<名前>`   | `**/<名前>` と `**/<名前>/**` |
| `<名前>/**`（単一のディレクトリ） | `<cwd>`          | `<名前>/**`   | `**/<名前>/**`                |
| その他の相対                      | `<cwd>`          | そのまま      | 同じ                          |

`<settingsRoot>` は規則の出どころで決まる（D8）。
`/` が 2 つ以上続く規則は `//` と同じに読む。
`/` で終わる規則は `/**` を足して読む。
空文字、`~`、`..` の区切りを含む規則は、allow では何も許可せず、deny ではそのパスだけを守る。
`..` を含む `/x` の deny は、`<settingsRoot>` につないで畳んだパスを守る。
基準ディレクトリは glob に埋め込まず文字どおりに比べるので、`cwd` に `*` が含まれていても wildcard として読まれない。

### D2: 相対パターンの基準は hook の入力の cwd

本体の「現在のディレクトリから」に合わせる。
ADR-0023 の project root（`getProjectRoot()`）は使わない。
作業ディレクトリが起動したディレクトリと違うセッションでは、相対パターンは作業ディレクトリの側を指す。

`/x` の基準は cwd ではなく、D8 の `<settingsRoot>` である。
2 つの基準は環境の読み方が違う。
相対パターンの基準は `CLAUDE_PROJECT_DIR` を読まず、`/x` の基準は読む。

### D3: `!` で始まる規則は何にも一致しない

本体は allow の `!` に意味を与えていない。
hook の反転をなくし、設定の `Edit(!.git/**)` など 7 件を消した。
代わりの規則（作業ディレクトリ全体を許可する `Edit(./**)` など）は足していない。

deny の `!`（前に書いた相対の deny からの除外）は実装していない。

### D4: Write、MultiEdit、NotebookEdit は Edit の規則でも判定する

本体の「Edit の規則は、ファイルを編集するすべての組み込みツールに適用される」に合わせる。
`Write(...)` の規則は足さない。

ただし、Edit の規則を借りた allow は、危険なパス（`/etc/`、`/usr/`、`/bin/`、`/sbin/`、`/.ssh/`、`/.gnupg/`、`/.aws/`、`/credentials`、`/.env` を含むパス）には返さない。
PermissionRequest の hook（`permission-auto-approve`）がこれらのパスへの書き込みを拒否しており、Write は変更前、PreToolUse で必ず `ask` になってその拒否の判定に届いていた。
PreToolUse が allow を返すとその判定は飛ばされるので、判定に届く状態を保つ。
判定は 1 つの関数（`lib/dangerous-write-paths.ts`）にまとめ、2 つの hook が同じものを使う。

### D5: workflow dir の文書を許可する規則を足す

allow に `Edit(.tmp/sessions/*/*.md)` を足した。
`.md` と深さ（`<id>/` の直下）に絞ったのは、workflow dir には hook が管理する状態ファイル（`reviewer-runs.log`、`.tripwire-disabled` など）があり、`document-workflow-guard` が `.md` だけを実装の gate から免除しているためである。

### D6: `*` を含まない allow 4 件を消す

`Edit(~/.bashrc)`、`Edit(~/.gitconfig)`、`Edit(~/.gitignore_global)`、`Edit(~/.zshrc)` を設定から消した。
この 4 件は変更前の hook では一致しておらず、`~/.zshrc` などへの Edit は `file-access-guard` の既定の deny（リポジトリの外で、明示の allow が無い）で止まっていた。
D1 で 4 件が一致し始めると、`file-access-guard` はパターン一致の段で allow を返し、既定の deny に届かなくなる。
4 件を消して、変更前の「止まる」を保った。

**不変条件**：`file-access-guard` は、パターン一致の allow（step 5）を、chezmoi の誘導（step 6a）と既定の deny より先に判定する。
ホームのファイルを allow の規則に書くと、誘導にも既定の deny にも届かなくなる。

### D7: 解決は環境を読まない関数にする

規則と対象を解決する関数（`lib/path-utils.ts` の `resolvePathPattern`、`resolveTargetPath`）は、引数だけで結果が決まる。
基準（`cwd` と `home`）は、hook の最初で 1 回作って渡す（`lib/project-root.ts` の `createMatchContext`）。
絶対パスでない `cwd` は使わず、プロセスの作業ディレクトリに落とす。

`/x` の基準は規則ごとに違うので、規則と一緒に運び（`SourcedRule`）、比べるときに文脈に足して渡す（`lib/pattern-matcher.ts` の `ruleContext`）。
出どころごとの基準を作るのは `lib/project-root.ts` の `createSettingsRoots` である。
環境を読むのは `lib/project-root.ts` だけである。

### D8: `/x` の基準は、規則の出どころで決まる

本体は `/x` を、規則を定義した設定の出どころごとに決まるディレクトリからのパスとして読む。
hook も同じ場所から読む。

| 出どころ                   | hook が読むファイル                                                       | `/x` の基準（`<settingsRoot>`）  |
| -------------------------- | ------------------------------------------------------------------------- | -------------------------------- |
| ユーザー設定               | `<home>/.claude/settings.json`                                            | `<home>/.claude`                 |
| プロジェクトの設定         | `<git toplevel>/.claude/settings.json`                                    | セッションを起動したディレクトリ |
| プロジェクトのローカル設定 | `<git toplevel>/.claude/settings.local.json`（`auto-approve` だけが読む） | セッションを起動したディレクトリ |
| テスト用の環境変数         | `CLAUDE_TEST_ALLOW` / `CLAUDE_TEST_DENY`                                  | セッションを起動したディレクトリ |

「セッションを起動したディレクトリ」は、`CLAUDE_TEST_CWD`、`CLAUDE_PROJECT_DIR`、hook の入力の cwd の順に見て、最初の絶対パスを使う。
どれも絶対パスでなければ、プロセスの作業ディレクトリを使う。
テスト用の環境変数の規則は設定ファイルを持たないので、本体が CLI フラグの規則に使う基準と同じにした。

どのファイルにどの基準を付けるかは、1 つの関数（`lib/settings-sources.ts` の `listSettingsSources`）に置く。
2 つの hook は、その結果から読むファイルを選ぶ。
基準は glob に埋め込まず、D1 のとおり文字どおりに比べる。

## Consequences

### Edit の allow が狭まった

`auto-approve` が Edit と Write を allow にするのは、`/tmp`、`~/.config`、`~/.local`、`~/workspace`、`~/.claude/plans` の下と、作業ディレクトリの `.tmp/sessions/*/*.md`、それにプロジェクトの設定が足す規則の範囲だけになった。
それ以外の場所では `ask` になる。
変更前は、Edit は場所を問わずほぼ allow だった。

### 規則を書くときに知っておくこと

- ファイルシステムの絶対パスは `//` で書く。`/x` は、ユーザー設定では `~/.claude/x`、プロジェクトの設定では `<セッションを起動したディレクトリ>/x` を指す。
- allow に名前だけの規則（`Edit(*.md)`）を書くと、作業ディレクトリ配下の任意の深さに一致する。単一のディレクトリ（`Edit(src/**)`）は `<cwd>/src` だけに一致し、任意の深さにするには `Edit(**/src/**)` と書く。
- 相対の deny が守るのは作業ディレクトリの下だけである（本体と同じ）。作業ディレクトリの外まで守る deny は `//**/` で書く。
- `*` はドットで始まる名前にも一致する。`Read(**/*.test.*)` は `.env.test.local` にも一致する。
- `..` を含む規則は、allow では何も許可せず、deny ではそのパスだけを守る。

### 本体と合わせていない点

hook が本体より広く許可する側。

- **symlink**：`auto-approve` は解決先を見ない。`file-access-guard` は字句の形と realpath の形の両方で判定するが、指す先が Edit の allow の範囲にあれば通す。Edit では変更前から同じである。

hook が本体より多く止める側。

- **`!` 付きの deny**：hook は除外を行わない。
- **危険なパスへの Write**（D4）：Edit には同じ判定が無い。判定は部分文字列で行うので、`.env.example` のような名前も止める。解消の道は 2 つある。Edit にも同じ判定を入れるか、判定を設定の deny の規則に移すかである。どちらも Edit の今の挙動を変える。
- **一致する規則が無いときの `ask`**：本体は一致しない呼び出しを自分の権限モードで判定するが、hook は `ask` を返す。

`/x` の基準と、読む設定ファイル。

- **途中で worktree に入ったあとの基準**：セッションの途中で `EnterWorktree` を使うと、本体の `/x` の基準は worktree に移る。hook が受け取る `CLAUDE_PROJECT_DIR` は元の場所のままで、入力の cwd は worktree を指す。Bash の `cd` のあとも入力の cwd は同じように動き、本体の基準は動かない。hook の入力には、この 2 つを区別できる項目が無い。hook は `CLAUDE_PROJECT_DIR` を使うので、このときプロジェクトの設定の `/x` は、hook では元の場所、本体では worktree を指す。ずれの向きは下の表のとおりである。`/cd` のあとの基準は確かめていない。

  | 規則            | 対象               | 本体                 | hook       | 実害                                                                                                                                             |
  | --------------- | ------------------ | -------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
  | deny `/sub/**`  | `<worktree>/sub/x` | 拒否                 | 一致しない | 無い。本体が自分の deny で拒否する                                                                                                               |
  | deny `/sub/**`  | `<元の場所>/sub/x` | deny には一致しない  | 拒否       | Write では無い。本体は worktree のセッションで元の checkout への Write を、hook を呼ぶ前に拒否する                                               |
  | allow `/sub/**` | `<worktree>/sub/x` | 許可                 | 一致しない | 承認の問い合わせが 1 回増える                                                                                                                    |
  | allow `/sub/**` | `<元の場所>/sub/x` | allow には一致しない | 許可       | Write では無い（同上）。`sed -i` の推論は Edit の allow を使うので、元の checkout への `sed -i` を hook が許可しうる。本体の扱いは確かめていない |

- **読む設定ファイルの集合**：次の場合に、hook と本体は違うファイルを読む。

  | 場合                                                                 | 本体                                                      | hook                                                       |
  | -------------------------------------------------------------------- | --------------------------------------------------------- | ---------------------------------------------------------- |
  | サブディレクトリで起動                                               | `<起動した場所>/.claude/settings.json` だけ。親は読まない | `<git toplevel>/.claude/settings.json`                     |
  | worktree のセッション                                                | ローカル設定は main checkout のもの                       | `auto-approve` は `<worktree>/.claude/settings.local.json` |
  | ローカル設定                                                         | 読む                                                      | `file-access-guard` は読まない                             |
  | `--settings`、CLI フラグ、managed settings、セッション中に足した規則 | 読む                                                      | 読まない                                                   |
  | `CLAUDE_CONFIG_DIR` を設定している場合のユーザー設定                 | 確かめていない                                            | `<home>/.claude/settings.json` に固定                      |

  本体の列は公式ドキュメントの記述である。実機で確かめたのは、サブディレクトリでの起動と、`--settings`、CLI フラグの行である。
  サブディレクトリで起動したセッションでは、hook は本体が読まない `settings.json` の `/x` を、起動した場所から読む。

- **基準の値**：`CLAUDE_TEST_CWD` が環境にあると、相対パターンの基準と同じく `/x` の基準も動く。`CLAUDE_PROJECT_DIR` も入力の cwd も絶対パスでないと、プロセスの作業ディレクトリが基準になる。ユーザー設定の `/x` の基準は `~/x` と同じく `HOME` の値に従い、`HOME` が相対パスなら基準も相対パスになる。基準は書かれたとおりのパスで比べ、symlink を解決しない。

### 受け入れた限界

- Write が allow になる範囲に、workflow dir の hook 管理の状態ファイルが入る場合がある（workflow dir が `~/.local` や `~/workspace` の下にあるとき）。`document-workflow-guard` は `.md` 以外を実装の gate に回す。Edit では変更前から同じである。
- `Edit(.tmp/sessions/*/*.md)` は、別のセッションの workflow dir の文書にも一致する。承認の成立には `approvals.log` に記録された hash との一致が要るので、別のセッションの承認行を書き換えても承認にはならない。

### 確認した事実

hook の deny は、別の hook の allow に勝つ。
2026-10-06 に、`claude -p` の子セッションに `.tmp/sessions/zz-r2-probe/approvals.log` を Edit させて確かめた。
`auto-approve` はこの Edit に allow を返し（判定のログで確認）、`document-workflow-guard` が拒否して、ファイルは書き換わらなかった。
この優先は、公式ドキュメントには書かれていない。
`document-workflow-guard` と `file-access-guard` の deny は、どちらもこの優先に依存している。

本体と hook の関係は、公式ドキュメントに次のように書かれている。
PreToolUse の hook の判定は、権限の規則を飛ばさない。
hook が allow を返しても、本体の deny と ask の規則は別に評価される。
hook が呼び出しを止めた場合（exit 2）は、allow の規則より優先される。

### 未確認の事実

`claude -p` で、PreToolUse の `ask` が拒否になるかどうか。
きっかけになった拒否の記録からそう推定しているが、公式ドキュメントに記載は無い。
配布後に確かめ、結果をこの ADR の改訂として足す。

`/x` の基準について、次は確かめていない。

- managed settings の `/x` の基準。公式ドキュメントの表に行が無い。
- `--settings` に JSON の文字列で渡した規則の基準。起動したディレクトリの下には一致しなかった。
- `/cd` のあとの基準。
- `///x` のように `/` が 3 つ以上続く規則と、`/../x` のように基準の外へ出る規則を、本体がどう読むか。hook は前者を `//x` と同じに読み、後者は基準につないで畳んだパスを守る。
- 途中で worktree に入ったあとの、元の checkout への `sed -i` を本体がどう扱うか。

### 未対応の課題

issue は未作成である。
次の 9 項目は、扱っていない。

1. symlink。`auto-approve` の allow は解決先を見ない。
2. `!` 付きの deny の除外を hook が行わない。
3. Read の規則を Glob、Grep、LS に当てていない。パスを取り出す関数が、Glob では `pattern` だけを返し、LS では何も返さないためである。
4. 一致する規則が無いときに `ask` を返す動作。allow の規則の外の場所では、`claude -p` の Edit と Write が通らない見込みである。
5. 危険なパスの扱いが Edit と Write で違う。
6. `file-access-guard` の判定の順序（D6 の不変条件）。
7. 別のセッションの workflow dir の文書を Write で上書きできる。
8. chezmoi の誘導がこのリポジトリで働いていない。source の場所を repoRoot の直下で探しており、`.chezmoiroot`（`home`）を見ない。`~/.zshrc` への Edit は既定の deny で止まり、source を直すようにという案内は出ない。この挙動はテスト（`file-access-guard.test.ts` の chezmoiroot layout）で固定してある。
9. hook が読む設定ファイルの集合を本体に合わせる（サブディレクトリでの起動、worktree のローカル設定、`--settings`、CLI フラグ、managed settings、`CLAUDE_CONFIG_DIR`）。

## Amendment (2026-10-06): `/x` を規則の出どころから読む

### 改めた箇所

D1 の表の `/x` の行、D2、D7 を書き直し、D8 を足した。
理由は、hook の `/x` の読み方を Claude Code 本体に合わせるためである。
D1 の「設定の 1 行は、本体と hook で同じ場所を指すようにする」は変わらない。

### 本体の読み方

公式ドキュメント「Configure permissions」の「Read and Edit」は、`/x` の解決先を次のように書いている（2026-10-06 に読んだ版）。

| 規則が書かれた場所                              | `/path` の解決先                   |
| ----------------------------------------------- | ---------------------------------- |
| Project settings at `.claude/settings.json`     | `<primary working directory>/path` |
| Local settings at `.claude/settings.local.json` | `<primary working directory>/path` |
| User settings at `~/.claude/settings.json`      | `~/.claude/path`                   |
| A file passed with `--settings <file>`          | `<directory of file>/path`         |
| CLI flags or session rules                      | `<primary working directory>/path` |

primary working directory は、セッションを起動したディレクトリである。
ローカル設定のファイルは git のルートに置かれるが、基準は起動したディレクトリである、とも書かれている。

### 観測

Claude Code 2.1.289 で確かめた。
`claude -p` で、存在しないパスへの Write を 1 回だけ頼み、tool の結果の文面を読んだ。
「拒否」は `File is in a directory that is denied by your permission settings.`、「承認待ち」は `... but you haven't granted it yet.` である。
規則は、ことわりが無ければ deny `Edit(/sub/**)` である。
Edit tool でも 1 回確かめた。プロジェクトの設定にこの規則を置き、`<プロジェクト>/sub/` の下にある既存のファイルへの Edit を頼むと、Write と同じ文面で拒否された。

| 規則の置き場所                                                  | 起動した場所                         | 対象                         | 結果                            |
| --------------------------------------------------------------- | ------------------------------------ | ---------------------------- | ------------------------------- |
| `<プロジェクト>/.claude/settings.json`                          | `<プロジェクト>`                     | `<プロジェクト>/sub/…`       | 拒否                            |
| 同上                                                            | 同上                                 | `<プロジェクト>/other/…`     | 作成                            |
| 同上                                                            | `<プロジェクト>`、Bash で `cd inner` | `<プロジェクト>/inner/sub/…` | 作成                            |
| 同上                                                            | 同上                                 | `<プロジェクト>/sub/…`       | 拒否                            |
| 同上（`<プロジェクト>` は git のルート）                        | `<プロジェクト>/inner`               | `<プロジェクト>/inner/sub/…` | 作成                            |
| 同上                                                            | 同上                                 | `<プロジェクト>/sub/…`       | 承認待ち                        |
| `<プロジェクト>/.claude/settings.local.json`                    | `<プロジェクト>`                     | `<プロジェクト>/sub/…`       | 拒否                            |
| 同上（`<プロジェクト>` は git のルート）                        | `<プロジェクト>/inner`               | `<プロジェクト>/inner/sub/…` | 拒否                            |
| 同上                                                            | 同上                                 | `<プロジェクト>/sub/…`       | 承認待ち                        |
| `--settings` の JSON の文字列                                   | `<作業場所>`                         | `<作業場所>/sub/…`           | 作成                            |
| `--settings <別の場所>/flag.json`                               | `<作業場所>`                         | `<作業場所>/sub/…`           | 作成                            |
| 同上                                                            | 同上                                 | `<別の場所>/sub/…`           | 拒否                            |
| `--disallowedTools 'Edit(/sub/**)'`                             | `<作業場所>`                         | `<作業場所>/sub/…`           | 拒否                            |
| `--add-dir` で足したディレクトリの `.claude/settings.json`      | `<作業場所>`                         | `<足したディレクトリ>/sub/…` | 作成                            |
| `<プロジェクト>/.claude/settings.json`、`-w` で worktree を作る | `<プロジェクト>`                     | `<worktree>/sub/…`           | 拒否                            |
| 同上、途中で `EnterWorktree`                                    | `<プロジェクト>`                     | `<worktree>/other/…`         | 作成                            |
| 同上                                                            | 同上                                 | `<worktree>/sub/…`           | 拒否                            |
| 同上                                                            | 同上                                 | `<プロジェクト>/other/…`     | worktree のセッションとして拒否 |
| `~/.claude/settings.json` の deny `Edit(/<名前>/**)`            | 任意                                 | `~/.claude/<名前>/…`         | 拒否                            |
| 同上                                                            | 同上                                 | `/<名前>/…`                  | 承認待ち                        |
| 同上                                                            | 同上                                 | `~/<名前>/…`                 | 承認待ち                        |
| 規則なし（上の 3 行の比較用）                                   | 同上                                 | `~/.claude/<名前>/…`         | 承認待ち                        |
| `--settings` の JSON で deny `Edit(//srv/**)`                   | 任意                                 | `/srv/…`                     | 拒否                            |

読み取れること。

- プロジェクトの設定とローカル設定の `/x` の基準は、セッションを起動したディレクトリである。Bash の `cd` のあとも動かない。git のルートでも、`.claude/` の親でもない。
- サブディレクトリで起動すると、親の `.claude/settings.json` の規則は当たらない。
- `-w` で始めた worktree のセッションと、途中で `EnterWorktree` したあとは、基準は worktree である。
- ユーザー設定の `/x` の基準は `~/.claude` である。
- `//x` はファイルシステムの絶対パスである。

### hook が受け取る値

PreToolUse の hook に、入力と環境を記録させた。

| 場面                                | 入力の `cwd` | `CLAUDE_PROJECT_DIR` | 本体の `/x` の基準 |
| ----------------------------------- | ------------ | -------------------- | ------------------ |
| `-w` で始めた worktree のセッション | worktree     | worktree             | worktree           |
| 起動した直後                        | 起動した場所 | 起動した場所         | 起動した場所       |
| 途中で `EnterWorktree` したあと     | worktree     | 起動した場所         | worktree           |

`EnterWorktree` のあと、入力に増える項目は無かった。

基準の候補ごとに、本体の基準と同じ場所を指すかを並べる。

| 場面                                 | `CLAUDE_PROJECT_DIR` | 入力の `cwd` | 読んだファイルの `.claude/` の親 |
| ------------------------------------ | -------------------- | ------------ | -------------------------------- |
| git のルートで起動                   | 一致                 | 一致         | 一致                             |
| Bash の `cd` のあと                  | 一致                 | 不一致       | 一致                             |
| サブディレクトリで起動、ローカル設定 | 一致                 | 一致         | 不一致                           |
| `-w` で始めた worktree               | 一致                 | 一致         | 一致                             |
| 途中で `EnterWorktree`               | 不一致               | 一致         | 一致                             |

どの候補にも不一致の場面がある。
`CLAUDE_PROJECT_DIR` を採ったのは、不一致が途中の `EnterWorktree`（と、確かめていない `/cd`）だけだからである。
入力の cwd は Bash の `cd` で外れる。worktree に `cd` で入る作業がこれに当たる。

### 採らなかった案

- **設定を読む時点で `/x` を絶対パスの形に書き換える**：基準が規則の文字列に入り、基準のパスに `*` や `[` があると wildcard として読まれる。D1 の「基準は文字どおりに比べる」を保てない。
- **deny を `CLAUDE_PROJECT_DIR` と入力の cwd の両方から読む**：Bash の `cd` のあとに、本体が許可する `<cwd>/x` を hook が拒否する。同じ 1 行が 2 つの層で別の場所を指す状態を、deny の側に作る。
- **allow を両方の基準で一致したときだけ許可する**：Bash の `cd` のあとに、プロジェクトの設定の `/x` の allow が何にも一致しなくなる。
- **2 つの hook の設定の読み込みを 1 つにまとめる**：`file-access-guard` がローカル設定や deny を読み始め、`/x` の読み方と関係のない判定が同じ変更で変わる。

### テスト

絶対パスを指す fixture の規則は `//` で書く。
出どころごとの `/x` の読み方は、`path-pattern-resolve.test.ts`、`pattern-matching.test.ts`、`auto-approve.test.ts`、`file-access-guard.test.ts` で確かめる。
`auto-approve.test.ts` は、一時ディレクトリに置いたユーザー設定とプロジェクトの設定を hook に読ませ、対象ごとの判定を見る。

## References

- ADR-0023（workflow dir と project root）
- Claude Code の公式ドキュメント「Configure permissions」の「Read and Edit」「Symlinks」「Extend permissions with hooks」（`https://code.claude.com/docs/en/permissions.md`、2026-10-06 に読んだ版）
- issue は未作成
- PR #266（この ADR を含む変更）
- PR #270（Amendment を含む変更）
