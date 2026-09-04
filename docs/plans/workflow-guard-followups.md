# document-workflow-guard の後続課題

`document-workflow-guard` の env 非依存化（ADR-0013）の調査中に発見した、本体スコープ外の課題をまとめる。実測は全て 2026-08-28〜2026-09-04 時点。session 成果物（`.tmp/sessions/`）は GC で失われるため、再調査コストの高い事実をここへ移送している。

設計層（spec）が列挙したのは 8 件だが、本ドキュメントは 9 件を扱う。課題 I は plan のレビュー中に新規発見したものを追加した。spec は承認済みで凍結されており本 plan は spec を触らないため、spec だけを読んだ人が 9 件目を見落とさないよう、この橋渡しをここに置く。

## 課題 A: `&>` / `&>>` によるゲート回避

`document-workflow-guard.ts` のリダイレクト対象抽出は、`&` を先頭に持つトークンを一貫して除外する形になっている。

- `isRedirectionToken`（`document-workflow-guard.ts:764`）は `/^(?:\d*>>?|\d*>\|)$/` にマッチするトークンのみをリダイレクトと認識する
- 分離形の場合、`document-workflow-guard.ts:744-745` の `!next.startsWith("&") && !isStderrRedirection(token)` により、次トークンが `&` で始まると対象抽出から除外される
- インライン形（`file>path` のように 1 トークンにまとまった形）の場合、`document-workflow-guard.ts:754-755` の `!inline[3].startsWith("&")` が同様に `&` 始まりを除外し、加えて `inline[1] !== "2"` により `2>` 系の fd 番号を持つものを一律除外する
- `isStderrRedirection`（`document-workflow-guard.ts:768`）は `/^2(>>?|>\|)$/` にマッチするトークンを stderr リダイレクトとして扱う

未着手である理由: ユーザー判断で別タスクに切り出すことを確定済み（2026-08-28）。`!startsWith("&")` は `2>&1` / `>&2` のような fd 複製構文を誤検知しないための load-bearing なチェックであり、単純に外すと `2>&1` のような正当な構文が偽陽性 deny になる。

## 課題 B: 複合コマンド構文によるゲート回避

`lib/bash-parser.ts` の `extractCommandsStructured`（`lib/bash-parser.ts:927-974`）は tree-sitter でパースした `result.commands` を「入力全体と一致する 1 件」と「それ以外」に分け、後者のみを `individualCommands` として返す。`if` / `while` / 関数本体のような複合コマンドは、内部の個々のコマンドが `parsingMethod: "tree-sitter"` のまま `individualCommands` から漏れる形になっており、複合コマンド構文の内側に隠れたリダイレクトはこの経路で対象抽出から漏れる。

未着手である理由: ユーザー判断で別タスクに切り出すことを確定済み（2026-08-28）。

## 課題 C: 非 Bash 経路の「対象不明 → allow」と、matcher に載らないツールが評価されないこと

- `document-workflow-guard.ts:167-169` は `getTargetFilePath` が対象パスを取れなかった場合に `if (!targetPath) { return context.success({}); }` で無条件 allow する
- 評価対象そのものが `GUARDED_TOOLS`（`document-workflow-guard.ts:24-30`、`Write` / `Edit` / `MultiEdit` / `NotebookEdit` / `Bash` の 5 種）と `.settings.hooks.json.tmpl:4` の matcher（`"Write|Edit|MultiEdit|NotebookEdit|Bash"`）の交差に限られており、この集合に無いツールは呼び出しごと評価を通過しない

未着手である理由: K10b は Bash 経路のみを対象とした。Write/Edit の `file_path` 欠落はツール入力スキーマ違反であって抽出失敗ではなく、原因クラスが異なるため同じ後続タスクに含めなかった。

## 課題 D: Bash 経由の spec/plan 編集が 3 hook を迂回する

`lib/workflow-tool-input.ts:21,37-39` の `EDIT_TOOLS` は `Write` / `Edit` / `MultiEdit` / `NotebookEdit` の 4 種のみを allowlist に持ち、`isWorkflowDocumentEdit` はこれ以外のツール名（`Bash` を含む）に対して `isEdit: false` を早期 return する。Bash のヒアドキュメントやリダイレクトで spec.md / plan-N.md の内容を書き換えても、この判定を消費する `plan-review-automation` / `spec-plan-placeholder-scan` / `spec-plan-self-audit` の 3 hook はいずれも編集として認識しない。

未着手である理由: allowlist の拡張は各 hook の入力前提（`tool_input.file_path` の存在）に波及するため、独立タスクとして切り出す必要がある。

## 課題 E: `CLAUDE_TEST_CWD` の採用条件の限定と production からの除去

production コードで `process.env.CLAUDE_TEST_CWD` を読むのは次の **7 ファイル**である: `spec-plan-self-audit.ts:27`、`plan-review-automation.ts:554-555`、`block-plan-mode.ts:22`、`file-access-guard.ts:330`、`document-workflow-guard.ts:228`、`lessons-learned-extractor.ts:102`、`spec-plan-placeholder-scan.ts:34`。

リポジトリ内で数え方が割れている。設計層（spec）は 1 箇所で「6 ファイル 7 箇所」（`file-access-guard.ts` が漏れている）、別の箇所で「5 hook」と書いており、spec 内部でも 5 と 6 に割れている。`session.ts:127` のコメントは "five CLAUDE_TEST_CWD readers" と書く。実測は 7。本ドキュメントの 7 を以後の SSoT とする。

機構の名指しに注意する: 「`isOutsideProject` を全 allow に倒す」とは書かない。`document-workflow-guard.ts:275-277` の `isOutsideProject` は `resolve(cwd, expandTilde(path))` を偽 cwd 基準で解決するため、**相対パスのターゲットは偽 cwd 配下＝「プロジェクト内」と判定される**。全面解除の実体は、偽 cwd が `resolveWorkflowDir` の基準ごとすり替わり、`wfPaths.research` が不在になって `isWorkflowActive` が偽になることである（副次的に、リポジトリ内の**絶対パス**ターゲットは「プロジェクト外」と判定されて allow される）。K11 が塞いだものより強い kill-switch が同じ surface に残っている、という結論自体は正しい。

未着手である理由: `NODE_TEST_CONTEXT` による gating を共有ヘルパにすると、新しい実装が古い lib を経由してしまう窓が開く。後続では「lib 追加のみの段」を先に置く two-phase か、各 hook への複製かを先に決める必要がある。

## 課題 F: 死んだコードの削除

対象は派生 8 関数（`getPlanPath` 等）、`getWorkflowDir` / `getWorkflowDirRelative` のシム 2 本、`knip.json` の `-public` tag。強制力が無い理由は次の 3 点である。

1. `knip` は CI に配線されていない。`grep -rn "knip" .github/` はヒット 0。
2. `home/dot_claude/hooks/tests/unit/workflow-paths.test.ts:6-23` が一族全体を import しているため、テストが死んだコードを緑で保護している。実測: `bunx knip --no-progress` の出力は `Unused exported types (1) WorkflowDirUnresolvableReason` のみで、シム 2 本も派生関数も報告されない。
3. `home/.chezmoiscripts/run_after_gc.sh.tmpl:64-75` が最大週 1 回 `bunx knip` をローカル実行するが、この経路は常に「clean」と報告する。`run_after_gc.sh.tmpl:69` の `if ! bunx knip --no-progress 2>&1 | tail -20; then` の終了コードはパイプ末尾の `tail` のものであり、knip の検出結果に関わらず 0 になる。したがって「報告はされるがゲートではない」ではなく、この経路では報告すら成功扱いに潰れている。

加えて、`document-workflow-guard.ts` の未使用 import `isWorkflowDocument` の除去は spec.md の K8 項目 6 に含まれていたが、plan-2 の `25a3aac` で既に解消済みである（実測: 同ファイルに `isWorkflowDocument` は 1 件も残っていない）。本課題からは除外する。

## 課題 G: GC が guard を無言で disarm する経路

- GC（`home/.chezmoiscripts/run_after_gc.sh.tmpl:28-32`）は `find "$SESSIONS_DIR" -mindepth 1 -maxdepth 1 -type d -mtime +7 -exec rm -rf {} +` で**セッション dir 自身の mtime のみ**を見る。dir mtime はエントリの追加・削除でしか更新されないため、7 日以上休止した進行中 workflow を「中身のファイルを編集しながら再開する」形では触っても、削除対象のまま残る。
- 寿命は「7 日ちょうど」ではなく **7 日以上・上限なし**である。`run_after_gc.sh.tmpl:11-23` に `INTERVAL_DAYS=7` + `$HOME/.claude/.last-gc` の頻度ゲートがあり、さらに `run_after_` なので `chezmoi apply` を実行しなければ発火しない。
- 本変更後、これは「guard の無言 disarm」になる。`isWorkflowActive` はファイル存在判定のみで、env を on/off スイッチから外した以上、ファイル存在が唯一の arming スイッチである。GC の `rm -rf` は、最安の自己解除である `rm <wfDir>/research.md` と同じ効果を、誰の操作もなく自動で起こす。承認状態・`off-plan-writes.log`・`plan-review.cache.json` も同時に消える。
- 隣接する 2 件も同じ課題に含める。1 つは `session.ts` の `CLAUDE_ENV_FILE` への未エスケープ書き込み（既知。詳細は `docs/plans/hook-target-diagnostics-followups.md` を参照し、ここでは記述を複製しない）。もう 1 つは `isOutsideProject` への `~/.claude/hooks/` denylist 案（実装コストは小さいが `isOutsideProject` の他の利用者への影響評価が別途要る）。

## 課題 H: 「guard の実行状態を可視化する」後続 spec

他の 8 件と違い、これはまだ設計されていない。本 spec から切り出した 3 つの責務（長期間走っていないことの検出 / `env-rejected`・`unresolvable` の再通知 / armed・deactivated の状態遷移告知）をまとめて扱う。

ADR-0013 側には判断と 1-2 行の要約しか置かないため、**証拠一式はここが唯一の所在になる**。

### 1. 否定済みの設計空間

追記型 sink の候補 4 案は実測で否定されている。否定の理由は 2 つ。

- `finally` で書く上書き型スタンプは、例外を連発している最中も「健全」と報告する（実行された事実と結果が分離できていない）
- machine-global な単一レコードは、別プロジェクトの活動を自プロジェクトの活動と誤読する

### 2. 設計の起点

「実行の証拠を **per-project** に、**結果次元付き**で、**atomic** に残す」。再利用候補は `home/dot_claude/hooks/lib/insight-digest.ts:309` の `writeFileSyncAtomic` と、同ファイル `:320` の `ensureDir`。もう 1 つは `session.ts:139-141` の projectHash 導出（`context.input.cwd` の `/` を `-` に置換して先頭の `-` を落とす形）である。`insight-digest.ts` の所在は `implementations/` ではなく `lib/` 配下であり、projectHash の行は guard 判定の docstring とは無関係なので、それぞれの所在を混同しない。

### 3. `unresolvable` と `env-rejected` の可視性は非対称で、無言なのは後者である

- `unresolvable`: `document-workflow-guard.ts:76-84` が**毎ツール呼び出しで** systemMessage を返す。加えて `session.ts:203-209` が起動時にも出す。
- `env-rejected`: `grep -rn "env-rejected" home/dot_claude/hooks/implementations/*.ts` は `session.ts:224` の 1 箇所のみ。すなわち **SessionStart の 1 回きり**で、セッション途中に読み手が見落とすと再通知が無い。
- したがって後続 spec が扱うべき再通知の主対象は `env-rejected` である。`unresolvable` については逆に「毎回出続けること」が正常時に鳴る警告として読み手に無視を訓練しないかを検討対象にする。両者は別方向の課題であり、ひとまとめに「再通知が要る」とは書かない。

### 4. 未解決の設計課題

状態遷移の告知（armed / deactivated）は、Round 1 のレビューで一度「要修正」と判定され実装予定だったものを、後続ラウンドの縮小で意図的に外した後退である。未解決のまま残っているのは次の 2 点。

- 判定媒体を wfDir 内に置くと GC / `git clean` で dir ごと消えて状態が読めなくなる（課題 G と同根）
- `cp -a` によるセッション引き継ぎで、前セッションの行が混入する

## 課題 I: `plan-review.cache.json` が git 追跡下のディレクトリに落ちる

`plan-review-automation.ts:291-294` は `const planDir = dirname(absoluteTargetPath);` でキャッシュ位置を決め、containment 検査を行わない。対象判定は `getWorkflowDocumentType`（`home/dot_claude/hooks/lib/workflow-paths.ts:108-121`）で **basename のみ**を見る。

- 実測: 本リポジトリには追跡下の `plan.md`（リポジトリルート）と `home/dot_claude/templates/spec.md` が実在する。どちらかを Write/Edit すると `plan-review.cache.json` が追跡下ディレクトリに作られ、`git check-ignore` にも掛からないため `git status` に現れて誤コミットされうる。
- `rules/workflow.md` の Session Artifact Retention は「実装計画（未着手・途中）は `docs/plans/` に移動」と指示しているため、`plan-N.md` の名前のまま移送すると同じ事故が起きる（かつ guard は wfDir スコープなのでそのファイルを workflow 文書として認識しない）。

未着手である理由: 本 plan のレビューで新規に発見したため、原因の切り分けと対処方針の検討がまだ済んでいない。
