# ADR-0027: hook は権限のパスパターンを Claude Code 本体と同じ規則で読む

## Status

accepted (2026-10-06)

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

| 本体の形                          | 基準     | glob（grant） | glob（restrict）              |
| --------------------------------- | -------- | ------------- | ----------------------------- |
| `//x`、`/x`                       | `/`      | `x`           | 同じ                          |
| `~/x`                             | `<home>` | `x`           | 同じ                          |
| `./x`                             | `<cwd>`  | `x`           | 同じ                          |
| `<名前>` または `**/<名前>`       | `<cwd>`  | `**/<名前>`   | `**/<名前>` と `**/<名前>/**` |
| `<名前>/**`（単一のディレクトリ） | `<cwd>`  | `<名前>/**`   | `**/<名前>/**`                |
| その他の相対                      | `<cwd>`  | そのまま      | 同じ                          |

`/` で終わる規則は `/**` を足して読む。
空文字、`~`、`..` の区切りを含む規則は、allow では何も許可せず、deny ではそのパスだけを守る。
基準ディレクトリは glob に埋め込まず文字どおりに比べるので、`cwd` に `*` が含まれていても wildcard として読まれない。

### D2: 相対パターンの基準は hook の入力の cwd

本体の「現在のディレクトリから」に合わせる。
ADR-0023 の project root（`getProjectRoot()`）は使わない。
作業ディレクトリが起動したディレクトリと違うセッションでは、相対パターンは作業ディレクトリの側を指す。

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

## Consequences

### Edit の allow が狭まった

`auto-approve` が Edit と Write を allow にするのは、`/tmp`、`~/.config`、`~/.local`、`~/workspace`、`~/.claude/plans` の下と、作業ディレクトリの `.tmp/sessions/*/*.md`、それにプロジェクトの設定が足す規則の範囲だけになった。
それ以外の場所では `ask` になる。
変更前は、Edit は場所を問わずほぼ allow だった。

### 規則を書くときに知っておくこと

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

### 未対応の課題

issue は未作成である。
次の 8 項目は、この変更では扱っていない。

1. symlink。`auto-approve` の allow は解決先を見ない。
2. `!` 付きの deny の除外を hook が行わない。
3. Read の規則を Glob、Grep、LS に当てていない。パスを取り出す関数が、Glob では `pattern` だけを返し、LS では何も返さないためである。
4. 一致する規則が無いときに `ask` を返す動作。allow の規則の外の場所では、`claude -p` の Edit と Write が通らない見込みである。
5. 危険なパスの扱いが Edit と Write で違う。
6. `file-access-guard` の判定の順序（D6 の不変条件）。
7. 別のセッションの workflow dir の文書を Write で上書きできる。
8. chezmoi の誘導がこのリポジトリで働いていない。source の場所を repoRoot の直下で探しており、`.chezmoiroot`（`home`）を見ない。`~/.zshrc` への Edit は既定の deny で止まり、source を直すようにという案内は出ない。この挙動はテスト（`file-access-guard.test.ts` の chezmoiroot layout）で固定してある。

## References

- ADR-0023（workflow dir と project root）
- Claude Code の公式ドキュメント「Configure permissions」の「Read and Edit」「Symlinks」「Extend permissions with hooks」（`https://code.claude.com/docs/en/permissions.md`、2026-10-06 に読んだ版）
- issue は未作成
- PR は未作成
