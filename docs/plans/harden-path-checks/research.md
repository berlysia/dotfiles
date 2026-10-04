# Research: hook のパス判定の強化（#241 の項目 2〜5）

## オーダー

Issue #241 の残り 4 項目を Document Workflow で進める。項目 1（repoRoot / additionalDirectories の境界判定）は `d6ce00a` で済んでいる。

- 項目 2: literal `/tmp` 判定が共通化されていない
- 項目 3: Bash のパス抽出の漏れ（`>`、`ln`、`$VAR`、`~`。ハードリンク経由の書き込み）
- 項目 4: `/tmp` の allow パターンが締め付けを上書きする
- 項目 5: macOS 以外の独自 `$TMPDIR` を一時ディレクトリのルートとして扱わない

制約: #235 が別の worktree（`fix/bash-parser-superlinear`）で `lib/bash-parser.ts` を直す。2026-10-04 時点でそのブランチは master と差分がなく、未コミットの変更もない。

以下、パスは `home/dot_claude/hooks/` 起点。行番号は `d6ce00a` 時点。「実測」は関数や hook を実際に呼んだ結果、「推定」はコードを読んだだけの結論。

## 1. 一時ディレクトリ判定の現状（項目 2、5）

### 1.1 実行時の判定は 3 か所

| 箇所                                                                                                                | 一時ディレクトリとみなすもの                                                                               | `..`                                                        | symlink                                                                                                            | 用途                                                                       |
| ------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------- |
| A. `implementations/file-access-guard.ts` の `collectTempRoots` / `isWithinTempRoots`（`validatePath` の step 1.5） | `/tmp` とその realpath。`$TMPDIR` は macOS の形（`/var/folders/<a>/<b>/T`）のときだけ、literal と realpath | セグメント単位で拒否                                        | 最寄りの既存の祖先を realpath し、物理位置もルート配下であることを要求。dangling link と ENOENT 以外のエラーは拒否 | allow（Read / Write / Edit / Bash のパス）                                 |
| B. `implementations/permission-auto-approve.ts:381` の `isSessionScratchpadSafe`                                    | `/tmp/claude-<uid>/<slug>/<session_id>/scratchpad/` だけ。`$TMPDIR` 版は対象外（:364-368 に理由）          | 生のパスに `..` があれば拒否                                | `lib/workflow-fs.ts:68` の `isStrictlyUnderProjectSubdir` で解決。scratchpad 自体が symlink なら拒否               | 自動承認                                                                   |
| C. `implementations/document-workflow-guard.ts:595-678` の interpreter scratch roots                                | 絶対パスは `/tmp` と、絶対値の `$CLAUDE_JOB_DIR` / `$DOCUMENT_WORKFLOW_DIR`。相対パスは `.tmp` ほか        | 部分文字列 `..` を含めば拒否（`a..b` という名前も巻き込む） | 解決しない。文字列比較のみ                                                                                         | interpreter（python / node など）の書き込み先が scratch の外なら deny 寄り |

### 1.2 実行時の判定ではないもの

- `lib/permission-analyzer.ts:717` の `isSafeWorkspaceTarget` は `/tmp/` の前方一致だけを見る。ただしこのモジュールを import するのは `scripts/update-auto-approve.ts` だけで、許可ルールの提案ツールであり hook の判定には入らない（`git grep permission-analyzer` で確認）
- `lib/pattern-matcher.ts:131-135` は find の開始パスの許可リストに `/^\/tmp/`（境界なし。`/tmpx` も通る）を持つ。用途は未確認（spec を書く前に呼び出し元を確かめる）

### 1.3 判定どうしの差

実測（A と B を bun で直接呼んだ。Linux、`TMPDIR` 未設定と `TMPDIR=/run/user/1000`）:

| パス                                   | A     | B                              |
| -------------------------------------- | ----- | ------------------------------ |
| `/tmp`、`/tmp/x`                       | true  | false（scratchpad の形でない） |
| `/tmp/../etc/x`                        | false | false                          |
| 自セッションの scratchpad 配下         | true  | true                           |
| scratchpad 内の、外を指す symlink 経由 | false | false                          |
| `/tmpx/y`                              | false | false                          |

- A と B が割れるのは `/tmp` と `/tmp/x` だけで、B が scratchpad に絞っているための意図した差
- `TMPDIR=/run/user/1000` でも A のルートは `["/tmp"]` のまま（実測）。項目 5 の記述どおり
- C は symlink を解決しないので、`/tmp` 配下の symlink がどこを指しても scratch 内とみなす（推定）

### 1.4 `$TMPDIR` を macOS の形に限っている理由

- `file-access-guard.ts:339-341` のコメント: `os.tmpdir()` は `$TMPDIR` に従い、プロジェクトの `.claude/settings.json` の `env` で上書きできる。受け入れる形を限ることで、`/`、`/var`、`~/.ssh` などが書き込み可能なルートになるのを防ぐ
- commit `eac5f24` の本文: `decision: accept $TMPDIR only in the exact macOS per-user shape …, since project settings env can set it` / `rejected: allowing all of /var/folders; it holds other users' temp dirs and caches`
- B 側（`permission-auto-approve.ts:364-368`）の理由は別: hook 自身の環境変数と、scratchpad が作られた環境が一致する保証がない
- この脅威を述べた ADR はない。根拠は上のコメントと commit だけ

### 1.5 共通化の受け皿の候補

- `lib/workflow-fs.ts`: `realpathInsideWorkflowDir`（:18）と `isStrictlyUnderProjectSubdir`（:68）。:37-44 に「意図的に共有しない」と書いてある。`resolveWithMissingTail`（:109）は「最寄りの既存の祖先を realpath して残りを付け直す」処理で、A の同じ処理とは別実装
- `lib/path-utils.ts`: `getHomeDir`、`expandTilde`、`normalizePath`。包含判定は持たない
- セグメント境界の包含判定は `file-access-guard.ts` の `isUnderRoot` と `document-workflow-guard.ts:603-609` の `isUnderSegmentRoot` に別々にある

### 1.6 既存テスト

- `tests/unit/file-access-guard.test.ts`: `temp roots (HOME isolated)`、`collectTempRoots`、`isWithinTempRoots`
- `tests/unit/permission-auto-approve.test.ts`: `isSessionScratchpadSafe`、`staticRuleEngine - session scratchpad file operations`
- `tests/unit/interpreter-write-classify.test.ts`、`tests/unit/document-workflow-guard.test.ts`: interpreter の書き込み先

## 2. Bash のパス抽出（項目 3）

### 2.1 現在の実装

- `file-access-guard.ts` は `lib/bash-parser.ts` を import していない（:3-22）
- `extractPathsFromBashCommand`（:280-322）は、コマンド文字列の全体に正規表現 5 本を当てるだけ。`;` `&&` `|` での分割、クォート、リダイレクトの解釈はない
- 拾うのは `cat|head|tail|less|more` の最初の 1 語、`rm` のフラグを飛ばした 1 語、`cp|mv` の 2 語、`chmod|chown` のモードの次の 1 語、`ls` の 1 語
- `resolvePath`（:324-337）は `/` で始まらない語を cwd 基準で解決する。`~/x` や `$HOME/x` は「cwd 配下の相対パス」になる

### 2.2 実測（`CLAUDE_TEST_REPO_ROOT` と cwd が `/home/user/project`、HOME は隔離）

| 入力                                                                   | 結果  |
| ---------------------------------------------------------------------- | ----- |
| `cat /home/user/other/a.txt`                                           | deny  |
| `cp /home/user/project/a /home/user/other/b`                           | deny  |
| `echo x > /home/user/other/a.txt`（`>>`、空白なしの `>/…` も同じ）     | allow |
| `tee /home/user/other/a.txt`                                           | allow |
| `ln /home/user/other/secret /home/user/project/link`（`ln -s` も同じ） | allow |
| `cat $HOME/.ssh/id_rsa`、`cat ~/.ssh/id_rsa`、`cat ~otheruser/x`       | allow |
| `cd /home/user/other && cat a.txt`                                     | allow |

Issue の記述（`>`、`ln`、`$VAR`、`~` を拾わない）はすべて再現した。`tee` と `cd` の追跡は Issue に無いが同じ漏れ。

### 2.3 流用できる既存の抽出器

- `document-workflow-guard.ts` の `analyzeSingleCommand`（:740-835）と `extractRedirectionTargets`（:859-891）が、書き込み先を語の単位で取り出している
  - リダイレクトは `>`、`>>`、`>|`、空白なしの `>file` を拾い、`2>` と `/dev/null` を除く
  - `tee`、`touch`、`mkdir`、`rm`、`rmdir`、`truncate`、`sed -i`、`perl -i` はフラグ以外の引数
  - `cp`、`mv`、`install`、`ln` は最後の引数だけ（`ln` のリンク元は拾わない）
  - export されていない。`~` と `$VAR` は展開しない
- `lib/bash-parser.ts` の `parseBashCommand` / `extractCommandsDetailed` は `SimpleCommand`（`name`、`args`、`redirections: string[]`）を返す。リダイレクトは生の文字列で、対象のパスを構造として持たない。変数展開とチルダを構造として返す API は無い（`parseSimpleCommandFromNode` :363-461 が拾うノードは `word`、`command_name`、`string`、`raw_string`。展開ノードが `args` から落ちるかは推定で、未確認）

### 2.4 ハードリンク（推定。実行では未確認）

- `ln` で repo の中に repo の外のファイルへのハードリンクを作ると、その後の Edit / Write は repo の中のパスとして step 1 で通る。ハードリンクはパス文字列でも realpath でも元のファイルと区別できない
- したがって検知できるのは `ln` を実行する時点だけ

## 3. allow パターンの上書き経路（項目 4）

### 3.1 実装

- `checkAllowPatterns`（`file-access-guard.ts:633-648`）は括弧の中を取り出し、`expandTilde` を通して `lib/pattern-matcher.ts:258` の `matchGitignorePattern` に渡す
- `/` で始まり `*` を含むパターンは `matchAbsoluteGlob`（`pattern-matcher.ts:198-229`）に回り、パスを `posix.normalize` してから照合する。`..` は畳まれる。symlink は解決しない
- 配布される設定に該当のパターンがある: `home/dot_claude/.settings.permissions.json:168` の `"Edit(/tmp/**)"` と :183 の `"Read(/tmp/**)"`

### 3.2 実測（隔離した HOME に settings を置き、hook を直接呼んだ）

| 操作とパス                          | allow が空 | `Edit(/tmp/**)` + `Read(/tmp/**)` |
| ----------------------------------- | ---------- | --------------------------------- |
| Write `/tmp/ok.txt`                 | allow      | allow                             |
| Write `/tmp/../home/user/other/x`   | deny       | deny                              |
| Read `/tmp/../etc/passwd`           | deny       | deny                              |
| Write `/tmp/D/<外を指す symlink>/x` | deny       | **allow**                         |
| Write `/tmp/D/<dangling symlink>`   | deny       | **allow**                         |

- **Issue の記述のうち `/tmp/../x` は再現しない**。glob の側が `..` を畳むので、パターンに一致しない
- **symlink は再現する**。step 1.5 が物理位置を見て拒否したパスを、step 5 が文字列の前方一致で許可する
- 配布される設定にこのパターンがあるので、実際の環境では step 1.5 の symlink 検査は効いていない

### 3.3 Issue に無い迂回: `..` を含む絶対パスが step 1 を通る

実測（allow が空。調査の subagent と、このセッションで別々に再現した）:

| 操作                                              | 結果      |
| ------------------------------------------------- | --------- |
| Read `/home/user/project/../other/secret`         | **allow** |
| Read `/home/user/project/../../../etc/passwd`     | **allow** |
| Write `/home/user/project/../other/x`             | **allow** |
| Bash `cat /home/user/project/../../../etc/passwd` | **allow** |
| Read `../other/secret`（相対）                    | deny      |
| Read `/home/user/other/secret`                    | deny      |

- 原因: `resolvePath`（:324-337）は絶対パスを無加工で返し、step 1 はその文字列に `isUnderRoot` を当てる
- 意図された挙動ではない根拠: 既存テスト `should block parent directory traversal`（`tests/unit/file-access-guard.test.ts:148`）が親ディレクトリへの遡りを拒否する意図を示している。このテストは相対パスしか見ていない
- 確認していないこと: Claude Code 本体の権限判定が同じパスをどう扱うか。リポジトリ内に記述は無い

### 3.4 同じ形の step

どれも無加工の `absPath` に対する文字列の判定。実測（隔離した HOME、additionalDirectories に `/home/user/extra`、allow は空）:

| 操作                                            | 結果      | 当たった step |
| ----------------------------------------------- | --------- | ------------- |
| Read `<HOME>/.claude/../../…/home/user/other/a` | **allow** | step 3        |
| Read `/home/user/extra/../other/a`              | **allow** | step 4        |
| Read `/home/user/extra/a`                       | allow     | step 4        |
| Write `/var/tmp/x`                              | deny      | step 2        |
| Read `/var/tmp/../log/syslog`                   | deny      | step 2        |

- step 3 と step 4 は `..` で外へ出られる（実測）
- **`/var/tmp` は今も通らない**（実測）。step 3 の `alwaysSafePaths` に `/var/tmp` があるが、先に step 2 の `/var/` の拒否に当たるので到達しない。調査の subagent 2 名は「後段で許可される」と推定していたが、誤り
- step 2（システムディレクトリ、:516-538）: `/tmp/../etc/passwd` は `/etc/` で始まらないので当たらない。3.2 で deny になったのは末尾の既定の拒否による
- step 6（chezmoi）: `$HOME/../x` は `$HOME/` で始まる（推定。未実測）

### 3.4.1 Bash の現状の追加の実測

| 入力                          | 結果                                             |
| ----------------------------- | ------------------------------------------------ |
| `out=/etc/x; echo x > "$out"` | allow                                            |
| `cat $SOMEVAR/x`              | allow                                            |
| `cat /etc/$f`                 | deny（`/etc/$f` という文字列が step 2 に当たる） |
| `cat a /etc/hostname`         | allow（2 つ目の引数を見ていない）                |
| `chmod 600 /etc/hostname`     | deny                                             |
| `ls /etc`                     | deny                                             |

### 3.5 判定順を決めた ADR

無い。ADR-0023 の K10（workflow dir への書き込みの許可。step 1.6）だけが関係する。

## 4. #235 との衝突面

- #235 が触る見込みの範囲（`lib/bash-parser.ts`）: `extractCommandsInternal` :644-670、`extractMetaCommands` :672-806、`collectExecutableTexts` :996-1040、`extractCommandsStructured` :1042-1056
- リダイレクトの処理は `parseSimpleCommandFromNode`（:396-403）と `collectExecutableTexts`（:1018-1020）の中にある。リダイレクト先や展開を構造として返すように `bash-parser.ts` を直すと、#235 と同じ関数を編集することになる
- `bash-parser.ts` を編集しない経路は 2 つある
  - 既存の API を呼ぶだけにする。ただしリダイレクトは生の文字列なので、対象のパスは呼ぶ側で取り出し直す
  - `document-workflow-guard.ts` の語の分割と書き込み先の抽出を `lib/` に出して共有する。`bash-parser.ts` には触れない
- 項目 2、4、5 と 3.3 は `bash-parser.ts` に関係しない

## 5. file-access-guard が起動されるツール（2026-10-04 に確認）

### 5.1 事実

- 配布済みの `~/.claude/settings.json` で、file-access-guard の登録は `PreToolUse matcher=Read|Write|Edit` の 1 つだけ（`jq` で確認）。テンプレート `home/dot_claude/.settings.hooks.json.tmpl:35-39` も同じ
- matcher の一致の仕方（2026-10-04 に公式ドキュメント https://code.claude.com/docs/en/hooks.md で確認）: 英数字、`_`、`-`、空白、`,`、`|` だけでできた matcher は、`|` で区切った名前との完全一致で評価される。ほかの文字が入ると正規表現になり、アンカーの無い部分一致になる。したがって `Read|Write|Edit` は NotebookEdit にも MultiEdit にも当たらない
- file-access-guard を import する hook、lib、cli、scripts は無い（`git grep`）
- したがって、hook のコードにある Bash、Glob、Grep、LS、NotebookEdit の分岐（`implementations/file-access-guard.ts:39-50` の `fileTools`、:216-322 の抽出）は、実際の環境では実行されない
- **2.2 と 3.4.1 の Bash の行、3.3 の Bash の行は、hook の関数を直接呼んだ結果であり、実際の環境の挙動ではない**。実際の環境では、Bash のパスは file-access-guard に検査されない。`cat /home/user/other/a.txt` の deny も起きない
- Read / Write / Edit の行（3.2、3.3、3.4）は、実際の環境でも hook が起動されるので有効

### 5.2 経緯

| commit                                      | 日付       | file-access-guard の matcher |
| ------------------------------------------- | ---------- | ---------------------------- | ----- | ----- | ---------- | ------------ | ------------ | --- | ---- | ---- | ------ |
| `ce65b18`（前身の deny-repository-outside） | 2025-07-14 | `(Read                       | Write | Edit  | MultiEdit  | NotebookRead | NotebookEdit | LS  | Glob | Grep | Bash)` |
| `e745e80`                                   | 2026-01-06 | `""`（全ツール）             |
| `b7e4d84`                                   | 2026-01-28 | `Read                        | Write | Edit  | MultiEdit` |
| `f4d271f`                                   | 2026-06-09 | `Read                        | Write | Edit` |

- `b7e4d84` の件名は `feat(claude): include repository name in voice notifications`。本文は音声通知の説明だけで、matcher を絞った理由は書かれていない
- 意図して絞ったのか、別の変更に巻き込まれたのかは、履歴からは分からない

### 5.3 Bash に登録されている他の guard（R6 の根拠）

- document-workflow-guard: `PreToolUse matcher=Write|Edit|MultiEdit|NotebookEdit|Bash|…`、run-guard 経由、`|| exit 2`
- auto-approve、deny-node-modules: `PreToolUse matcher=""`（全ツール）。auto-approve は run-guard 経由、`|| exit 2`
- run-guard（`hooks/executable_run-guard.sh:15,95`）は 20 秒でタイムアウトし、`block` で exit 2 にする

### 5.4 その他の確認

- `lib/pattern-matcher.ts:131` の `/^\/tmp/` は、`/tmpx/y` と `/tmp/../etc` に一致する（node で正規表現を評価）
- `isWithinTempRoots` と一時ディレクトリの既存テストのうち `..` を含むもの（`tests/unit/file-access-guard.test.ts` の :418、:536、:547、:607、:749）は、どれも字句の形がルートの外に出る入力で、spec の新しい規則でも期待値は deny / false のまま。`/tmp/a/../b` のようにルートの中にとどまる `..` を拒否するテストは無い

### 5.5 Bash を検査の対象にするときに効く既存の方針

- step 6b（`implementations/file-access-guard.ts:609-622`）: dotfiles の repo では、HOME 配下の読み取り（Read、Glob、Grep、LS、NotebookRead）をすべて許可する。この repo では今も `Read ~/.ssh/id_rsa` は通る
- step 4（:552-579）の書き込みの分岐は `Edit`、`Write`、`MultiEdit` だけで、`NotebookEdit` が無い。step 6a（:595-599）には `NotebookEdit` がある
- `getAllowPatterns(files, "Write")` は `Write(…)` と `Edit(…)` の両方を返し、`"Edit"` は `Edit(…)` だけを返す（:187-212）
- 配布している設定（`home/dot_claude/.settings.permissions.json`）でシステムディレクトリを指すパターンは、deny の `Edit(/etc/**)`、`Edit(/usr/**)` など書き込み側だけ。`Read(/etc/**)` のような読み取りの deny は無い（`jq` で確認）
- step 2 の一覧には `/dev` が入っている（:516-529）

### 5.6 glob の展開に使える API（実測。node v24.15.0 と bun 1.4.0）

scratchpad に `real/a.ts`、`real/.hidden`、`out/passwd`、`link → out` を置いて `fs.globSync(pattern, { cwd })` を呼んだ。node と bun で結果は同じ。

| パターン                 | 結果                                       |
| ------------------------ | ------------------------------------------ |
| `lin*/passwd`            | `[]`（symlink のディレクトリをたどらない） |
| `real/*`                 | `["real/a.ts"]`（`.hidden` を返さない）    |
| `{real/a.ts,out/passwd}` | 2 件とも返す                               |
| `real/**`                | `["real", "real/a.ts"]`                    |

- `fs.globSync` は symlink をたどらないので、「glob が repo の中の symlink に当たって外へ届く」場合を列挙できない。シェルは `lin*/passwd` を `link/passwd` に展開する

### 5.7 判定ログ（`~/.claude/logs/decisions.jsonl`）

- Bash の記録は 83 件（2026-10-04 時点）。項目は `cwd`、`decision`、`input`、`reason`、`session_id`、`timestamp`、`tool_name`、`user`
- `decision` の内訳は allow 28、pass 55。他の guard が先に deny したコマンドは含まれない

### 5.8 glob の上限の根拠にするエントリ数（この worktree、2026-10-04）

| ディレクトリ                       | エントリ数 |
| ---------------------------------- | ---------- |
| `node_modules`                     | 14         |
| `home/dot_claude/node_modules`     | 8          |
| `home/dot_claude/hooks/tests/unit` | 92         |

### 5.9 run-guard と判定ログ

- `hooks/executable_run-guard.sh:17-20` の `block` は `run-guard: <原因>; blocking this tool call (guard hook: <impl>). Fix: <対処>` を stderr に出して exit 2 にする。引数は hook のパス 1 つ（:14）
- タイムアウト（:95）と異常終了（:101）の対処の文言は、原因の調べ方と `bun install` だけで、hook を登録から外す手順は無い
- `lib/centralized-logging.ts:325-333` の `logDecision(toolName, decision, reason, sessionId, input)` が `decisions.jsonl` に書く。`implementations/auto-approve.ts:80` と `permission-llm-evaluator.ts:289-357` が使っている

## 6. Bash の抽出と登録（別の spec に持ち越す。2026-10-04 にユーザーが分割を選んだ）

この節は、spec のレビュー Round 1〜4 で Bash の側について固まったことと、未解決のまま残ったことの記録。次の spec の材料にする。

### 6.1 ユーザーが決めたこと

- file-access-guard の matcher に Bash を足して、項目 3 を効かせる
- Glob と Grep は足さない
- spec は判定側と Bash 側に分ける。Bash 側は K10 を作り直す

### 6.2 レビューを通った設計（Round 4 で指摘が出なかった部分）

- **抽出の置き場**: `document-workflow-guard.ts:748-915` の `splitShellWords`、`extractRedirectionTargets`、`extractMainCommand`、書き込みコマンドの分岐を `lib/bash-path-operands.ts` に移す。文字列の処理だけを持ち、`node:fs` も `lib/deny-input.ts` も import しない。`bash-parser.ts` は編集しない
- **役割つきの表**: `classifyPathOperands(words)` が `{ word, role: "read" | "write" | "link-source" }[]` を返す。document-workflow-guard は `role === "write"` だけを使い、workflow-cli と interpreter の分岐、`dedupe`、空文字の除去は自分に残す
  - write: 出力のリダイレクトの先、`tee` / `touch` / `mkdir` / `rm` / `rmdir` / `truncate` の位置引数、`sed -i` / `perl -i` の最後の位置引数、`cp` / `mv` / `install` / `ln` の最後の位置引数（位置引数が 2 つ以上のとき。`-t DIR` があれば `DIR`）、`chmod` / `chown` のモード・所有者の次以降
  - read: 入力のリダイレクトの元、`cat` / `head` / `tail` / `less` / `more` / `ls` の位置引数、`cp` / `mv` / `install` の write にならなかった位置引数
  - link-source: シンボリックでない `ln` の write にならなかった位置引数。`"write"` のカテゴリで判定する
  - lib が解釈するフラグは一覧で持つ（`-t` の各形、`head` / `tail` の `-n` / `-c`、`--`）
- **document-workflow-guard の結果が変わる点**: `chmod` / `chown` が write-like になる。`cp -t DIR a` の書き込み先が `a` から `DIR` になる。`sed -i 's/a/b/'` のスクリプト語を書き込み先として扱う今の挙動は変えない
- **判定への渡し方**: Bash のオペランドは `judge(form, { category, allowPatterns })` に渡す。write は `getAllowPatterns(files, "Write")`、read は `"Read"`。Read ツールで読めるパスは Bash でも読める（dotfiles の repo では step 6b が HOME 配下の読み取りを通す）
- **システムディレクトリ**: 書き込みは上書きできない拒否。読み取りは `/proc`、`/sys`、`/dev` を除き、ユーザーの設定の `Read(…)` に当たれば通す。プロジェクトの設定のパターンは使わない
- **判定しないデバイスファイル**: `/dev/null`、`/dev/stdin`、`/dev/stdout`、`/dev/stderr`、`/dev/tty`、`/dev/zero`、`/dev/random`、`/dev/urandom`、`/dev/fd/<数字>`（正規化の前の文字列との完全一致）
- **登録の前の再生**: `decisions.jsonl` の Bash の記録を新しい抽出と判定に通し、母集団、deny の件数と一覧、理由別の件数を報告して、ユーザーの返答を待つ。matcher の変更は単独の commit
- **復旧の案内**: 文言はテンプレートの登録の行に 1 か所だけ置き、run-guard の 2 つ目の引数で渡す。手順を行うのは人だと書く。環境変数のスイッチは置かない
- **deny の記録**: 既存の `logDecision` で種別つきで残す

### 6.3 未解決のまま残った指摘（Round 4）

- **語の展開の扱い（K10）が収束しなかった**。危ない形を列挙する作りなので、ラウンドごとに別の形が見つかった:
  - Round 2: ブレース展開（`{/etc/passwd,x}`）、glob が repo の中の symlink に当たる形（`lin*/passwd`）
  - Round 3: `$` の行がブレースと glob の行より前にある順序の問題、1 語の中にクォートの内と外が混ざる形（`"$HOME"/*.md`）
  - Round 4: ブレース展開の後のチルダと `$HOME`（`{~,x}/.ssh/id_rsa`）、`.*` が `..` に一致するシェル（bash 5.1 以前）、zsh と globstar での `**` の再帰、`$'…'` と `$"…"`、同じセグメントに glob と `$` がある形（`lin*$f/passwd`）、`walkGlob` の `base` が空のときの cwd とルートの区別
- **次の spec での方針の候補**: 「判定できる形」を決め、それ以外の展開の構文を含む語は deny にする。`$VAR` で始まる語だけを名指しの例外として「判定しない」にする（`out=$(mktemp); … > "$out"` を止めないため）
- **run-guard の 2 つ目の引数に求めること**: 引数が無いときの出力が今と同じ。案内を `printf` の書式文字列に入れない。`RUN_GUARD_RECOVERY` は引数の有無にかかわらず設定し直す（無ければ消す）。案内の文言に `'` を使わない
- **ログの書き込みの失敗**: `lib/centralized-logging.ts` のコンストラクタの `mkdirSync` は try の外にあるので、`logDecision` が例外を投げうる。呼び出しを try/catch で包み、deny の判定と種別を変えない
- **ユーザーの設定の見分け**: `getSettingsFiles()` を引数なしで別に呼ぶ（:139 が引数で分岐する）。配列の添字で見分けない。`getHomeDir()` は `process.env.HOME` を使う（`lib/path-utils.ts:27`）ので、プロジェクトの `env` で動かせないかを確かめる

### 6.4 glob についての事実

- `fs.globSync` は symlink をたどらない（5.6）ので、シェルの展開の列挙には使えない
- Round 3〜4 の設計（`walkGlob`: 記号のある階層のディレクトリを読み、symlink の行き先を判定する。合計 5,000 エントリと 5 秒で打ち切る）は、手順そのものへの指摘は軽微だった。pnpm の `node_modules` のように repo の外を指す symlink が並ぶディレクトリでは、`ls *` が deny になりうる

## 7. 調査で残ったもの

- このセッションの確認用に作った `/tmp/probe-home-7b6Eju` が残っている

- 調査の subagent が作った一時 HOME `/tmp/tmp.dwkarsFHh7` が残っている。`rm -rf` が guard hook に止められた
