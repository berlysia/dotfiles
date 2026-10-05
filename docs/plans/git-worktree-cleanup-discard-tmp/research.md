# Research: git-worktree-cleanup で `.tmp/` 持ちの merged worktree を対話なしで消す

## オーダー

エージェントが「マージ済みの 3 つの worktree は、`.tmp/` の中身が不要なら、端末で `git-worktree-cleanup` を実行して y と答えれば消せます。このツールは、その確認には端末での応答しか受け付けません」と報告した。これを対話なしでできるようにしたい。

## 現状（観測した事実）

### 端末でしか答えられないのは意図された実装

- `home/dot_local/bin/executable_git-worktree-cleanup:427-490` の `classify` は worktree を KEEP / REMOVE / ASK / ASK_HUMAN に分類する
- `.tmp/` `.entire/` に ignored ファイルがあると ASK_HUMAN になる（`:459-468`）。merged かどうかは理由の文字列に `(merged: <方式>)` と添えるだけで、分類は変わらない
- `confirm_delete`（`:493-517`）は `--yes` で ASK だけに yes と答え、ASK_HUMAN には答えない。TTY が無ければ `answer_mode=no` になる（`:117-119`）
- この範囲は commit `f89cd21`（2026-10-02）の決定として記録されている: 「`--yes` answers only ASK; commits not on origin, files in .tmp/ or .entire/, worktrees untouched since creation and undetectable in-use state need a human y on a terminal」。intent は「複数の Claude session が同じ repo の worktree を使っている間も安全に実行できる」
- `docs/commands/git-worktree-cleanup.md:46` に理由がある: merged でも `.tmp/sessions/` の spec / plan が `docs/` へ移されていないことがある

### ASK_HUMAN は 4 つの別々の理由を束ねている

| 段  | 理由                                                 | 失うもの                                 | merged で安全になるか                                       |
| --- | ---------------------------------------------------- | ---------------------------------------- | ----------------------------------------------------------- |
| 5a  | 使用中を検出できない（`cwd_unknown`、`:456-458`）    | 他 session の作業場所                    | ならない                                                    |
| 5b  | `.tmp/` `.entire/` に ignored ファイル（`:459-468`） | git に無いファイル（plan / spec / メモ） | ならない（ファイルは git の外）。ただし失うものは列挙できる |
| 6   | 作業開始直後（`:469-471`）                           | これから使う worktree                    | —                                                           |
| 8   | origin に無い commit（`:475-480`）                   | commit                                   | merged なら到達しない                                       |

段の順序が効く。5b は 6・7・8 より前で return するので、5b に当たった worktree は「作業開始直後か」「origin に無い commit があるか」を評価されていない。5b のうち `is_merged` が真のものに限れば、tip の内容は `origin/<main>` に入っているので段 8 の懸念は残らない。

段 6（作業開始直後）は `is_merged` だけでは除けない。`git-worktree-create` が `origin/<main>` から作った直後の worktree は、tip が `origin/<main>` の祖先なので `is_merged` が `ancestor` で真になる（`:371-374`）。そこに `.tmp/` があるのは、session が plan を書いたがまだ commit していない状態で、`.tmp/` の中身が最も必要な場面にあたる。したがって対話なしで消してよい範囲は「5b、かつ作業開始直後でなく、かつ merged」、言い換えると「`.tmp/` `.entire/` が無ければ段 7 で REMOVE になっていた worktree」になる。

5a は 5b より前で return するので、5b を対象にした新しい経路は 5a に届かない。

### 現在ある回避策（コード変更なし）

理由の文言（`:465`）が案内している: 中身を移すか消してから再実行する。`.tmp/` が空になれば段 7 で REMOVE になり `--non-interactive` で消える。エージェントの Bash からは `rm -rf <worktree>/.tmp` → `git-worktree-cleanup <branch>` の 2 手になる。

### 削除の機構

- `git worktree remove` は `--force` なしで呼ばれる（`:219`）。ignored ファイルだけの worktree は `--force` なしで消える（git 2.43.0 で実測: `.tmp/sessions/x/plan.md` だけを持つ worktree に対し終了コード 0、ディレクトリ消失）
- 削除直前に再分類し、`verdict` が変わっていて REMOVE でなければ残す（`:555-564`）。新しい分類値を足すなら、1 回目と 2 回目で同じ値が出る必要がある
- `git status --porcelain --ignored -- .tmp .entire` の出力は `!! .tmp/` とディレクトリ単位に畳まれる（実測）。個々のファイル名を出すには別の列挙が要る

### エージェントからの実行経路

- `home/dot_claude/hooks/implementations/permission-auto-approve.ts:173` の `/^git-worktree-(create|cleanup)\b/` が、引数に関係なく静的に allow する（`SAFE_BASH_WORD_PATTERNS` で語境界を確認、`:440-458`）
- 静的層が allow しなかった場合は `permission-llm-evaluator.ts`（Layer 2b）に渡り、そこで allow されなければ人間の確認になる（`.settings.hooks.json.tmpl:314-337`）。静的層の `uncertain` は人間の確認を保証しない
- `.settings.permissions.json` に `ask` の規則は無い（`allow` と `deny` のみ）

つまり現状は「エージェントは `git-worktree-cleanup` を許可なしに実行できるが、TTY が無いので ASK_HUMAN は必ず残る」という組み合わせで安全を保っている。対話なしで消せる経路を足すと、この組み合わせが変わる。

### テスト

- `tests/git-worktree-cleanup/run.sh`（934 行、bash、ISO 25010 の特性別に区画）。CI は `ci-git-worktree-cleanup.yml` が ubuntu / macOS の `/bin/bash`（macOS は 3.2）で実行する
- `.tmp/` 関連の既存ケース: `test_F10`（`--yes` で残り、`(merged: squash)` と `answer y on a terminal` を出す、`:319-330`）、`test_U1`（`--yes` の混在走査で `tmpd` が残る、`:857-874`）
- 「merged + `.tmp/` を TTY の y で消す」ケースは無い
- fixture: `make_repo` / `wt` / `mk_pushed` / `mk_squashed` / `run_cleanup` / `run_cleanup_tty`（`:49-205`）
- auto-approve 側: `home/dot_claude/hooks/tests/unit/permission-auto-approve.test.ts:165` が `"git-worktree-cleanup"` を allow の例に持つ。`uncertain` の例は `:357-391`

### 実際の worktree（2026-10-06 時点、読み取りのみ）

| worktree                              | `.tmp/` `.entire/` の ignored ファイル数 | HEAD reflog の相異なる commit 数 |
| ------------------------------------- | ---------------------------------------- | -------------------------------- |
| `fix/bash-parser-superlinear`         | 12（すべて `.tmp/sessions/d70d1ada/`）   | 18                               |
| `fix/harden-path-checks`              | 14（すべて `.tmp/sessions/ee6fc9b0/`）   | 13                               |
| `fix/pattern-matcher-relative-anchor` | 0                                        | 12                               |
| `wip/207-portless-plan`               | 12（すべて `.tmp/sessions/acc72cfa/`）   | 5                                |

ignored ファイルを持つ 3 つはどれも作業開始直後ではない。1 つの worktree あたりのファイル数は 12〜14。`git ls-files --others --ignored --exclude-standard -- .tmp .entire` は個々のファイルを列挙する。merged かどうかは未確認（確かめるには cleanup を実行するか `is_merged` 相当を手で再現する必要があり、前者は副作用がある）。

### ユーザーの方針（会話で確定）

- 範囲と形: 専用 flag、merged 限定。`--yes` の意味は変えない
- 権限: flag 付きの呼び出しは `permission-auto-approve` の静的 allow から外す
- 動き: 消えなかった worktree について、エージェントが「この状況で、こういうことが書いてあった」と人間に伝えて聞く。flag は、その答えを実行する手段

## 設計上の論点

1. **誰が「`.tmp/` の中身は不要」と判断するか**。現行は端末の y がその判断の記録。対話なしにするなら、判断を別の場所（flag を付けるという行為、会話での指示、権限確認）へ移すことになる
2. **flag の範囲**。5b 全体か、5b かつ merged か。`--yes` を広げるか、別の flag か
3. **auto-approve との関係**。flag 付きの呼び出しを静的 allow から外すか、そのままにするか
4. **offline 時**。REMOVE は offline でも消す（古い `origin/<main>` に含まれるものは新しい方にも含まれる、`docs/commands/git-worktree-cleanup.md:58`）。merged の判定は同じ ref を使うので、同じ論法が成り立つ
5. **何を消したかの記録**。対話では人間が事前に中身を見る前提だった。対話なしでは、消したファイルの一覧を出力に残さないと後から分からない
