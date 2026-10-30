# Claude Code Hooks Testing

Claude Code の TypeScript Hook 実装のテスト。`node:test` と `node:assert` で書き、リポジトリルートから実行する。パスはリポジトリルート相対で書く。

## テストファイル構成

- `home/dot_claude/hooks/tests/unit/` - 単体テスト（`*.test.ts`）
- `home/dot_claude/hooks/tests/perf/` - 実時間・線形時間のテスト（`*.test.ts`）
- `home/dot_claude/hooks/tests/heavy/` - git を起動するテストと、負荷に弱いテスト（`*.test.ts`）
- `tests/heavy/` - リポジトリ直下の `tests/` のうち、同じ理由で heavy に置く `*.test.mjs`。`tests/lib/` の helper は import してよいが、`tests/*.test.mjs` は import しない
- `home/dot_claude/hooks/tests/support/` - unit・perf・heavy が共有する helper（`*.test.ts` にしない）
- `home/dot_claude/hooks/tests/__fixtures__/` - テストが読む固定データ
- `home/dot_claude/hooks/tests/preload-test-env.mjs` - 全テストプロセスの前に読み込む環境の準備

## node:test のスイート（unit / perf / heavy）

- `bun run test`: `home/dot_claude/hooks/tests/unit/*.test.ts` と、リポジトリ直下の `tests/` の unit に残る `*.test.mjs` を並列に実行する。completion gate と pre-commit が実行するのはこれだけで、経過時間を assert するテストと、git を起動するテストは置かない（`home/dot_claude/hooks/tests/unit/test-layout.test.ts` が配線と置き場を検査し、git の shim が起動を見張る）
- `bun run test:perf`: `home/dot_claude/hooks/tests/perf/*.test.ts` をファイルごとに直列で実行する。ReDoS などの線形時間ガードと、経過時間の上限の assert を置く。CI（`ci-typescript.yml`）と `bun run check` が実行する
- `bun run test:heavy`: `home/dot_claude/hooks/tests/heavy/*.test.ts` と `tests/heavy/*.test.mjs` を直列で実行する。CI と `bun run check` が実行する。pre-commit は、`.chezmoiremove` 周辺を変えたときだけ `tests/heavy/chezmoiremove-coverage.test.mjs` を直接走らせる
- hook を編集した session では、`chezmoi apply` の前に `bun run test:heavy` も走らせる。apply すると `~/.claude/hooks/` に配られ、CI を通る前に使われるため
- unit・perf・heavy は互いを import しない。共有する helper は `home/dot_claude/hooks/tests/support/`（リポジトリ直下の `tests/` では `tests/lib/`）に置く。support に置くのは helper を作る関数と定数だけで、トップレベルの `let` と `after`・`afterEach`・`beforeEach` の登録は置かない（test-layout が検査する）。unit が import する support は、import のときも呼んだときも git を起動しない
- テストのプロセスでは bash-parser の解析予算が 10 秒になる（`preload-test-env.mjs`）。本番の 100 ms で測るテストは `home/dot_claude/hooks/tests/perf/parse-budget.test.ts` に置く

### 置き場の規則

テストは、まず unit に置く。次のどれかに該当するなら heavy に置く。

- (g) git のプロセスを起動する。`beforeEach` や `before` の setup、モジュールの読み込み時に起動するものも含む。テスト本体が git の結果を使わなくても heavy に置く（setup を書き換えて unit に戻す案は `docs/plans/heavy-setup-only-git-tests.md`）
- (a) 本番の timeout を実時間で待ち、どちらが先に起きるかで結果が変わる。注入した時計や fake timer を使うものは該当しない
- (b) (g) にも (a) にも該当せず、`yes` を `nproc` の 6 倍走らせた負荷の下で、1 件が 5 秒以上かかる

経過時間の上限だけを確かめるテストは perf に置く。ロジックは unit（git を要するなら heavy）に残し、perf には上限の assert だけを持つ同じ場面のテストを別名で置く。unit に `performance.now() -` の式と、同じ行の `Date.now() - ... <` の式は置けない（test-layout が検査する）。複数行の式、変数を経由した式、`>` での比較、実時間の timeout 待ちは静的に見分けられないので、この規則とレビューで守る。

### heavy に移した guard・permission・deny・fail-closed 系のテスト

次のテストは、`bun run test`（completion gate と pre-commit）から外れて heavy にある。落ちても gate は止まらないので、CI や `bun run test:heavy` で落ちたときは、必ず原因を調べる。

- write-protection: `classifyWriteTarget` の 10 件（保護パスを hold にする判定。worktree の偽装、symlink での脱出、`..`、`lstat` の失敗）
- bash-write-hold: `assessBashCommand - verified worktrees` の 2 件
- auto-approve: `a /path rule read from a settings file anchors at its source` の 5 件（settings 由来の `/path` ルールが発生元に anchor する deny の分岐）
- file-access-guard: `no repository scenario > should allow operations when not in a repository`
- run-guard: `blocks with exit 2 when the hook exceeds the timeout, with only /usr/bin:/bin on PATH`、`returns within the timeout and kills descendants that hold stdout`（fail-closed のラッパーの timeout）
- workflow-bash-sync: `tripwire (K2)` の 8 件と `doc hash dispatch (K1)` の 2 件（gate が閉じている間の repo 変更を見張る tripwire）
- working-tree-fingerprint: `fail-safe` の 12 件と、検出・state file の各テスト（completion gate が「変化なし」と誤って skip しない側に倒す判定）
- compaction-testament: PreCompact の 7 件と `project dir anchoring > restores the testament after the session cwd drifts into a subdir`（ignore されていない dir の発話を書かない側に倒す判定）
- claude-worktree: `git hardening` の C06・C07・C08、`removeWorktree` の拒否（C31・C33〜C36・C40・C44）、ハンドラの C54 の拒否
- agent-learnings（データ保護）: inbox の全件、store の symlink 拒否、worker の `rejects ...` 系、cli の `rejects human-only operations when an agent environment variable is present, even with a TTY`

unit に残る deny の分岐のテストは、auto-approve の `auto-approve.ts hook behavior`（Bash の deny）と file-access-guard の `block ...` 系で、gate が走らせる。

## git の shim

`bun run test` だけが `CLAUDE_TEST_FORBID_GIT=1` を立てる。preload（`preload-test-env.mjs`）は、値がちょうど `1` のとき、テストファイルのプロセスごとに `git` の shim（`home/dot_claude/hooks/tests/support/git-shim.mjs`）を PATH の先頭に置く。shim は本物の git を呼ばず、引数・cwd・テストファイルのパスを記録して exit 1 する。プロセスの終わりに、記録が 1 行でもあれば、記録を stderr に出してそのテストファイルを失敗にする。記録が無い・読めないときと、shim を置けなかったときも失敗にする。git が無いときのフォールバックを持つ hook が、テストを落とさずに進んだ場合も、記録で気づける。

shim が覆わない範囲がある。

- `node --test <file>` を直接走らせたとき（`CLAUDE_TEST_FORBID_GIT` が立たない）
- pre-commit が `tests/heavy/chezmoiremove-coverage.test.mjs` を直接走らせるとき（`CLAUDE_TEST_FORBID_GIT=''` を付けて走らせる）
- 絶対パスの git、PATH を差し替えた git、絞った PATH の git。PATH を差し替える helper は `home/dot_claude/hooks/tests/support/fake-git.ts`（`createBlockingGit`、今は heavy だけが使う）。絞った PATH で hook を起動する unit は `unit/run-guard.test.ts`（`/usr/bin:/bin`）。unit で絶対パスの git を起動する箇所は、見つかっていない

shim を外すには、`CLAUDE_TEST_FORBID_GIT= bun run test` のように空にして走らせる。`test:perf` と `test:heavy` の script は、呼び出し元から値が漏れても入らないよう、空の代入を持つ。プロセスが強制終了されたとき、shim の置き場（`os.tmpdir()` 下の 0700 の `claude-git-shim-*`）が残ることがある。残ったものは手で消してよい。

## 計測のやり直し

unit に残るテストが再び重くなっていないかは、大きな変更の後に次の手順で測り直す。

1. `uptime` と `nproc` を記録し、ほかの session が重い処理（`bun run test` など）を走らせていないことを確かめる
2. 負荷なしで `bun run test` の起動から終了までの実時間を測る
3. `yes > /dev/null` を `nproc` の 6 倍の本数、背景で走らせる。その下で `bun run test` の実時間を 3 回測る。毎回、`yes` を止め、残りが 0 本であることを確かめる
4. 同じ負荷の下で、同じファイル一覧と同じ環境（`CLAUDE_TEST_FORBID_GIT=1`）の junit を取り、1 件 5 秒以上のテストを探す（`node --test --test-reporter=junit --test-reporter-destination=<file>` を `package.json` の `test` と同じ引数で走らせ、`testcase` の `time` を見る）
5. 3 回の最大が 60 秒以下で、unit に 5 秒以上のテストが無ければ合格。5 秒以上のテストが残れば、上の規則 (b) で heavy に移して測り直す

## 計測の記録

2026-10-21、`nproc` は 8。

| 条件                | `bun run test` の実時間 |
| ------------------- | ----------------------- |
| 負荷なし            | 6.4 秒                  |
| `yes` 48 本・1 回目 | 32.1 秒                 |
| `yes` 48 本・2 回目 | 28.4 秒                 |
| `yes` 48 本・3 回目 | 37.8 秒                 |

- 負荷の下の最大は 37.8 秒。completion gate の上限（120 秒）の半分より小さい
- 5 秒以上のテストは、負荷なしでも負荷の下でも 0 件
- `bun run test:heavy` は、負荷なしで 48.8 秒

`preload-test-env.mjs` は、テストファイルごとに `CLAUDE_LOGS_DIR` を使い捨てのディレクトリへ向ける（hook のログが開発者の `~/.claude/logs/` に書かれないようにするため）。`TMPDIR` もテストファイルごとの使い捨てのディレクトリへ向け、プロセスの終了時に消す（`/tmp` に残ったものは、次の起動で systemd-tmpfiles が消すまで WSL の起動を止めるため）。また git が hook に渡す `GIT_DIR` などの変数を消す（pre-commit から実行したとき、テストが起動する `git` がコミット中のリポジトリを書き換えないようにするため）。

## テスト実行方法

```bash
# unit テスト
bun run test

# perf テスト
bun run test:perf

# heavy テスト（git を起動するテストと負荷に弱いテスト）
bun run test:heavy

# 型チェック
bun run typecheck

# unit・perf・heavy・型チェック・lint をまとめて
bun run check

# 個別のテストファイル
node --import ./home/dot_claude/hooks/tests/preload-test-env.mjs --test home/dot_claude/hooks/tests/unit/session.test.ts
```

### 個別 Hook の手動実行

```bash
echo '{"tool_name": "Bash", "tool_input": {"command": "git status"}}' | bun home/dot_claude/hooks/implementations/auto-approve.ts
```

## 新しいテストの追加

1. 既存のテストで似た形のものを探して、構成を合わせる
2. `home/dot_claude/hooks/tests/unit/<対象>.test.ts` に書く。経過時間を測るものは `home/dot_claude/hooks/tests/perf/` に、git を起動するものは `home/dot_claude/hooks/tests/heavy/` に置く（上の「置き場の規則」）
3. unit・perf・heavy で共有する helper は `home/dot_claude/hooks/tests/support/` に置く
4. 構成の書き方は `home/dot_claude/hooks/tests/unit/README.md` を参照
