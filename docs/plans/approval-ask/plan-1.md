<!-- spec-ref: spec.md -->

# Plan: AskUserQuestion による承認の経路（コード）(Execution layer)

spec.md の K1〜K9・K12 のうちコードに当たる部分を実装する。文書（workflow.md・reference skill・ADR）と配備後の確認は plan-2 で行う。

テストの実行（単一ファイル）: `node --import ./home/dot_claude/hooks/tests/preload-test-env.mjs --test <file>`。全体: `bun run test`、型: `bun run typecheck`、lint: `bun run lint`。fixture はすべて既存の `home/dot_claude/hooks/tests/unit/test-helpers.ts` から import する（`createPostToolUseContext`、`createPreToolUseContextFor`、`createUserPromptSubmitContext`、`invokeRun`、`EnvironmentHelper`、`TEST_SESSION_ID`、`buildPlanContent`、`buildPlanNContent`、`createWorkflowRepo`、`pendingWorkflowRepo`、`TEST_WORKFLOW_DIR`、`seedWorkflow`）。新しい fixture は作らない。

## Files

```
# 新規作成
home/dot_claude/hooks/lib/workflow-approval-record.ts
home/dot_claude/hooks/implementations/approval-answer-recorder.ts
home/dot_claude/hooks/tests/unit/workflow-approval-record.test.ts
home/dot_claude/hooks/tests/unit/approval-answer-recorder.test.ts

# 編集
home/dot_claude/hooks/lib/workflow-approval.ts
home/dot_claude/hooks/lib/guarded-tools.ts
home/dot_claude/hooks/lib/workflow-gate.ts
home/dot_claude/hooks/implementations/approval-recorder.ts
home/dot_claude/hooks/implementations/document-workflow-guard.ts
home/dot_claude/hooks/implementations/session.ts
home/dot_claude/hooks/cli/workflow.ts
home/dot_claude/.settings.hooks.json.tmpl

# テスト
home/dot_claude/hooks/tests/unit/workflow-approval.test.ts
home/dot_claude/hooks/tests/unit/approval-recorder.test.ts
home/dot_claude/hooks/tests/unit/document-workflow-guard.test.ts
home/dot_claude/hooks/tests/unit/guarded-tools.test.ts
home/dot_claude/hooks/tests/unit/session.test.ts
home/dot_claude/hooks/tests/unit/workflow-cli.test.ts
```

## Tasks

### T1: 葉のモジュールに定数・組み立て・判定・照合を足す（spec K3・K4・K7）

**Files:**

- 編集: `home/dot_claude/hooks/lib/workflow-approval.ts`
- テスト: `home/dot_claude/hooks/tests/unit/workflow-approval.test.ts`
- 参照: `home/dot_claude/hooks/lib/workflow-approval.ts:31-60`（既存の `UTTERANCE` / `parseApprovalUtterance` / `isApprovalShapedPrompt` の並び）
- 参照: `home/dot_claude/node_modules/@anthropic-ai/claude-agent-sdk/sdk-tools.d.ts:3749-3935`（`AskUserQuestionOutput`）

この module は node 組込みだけに依存する葉のまま保つ（gate を import しない）。

- [ ] **Step 1: 失敗するテストを書く**（`workflow-approval.test.ts` に `describe("approval question (spec K3/K4/K7)")` を足す）

  定数（export）: `APPROVAL_QUESTION_TEXT = "Document Workflow の承認: 承認する文書にチェックを付けてください（議論したいときは Esc）"`、`APPROVAL_QUESTION_PREFIX = "Document Workflow の承認"`、`APPROVAL_HEADER = "承認"`、`DECLINE_LABEL = "承認しない"`、`DECLINE_DESCRIPTION = "今は承認しない（何を直すか伝える）"`、`HASH_PREFIX = "hash="`、`HASH_PREFIX_LENGTH = 12`、`MAX_DOCS_PER_QUESTION = 3`、`WORKFLOW_DOC_NAME = /^(spec|plan|plan-[1-9][0-9]*)\.md$/`。

  テストケース（入力 → 期待）:
  - `buildApprovalQuestions([{name:"spec.md",hash:H1}])` → `[{question: APPROVAL_QUESTION_TEXT, header: "承認", multiSelect: true, options: [{label:"spec.md", description:"hash="+H1.slice(0,12)}, {label:"承認しない", description: DECLINE_DESCRIPTION}]}]`（`H1 = "a".repeat(64)`、既存の定数）。
  - 3 件 `[plan-2.md, spec.md, plan-1.md]` → options の順が入力のまま `plan-2.md, spec.md, plan-1.md, 承認しない`（並べ替えない）。
  - 0 件、4 件、重複 `[spec.md, spec.md]`、文書名が `../x.md` / `plan-0.md` / `plan-01.md` / `spec.md\n` / `SPEC.md` / `spec.md/` / `spe\0c.md` / `承認しない` → いずれも throw。
  - `isApprovalLikeQuestion(buildApprovalQuestions(x))` が、上の正常系 2 つで true（包含の不変条件）。
  - `isApprovalLikeQuestion` が true: `[{question:"Document Workflow の承認（改変）", ...}]`、選択肢に `承認しない` を含む任意の質問、`[{question:"spec.md を承認しますか", options:[{label:"spec.md"},{label:"いいえ"}]}]`、2 問目にだけ承認らしい質問がある配列。
  - `isApprovalLikeQuestion` が false: `[{question:"この方針で進めてよいか", options:[{label:"はい"},{label:"いいえ"}]}]`、`[{question:"承認フローを変えますか", options:[{label:"はい"},{label:"いいえ"}]}]`（`承認` を含むが文書名の label が無い）。
  - `isApprovalLikeQuestion` が throw せず false: `undefined`、`null`、`"x"`、`[null]`、`[{options: null}]`、`[{question: 1, options: [1]}]`、getter が throw する object（`Object.defineProperty({}, "question", { get() { throw new Error("x"); } })` を要素に持つ配列）。
  - `matchApprovalAnswer(expected, answerValue)`（`expected` は `buildApprovalQuestions` の戻り値、`answerValue` は `answers` の値の文字列）:
    - `"spec.md, plan-1.md"` → `{kind:"approve", docs:["spec.md","plan-1.md"]}`
    - `"spec.md, spec.md"` → `{kind:"approve", docs:["spec.md"]}`
    - `"承認しない"` → `{kind:"decline"}`
    - `"spec.md, 承認しない"` → `{kind:"invalid", reason:"decline-mixed"}`
    - `""` → `{kind:"freeText", text:""}`
    - `"直してほしい"`（Other の自由入力）→ `{kind:"freeText", text:"直してほしい"}`
    - `"spec.md, plan-9.md"`（片方が label に無い）→ `{kind:"freeText", text:"spec.md, plan-9.md"}`
  - `deepEqualIgnoringKeyOrder`（export）: キー順だけ違う object 同士は true、配列の順が違うと false、片方に余分なキーがあると false、`{a: undefined}` と `{}` は false、`[]` と `{}` は false、`1` と `"1"` は false、`{a: null}` と `{}` は false。

- [ ] **Step 2: 実行して失敗を確認** — 実行: `node --import ./home/dot_claude/hooks/tests/preload-test-env.mjs --test home/dot_claude/hooks/tests/unit/workflow-approval.test.ts`。期待: FAIL（`buildApprovalQuestions` などが export されていない）。

- [ ] **Step 3: 最小実装** — シグネチャ:

  ```ts
  export interface ApprovalDoc {
    name: string;
    hash: string;
  }
  export interface ApprovalOption {
    label: string;
    description: string;
  }
  export interface ApprovalQuestion {
    question: string;
    header: string;
    multiSelect: true;
    options: ApprovalOption[];
  }
  export function buildApprovalQuestions(
    docs: readonly ApprovalDoc[],
  ): ApprovalQuestion[];
  export function isApprovalLikeQuestion(questions: unknown): boolean; // never throws
  export type ApprovalAnswer =
    | { kind: "approve"; docs: string[] }
    | { kind: "decline" }
    | { kind: "freeText"; text: string }
    | { kind: "invalid"; reason: "decline-mixed" };
  export function matchApprovalAnswer(
    expected: readonly ApprovalQuestion[],
    answerValue: string,
  ): ApprovalAnswer;
  export function deepEqualIgnoringKeyOrder(a: unknown, b: unknown): boolean;
  ```

  `isApprovalLikeQuestion` は全体を `try { ... } catch { return false; }` で包み、配列でなければ false、各要素について (a) `question` が文字列で `APPROVAL_QUESTION_PREFIX` で始まる、(b) `options` が配列で `label === DECLINE_LABEL` の要素がある、(c) `question` が `承認` を含み `options` のどれかの `label` が `WORKFLOW_DOC_NAME` に一致する、のどれかで true。`matchApprovalAnswer` は `answerValue.split(", ")` の各要素を `expected[0].options` の label 集合と照らし、全要素が文書名の label なら重複を除いて approve、`[DECLINE_LABEL]` だけなら decline、DECLINE_LABEL と文書名が混在すれば invalid、それ以外は freeText。

- [ ] **Step 4: 実行して通過を確認** — 同じコマンドで PASS。

- [ ] **Step 5: コミット** — `git add home/dot_claude/hooks/lib/workflow-approval.ts home/dot_claude/hooks/tests/unit/workflow-approval.test.ts` → `git commit -m "feat(hooks): add approval question builder and matcher"`。

### T2: ledger の行に `via` を足す（spec K5）

**Files:**

- 編集: `home/dot_claude/hooks/lib/workflow-approval.ts`（`ApprovalRecord`、`appendApproval`、`parseRecord`）
- テスト: `home/dot_claude/hooks/tests/unit/workflow-approval.test.ts`
- 参照: `home/dot_claude/hooks/lib/workflow-approval.ts:62-150`（`ApprovalRecord` / `appendApproval` / `readLatestApprovals` / `parseRecord`）

- [ ] **Step 1: 失敗するテストを書く**（`appendApproval` は `{v:1, ...record}` を書くので 1 つ目は変更前から実行時には通り、型でだけ落ちる。変更前に落ちるのは 2 つ目）
  - `appendApproval(wf, {doc:"plan.md", hash:H1, session:"s", at:"t", via:"ask"})` の後、log の 1 行を `JSON.parse` すると `{v:1, doc:"plan.md", hash:H1, session:"s", at:"t", via:"ask"}`。
  - `readLatestApprovals` が `via:"utterance"` / `via:"ask"` の行をその値で返し、`via` の無い既存形式の行は `via: undefined`、`via:"other"` の行は `via: undefined` で返す（行は無視しない。`ignoredLines` は増えない）。
- [ ] **Step 2: 失敗を確認**（T1 と同じコマンド）。
- [ ] **Step 3: 実装** — `export type ApprovalVia = "utterance" | "ask";`。`ApprovalRecord` に `via?: ApprovalVia` を足す。`appendApproval` は record をそのまま `{v:1, ...record}` で書く（既存）。`parseRecord` は `via` が `"utterance"` か `"ask"` のときだけ取り込み、それ以外は付けない。`v` は 1 のまま。
- [ ] **Step 4: 通過を確認**。
- [ ] **Step 5: コミット** — `feat(hooks): record the approval route in the ledger`。

### T3: 記録の手順を lib に移し、AskUserQuestion の応答の照合と記録を足す（spec K3・K5・K8）

**Files:**

- 新規: `home/dot_claude/hooks/lib/workflow-approval-record.ts`
- 編集: `home/dot_claude/hooks/implementations/approval-recorder.ts`（関数 `setApprovalLineApproved` と `recordOne` を削除して lib から import。`recordOne` の返答の文（「もう一度『承認 X』と書く」を含む 3 か所）は lib の `describeRecordResult` に置き換わる）
- テスト: `home/dot_claude/hooks/tests/unit/workflow-approval-record.test.ts`、`home/dot_claude/hooks/tests/unit/approval-recorder.test.ts`
- 参照: `approval-recorder.ts` の `setApprovalLineApproved` / `recordOne`（移す 2 関数）と、`planned` の組み立て（hash の読み方）
- 参照: `home/dot_claude/hooks/lib/workflow-gate.ts` の `evaluateApprovalReadiness` / `listApprovalCandidates`

repo の作り方（このタスクと T5 で共通）: `approval-recorder.test.ts` の `beforeEach` と同じ。`realpathSync(mkdtempSync(...))`、`wf = join(repo, deriveDefaultWorkflowDir(TEST_SESSION_ID))`、`EnvironmentHelper` で `CLAUDE_TEST_CWD=repo`、`DOCUMENT_WORKFLOW_DIR` を unset。文書は `buildPlanContent` / `buildPlanNContent` で、Review が pass・Approval が pending の状態で書く。

- [ ] **Step 1: 移設（挙動も文も変えない）** — `setApprovalLineApproved` と `recordOne` を lib に移し、`recordOne` の返り値を `RecordResult` に変える。`approval-recorder.ts` は今の文（「もう一度『承認 X』と書く」を含む）をそのまま組み立てる局所関数で `RecordResult` を文にする。`approval-recorder.test.ts` は変えない。`bun run test` が通ることを確かめてコミット `refactor(hooks): move approval recording into a shared lib`。
- [ ] **Step 2: 失敗するテストを書く**（`workflow-approval-record.test.ts`）
  - `recordOne`:
    - 通常 → `{doc, state:"recorded", hash}`、log の行に渡した `via`、承認行が approved。
    - 文書を symlink にする → `state:"loggedOnly"`。
    - `approvals.log` の位置にディレクトリを作っておく（追記が失敗する）→ `state:"failed"`、例外を投げない。
  - `verifyAndRecordApprovalAnswer(wf, toolResponse, session)`。基本形は `{questions: buildApprovalQuestions(docs), answers: {[APPROVAL_QUESTION_TEXT]: "<選択>"}}`、docs は spec.md と plan-1.md（どちらも承認待ち）:
    - `"spec.md, plan-1.md"` → `{kind:"recorded", results:[{doc:"spec.md",state:"recorded"},{doc:"plan-1.md",state:"recorded"}]}`。log の 2 行とも `via:"ask"`、hash は照合に使った値と等しい。
    - plan-1.md を symlink にして同じ回答 → `results` が `[recorded, loggedOnly]`（例外を投げない）。
    - `afkTimeoutMs: 1000` を足す → `{kind:"afk"}`。
    - `response: "やっぱり待って"` を足す → `{kind:"freeText", text:"やっぱり待って"}`。
    - 表駆動で `{kind:"malformed"}` になり log が増えないもの: キー `extra: 1` を足す / `answers` が無い / `answers: null` / `answers: {}` / `answers: {other: "spec.md"}` / `answers` に質問文のキーと別のキーの 2 つ / `answers` の値が数値 / `questions` が長さ 2 / `question` の文を変える / `header` を `"確認"` / `multiSelect: false` / 選択肢に `preview: "x"` を足す / `承認しない` を先頭に動かす / description の hash を 1 桁変える / description に ` ※差し戻し` を足す / `承認しない` の description を変える / `承認しない` の選択肢を消す / `承認しない` を 2 つ / label が `"../x.md"`・`"plan-01.md"`・`"SPEC.md"`・`"spec.md\n"` / 回答 `"spec.md, 承認しない"`。
    - label が `"../<wfDir の basename>/spec.md"`（実在の承認待ちの spec.md に解決される名前）で回答もそれ → `{kind:"malformed"}`、log が増えない（文書名の検証が gate より前にあることを示す。検証が無ければ記録されてしまう入力）。
    - label が `"plan-2.md"` で plan-2.md の Review が needs-work → `{kind:"notCandidate", docs:["plan-2.md"]}`。
    - キー順だけ違う questions → recorded。
    - 文書の順を入れ替えた questions（`buildApprovalQuestions([plan-1.md, spec.md])` の出力）→ recorded（作り直しは応答に載った順で行うので一致する。文書の順は model が選べる、という spec K11 の記述どおり）。
    - `"承認しない"` → `{kind:"decline"}`。
    - `annotations: {[APPROVAL_QUESTION_TEXT]: {notes: "ここ直して"}}` → `{kind:"notes", notes:"ここ直して"}`。
    - 承認らしくない質問（`[{question:"進めてよいか", ...}]`）→ `{kind:"notApproval"}`。
    - decline・notes・freeText・afk・notCandidate・notApproval のどれでも log が増えない。
  - 同じ文書を同じ hash で 2 回 `recordOne` する → 2 回とも例外なく返り、`readLatestApprovals(wf).latest.get(doc).hash` はその hash（ledger に同じ行が 2 つあっても結果が変わらない）。
  - `describeRecordResult`: `recorded` →「`<doc>` を hash=<12 桁> で承認として記録した」、`loggedOnly` →「`<doc>` は log には記録したが承認行の書き換えに失敗した。`workflow-cli status` で確認する」、`failed` →「`<doc>` は記録できなかった（何も書いていない）。`workflow-cli status` で確認する」。復旧の一句（どの経路でやり直すか）は含めない。
  - `approval-recorder.test.ts`: 発話の経路で記録した行が `via:"utterance"` になる。既存の期待のうち「もう一度」を含むもの（`recordOne` の返答）を `describeRecordResult` の文に変える（spec K5・K12）。
- [ ] **Step 3: 失敗を確認**（両ファイル）。
- [ ] **Step 4: 実装**

  ```ts
  export type RecordState = "recorded" | "loggedOnly" | "failed";
  export interface RecordResult {
    doc: string;
    state: RecordState;
    hash: string;
    detail?: string;
  }
  export function recordOne(
    wfDir: string,
    doc: string,
    hash: string,
    session: string,
    at: string,
    via: ApprovalVia,
  ): RecordResult; // never throws
  export function describeRecordResult(result: RecordResult): string;
  export type AnswerVerification =
    | { kind: "notApproval" }
    | { kind: "afk" }
    | { kind: "freeText"; text: string }
    | { kind: "malformed" }
    | { kind: "notCandidate"; docs: string[] }
    | { kind: "decline" }
    | { kind: "notes"; notes: string }
    | { kind: "recorded"; results: RecordResult[] };
  export function verifyAndRecordApprovalAnswer(
    wfDir: string,
    toolResponse: unknown,
    session: string,
    now?: Date,
  ): AnswerVerification;
  ```

  - `recordOne` は全体を try/catch で包み、ledger の追記の前に失敗すれば `failed`、追記の後に失敗すれば `loggedOnly` を返す（今の実装の `logged` の旗と同じ区別）。書き換えの後の確認で、log はあるが承認行が approved でなければ `loggedOnly`、log も無ければ `failed`。
  - `verifyAndRecordApprovalAnswer` の判定順は spec K3「判定の順」の (1)・(3)〜(9)（(0) `tool_name` と (2) `agent_id` は hook 側）: `isApprovalLikeQuestion(r?.questions)` が偽 → notApproval / `afkTimeoutMs` キーがある → afk / `response` キーがある → freeText（`response` が文字列でなければ malformed）/ 型の検査: `r` が object、キーが `questions`・`answers`・`annotations` だけ、`questions` が長さ 1 の配列、`answers` が object で、キーがちょうど 1 つで `questions[0].question` と等しく、値が文字列 → どれかを外れれば malformed / 文書名の検査: `questions[0].options` が配列で、各要素の `label` が文字列、`承認しない` がちょうど 1 つ、残りが `WORKFLOW_DOC_NAME` に一致・重複なし・1〜3 件 → 外れれば malformed / 候補の検査: `listApprovalCandidates(wfDir)` に無い名前があれば notCandidate / 作り直し: 各文書の `evaluateApprovalReadiness(wfDir, name).hash` で `buildApprovalQuestions` を呼び、`deepEqualIgnoringKeyOrder(結果, r.questions)` が偽なら malformed / `annotations` のどれかに文字列の `notes` があれば notes / `matchApprovalAnswer(作り直した questions, 回答)`: decline → decline、freeText → freeText、invalid → malformed / approve なら、作り直しで読んだ hash をそのまま渡して文書ごとに `recordOne(..., "ask")`。記録のループは例外を投げない（`recordOne` が投げないため）。
  - `deepEqualIgnoringKeyOrder` と `buildApprovalQuestions` は T1 の葉の関数を使う。
  - `describeRecordResult` は状態の事実と、経路に依らない `workflow-cli status` の案内だけを返す（spec K5）。経路ごとの復旧の一句は hook が足す: 発話の recorder は足さない、AskUserQuestion の recorder は `loggedOnly` / `failed` の文の後に「`ask-approval` をもう一度呼ぶとこの文書が質問に出る」を足す（spec K3「返答の種類」）。`approval-recorder.ts` の局所の整形関数は削除し、`describeRecordResult` を使う。

- [ ] **Step 5: 通過を確認**（両ファイル）。
- [ ] **Step 6: コミット** — `feat(hooks): verify AskUserQuestion approval answers`（Step 2 のテストはこのコミットに入れる）。

### T4: 発話の recorder の 2 件以上の返答を変える（spec K6・K12）

**Files:**

- 編集: `home/dot_claude/hooks/implementations/approval-recorder.ts`（`listApprovalCandidates` の結果が 1 件でないときの分岐）
- テスト: `home/dot_claude/hooks/tests/unit/approval-recorder.test.ts`（承認待ちが 2 件で名前なしの発話を扱う既存のテスト）
- 参照: `approval-recorder.ts` の `approvalOutput`

- [ ] **Step 1: テストを変える** — 承認待ちが 2 件で素の `承認` → log 無し、`additionalContext` に `workflow-cli ask-approval` を含み、`systemMessage` に `approve plan-1.md plan-2.md`（待っている文書名を空白で並べた例）を含む。既存の「`承認 plan-1.md` / `承認 plan-2.md`」を並べる期待は削除。
- [ ] **Step 2: 失敗を確認**。
- [ ] **Step 3: 実装** — `approvalOutput` に model 向けと利用者向けで別の文を渡せる引数を足す（`approvalOutput(text, userText?)`、`userText` が無ければ両方に `text`）。2 件以上の分岐で、model 向けは「承認を待っている文書が N 件あるので記録していない。`workflow-cli ask-approval` を実行し、その出力をそのまま AskUserQuestion に渡して聞き直す」、利用者向けはそれに「質問が出ない場合は `approve <文書名…>` と打つ（例: `approve spec.md plan-1.md`）」を足す。
- [ ] **Step 4: 通過を確認**。
- [ ] **Step 5: コミット** — `feat(hooks): ask again via AskUserQuestion when a bare approve is ambiguous`。

### T5: PostToolUse の recorder を作る（spec K2・K3）

**Files:**

- 新規: `home/dot_claude/hooks/implementations/approval-answer-recorder.ts`
- テスト: `home/dot_claude/hooks/tests/unit/approval-answer-recorder.test.ts`
- 参照: `home/dot_claude/hooks/implementations/approval-recorder.ts:144-234`（hook の形、`resolveWorkflowDir` の使い方、`import.meta.main` の起動部）
- 参照: `home/dot_claude/hooks/tests/unit/test-helpers.ts:509-525`（`createPostToolUseContext`）

- [ ] **Step 1: 失敗するテストを書く**（repo の作り方は T3 と同じ。context は `createPostToolUseContext("AskUserQuestion", input, response)` に `Object.assign` で `agent_id` や `tool_name` を上書きできる形）
  - recorded → `systemMessage` に `spec.md を hash=<12 桁> で承認として記録した` と `[approval-answer-recorder]` を含む。
  - `tool_input` を読まないこと: `tool_input.answers` が `"spec.md, plan-1.md"` で `tool_response.answers` が `"承認しない"` → 記録されない（decline）。`tool_input` が `{}` で `tool_response` が正常 → 記録される。（`tool_input` に `answers` があれば記録しない、という veto の案は採らない。research の T2 で、PostToolUse の `tool_input.answers` には利用者の回答が入っていたので、veto にすると正規の承認がすべて記録されなくなる。）
  - `via` が定数であること: `tool_input` と `tool_response` に `via: "utterance"` を混ぜても（`tool_response` の未知のキーは malformed になるので、`tool_input` 側にだけ混ぜる）ledger の行は `via:"ask"`。
  - `tool_name` を `"mcp__x__AskUserQuestion"` にした context → 何も出さない（`jsonCalls` が空、log 無し）。
  - `agent_id: "sub"` + 承認の質問 → 記録しない返答、log 無し。
  - `agent_id: "sub"` + 一般の質問 → 何も出さない。
  - wfDir が解決できない session id（`session_id` を `"../bad"` に上書き）+ 承認の質問 → 「workflow dir を解決できない」の返答、log 無し。同じ session id + 一般の質問 → 何も出さない。
  - afk → 「離席」と「出し直さない」を含む、log 無し。
  - decline → 「承認しなかった」を含み、`ask-approval` を含まない、log 無し。
  - notes → notes の本文を含む、log 無し。
  - freeText → 入力された文字列を含む、log 無し。
  - malformed → 「形と違う」と `ask-approval` を含み、`systemMessage` に `approve ` を含む。
  - notCandidate → 「承認待ちでなくなった」を含む。
  - 一部だけ記録（plan-1.md を symlink にする）→ 文書ごとの状態の文（`describeRecordResult`）と、`systemMessage` に `approve plan-1.md` を含む。
  - notApproval → 何も出さない。
  - `verifyAndRecordApprovalAnswer` が throw する状況（wfDir の親を読めなくする代わりに、`tool_response` を getter が throw する object にする）→ 「記録できなかった可能性」と `workflow-cli status` を含む。
- [ ] **Step 2: 失敗を確認**。
- [ ] **Step 3: 実装** — `defineHook({ trigger: { PostToolUse: true }, run })`。spec K3「判定の順」の (0)〜(2) を hook で行う: `context.input.tool_name !== "AskUserQuestion"` なら `context.success({})` / `isApprovalLikeQuestion(tool_response?.questions)` が偽なら `context.success({})` / `agent_id` があれば記録しない返答。続いて `resolveWorkflowDir({cwd: getProjectRoot(), sessionId})` が unresolvable なら「workflow dir を解決できないので記録していない」（spec に個別の記述は無いが、記録しない側に倒れ、返答は承認らしい質問のときだけなので spec の追補は要らない）。それ以外は `verifyAndRecordApprovalAnswer` を呼ぶ。`verifyAndRecordApprovalAnswer` の結果を spec K3「返答の種類」の文に整形し、`{event:"PostToolUse", output:{systemMessage, hookSpecificOutput:{hookEventName:"PostToolUse", additionalContext}}}` で返す。全体を try/catch で包み、例外は「記録できなかった可能性がある。`workflow-cli status` で確認する」。
- [ ] **Step 4: 通過を確認**。
- [ ] **Step 5: コミット** — `feat(hooks): record approvals from AskUserQuestion answers`。

### T6: guard に AskUserQuestion の分岐を足し、GUARDED_TOOLS を lib に寄せる（spec K4・K12）

**Files:**

- 編集: `home/dot_claude/hooks/implementations/document-workflow-guard.ts`（ローカルの `GUARDED_TOOLS`、予約ツールの分岐の後の新しい分岐、ADR-0023 K9 の deny 文（`judgeApprovalWrite` の 2 つの英語の文: 承認行の書き手を述べる文と「ask the user to write 「承認 …」」）、予約ツールの 2 つの deny 文）
- 編集: `home/dot_claude/hooks/lib/guarded-tools.ts`（集合、docstring、`matcherCoversTools` の切り出し）
- 編集: `home/dot_claude/hooks/lib/workflow-gate.ts`（診断の次の一手の 2 つの文「会話で「承認 X」と書く」）
- テスト: `home/dot_claude/hooks/tests/unit/document-workflow-guard.test.ts`、`home/dot_claude/hooks/tests/unit/guarded-tools.test.ts`、`home/dot_claude/hooks/tests/unit/session.test.ts`（既存の guard の監査の期待）。`workflow-gate.ts` の診断の文を固定している既存のテストは無い（`rg -l '会話で「承認' home/dot_claude/hooks/tests` が 0 件、2026-10-03）。
- 参照: `home/dot_claude/hooks/tests/unit/document-workflow-guard.test.ts:1505-1560`（予約ツールのテストの形、`createPreToolUseContextFor(hook, tool as never, input)`）

順序: 先に「import 元の切り替え」だけを行い既存テストが通ることを確かめ、その後で AskUserQuestion を足す（scope-justification の Round 3 の注意）。

- [ ] **Step 1: import 元の切り替え** — guard のローカルの `GUARDED_TOOLS` を削除し `import { GUARDED_TOOLS } from "../lib/guarded-tools.ts"`。`GUARDED_TOOLS_FOR_TESTING` の export と、それを使う `guarded-tools.test.ts` の集合の一致の検査（再 export で自明になる）を削除する（参照はこの 1 か所だけ、2026-10-03 の rg で確認）。これは spec K4 の「`GUARDED_TOOLS_FOR_TESTING` は lib の集合を再 export して残し」からの意図的な逸脱である。理由: 集合を lib の 1 か所にした後は、再 export と一致の検査は常に通り、何も守らない（plan のレビューの architecture の指摘）。代わりの守りは T9 Step 0 の「テンプレートの matcher が GUARDED_TOOLS を覆う」テスト。spec の意図（集合と配線の食い違いを検出する）はこれで保たれる。`SCHEDULING_TOOLS` のコメントを「guard の分岐の種類を表す集合で、registration の集合（`GUARDED_TOOLS`）とは意味が違うのでここに置く」に書き換える。`bun run test` と `bun run typecheck` が通ることを確認してコミット `refactor(hooks): let the workflow guard use the shared guarded-tools set`。
- [ ] **Step 2: 失敗するテストを書く**
  - `guarded-tools.test.ts`:
    - 期待一覧に `AskUserQuestion` を足す。
    - `matcherCoversTools(matcher, tools)`: `("AskUserQuestion", ["AskUserQuestion"])` → covered、`("", [...])` / `("*", ...)` → covered、`("AskUserQuestions", ["AskUserQuestion"])` → missing、`("Ask.*", ["AskUserQuestion"])` → missing（正規表現として解釈しない）。`matcherCoversGuardedTools(m)` は `matcherCoversTools(m, [...GUARDED_TOOLS])` と同じ結果。
  - `session.test.ts`: 既存の guard の監査のテストで、fixture の matcher が `AskUserQuestion` を含まないために「covers」の期待が「missing」になるものは、fixture の matcher に `|AskUserQuestion` を足して直す（Step 4 で `session.test.ts` が通ることを必須の確認にする）。
  - guard（AskUserQuestion）。「ある」はキーが存在し値が `undefined` でないこと:
    - 承認の質問（`buildApprovalQuestions([{name:"spec.md",hash:H}])`）+ `answers: {[APPROVAL_QUESTION_TEXT]: "spec.md"}` → deny。理由に `answers` を含む。
    - 同じ質問 + `answers: {}` / `answers: ""` / `answers: null` / `annotations: []` / `annotations: {x: {notes: "n"}}` → いずれも deny。
    - 同じ質問で `answers` も `annotations` も無い → allow。
    - 2 問目にだけ承認らしい質問がある `questions` + `answers` → deny。
    - 一般の質問 `{questions:[{question:"進めてよいか", header:"確認", multiSelect:false, options:[{label:"はい",description:""},{label:"いいえ",description:""}]}], answers:{"進めてよいか":"はい"}}` → allow。
    - `tool_input` が文字列 / null → allow（質問が無い）。
    - `questions` の getter が throw し、`answers` を持つ → deny。`answers` を持たない → allow かつ `systemMessage` に警告。
    - `questions` の getter が throw し、`answers` の getter も throw する → deny（catch の中の読み出しの失敗も deny に倒す）。
    - wfDir が解決できない session id（`overrides.session_id` に `"../bad"`）+ 承認の質問 + answers → deny（wfDir の解決より前に判定している）。
  - 予約ツールと ADR-0023 K9 の deny 文、`workflow-gate.ts` の診断の文のテスト: 既存の `includes("会話で")` などの期待を、新しい文言に含める語（`ask-approval` と `approve`）を含むことの確認に変える。
- [ ] **Step 3: 実装**
  - `lib/guarded-tools.ts`: 集合に `"AskUserQuestion"` を足す。`matcherCoversTools(matcher: string, tools: readonly string[]): MatcherCoverage` を切り出し（今の `matcherCoversGuardedTools` の本体を、`GUARDED_TOOLS` の代わりに引数の `tools` で行う）、`matcherCoversGuardedTools` はそれに委譲する。docstring を「評価の種類は 3 つ: 書き込みの評価（Write / Edit / MultiEdit / NotebookEdit / Bash）、予約ツールの prompt の文面（CronCreate / ScheduleWakeup）、AskUserQuestion の質問の内容（承認らしい質問に `answers` / `annotations` があれば deny）」に直す。この module は何も import しないまま。
  - guard: 予約ツールの分岐の直後に、別の分岐 `if (tool_name === "AskUserQuestion")` を置き、必ず return する。中身は `try { const q = (tool_input as {questions?: unknown})?.questions; if (isApprovalLikeQuestion(q) && hasPrefilled(tool_input)) deny; else allow } catch { try { hasPrefilled(tool_input) ? deny : allow+警告 } catch { deny } }`。`hasPrefilled(x)` は `x` が object で、`answers` か `annotations` のキーの値が `undefined` でないこと。
  - deny 文: AskUserQuestion は「承認の質問の回答は利用者が選ぶもので、`answers` / `annotations` を model が入れることはできない。`workflow-cli ask-approval` の出力をそのまま渡す」。予約ツールと ADR-0023 K9 の deny 文は「承認は利用者が行う。`workflow-cli ask-approval` で AskUserQuestion を出すか、利用者に会話で `approve` と打ってもらう」（英語の文は同じ意味の英語にし、承認行の書き手として `approval-answer-recorder` も挙げる）。`workflow-gate.ts` の診断の次の一手は「`workflow-cli ask-approval` で承認の質問を出すか、会話で `approve <文書名>` と打つ」。
- [ ] **Step 4: 通過を確認**（`document-workflow-guard.test.ts`・`guarded-tools.test.ts`・`session.test.ts` と `bun run test`）。
- [ ] **Step 5: コミット** — `feat(hooks): deny pre-filled answers on approval questions`。

### T7: SessionStart の監査に PostToolUse の登録を足す（spec K2）

**Files:**

- 編集: `home/dot_claude/hooks/implementations/session.ts:52-110`（`extractGuardMatcher` / `auditGuardWiring` の近く）と summary の組み立て（`auditGuardWiring` を呼んでいる箇所）
- テスト: `home/dot_claude/hooks/tests/unit/session.test.ts`
- 参照: `home/dot_claude/hooks/lib/guarded-tools.ts`（`matcherCoversGuardedTools` の、正規表現でなく選択肢の文字列で比べる方針）

- [ ] **Step 1: 失敗するテストを書く**
  - `extractHookMatcher(settings, "PostToolUse", "approval-answer-recorder.ts")` が、該当 entry の matcher を返す / 無ければ null。
  - `extractGuardMatcher(settings)` の既存テストはそのまま通る（シグネチャを変えない）。
  - `auditAnswerRecorderWiring`（settings のパスを読む既存の形に合わせる）が、matcher `"AskUserQuestion"` で「covers」、`""` / `"*"` で「covers」、`"AskUserQuestions"` や entry 無しで「missing」を返す。
  - settings の JSON が壊れているとき: `auditAnswerRecorderWiring` は「could not audit」を返し、同じ settings で `auditGuardWiring` の結果は変わらない（片方の失敗がもう片方を巻き込まない）。
- [ ] **Step 2: 失敗を確認**。
- [ ] **Step 3: 実装** — `extractHookMatcher(settings, event, fileName)` を足し、`extractGuardMatcher` はそれに委譲する。`auditAnswerRecorderWiring` は `auditGuardWiring` と別の関数で、独自の try/catch を持つ（catch の文は既存と同じく `error.name` だけを出す）。matcher の被覆は T6 で切り出した `matcherCoversTools(matcher, ["AskUserQuestion"])` を使う（判定を複製しない）。SessionStart の出力に 1 行足す。
- [ ] **Step 4: 通過を確認**。
- [ ] **Step 5: コミット** — `feat(hooks): audit the approval answer recorder wiring at session start`。

### T8: CLI に `ask-approval` を足し、triage と status を変える（spec K5・K7・K9）

**Files:**

- 編集: `home/dot_claude/hooks/cli/workflow.ts:189-210`（分岐と usage）、`cmdTriage`（`:871` 付近）、`cmdStatus`（`:327` 付近）
- テスト: `home/dot_claude/hooks/tests/unit/workflow-cli.test.ts`
- 参照: `home/dot_claude/hooks/tests/unit/workflow-cli.test.ts:1080` 以降（`describe("workflow-cli: triage")` の repo の作り方）

- [ ] **Step 1: 失敗するテストを書く**
  - `ask-approval`: spec.md・plan-1.md が承認待ち → exit 0、stdout を `JSON.parse` すると `{questions: buildApprovalQuestions([spec.md, plan-1.md の現在の hash])}` と深い等価、stderr に `[approval-answer-recorder]` を含む。
  - 承認待ち 4 件 → stdout は先頭 3 件、stderr に `残り 1 件` を含む。
  - 承認待ち 0 件 → exit 1、stderr に理由。
  - 候補と readiness のずれ: `listApprovalCandidates` を一度呼んで 2 件あることを確かめた後で plan-1.md の Review を needs-work に書き換えてから `ask-approval` → plan-1.md が質問に出ない。spec.md も書き換えて 0 件にすると exit 1。（`listApprovalCandidates` は呼ぶたびに読み直すので、書き換えた後の呼び出しで除かれることを確かめる）
  - `triage` の成功時の stdout に `workflow-cli ask-approval` を含む。
  - `status` の出力: 最新の承認の行が `via:"ask"` → `via=ask`、`via:"utterance"` → `via=utterance`、`via` 無し → `via=unknown`、承認の行が無い文書には `via=` の行を出さない。
  - usage の文字列に `ask-approval` を含む。
- [ ] **Step 2: 失敗を確認**。
- [ ] **Step 3: 実装** — `case "ask-approval": return cmdAskApproval(rest, deps);`。`cmdAskApproval` は `resolveTargetWfDir` → `listApprovalCandidates(wfDir)` → 各候補の `evaluateApprovalReadiness(wfDir, name)` を読み、`ready` が偽になったもの（一覧と読み直しの間に変わったもの）を除く → 0 件なら `err("no documents are waiting for approval")` → 先頭 `MAX_DOCS_PER_QUESTION` 件の、いま読んだ `hash` で `buildApprovalQuestions` → `{ exitCode: 0, stdout: JSON.stringify({questions}) + "\n", stderr: <注意の文> }`。注意の文は「回答の後に [approval-answer-recorder] の返答が無ければ記録されていない。workflow-cli status で確かめる」と、4 件以上なら「残り N 件は記録の後にもう一度呼ぶと出る」。`cmdTriage` の成功時の stdout に「next: workflow-cli ask-approval の出力で AskUserQuestion を出して承認を求める」の 1 行を足す。`cmdStatus` は `readLatestApprovals(wfDir)` を読み、承認の行がある各文書について `approval via: <doc> via=<ask|utterance|unknown>` を出す。
- [ ] **Step 4: 通過を確認**。
- [ ] **Step 5: コミット** — `feat(workflow-cli): add ask-approval and show the approval route`。

### T9: settings テンプレートに配線する（spec K2・K4）

**Files:**

- 編集: `home/dot_claude/.settings.hooks.json.tmpl:4`（PreToolUse の matcher）と PostToolUse 節（`:98` 以降）
- 参照: `home/dot_claude/.settings.hooks.json.tmpl:281-285`（UserPromptSubmit の approval-recorder の entry の書き方）

- [ ] **Step 0: 失敗するテストを書く** — `guarded-tools.test.ts` に「テンプレートの guard の matcher が GUARDED_TOOLS を覆う」テストを足す。テンプレートは `{{ if … }}` などの構文を含み JSON として読めないので、`const i = tmpl.indexOf("document-workflow-guard.ts")` の手前の部分で最後に現れる `/"matcher":\s*"([^"]*)"/g` の一致を guard の matcher とする（guard の entry は自分の matcher の後に command を持つので、直前の matcher が自分のもの）。その値が `matcherCoversGuardedTools` で covered。同じ方法で `approval-answer-recorder.ts` の直前の matcher が `matcherCoversTools(m, ["AskUserQuestion"])` で covered。どちらも Step 1 の前は赤い。あわせて、各ファイル名がテンプレートに 1 回だけ現れることを assert する（2 回現れると「直前の matcher」の前提が崩れるため）。
- [ ] **Step 1: 変更** — PreToolUse の matcher を `Write|Edit|MultiEdit|NotebookEdit|Bash|CronCreate|ScheduleWakeup|AskUserQuestion` にする。PostToolUse に `{"matcher": "AskUserQuestion", "hooks": [{"type": "command", "command": "bun {{ .chezmoi.homeDir }}/.claude/hooks/implementations/approval-answer-recorder.ts"}]}` を足す。
- [ ] **Step 2: 検証** — `chezmoi execute-template --source home < home/dot_claude/.settings.hooks.json.tmpl | jq -e '.PreToolUse[0].matcher | contains("AskUserQuestion")'` が true、`... | jq -e '[.PostToolUse[] | select(.matcher == "AskUserQuestion")] | length == 1'` が true。`bun run test`・`bun run typecheck`・`bun run lint` がすべて通る。（ここの jq のパスは、テンプレートの出力が event の object なので `.PreToolUse`。配備後の `~/.claude/settings.json` では `.hooks.PreToolUse` になる。）AskUserQuestion の入力を書き換える層が他に無いこと: `rg -n 'updatedInput' home/dot_claude/hooks/implementations home/dot_claude/hooks/lib` の各ヒットが AskUserQuestion に適用されない（`tool_name` で AskUserQuestion を除外している、または別のツールに限られている）ことを読んで確かめる。適用されるものがあれば止めて利用者に報告する。
- [ ] **Step 3: コミット** — `feat(hooks): wire the approval answer recorder`（Step 0 のテストをこのコミットに入れる）。

T6 の guard の変更と T9 の matcher の変更は、別のコミットでも `session.ts` の監査は配備時にしか読まない（`~/.claude/settings.json`）ので、リポジトリのテストは途中で落ちない。配備（`chezmoi apply`）は T9 の後にまとめて行う（plan-2）。

## ISO 25010 具体テストケース

### 機能適合性（正確性）

- **入力**: spec.md と plan-1.md が承認待ち、`ask-approval` の出力で質問、回答 `"spec.md, plan-1.md"` → **期待**: `approvals.log` に 2 行（`via:"ask"`、hash は照合に使った値）、両文書の承認行が approved。
- **入力**: 回答 `"承認しない"` → **期待**: log の行数は変わらない、返答に `ask-approval` を含まない。
- **入力**: plan-1.md を symlink にして同じ回答 → **期待**: spec.md は recorded、plan-1.md は loggedOnly、もう一度 `ask-approval` を呼ぶと plan-1.md が質問に出る。

### セキュリティ（真正性）

- **入力**: questions の description を `hash=<12 桁> ※差し戻し` にした応答 → **期待**: malformed、log 無し。
- **入力**: label `"../x.md"` → **期待**: malformed、gate と ledger に渡らない。
- **入力**: PreToolUse に承認の質問 + `answers` → **期待**: deny。
- **入力**: 一般の質問 + `answers` → **期待**: allow。
- **入力**: `buildApprovalQuestions` の任意の正常入力 → **期待**: `isApprovalLikeQuestion` が true。

### 使用性（操作性）

- **入力**: 承認待ち 2 件で素の `承認` → **期待**: log 無し、`additionalContext` に `workflow-cli ask-approval`、`systemMessage` に `approve plan-1.md plan-2.md`。
- **入力**: afk の応答 → **期待**: 返答に「出し直さない」。

### 保守性

- **入力**: `rg -n '"Document Workflow の承認' home/dot_claude/hooks --glob '!**/tests/**'` → **期待**: `lib/workflow-approval.ts` の 1 か所だけ。

## Approval

- Plan Status: complete
- Review Status: pass
- Approval Status: approved

## Reviewer Outputs (Round 1)

### logic-validator

- verdict: needs-work
- 主指摘: T5 が `agent_id` を `isApprovalLikeQuestion` より先に見ており spec K3 の判定順と逆。`answers` のキーの扱い（欠落・余分・非文字列）が未定義。`workflow-gate.ts` と guard の英語の deny 文に旧案内が残るのに Files に無い。T3 のテストの入ったコミットの順と `recordOne` の gate 未充足時の状態が未定義。

### scope-justification-reviewer

- verdict: needs-work
- 主指摘: T5 の判定順の食い違い。T3 の「今と同じ文に整形」は K12 と矛盾。spec K4 の `session.test.ts` の既存の期待の更新が T6 に無い。unresolvable 時の返答は spec に無い（fail-closed で妥当）。

### architecture-boundary-analyzer

- verdict: needs-work
- 主指摘: guard が lib を再 export すると `guarded-tools.test.ts` の集合の一致の検査が自明になる。T7 が matcher の被覆判定を session.ts に複製する（`matcherCoversTools` を lib に切り出す）。結果の文の整形の置き場所を 1 つにする。

### security-vulnerability-analyzer

- verdict: needs-work
- 主指摘: `tool_input` を読まないこと・`via` が定数であることを固定するテストが無い。文書名の検証が gate より前にあることを示せるテストにする（実在の文書に解決される `../` の名前）。構造の完全一致の改変パターンと深い等価の境界値が足りない。guard の catch 内の読み出しの例外と「ある」の定義。

### resilience-analyzer

- verdict: needs-work
- 主指摘: `failed` 状態が実装にもテストにも無く、記録のループで例外が出ると部分失敗が汎用の例外の返答に埋もれる。`answers` に質問文のキーが無いと TypeError になる。unresolvable のテストが無い。T7 の独自 try/catch のテスト、T8 の候補と readiness のずれ。

<!-- auto-review: pending -->
<!-- intent-triage: pending -->

## Reviewer Outputs (Round 2)

### logic-validator

- verdict: needs-work
- 主指摘: テンプレートの matcher のテストは T6 で書くと T6〜T8 の `bun run test` が赤くなる（T9 で書く）。T3 の refactor のコミットが利用者に見える文を変えている。`session.test.ts` の更新を必須の確認として書き、`workflow-gate.ts` の文を見るテストを今特定する。

### scope-justification-reviewer

- verdict: pass
- 主指摘: Round 1 の 4 点は解消。軽微: unresolvable の分岐は spec に追補不要と書く。

### architecture-boundary-analyzer

- verdict: needs-work
- 主指摘: `describeRecordResult` は境界違反ではないが、復旧の一句は経路で違うので lib は事実だけを返す。テンプレートの matcher を最初の `"matcher"` から拾う正規表現は誤る。`GUARDED_TOOLS_FOR_TESTING` は用途が無くなるので消す。

### security-vulnerability-analyzer

- verdict: pass
- 主指摘: Round 1 は解消。軽微: PostToolUse で `tool_input` を veto にだけ使う案、AskUserQuestion の入力を書き換える層が他に無いことの確認。

### resilience-analyzer

- verdict: pass
- 主指摘: Round 1 の 5 点は解消。軽微: T8 の候補と readiness のずれのテスト、同じ文書を 2 度記録しても結果が変わらないことのテスト。

<!-- auto-review: verdict=needs-work; hash=540b1024c4dc09ab8f6cf94263916eb91b0e89d49ec312371b2078e2b4a27d69; design-hash=71f8055404d824f444a13f480993f78c4003abc59fe8da1168fa6e9c1d95e309; round=1; parent-spec-hash=98dfec921058b7bc43fc11c288ae0bedfe7daac7ce28c000f8228f2ce7384c15; at=2026-10-02T20:07:59.268Z; reviewers=logic-validator+scope-justification-reviewer -->
<!-- intent-triage: adopted=20; excluded=0; at=2026-10-02T20:07:59.299Z -->

## Reviewer Outputs (Round 3)

### logic-validator

- verdict: needs-work
- 主指摘: Round 2 の 4 点は解消。`GUARDED_TOOLS_FOR_TESTING` の削除が承認済み spec K4（再 export して残す）と食い違う（plan に意図的な逸脱として明記）。T3 の malformed 表の「選択肢の順の入れ替え」が曖昧（文書同士の入れ替えは recorded になる）。

### architecture-boundary-analyzer

- verdict: pass
- 主指摘: Round 2 の 3 点は解消。軽微: T9 Step 0 のテストにファイル名の出現が 1 回であることの assert を足す。

### scope-justification-reviewer

- verdict: pass (carried from Round 2)
- 主指摘: Round 2 で pass、再実行なし

### security-vulnerability-analyzer

- verdict: pass (carried from Round 2)
- 主指摘: Round 2 で pass、再実行なし

### resilience-analyzer

- verdict: pass (carried from Round 2)
- 主指摘: Round 2 で pass、再実行なし

<!-- auto-review: verdict=needs-work; hash=8dceb53e636b4c8452581a3597bd93d71cedaf7d23ab44d38d8d6f6343058359; design-hash=78610fa8b3f088cfa8ef80f664d8c90097ff87e8c06f476b5e7d7966362a7723; round=2; parent-spec-hash=98dfec921058b7bc43fc11c288ae0bedfe7daac7ce28c000f8228f2ce7384c15; at=2026-10-02T20:13:27.107Z; reviewers=logic-validator+scope-justification-reviewer -->
<!-- intent-triage: adopted=11; excluded=0; at=2026-10-02T20:13:27.137Z -->

## Reviewer Outputs (Round 4)

### logic-validator

- verdict: pass
- 主指摘: Round 3 の 2 点は解消、新しい矛盾なし。軽微: ADR の K4 の要約を plan での逸脱に合わせる（plan-2 T4 に反映）。T6〜T9 の間はテンプレートの matcher の検査が無いが、リポジトリのテストは落ちない。

### architecture-boundary-analyzer

- verdict: pass (carried from Round 3)
- 主指摘: Round 3 で pass、再実行なし

### scope-justification-reviewer

- verdict: pass (carried from Round 3)
- 主指摘: Round 3 で pass、再実行なし

### security-vulnerability-analyzer

- verdict: pass (carried from Round 3)
- 主指摘: Round 3 で pass、再実行なし

### resilience-analyzer

- verdict: pass (carried from Round 3)
- 主指摘: Round 3 で pass、再実行なし

<!-- auto-review: verdict=needs-work; hash=e975711a8dcb64b4d3b57d7a259ecb0c301d87b1c7cf237d85e97d72ffd09430; design-hash=3f1279cdd4b718868b29239c2b1815d2f9505b6b73afb67dca0b2701b5ed83f9; round=3; parent-spec-hash=98dfec921058b7bc43fc11c288ae0bedfe7daac7ce28c000f8228f2ce7384c15; at=2026-10-02T20:16:44.899Z; reviewers=logic-validator+architecture-boundary-analyzer -->
<!-- intent-triage: adopted=3; excluded=0; at=2026-10-02T20:16:44.932Z -->

<!-- auto-review: verdict=pass; hash=01319c3dbbedd448b62caf5024940fe77335e34dac853c02fe4aae66e810ec84; design-hash=b691a86e612e6cd9a15b0ec805bcf6a0276093ea9505bf024c88762f7e460c67; round=4; parent-spec-hash=98dfec921058b7bc43fc11c288ae0bedfe7daac7ce28c000f8228f2ce7384c15; at=2026-10-02T20:18:20.857Z; reviewers=logic-validator -->
<!-- intent-triage: adopted=2; excluded=0; at=2026-10-02T20:18:20.874Z -->
