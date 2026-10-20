# ADR-0027: hook は権限のパスパターンを Claude Code 本体と同じ規則で読む

## Status

accepted (2026-10-06)

`/x` の基準を規則の出どころから読む改訂を含む（Amendments）。

## Context

Claude Code の権限の設定（`permissions.allow` / `permissions.deny`）は、本体と hook の両方が読む。
hook は `auto-approve`（PreToolUse）と `file-access-guard`（PreToolUse）で、`Edit(~/.config/**)` のような規則のパスの部分を自前の関数でパスと比べていた。
同じ行の意味が本体と hook で違っていた。

きっかけは、`claude -p` で Document Workflow を実行したとき、workflow dir の `research.md` への Write が `No patterns matched` で 6 回拒否されたことである。
調べると、次の 4 つの食い違いが見つかった。

1. hook は Write を `Write(...)` の規則でだけ判定していた。設定に `Write(...)` の規則は 1 件も無い。本体は Edit の規則で判定する。
2. hook は相対パターンを部分文字列として比べていた。`Write(sub/**)` を足すと、`<repo>/sub/../../x` や `<repo>/xsub/y` も allow になった。本体は現在のディレクトリの下だけを区切り単位で比べる。
3. allow の `Edit(!.git/**)` など 7 件が、1 件ごとに「そこ以外のすべての Edit を許可」として働いていた。`Edit(!.git/**)` の 1 件だけで `/etc/hosts` への Edit が allow になった。本体は allow の `!` に意味を与えていない。
4. `*` を含まない絶対パターン（`Edit(~/.zshrc)`、`Edit(/etc/passwd)`）は、hook では 1 件も一致していなかった。

本体の規則は公式ドキュメント（References）に書かれている。

## Decision

### D1: hook はパスの規則を本体と同じ規則で比べる

設定の 1 行は、本体と hook で同じ場所を指すようにする。
規則のパスの部分を「文字どおりの基準ディレクトリ」と「そこからの相対の glob」に解決し、対象のパスを正規化した絶対パスに解決してから、区切り単位で比べる。

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
ADR-0023 の project root は使わない。
作業ディレクトリが起動したディレクトリと違うセッションでは、相対パターンは作業ディレクトリの側を指す。

`/x` の基準は cwd ではなく、D8 の `<settingsRoot>` である。
相対パターンの基準は入力の cwd だけを読み、`/x` の基準は入力の `transcript_path`、`CLAUDE_PROJECT_DIR`、入力の cwd を読む。

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
判定は 1 か所にまとめ、2 つの hook が同じものを使う。

### D5: workflow dir の文書を許可する規則を足す

allow に、workflow dir の直下の `.md` だけを指す規則（`<id>/` の直下）を足した。
`.md` と深さに絞ったのは、workflow dir には hook が管理する状態ファイル（`reviewer-runs.log`、`.tripwire-disabled` など）があり、`document-workflow-guard` が `.md` だけを実装の gate から免除しているためである。

### D6: `*` を含まない allow 4 件を消す

`Edit(~/.bashrc)`、`Edit(~/.gitconfig)`、`Edit(~/.gitignore_global)`、`Edit(~/.zshrc)` を設定から消した。
この 4 件は変更前の hook では一致しておらず、`~/.zshrc` などへの Edit は `file-access-guard` の既定の deny（リポジトリの外で、明示の allow が無い）で止まっていた。
D1 で 4 件が一致し始めると、`file-access-guard` はパターン一致の段で allow を返し、既定の deny に届かなくなる。
4 件を消して、変更前の「止まる」を保った。

**不変条件**：`file-access-guard` は、パターン一致の allow（step 5）を、chezmoi の誘導（step 6a）と既定の deny より先に判定する。
ホームのファイルを allow の規則に書くと、誘導にも既定の deny にも届かなくなる。

### D7: 解決は環境を読まない関数にする

規則と対象を解決する関数は、引数だけで結果が決まる。
基準（`cwd` と `home`）は、hook の最初で 1 回作って渡す。
絶対パスでない `cwd` は使わず、プロセスの作業ディレクトリに落とす。

`/x` の基準は規則ごとに違うので、規則と一緒に運び、比べるときに文脈に足して渡す。
環境を読むのは、基準を作る 1 か所だけである。

### D8: `/x` の基準は、規則の出どころで決まる

本体は `/x` を、規則を定義した設定の出どころごとに決まるディレクトリからのパスとして読む。
hook も同じ場所から読む。

| 出どころ                   | hook が読むファイル                                                       | `/x` の基準（`<settingsRoot>`） |
| -------------------------- | ------------------------------------------------------------------------- | ------------------------------- |
| ユーザー設定               | `<home>/.claude/settings.json`                                            | `<home>/.claude`                |
| プロジェクトの設定         | `<git toplevel>/.claude/settings.json`                                    | セッションの基準のディレクトリ  |
| プロジェクトのローカル設定 | `<git toplevel>/.claude/settings.local.json`（`auto-approve` だけが読む） | セッションの基準のディレクトリ  |
| テスト用の環境変数         | `CLAUDE_TEST_ALLOW` / `CLAUDE_TEST_DENY`                                  | セッションの基準のディレクトリ  |

テスト用の環境変数の規則は設定ファイルを持たないので、本体が CLI フラグの規則に使う基準と同じにした。
どのファイルにどの基準を付けるかは 1 か所に置き、2 つの hook はその結果から読むファイルを選ぶ。

「セッションの基準のディレクトリ」は、本体の primary working directory である。
セッションを起動したディレクトリで始まり、Bash の `cd` では動かず、`EnterWorktree` で worktree に移り、`ExitWorktree` で元に戻る。
hook の入力に、この場所を表す項目は無い。
入力の `transcript_path` の親ディレクトリの名前が、この場所の絶対パスを符号化したもの（UTF-16 の 1 単位ごとに、ASCII の英数字以外を `-` に置き換える。連続する `-` はまとめない）で、この場所と一緒に動く。
名前から元のパスには戻せないので、hook は候補のパスを同じ規則で名前に変えて比べ、次の順で決める。

1. `CLAUDE_TEST_CWD` が絶対パスなら、それを使う（テスト用の上書き）。
2. `transcript_path` が絶対パスなら、その親ディレクトリの名前を取る。`CLAUDE_PROJECT_DIR`、入力の cwd、入力の cwd の親ディレクトリ（近い順。ルートは含めない）の順に、名前が一致した最初のものを使う。
3. 一致するものが無ければ、`CLAUDE_PROJECT_DIR`、入力の cwd の順に、最初の絶対パスを使う。
4. どれも絶対パスでなければ、プロセスの作業ディレクトリを使う。

2 の候補は `..` を畳み、末尾の `/` を落としてから名前と比べ、その値を基準にする。
3 と 4 は書かれたとおりの値を返す。
どちらも、規則を解決するときに同じ畳み方を通る。symlink は解決しない。
基準は glob に埋め込まず、D1 のとおり文字どおりに比べる。

名前の付け方が変わると、2 は一致しなくなり、hook は何も知らせずに `CLAUDE_PROJECT_DIR` を使う。
気づく手段として、SessionStart の hook が、`source` が `startup` のときに、入力の cwd から作った名前と `transcript_path` の親ディレクトリの名前を比べ、合わないときだけ 1 行を出す。
点検が比べるのは、起動したディレクトリのパスに含まれる文字だけである。パスが英数字と `/` だけなら、ほかの文字の扱いが変わっても合ったままで、気づけない。

## 却下した代替案

`/x` の基準について。

- **設定を読む時点で `/x` を絶対パスの形に書き換える**：基準が規則の文字列に入り、基準のパスに `*` や `[` があると wildcard として読まれる。D1 の「基準は文字どおりに比べる」を保てない。
- **基準を `CLAUDE_PROJECT_DIR` に固定する**：途中で `EnterWorktree` を使ったあと、本体と別の場所を指す。
- **PostToolUse で `EnterWorktree` の結果をセッションごとに記録し、基準の候補に足す**：記録が要るのは、入力の cwd が基準の下に無い場面だけで、`claude -p` の観測では追加の作業ディレクトリへ `cd` した場合に限られた。subagent や再開したセッションで名前が基準を指さない場面は、名前で検算する記録では補えない。費用は、hook、状態のファイル、hook の登録、登録が外れたことを知らせる点検である。状態のファイルは `<home>/.claude` の下に置くことになり、判定する相手（モデル）が書き換えられるので読む側に防御が要り、同じ名前の別のディレクトリを基準にさせる道が 1 本増える。得るものに見合わないので持たない。
- **deny をいつも `CLAUDE_PROJECT_DIR` と入力の cwd の両方から読む**：Bash の `cd` のあとに、本体が許可する `<cwd>/x` を hook が拒否する。同じ 1 行が 2 つの層で別の場所を指す状態を deny の側に作る。
- **allow を両方の基準で一致したときだけ許可する**：Bash の `cd` のあとに、プロジェクトの設定の `/x` の allow が何にも一致しなくなる。
- **選んだ候補が `CLAUDE_PROJECT_DIR` でないときだけ、deny を両方の基準で評価する**：同じ名前の別のディレクトリ F を選んだ場合、F と `CLAUDE_PROJECT_DIR` のどちらも本体の基準ではないので、守る場所が増えない。
- **選んだ候補が worktree の置き場所にあることを条件に足す**：置き場所は `.claude/worktrees/`、リポジトリごとの規約、`WorktreeCreate` の hook が返す任意の場所があり、hook の側が置き場所の規約を持つことになる。
- **一致が無いことを tool 呼び出しのたびに知らせる**：一致が無いのは、テストの入力や subagent でも起きるので、名前の付け方が変わった合図にならない。
- **2 つの hook の設定の読み込みを 1 つにまとめる**：`file-access-guard` がローカル設定や deny を読み始め、`/x` の読み方と関係のない判定が同じ変更で変わる。

## Consequences

### Edit の allow が狭まった

`auto-approve` が Edit と Write を allow にするのは、`/tmp`、`~/.config`、`~/.local`、`~/workspace`、`~/.claude/plans` の下と、作業ディレクトリの workflow dir の文書、それにプロジェクトの設定が足す規則の範囲だけになった。
それ以外の場所では `ask` になる。
変更前は、Edit は場所を問わずほぼ allow だった。

### 規則を書くときに知っておくこと

- ファイルシステムの絶対パスは `//` で書く。`/x` は、ユーザー設定では `~/.claude/x`、プロジェクトの設定では `<セッションの基準のディレクトリ>/x` を指す（D8。起動したディレクトリか、入った worktree）。
- allow に名前だけの規則（`Edit(*.md)`）を書くと、作業ディレクトリ配下の任意の深さに一致する。単一のディレクトリ（`Edit(src/**)`）は `<cwd>/src` だけに一致し、任意の深さにするには `Edit(**/src/**)` と書く。
- 相対の deny が守るのは作業ディレクトリの下だけである（本体と同じ）。作業ディレクトリの外まで守る deny は `//**/` で書く。
- `*` はドットで始まる名前にも一致する。`Read(**/*.test.*)` は `.env.test.local` にも一致する。
- `..` を含む規則は、allow では何も許可せず、deny ではそのパスだけを守る。

### 本体と合わせていない点

hook が本体より広く許可する側。

- **symlink**：`auto-approve` は解決先を見ない。`file-access-guard` は字句の形と realpath の形の両方で判定するが、指す先が Edit の allow の範囲にあれば通す。Edit では変更前から同じである。

hook が本体より多く止める側。

- **`!` 付きの deny**：hook は除外を行わない。
- **危険なパスへの Write**（D4）：Edit には同じ判定が無い。判定は部分文字列で行うので、`.env.example` のような名前も止める。解消するには、Edit にも同じ判定を入れるか、判定を設定の deny の規則に移すかで、どちらも Edit の今の挙動を変える。
- **一致する規則が無いときの `ask`**：本体は一致しない呼び出しを自分の権限モードで判定するが、hook は `ask` を返す。

`/x` の基準と、読む設定ファイル。

- **名前が一致する候補が無いときの基準**：D8 の 2 で一致が無いと、hook は `CLAUDE_PROJECT_DIR` を基準にする。本体の基準が `CLAUDE_PROJECT_DIR` と同じあいだ（起動した場所にいる、`-w` で始めた）は、それで合う。セッションの途中で worktree に入ったあとに一致が無いと、プロジェクトの設定の `/x` は、hook では元の場所、本体では worktree を指す。一致が無くなるのは、入力の cwd が基準の下に無い場合（worktree に入ったあと、追加の作業ディレクトリへ `cd` した場合に当たる見込み。試していない）と、`transcript_path` の親ディレクトリの名前が基準を指さない場合（名前の付け方は公式ドキュメントに無く、再開したセッションと subagent では観測していない）である。
  - ずれの向き：deny `/sub/**` では、worktree の下は本体が自分の deny で拒否するので実害は無く、元の場所の下は hook が余分に拒否しうる（Write は、本体が worktree のセッションとして先に拒否する。Edit は試していない）。allow `/sub/**` では、worktree の下は承認の問い合わせが 1 回増え、元の場所の下は hook が承認なしで通しうる。`sed -i` の推論は Edit の allow を使うので、元の checkout への `sed -i` を hook が許可しうる（本体の扱いは確かめていない）。
  - hook の `/x` の deny が効くのは、ファイルを扱う tool の呼び出しだけである。Bash のコマンドの中のパスに当たる deny は `Bash(...)` の規則だけで、`sed -i` の推論は Edit の deny を見ない。
- **同じ名前になる別のディレクトリ**：名前は英数字以外をすべて `-` にするので、長さが同じで区切りの文字だけが違うパスは同じ名前になる。候補は `CLAUDE_PROJECT_DIR` を先に比べるので、本体の基準が `CLAUDE_PROJECT_DIR` と同じあいだは起きない。途中で worktree に入ったあと、入力の cwd かその親が worktree と同じ名前の別のディレクトリ F であれば、hook は F を基準にする。ずれの向きは上と同じで、F の下を hook が余分に拒否または許可する。
- **相対パターン**の基準は入力の cwd で、`cd` で動く（D2）。`/x` の規則が `cd` で動かないという性質は、上の条件のときに限って崩れる。
- **読む設定ファイルの集合**：次の場合に、hook と本体は違うファイルを読む。

  | 場合                                                                 | 本体                                                      | hook                                                       |
  | -------------------------------------------------------------------- | --------------------------------------------------------- | ---------------------------------------------------------- |
  | サブディレクトリで起動                                               | `<起動した場所>/.claude/settings.json` だけ。親は読まない | `<git toplevel>/.claude/settings.json`                     |
  | worktree のセッション                                                | ローカル設定は main checkout のもの                       | `auto-approve` は `<worktree>/.claude/settings.local.json` |
  | ローカル設定                                                         | 読む                                                      | `file-access-guard` は読まない                             |
  | `--settings`、CLI フラグ、managed settings、セッション中に足した規則 | 読む                                                      | 読まない                                                   |
  | `CLAUDE_CONFIG_DIR` を設定している場合のユーザー設定                 | 確かめていない                                            | `<home>/.claude/settings.json` に固定                      |

- **基準の値**：`CLAUDE_PROJECT_DIR` も入力の cwd も絶対パスでないと、プロセスの作業ディレクトリが基準になる。ユーザー設定の `/x` の基準は `HOME` の値に従い、`HOME` が相対パスなら基準も相対パスになる。基準は書かれたとおりのパスで比べ、symlink を解決しない。

### 受け入れた限界

- Write が allow になる範囲に、workflow dir の hook 管理の状態ファイルが入る場合がある（workflow dir が `~/.local` や `~/workspace` の下にあるとき）。`document-workflow-guard` は `.md` 以外を実装の gate に回す。Edit では変更前から同じである。
- D5 の規則は、別のセッションの workflow dir の文書にも一致する。承認の成立には `approvals.log` に記録された hash との一致が要るので、別のセッションの承認行を書き換えても承認にはならない。

### 確認した事実

hook の deny は、別の hook の allow に勝つ。
`claude -p` の子セッションに workflow dir の `approvals.log` を Edit させて確かめた。`auto-approve` はこの Edit に allow を返し、`document-workflow-guard` が拒否して、ファイルは書き換わらなかった。
この優先は公式ドキュメントに無く、`document-workflow-guard` と `file-access-guard` の deny は、どちらもこの優先に依存している。

公式ドキュメントによれば、PreToolUse の hook が allow を返しても、本体の deny と ask の規則は別に評価される。hook が呼び出しを止めた場合（exit 2）は、allow の規則より優先される。

設定の ask 規則と hook の関係は、Claude Code 2.1.296 で、`Read(//tmp/**)` の allow に一致するパスについて確かめた（allow に一致しないパスでは測っていない）。

- 自動承認の hook を登録していないとき、ask 規則に一致する Read は、対話のセッションで確認を出し、`claude -p` では拒否になる。
- PermissionRequest の hook の allow は、ask 規則の確認を抑える（`permission-auto-approve` だけを登録すると、ask 規則に一致する Read が `claude -p` で読めた）。公式ドキュメントに PermissionRequest の hook についての記載は無い。
- PreToolUse の hook の allow は、ask 規則の確認を抑えない。公式ドキュメントの記述と一致する。
- ask 規則と deny 規則は、symlink を Read したとき、リンク先のパスにも照合される。
- `.env` 系の Read を hold するようにした後は、3 つの hook（`auto-approve`、`permission-auto-approve`、`permission-llm-evaluator`）を登録した `claude -p` で、ask 規則に一致する `.env` の Read は拒否になり、3 つの hook の `held:` が判定のログに残り、allow は無かった。`.env.example` は読めた。対話のセッションでは `.env` の Read に確認が出た。subagent の中の Read も同じ結果だった。

これらは設定の ask 規則についての計測であり、PreToolUse の hook が返す `ask` とは別のものである。

`/x` の基準は Claude Code 2.1.289 の `claude -p` で、存在しないパスへの Write の結果の文面を読んで確かめた（Edit でも 1 回確かめた）。

- プロジェクトの設定とローカル設定の `/x` の基準は、セッションを起動したディレクトリである。Bash の `cd` のあとも動かない。git のルートでも、`.claude/` の親でもない。
- サブディレクトリで起動すると、親の `.claude/settings.json` の規則は当たらない。
- `-w` で始めた worktree のセッションと、途中で `EnterWorktree` したあとは、基準は worktree である。
- ユーザー設定の `/x` の基準は `~/.claude` である。
- `//x` はファイルシステムの絶対パスである。
- hook の入力に、`EnterWorktree` のあと増える項目は無い。`CLAUDE_PROJECT_DIR`、入力の cwd、読んだファイルの `.claude/` の親は、どれも本体の基準と一致しない場面がある。`transcript_path` の親ディレクトリの名前だけが、全場面で本体の基準を符号化していた。符号化の規則（D8）は公式ドキュメントに無い。観測した文字は `/`、`.`、`_`、空白、日本語、絵文字で、絵文字 1 字は `-` 2 つになる。

## Amendments

### 2026-10-06: `/x` を規則の出どころから読む

hook の `/x` の読み方を Claude Code 本体に合わせるため、D1 の表の `/x` の行、D2、D7 を書き直し、D8 を足した。
D1 の「設定の 1 行は、本体と hook で同じ場所を指すようにする」は変わらない。
変えた後の規則は Decision に反映してある。観測の表と手がかりの比較は、改訂時点のファイルから `git show 01385b992ed92f40579f08f6d999c3a1d8bc6925:docs/decisions/0027-permission-path-pattern-semantics.md` で読める。

## References

- ADR-0023（workflow dir と project root）
- Claude Code の公式ドキュメント「Configure permissions」の「Read and Edit」「Symlinks」「Extend permissions with hooks」（`https://code.claude.com/docs/en/permissions.md`、2026-10-06 に読んだ版）
