# Research: Document Workflow の同一性（セッション・版・場所）

対象 Issue: #197（別セッションの plan を書き換える）、#221（承認が改訂版に引き継がれる）、#209（worktree / `cd` でパス前提が食い違う）、#216（worktree 内で `git-worktree-create` が失敗）

作業場所: worktree `.git/worktree/fix/workflow-identity`（ブランチ `fix/workflow-identity`、`fbfe556` 起点）

H = `home/dot_claude/hooks`。行番号は `fbfe556` 時点。「推定」と書いたものはコードからの読みで未実行。

## 0. 共通の構造

承認状態は「3 つの status 行 + 最新の auto-review marker（verdict, hash）」だけで表されている。次の 3 つの同一性がどこにも記録されていない。

| 同一性     | 本来知りたいこと               | 現状の代用                                                   | 破れた Issue |
| ---------- | ------------------------------ | ------------------------------------------------------------ | ------------ |
| セッション | どの会話の workflow か         | Bash の env（`CLAUDE_SESSION_ID` / `DOCUMENT_WORKFLOW_DIR`） | #197         |
| 版         | 人間がどの版を承認したか       | なし（承認行は hash 計算から除外）                           | #221         |
| 場所       | どのディレクトリを基準にするか | 各部品の `process.cwd()`                                     | #209, #216   |

## 1. セッションの同一性（#197）

### 事実

- CLI（H/cli/workflow.ts:740-760）の wfDir 決定は env のみ。優先順は `DOCUMENT_WORKFLOW_DIR`（`.tmp/sessions` 配下なら採用）→ `CLAUDE_SESSION_ID` 先頭 8 桁 → `<cwd>/.tmp/sessions` そのもの。基準は `process.cwd()`。`resolveWorkflowDir` は使っていない
- `--wf-dir` は全サブコマンドで使え、`.tmp/sessions` の厳密な子孫でなければ拒否（cli/workflow.ts:164-192）
- 不一致警告（:182-190）は `CLAUDE_SESSION_ID` 由来の dir と wfDir の比較。両 env が同じ古いセッションを指すと発火しない（#197 の観測と一致）
- 書き込み系の成功出力は渡した名前だけを表示し、絶対パスも wfDir の決定元も出さない（round :466-469 / stamp :694 / triage :737）
- `round` は doc 引数に素のファイル名を要求する（:356-360）。`stamp` / `triage` は要求せず、`..` や絶対パスで wfDir 外の `.md` を書き換えられる
- `status [doc]`: `diagnoseGate(wfDir, target)`（H/lib/workflow-gate.ts:138-147）は target を表示用の note にしか使わず、診断対象は常に wfDir の spec.md か plan.md。plan-N.md は診断しない。`## Files` も解析しない
- SessionStart（H/implementations/session.ts:137-182）は source を問わず `CLAUDE_ENV_FILE` に `appendFileSync` で `CLAUDE_SESSION_ID` と `DOCUMENT_WORKFLOW_DIR`（**相対パス**）を追記する
- stamp の起動証跡チェック（cli/workflow.ts:516-540）は `reviewer-runs.log` の session_id 列（parts[0]）を読まない。古い wfDir に対する stamp は、古いセッションの reviewer 実行で通る
- 「現セッション」を記録したファイルは存在しない。hook は全て hook 入力の `session_id` を使う（9 箇所）が、CLI はそれを受け取る経路がない

### 公式仕様（code.claude.com/docs/en/hooks.md, env-vars.md。要約ツール経由で取得）

- `CLAUDE_SESSION_ID` は Claude Code のネイティブ変数ではない（本リポジトリの session.ts が定義）
- `CLAUDE_ENV_FILE` の export は「後続の Bash コマンドに残る」。`/clear` で新しいファイルになるか、古い export が残るか、同名が重なったときどちらが勝つかは**未記載**
- hook 入力の `session_id` は全イベント共通のフィールド。`/clear` で変わるかは未記載（#197 の観測では変わった）
- PreToolUse の `hookSpecificOutput.updatedInput` でツール引数を書き換えられる。ただし `permissionDecision` を `allow`（権限確認を飛ばす）か `ask` と組にする必要があり、複数 hook が `updatedInput` を返したときの合成は未規定
- **`CLAUDE_CODE_SESSION_ID` は Claude Code が Bash のサブプロセスにネイティブに渡す**。CHANGELOG: "Added `CLAUDE_CODE_SESSION_ID` environment variable to the Bash tool subprocess environment, matching the `session_id` passed to hooks"。本セッションの Bash env でも `CLAUDE_CODE_SESSION_ID=7d715a2f-…` を観測（v2.1.287）。env-vars ページには未掲載
- `CLAUDE_PROJECT_DIR` は本セッションの Bash env には存在しない（観測）
- **V1 の結果（2026-10-02、ユーザーが別ターミナルで実施）**: `/clear` の前 `CLAUDE_CODE_SESSION_ID=CLAUDE_SESSION_ID=3cfa34d0-…`、後 `=2bb6382e-…`。`CLAUDE_CODE_SESSION_ID` は `/clear` に追従する。spec K3 の前提は成立
  - `/resume` の後は ID が維持された（ユーザー報告）。resume は同じセッションの継続なので hook の `session_id` とも一致する（CHANGELOG: MCP も `--resume` で hook/Bash と同じ ID を受け取る）
  - 同時に、`CLAUDE_ENV_FILE` 由来の `CLAUDE_SESSION_ID` もこの試行では追従した。したがって #197 で古い値が残った経路は「`/clear` で env ファイルが読み直されない」ではない。経路は未特定のまま（#197 コメント 3 で古い値だったことは事実）。K4（利用者側の export をやめ、Claude Code が維持する値だけを使う）は、経路が特定できない以上、利用者側の配送を同一性に使わないという判断として維持する
- `/fork` で分岐したセッション（4177efb8）の Bash env では、`CLAUDE_CODE_SESSION_ID` / `CLAUDE_SESSION_ID` / `DOCUMENT_WORKFLOW_DIR` がいずれも fork 先の ID を指していた（観測、2026-10-02）。fork は新しい Claude Code プロセスなので `/clear` と同じ条件ではない。`/clear` 後の値は未観測
- UserPromptSubmit の入力は `prompt`（ユーザーが打ったテキスト）。`!` の bash モードが hook を通るかは未記載

### 原因の整理

hook（正しい session_id を持つ）と CLI（env しか見られない）で情報源が分かれており、env は `/clear` を越えて正しさが保証されない。CLI 内でどう突き合わせても env 同士の比較なので検出できない。

## 2. 版の同一性（#221）

### 事実

- gate 条件（H/implementations/document-workflow-guard.ts:373-396 `hasApprovedPlan`, :423-499 `checkTarget`、H/lib/workflow-gate.ts:69-141 `diagnoseDocument`）: 3 status 行の厳密一致 + 最新 marker の verdict=pass + marker hash == 現 doc hash。二層は加えて plan-N の `parent-spec-hash` == 現 spec hash
- **同じ判定が guard と workflow-gate.ts に重複実装**されている（guard の `hasApprovedPlan` / `isContentApproved` と、`diagnoseDocument` / `hasApprovedDocument`）
- 文書 hash（H/lib/document-hash.ts:63-72）の正規化: auto-review / intent-triage marker 除去、`## Reviewer Outputs (Round N)` 節除去、**`Approval Status:` の値を空に**、`[x]`→`[ ]`、trimEnd。`Review Status` / `Plan Status` の値は含む
- design-hash（:101-117）は `## Files` / `## Key Decisions` / `## Scope` / `## Tasks` のみ。carry-forward 判定に使う
- marker 形式: `<!-- auto-review: verdict=…; hash=…; design-hash=…; round=N[; parent-spec-hash=…]; at=…; reviewers=… -->`（cli/workflow.ts:556-575 が生成、H/lib/workflow-marker.ts:47-89 が最後の 1 つを解析）
- 承認行の保護は `workflow-cli` の `wouldTouchApprovalStatus`（cli/workflow.ts:206-211）だけ。model が Edit/Write で承認行を変えることを止める hook はない（規約の文章のみ: rules/workflow.md CRITICAL 節）
- 人間が承認行を変えたことを観測する hook はない。「承認した hash」の概念はコードに存在しない
- 現行の運用では、ユーザーが会話で「承認」と言ったとき model が承認行を書き換える経路が規約上正当（rules/workflow.md: 「明示的に approve/承認 と発言するか /execute-plan を指示しない限り」）

### 原因の整理

承認行は hash 計算から除外されている（承認を書いた瞬間に marker の hash 一致が崩れないようにするため）。その結果、どの版に対する承認かが文書のどこにも残らない。改訂 → round → stamp pass で marker が新しい hash を持てば gate は開く。

## 3. 場所の同一性（#209, #216）

### 事実

- `resolveWorkflowDir`（H/lib/workflow-resolve.ts:84-143）は渡された cwd をプロジェクト root とみなす。呼び出し 9 hook のうち 8 つが `CLAUDE_TEST_CWD || process.cwd()`、compaction-testament だけ `CLAUDE_PROJECT_DIR`（commit 28175f4。同 commit は他 hook への展開を「別 workflow」と明記）
- guard の `## Files` 解決（document-workflow-guard.ts:528-531, 446）は `process.cwd()` 基準の `resolve`
- `isStrictlyUnderProjectSubdir`（H/lib/workflow-fs.ts:68-87）は realpath ベースの包含検査。`.tmp/sessions` 自体が symlink だと false（#209 の symlink 共有が弾かれる理由）
- session.ts は `DOCUMENT_WORKFLOW_DIR` を相対パスで export する。受け手は自分の cwd につなげて解釈する
- workflow まわりで git の common dir を使う箇所はない（quality-loop の bin 探索だけが使う）
- file-access-guard の repo root は `git rev-parse --show-toplevel`（プロセスの cwd で実行）
- #216: `executable_git-worktree-create:62-63` が `--show-toplevel` + `/.git/worktree`。`executable_git-worktree-cleanup` は `git worktree list` の先頭を基準にするため同じ不具合はない
- 新規 worktree には `node_modules` がなく、`bun install` するまで typecheck / test が失敗する（本セッションで観測）

### 公式仕様

- hook 入力の `cwd` は `cd` と worktree 移動に追従する（明記）
- `CLAUDE_PROJECT_DIR` は hook プロセスに渡され、worktree に入っても「session 開始時の root に留まる」（明記）。Bash ツールの env に入るかは未記載

### 観測（本セッション）

- hook **プロセス**の `process.cwd()` も Bash の `cd` に追従する。根拠: Bash で worktree に `cd` した後の Stop hook（completion-gate、`process.cwd()` で typecheck/test を実行）が `cc-hooks-ts` 等を解決できずに失敗した。`cc-hooks-ts` を持つ `home/dot_claude/node_modules` は本体 checkout には存在し、worktree には `bun install` 前は存在しなかった。続いて workflow-bash-sync が worktree 側の wfDir に対して tripwire を新規に張った
- したがって現行の 8 hook と CLI は `cd` の後に別の wfDir を見る（#209 コメントの推測が `process.cwd()` 経由でも成り立つ）

## 4. 既存テスト

- H/tests/unit/workflow-cli.test.ts: `runWorkflowCli` を直接呼ぶ。`sessionId: "test-ses"`（無効な ID）固定で不一致警告の経路は未テスト。`import.meta.main` の wfDir 決定はテスト不能な形。`status` は出力の形だけ確認
- workflow-resolve.test.ts: env pin の受理・拒否、tilde、traversal、alias。CLI は対象外
- document-workflow-guard.test.ts / workflow-gate.test.ts / document-hash.test.ts / workflow-marker.test.ts: gate 条件、hash 正規化、marker 解析
- 実行: `bun run test`（node --test）、`bun run typecheck`

## 5. ユーザー判断（2026-10-02）

- 承認の経路: **会話で承認**。UserPromptSubmit hook が厳密な形の発話を検出し、その時点の hash を記録する
- 場所の基準: **session 開始時の root に固定**。`## Files` は対象ファイルが属する worktree からの repo 相対パスで照合する

## 6. 設計で決めること（spec で扱う）

1. **CLI に正しいセッションを渡す経路**
   - 候補 A: PreToolUse(Bash) hook が `workflow-cli` の呼び出しを検出し、`updatedInput` で hook の `session_id` を注入する（例: `--session <id>` を付与）。CLI は注入値を env より優先し、env と食い違えば書き込みを拒否
   - 候補 B: CLI が env を使わず、書き込み系に `--wf-dir` を必須化。hook（guard）が `--wf-dir` の値を hook の session_id 由来の dir と照合して deny
   - 候補 C: SessionStart がセッション → dir の記録を残す。並行セッションでは「現在」を 1 つに決められないため単独では不成立
2. **承認の記録者と記録先**
   - 候補 A: 人間だけが打てる経路（UserPromptSubmit でユーザー発話の承認を検出、または `!` 経由の専用コマンド）で承認時の hash を wfDir に記録。gate は記録 hash == 現 hash を要求
   - 候補 B: 承認行に hash を併記（`Approval Status: approved (hash=…)`）。承認行は hash 計算外なので文書 hash を乱さない。ただし誰が hash を書くかが残る
   - どちらでも、model の Edit/Write による承認行の変更を guard で止めるかを決める
   - 未確認: UserPromptSubmit が slash command をどの形で受け取るか、`!` 実行が PreToolUse を通るか
3. **場所の基準**: 「同じ workflow」を何で定義するか（セッション開始 root = `CLAUDE_PROJECT_DIR` か、git common dir の親か）。`## Files` は基準 root からの相対ではなく、対象ファイルの worktree toplevel からの repo 相対パスで照合する案がある
4. **判定ロジックの一本化**: guard と workflow-gate.ts の重複を 1 つにし、`status` が guard と同じ判定（plan-N と `## Files` を含む）を返すようにする
5. **#216 の範囲**: `--git-common-dir` 基準への修正に、新規 worktree での依存 install を含めるか
