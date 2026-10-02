<!-- spec-ref: spec.md -->

# Plan: 承認を人間の発話で記録し、承認した版に結びつける (Execution layer)

spec K7・K8・K9・K12（#221、#209 の文書）。H = `home/dot_claude/hooks`。plan-4 の実装（commit 4cef612 まで）を前提にする。

## 方針と範囲

- T1（K8 の記録形式）: `H/lib/workflow-approval.ts` を新設し、`approvals.log`（JSON Lines、`{"v":1,"doc","hash","session","at"}`）の追記と読み取りだけを置く。node の組込みだけに依存する葉のモジュールにする（hash は gate が計算する。spec の Architecture 節の `document-hash ← workflow-approval` の矢印は実際には不要で、ADR に書く）
  - 読み手は同じ `doc` の最後の行だけを使い、不正な行と `v !== 1` の行は数えて読み飛ばす
  - log が読めない（同名のディレクトリ、権限、symlink のループ）ときは例外を投げず、`readError` を返す。例外が gate から guard まで届くと、guard は fail-open で通す（`document-workflow-guard.ts` の catch）。model が Bash の `mkdir` で作れる状態なので、ここで閉じておく
- T2（K8 の gate 条件）: gate の文書条件に「approvals.log の最新の承認 hash = 現在の文書 hash」（`approvalRecord`）を足す。spec / plan / plan-N のどれにも効く。`isDocumentApproved` / `isImplementationPhase` / `evaluateTarget` はこの条件を含む
  - 診断は spec K8 の形にする: 条件の表示名は `approval`、見つかった値は `recorded=<12 桁 | none> current=<12 桁>`、読み飛ばした行があれば `; ignored-lines=<N>`、読めなければ `; ledger-unreadable`。次の 1 手は「会話で『承認 <文書名>』と書く」。二層モードで spec が通った後の note と次の 1 手（plan-N.md の承認を求める文）も同じ言い方に揃える
  - 承認行の `approved` は表示であり取り消しの手段なので、条件 `approvalStatus` は残す。gate が通るのは両方がそろったときだけ
  - 承認の準備ができた文書の判定（`evaluateApprovalReadiness`）と、承認待ちの文書の一覧（`listApprovalCandidates`）を gate に置く。どの文書が承認待ちかは gate の判断で、hook には発話の解釈と記録だけを残す
  - parent-spec-hash の照合は `isImplementationPhase` / `evaluateTarget` / 準備の判定の 3 か所で要るので、`parentSpecMatches` に括り出す
  - 既存テストの「承認済み」の fixture は log が無いので落ちる。fixture を作る関数に `recordApprovalsForTest(wfDir)` を足す（対象は T2 の Files に列挙した 7 か所）
- T3（K7）: UserPromptSubmit の hook `approval-recorder` を新設する
  - 反応する発話: 前後の空白を除いた全体が、`承認` / `approve`（`approve` だけ大文字小文字を問わない）に、任意の文書名（`spec.md` / `plan.md` / `plan-<数字>.md`、小文字のみ、空白区切り）と末尾の句点・感嘆符を足しただけの形。文書名を大文字小文字で区別するのは、macOS の大文字小文字を区別しないファイルシステムで `PLAN.MD` を読めてしまい、gate が照合しない名前で log に書くのを防ぐため
  - 人間が打ったプロンプトだけを記録する。UserPromptSubmit の入力の `source`（cc-hooks-ts 2.1.281 の型にある任意フィールド: `user` / `sdk` / `system` / `loop_wakeup` / `schedule_wakeup` / `poll_event`）が `user` か無いときだけ動く。サブエージェントの中で発火した（`agent_id` がある）ときも記録しない
  - 文書名が無いときの対象: `listApprovalCandidates` がちょうど 1 件を返すとき。0 件・複数件なら何も書かず、理由と文書名を付けた発話の形を伝える
  - 文書名があるとき（重複は除く）は、名前の付いた文書がすべて「承認以外の条件を満たす」ときだけ全部を記録する。1 つでも満たさなければ何も書かない。spec K7 は「文書名があればそれ」とだけ定めており、全か無かにするのは本 plan の判断（部分的な承認を作らないため）。ADR に書く
  - 記録の手順: 全対象の hash を先に求め、文書ごとに log に追記し、承認行を書き換え（一意な名前の一時ファイルを排他作成して書き、rename する。仕込まれた symlink を辿らない。symlink の文書は書き換えない）、最後に `evaluateDocument` で読み直して、gate の条件がそろった文書だけを「記録した」と伝える。同じ発話の繰り返しは同じ hash の行を足すだけで、最後の行だけを使う読み手には無害（spec K7 の「もう一度言えば完了する」）
  - 返答は `additionalContext`（model 向け）と `systemMessage`（利用者に直接見える）の両方で出す。内部エラーのときも「記録できなかった可能性がある、`workflow-cli status` で確認する」と返し、黙って成功扱いにしない
  - `.settings.hooks.json.tmpl` の UserPromptSubmit に、非同期にせず登録する
- T4（K9）: guard が次の書き込みを deny する
  - wfDir の `.md`（realpath で比べ、拡張子は大文字小文字を問わない）への Write / Edit / MultiEdit で、新内容の「承認済みの承認行」の数が旧内容より増えるもの。承認行は表示用の寛容な形（先頭のハイフン欠落を許す）で数える。行の有無ではなく数で比べるのは、旧内容が承認済みの行を引用している（コードブロック、Reviewer Outputs の抜粋）ときに、本物の承認行を approved にする編集が素通りしないようにするため。値の変わらない書き換えと approved → pending（取り消し）は通る
  - 旧内容が読めないときは「旧内容なし」として扱う（承認済みにする書き込みは deny 側に倒れる）
  - `<root>/.tmp/sessions/*/approvals.log`（大文字小文字を問わない。他のセッションの log も含む）への Write / Edit / MultiEdit。他のセッションの log を偽造して task-handoff で持ち込む経路も閉じる
  - Bash は対象外（spec R4）
  - 判定は workflow の文書の近道（`classifyExemption`）より前に置く
- T5（K12 と文書）: ADR-0022 を書き、ADR-0013 の Open observation items 1 を解消したと相互参照する。rules/workflow.md の承認の記述と、hook が出す Executive Summary の雛形（`workflow-review-core.ts`）の Next Action を「会話で `承認`（必要なら文書名）と書く」に改め、`/execute-plan` を承認の操作から外す。reference skill に worktree での手順と承認の手順を書く
  - reference skill の `/clear` の節に plan-4 で古くなった 2 文（空変数ガード）が残っている。同じファイルを T5 で書き換えるので、ここで直す（K4 の目的である「シェル変数の取り違えをなくす」の残り）
- 運用上の注意: この plan の実装が終われば plan-2〜plan-5 がそろうので、`chezmoi apply` してよい。配備したら Claude Code を起動し直す（spec R6）。配備前に承認された進行中の workflow は log が無いので gate が止めるが、診断が「会話で承認と書く」を示すので 1 発話で戻る（spec R1）

## 受け入れるリスク

- model が Bash で `approvals.log` に追記する経路は止めない（spec R4。Bash の書き込み先の判定には既知の穴がある: followups 課題 A/B）
- **プロンプトの出どころの判定は、Claude Code が `source` を送る前提に立つ**。公式ドキュメントの UserPromptSubmit の入力には出どころのフィールドが載っていないが、cc-hooks-ts 2.1.281 の型には `source` がある（logic-validator が `index.d.mts:132` で確認）。hook は `source` が `user` か無いときだけ記録する。値が無いとき（古い Claude Code）は人間の入力として扱うので、そのときは予約したプロンプトを区別できない。model が「承認」だけのプロンプトを予約して自分を承認させるのは意図的な迂回で、spec R4 の脅威モデルの外。実行時に `source` が届くかは配備後に実測する（T5 Step 6）
- 文書名なしの「承認」は、別の話題への返事でも承認待ちが 1 件なら記録される（spec R7）。記録したら対象・hash・取り消し方を必ず伝える
- hook が承認行を書き換えるので、model が直前に読んだ内容と食い違い、次の Edit が「読み込み後に変更された」で失敗しうる。読み直せばよい
- `session` は監査用で照合に使わない。task-handoff で旧 wfDir を複製した場合も、文書が同じ版なら承認は引き継がれる（spec K8）
- 取り消した後で人間が承認行を手で `approved` に戻すと、log の最新 hash が一致していれば再発話なしで通る（spec K8。model には K9 によりできない）
- K9 の数の比較では、新しく作る `.md` が承認済みの行を引用しているだけでも deny される（誤検知）。wfDir の文書で承認行を引用する必要はまず無いので受け入れる
- 承認行の表記ゆれ（`**Approval Status**: approved`、`Approval Status : approved` など）は K9 の数え方に当たらない。gate は log を要求するので承認にはならず、表示の誤誘導だけが残る
- K9 の数の比較は、引用された承認済みの行を消しつつ本物の承認行を approved にする「差し引きゼロ」の編集を通す。wfDir の中の文書が symlink / hard link で wfDir の外を指す場合も、realpath が外なので判定に当たらない。どちらも gate は log を要求するので承認にはならず、表示の誤誘導だけが残る（spec R4 の範囲）
- K9 のパスの比較は文字列の前方一致なので、プロジェクトの root に非 ASCII の文字があり、model が別の Unicode 正規化形（NFD / NFC）で書くと一致しない。今の root は ASCII なので対象外
- K9 のパスの比較は大文字小文字を区別しない。大文字小文字を区別するファイルシステムでは、名前の大小だけが違う別の dir への書き込みも止める（安全側の誤検知）

## Files

```
# 新規作成
home/dot_claude/hooks/lib/workflow-approval.ts
home/dot_claude/hooks/implementations/approval-recorder.ts
home/dot_claude/hooks/tests/unit/workflow-approval.test.ts
home/dot_claude/hooks/tests/unit/approval-recorder.test.ts
docs/decisions/0022-workflow-identity.md

# 編集
home/dot_claude/hooks/lib/workflow-gate.ts
home/dot_claude/hooks/lib/workflow-marker.ts
home/dot_claude/hooks/lib/workflow-review-core.ts
home/dot_claude/hooks/implementations/document-workflow-guard.ts
home/dot_claude/.settings.hooks.json.tmpl
home/dot_claude/rules/workflow.md
.skills/document-workflow-reference/SKILL.md
docs/decisions/0013-workflow-dir-session-derivation.md

# テスト
home/dot_claude/hooks/tests/unit/test-helpers.ts
home/dot_claude/hooks/tests/unit/workflow-gate.test.ts
home/dot_claude/hooks/tests/unit/document-workflow-guard.test.ts
home/dot_claude/hooks/tests/unit/workflow-cli.test.ts
```

## Tasks

テストの実行は、リポジトリ（worktree）のルートで `node --import ./home/dot_claude/hooks/tests/preload-test-env.mjs --test <file>`。ソースは Read ツールで 1 ファイルずつ読む。着手前に `bun run test` の pass 数を控える（plan-4 完了時点で tests 2306 / pass 2290 / fail 0 / skipped 16）。

### T1: `approvals.log` の追記と読み取り（K8）

**Files:**

- 新規: `H/lib/workflow-approval.ts`、`H/tests/unit/workflow-approval.test.ts`

- [ ] **Step 1: 失敗するテストを書く**

```ts
#!/usr/bin/env node --test

import { strict as assert } from "node:assert";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  APPROVALS_LOG,
  appendApproval,
  readLatestApprovals,
} from "../../lib/workflow-approval.ts";

const H1 = "a".repeat(64);
const H2 = "b".repeat(64);

describe("workflow-approval (spec K8)", () => {
  it("appends one JSON line per approval", () => {
    const wf = mkdtempSync(join(tmpdir(), "approvals-"));
    appendApproval(wf, {
      doc: "plan.md",
      hash: H1,
      session: "s1",
      at: "2026-10-02T00:00:00.000Z",
    });
    assert.equal(
      readFileSync(join(wf, APPROVALS_LOG), "utf-8"),
      `${JSON.stringify({ v: 1, doc: "plan.md", hash: H1, session: "s1", at: "2026-10-02T00:00:00.000Z" })}\n`,
    );
  });

  it("uses only the last line for each document, so a revert does not revive an old approval", () => {
    const wf = mkdtempSync(join(tmpdir(), "approvals-"));
    appendApproval(wf, { doc: "plan.md", hash: H1, session: "s", at: "t1" });
    appendApproval(wf, { doc: "plan.md", hash: H2, session: "s", at: "t2" });
    appendApproval(wf, { doc: "spec.md", hash: H1, session: "s", at: "t3" });
    const r = readLatestApprovals(wf);
    assert.equal(r.latest.get("plan.md")?.hash, H2);
    assert.equal(r.latest.get("spec.md")?.hash, H1);
    assert.equal(r.ignoredLines, 0);
    assert.equal(r.readError, undefined);
  });

  it("skips malformed lines and other versions, and counts them", () => {
    const wf = mkdtempSync(join(tmpdir(), "approvals-"));
    appendFileSync(
      join(wf, APPROVALS_LOG),
      [
        "not json",
        JSON.stringify({
          v: 2,
          doc: "plan.md",
          hash: H1,
          session: "s",
          at: "t",
        }),
        JSON.stringify({
          v: 1,
          doc: "plan.md",
          hash: "short",
          session: "s",
          at: "t",
        }),
        JSON.stringify({
          v: 1,
          doc: "plan.md",
          hash: H2,
          session: "s",
          at: "t",
        }),
        "",
      ].join("\n"),
    );
    const r = readLatestApprovals(wf);
    assert.equal(r.latest.get("plan.md")?.hash, H2);
    assert.equal(r.ignoredLines, 3);
  });

  it("reads an absent log as no approvals", () => {
    const r = readLatestApprovals(mkdtempSync(join(tmpdir(), "approvals-")));
    assert.equal(r.latest.size, 0);
    assert.equal(r.ignoredLines, 0);
    assert.equal(r.readError, undefined);
  });

  it("refuses to append through a symlink at the ledger's name", () => {
    const wf = mkdtempSync(join(tmpdir(), "approvals-"));
    const outside = join(wf, "..", `outside-${Date.now()}.txt`);
    writeFileSync(outside, "keep");
    symlinkSync(outside, join(wf, APPROVALS_LOG));
    assert.throws(
      () =>
        appendApproval(wf, { doc: "plan.md", hash: H1, session: "s", at: "t" }),
      /ELOOP|EMLINK/,
    );
    assert.equal(readFileSync(outside, "utf-8"), "keep");
  });

  it("reports an unreadable log instead of throwing", () => {
    const wf = mkdtempSync(join(tmpdir(), "approvals-"));
    mkdirSync(join(wf, APPROVALS_LOG));
    const r = readLatestApprovals(wf);
    assert.equal(r.latest.size, 0);
    assert.match(r.readError ?? "", /EISDIR/);
  });
});
```

- [ ] **Step 2: テストを実行して失敗を確認**

実行: `node --import ./home/dot_claude/hooks/tests/preload-test-env.mjs --test home/dot_claude/hooks/tests/unit/workflow-approval.test.ts`
期待: モジュールが無いので `ERR_MODULE_NOT_FOUND` で失敗する

- [ ] **Step 3: 最小実装を書く**

```ts
/**
 * The approval ledger (spec K8): which version of a workflow document a
 * human approved. One JSON object per line, appended by approval-recorder
 * when the user says `承認` in the conversation. The gate trusts this file,
 * not the Approval Status line -- the line is display and the way to revoke.
 *
 * JSON Lines so document names and session ids need no delimiter rules of
 * their own. The reader keeps only the last line per document: approve,
 * revise, then revert to the approved text and the old approval does not
 * come back. `session` is audit only and never matched, so a wfDir copied by
 * task-handoff keeps its approvals for unchanged documents.
 *
 * A leaf module (node builtins only): the document hash is computed by the
 * gate, which is the only reader.
 */

import {
  closeSync,
  constants as fsConstants,
  openSync,
  readFileSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";

export const APPROVALS_LOG = "approvals.log";

export interface ApprovalRecord {
  doc: string;
  hash: string;
  session: string;
  at: string;
}

export interface LatestApprovals {
  latest: Map<string, ApprovalRecord>;
  /** Lines that were not a valid version-1 record. */
  ignoredLines: number;
  /** Set when the log exists but cannot be read; the caller must treat every document as unapproved. */
  readError?: string;
}

const HASH_PATTERN = /^[0-9a-f]{64}$/;

/**
 * One line, one write on an O_APPEND descriptor, so concurrent appends never
 * interleave mid-line. O_NOFOLLOW: a symlink planted at the ledger's name
 * makes the append fail instead of writing into whatever it points at.
 */
export function appendApproval(wfDir: string, record: ApprovalRecord): void {
  const flags =
    fsConstants.O_WRONLY |
    fsConstants.O_APPEND |
    fsConstants.O_CREAT |
    fsConstants.O_NOFOLLOW;
  const fd = openSync(join(wfDir, APPROVALS_LOG), flags, 0o644);
  try {
    writeSync(fd, `${JSON.stringify({ v: 1, ...record })}\n`);
  } finally {
    closeSync(fd);
  }
}

/**
 * The last valid record per document. Lines that are not JSON, not version
 * 1, or miss a field are skipped and counted, so a diagnosis can say the
 * ledger had lines it did not understand (a newer writer, a hand edit)
 * instead of silently treating them as absent. A log that cannot be read
 * (a directory, EACCES, ELOOP) is reported, not thrown: an exception would
 * reach the guard's catch, which allows the call.
 */
export function readLatestApprovals(wfDir: string): LatestApprovals {
  const latest = new Map<string, ApprovalRecord>();
  let text: string;
  try {
    text = readFileSync(join(wfDir, APPROVALS_LOG), "utf-8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return { latest, ignoredLines: 0 };
    }
    return { latest, ignoredLines: 0, readError: code ?? String(error) };
  }
  let ignoredLines = 0;
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    const record = parseRecord(line);
    if (record === null) {
      ignoredLines++;
      continue;
    }
    latest.set(record.doc, record);
  }
  return { latest, ignoredLines };
}

function parseRecord(line: string): ApprovalRecord | null {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const { v, doc, hash, session, at } = value as Record<string, unknown>;
  if (v !== 1) return null;
  if (
    typeof doc !== "string" ||
    typeof session !== "string" ||
    typeof at !== "string"
  )
    return null;
  if (typeof hash !== "string" || !HASH_PATTERN.test(hash)) return null;
  return { doc, hash, session, at };
}
```

- [ ] **Step 4: テストを実行して通過を確認**

実行: Step 2 と同じ。続けて `bun run typecheck`
期待: 6 件 PASS、typecheck のエラー 0（macOS の O_NOFOLLOW は symlink に対して ELOOP、Linux も ELOOP。念のため EMLINK も許す）

- [ ] **Step 5: コミット**

```bash
git add home/dot_claude/hooks/lib/workflow-approval.ts home/dot_claude/hooks/tests/unit/workflow-approval.test.ts
git commit -m "feat(hooks): add the approval ledger reader and writer"
```

### T2: gate が approvals.log の最新 hash を承認の条件にする（K8）

**Files:**

- 編集: `H/lib/workflow-gate.ts`（冒頭の docstring、`DocumentDiagnosis` の条件、`evaluateDocument`、`isDocumentApproved`、`diagnoseGate` の note と nextAction、`formatGateDiagnosis`、`isImplementationPhase` と `evaluateTarget` の parent-spec-hash の照合。新規 `parentSpecMatches` / `evaluateApprovalReadiness` / `listApprovalCandidates`）
- テスト: `H/tests/unit/test-helpers.ts`、`H/tests/unit/workflow-gate.test.ts`、`H/tests/unit/document-workflow-guard.test.ts`、`H/tests/unit/workflow-cli.test.ts`
- 承認済みの fixture で gate を通るもの（logic-validator が tests 全体を grep して確認済み。この 7 か所に `recordApprovalsForTest` を入れる）:
  1. test-helpers.ts `createWorkflowRepo`（guard の :147 / :540 / :1233 / :1262、interpreter-write-classify の :102 が使う）
  2. document-workflow-guard.test.ts のローカル `createSessionWorkflowRepo`（:38-47。:465 の「allows Write when session-specific plan is approved」が使う）
  3. document-workflow-guard.test.ts の two-layer describe の `createTwoLayerRepo`
  4. workflow-gate.test.ts の「reports all conditions satisfied」（:42 付近）
  5. workflow-gate.test.ts の「two-layer diagnosis adds the owning plan-N note」（:95-112。spec が通らないと note が出ない）
  6. workflow-gate.test.ts の `twoLayerRepo` と、evaluateTarget の単層 approved の 2 件
  7. workflow-cli.test.ts の status の approved の 2 件（単層 approved、two-layer）
  - 入れないもの: `createGitWorkflowRepo`（呼び出し元はすべて pending）、`seedWorkflow` の spec.md（marker hash が `seed` で、どのみち `hashMatch` で落ちる。stamp の parent-spec-hash の計算にだけ使う）、deny を期待するテスト

- [ ] **Step 1: 失敗するテストを書く**

test-helpers.ts に足す（`readFileSync` / `readdirSync` を `node:fs` の import に、`appendApproval` を `../../lib/workflow-approval.ts`、`STRICT_APPROVAL_STATUS` を `../../lib/workflow-marker.ts` から import に足す。既にあるものは足さない）:

```ts
/**
 * Approve every workflow document in `wfDir` whose Approval line says
 * approved, at its current hash, as approval-recorder would after a human
 * said `承認` (spec K8). Fixtures that build an approved document call this
 * so the gate sees a matching ledger entry; tests about a missing or stale
 * ledger simply do not call it. The hash is computed here independently of
 * the gate, as an oracle.
 */
export function recordApprovalsForTest(wfDir: string): void {
  for (const name of readdirSync(wfDir)) {
    if (
      name !== "spec.md" &&
      name !== "plan.md" &&
      !/^plan-[0-9]+\.md$/.test(name)
    )
      continue;
    const content = readFileSync(join(wfDir, name), "utf-8");
    if (!STRICT_APPROVAL_STATUS.test(content)) continue;
    appendApproval(wfDir, {
      doc: name,
      hash: computeWorkflowRepoPlanHash(content),
      session: TEST_SESSION_ID,
      at: "2026-10-02T00:00:00.000Z",
    });
  }
}
```

workflow-gate.test.ts に足す（`appendFileSync` / `readFileSync` を `node:fs` の（`mkdirSync` は既に import 済み）、`evaluateApprovalReadiness` / `listApprovalCandidates` を `../../lib/workflow-gate.ts` の、`appendApproval` を `../../lib/workflow-approval.ts` の、`recordApprovalsForTest` を `./test-helpers.ts` の既存の import に足す）:

```ts
test("evaluateTarget: an approved plan without a ledger entry denies, naming the next step", () => {
  const wf = freshWf();
  writeFileSync(join(wf, "research.md"), "x");
  writeFileSync(join(wf, "plan.md"), buildPlanContent(approvedWorkflowRepo()));
  const e = evaluateTarget({
    projectRoot: "/r",
    wfDir: wf,
    target: "/r/src/a.ts",
  });
  equal(e.kind, "deny");
  if (e.kind !== "deny") return;
  const record = e.diagnosis.primary.conditions.approvalRecord;
  equal(record.ok, false);
  match(record.foundLine ?? "", /^recorded=none current=[0-9a-f]{12}$/);
  match(e.diagnosis.nextAction, /承認 plan\.md/);
  match(
    formatGateDiagnosis(e.diagnosis, "src/a.ts"),
    /✗ approval \(found: recorded=none/,
  );
});

test("evaluateTarget: a ledger entry for an older version does not approve the current one", () => {
  const wf = freshWf();
  writeFileSync(join(wf, "research.md"), "x");
  writeFileSync(join(wf, "plan.md"), buildPlanContent(approvedWorkflowRepo()));
  appendApproval(wf, {
    doc: "plan.md",
    hash: "c".repeat(64),
    session: "s",
    at: "t",
  });
  appendFileSync(join(wf, "approvals.log"), "garbage\n");
  const e = evaluateTarget({
    projectRoot: "/r",
    wfDir: wf,
    target: "/r/src/a.ts",
  });
  equal(e.kind, "deny");
  if (e.kind !== "deny") return;
  match(
    e.diagnosis.primary.conditions.approvalRecord.foundLine ?? "",
    /^recorded=cccccccccccc current=[0-9a-f]{12}; ignored-lines=1$/,
  );
});

test("evaluateTarget: an unreadable ledger keeps the gate closed", () => {
  const wf = freshWf();
  writeFileSync(join(wf, "research.md"), "x");
  writeFileSync(join(wf, "plan.md"), buildPlanContent(approvedWorkflowRepo()));
  mkdirSync(join(wf, "approvals.log"));
  const e = evaluateTarget({
    projectRoot: "/r",
    wfDir: wf,
    target: "/r/src/a.ts",
  });
  equal(e.kind, "deny");
  if (e.kind !== "deny") return;
  match(
    e.diagnosis.primary.conditions.approvalRecord.foundLine ?? "",
    /ledger-unreadable/,
  );
});

test("evaluateTarget: the ledger's session is not matched", () => {
  const wf = freshWf();
  writeFileSync(join(wf, "research.md"), "x");
  const plan = buildPlanContent(approvedWorkflowRepo());
  writeFileSync(join(wf, "plan.md"), plan);
  appendApproval(wf, {
    doc: "plan.md",
    hash: computeDocumentHash(plan, SPEC_NORMALIZERS),
    session: "another-session",
    at: "t",
  });
  equal(
    evaluateTarget({ projectRoot: "/r", wfDir: wf, target: "/r/src/a.ts" })
      .kind,
    "allow",
  );
});

test("evaluateTarget: the Approval line still revokes a recorded approval", () => {
  const wf = freshWf();
  writeFileSync(join(wf, "research.md"), "x");
  writeFileSync(join(wf, "plan.md"), buildPlanContent(approvedWorkflowRepo()));
  recordApprovalsForTest(wf);
  const approved = readFileSync(join(wf, "plan.md"), "utf-8");
  writeFileSync(
    join(wf, "plan.md"),
    approved.replace(
      "- Approval Status: approved",
      "- Approval Status: pending",
    ),
  );
  equal(
    evaluateTarget({ projectRoot: "/r", wfDir: wf, target: "/r/src/a.ts" })
      .kind,
    "deny",
  );
});

test("evaluateApprovalReadiness and listApprovalCandidates: ready means every condition but approval", () => {
  const wf = freshWf();
  writeFileSync(join(wf, "research.md"), "x");
  writeFileSync(join(wf, "plan.md"), buildPlanContent(pendingWorkflowRepo()));
  equal(evaluateApprovalReadiness(wf, "plan.md").ready, false);
  equal(listApprovalCandidates(wf).length, 0);
  writeFileSync(
    join(wf, "plan.md"),
    buildPlanContent({
      planStatus: "complete",
      approvalStatus: "pending",
      review: { verdict: "pass" },
    }),
  );
  const r = evaluateApprovalReadiness(wf, "plan.md");
  equal(r.ready, true);
  equal(r.alreadyApproved, false);
  match(r.hash, /^[0-9a-f]{64}$/);
  equal(listApprovalCandidates(wf).join(","), "plan.md");
});

test("two-layer: once spec.md passes, the note and next step ask for 承認 of the owning plan-N.md", () => {
  const wf = freshWf();
  writeFileSync(join(wf, "research.md"), "x");
  writeFileSync(join(wf, "spec.md"), buildPlanContent(approvedWorkflowRepo()));
  recordApprovalsForTest(wf);
  const d = diagnoseGate(wf, join(wf, "..", "src", "a.ts"));
  ok(d.note && /承認 plan-N\.md/.test(d.note));
  match(d.nextAction, /承認 plan-N\.md/);
});
```

同ファイルの既存テストを直す:

- Files の 4・5・6 の fixture で、承認済みの文書を書いた後に `recordApprovalsForTest(wf)` を呼ぶ
- 「points approval at a human when only approval is pending」をテスト名「points approval at a conversational 承認 when only approval is pending」にし、`match(d.nextAction, /human/)` を `match(d.nextAction, /承認 plan\.md/)` にする

document-workflow-guard.test.ts: `createSessionWorkflowRepo`（:38-47）は plan.md を書いた後に `recordApprovalsForTest(join(repo, sessionDir))`、`createTwoLayerRepo` は plan-N.md を書くループの後に `recordApprovalsForTest(join(repo, TEST_WORKFLOW_DIR))` を呼ぶ（import に足す）。

workflow-cli.test.ts: status の approved の 2 件で、文書を書いた後に `recordApprovalsForTest(wf)` を呼ぶ（import に足す）。

- [ ] **Step 2: テストを実行して失敗を確認**

実行: `node --import ./home/dot_claude/hooks/tests/preload-test-env.mjs --test home/dot_claude/hooks/tests/unit/workflow-gate.test.ts`
期待: `evaluateApprovalReadiness` が export されていないので、ファイル全体が SyntaxError で失敗する

- [ ] **Step 3: 最小実装を書く**

workflow-gate.ts（`basename` / `dirname` を `node:path`、`readLatestApprovals` を `./workflow-approval.ts` から import）:

- 冒頭の docstring に「文書の条件には approvals.log の最新の承認 hash（spec K8）を含む。log は approval-recorder だけが書く」と 1 文足す
- `DocumentDiagnosis.conditions` に `approvalRecord: GateCondition;` を足す
- `evaluateDocument` の存在しない文書の分岐に `approvalRecord: { ...empty, expected: "approvals.log records the current hash" }` を足す。存在する文書の分岐で、`computedHash` の後に:

```ts
const ledger = readLatestApprovals(dirname(path));
const recorded = ledger.readError
  ? undefined
  : ledger.latest.get(basename(path))?.hash;
const notes = [
  ledger.ignoredLines > 0 ? `; ignored-lines=${ledger.ignoredLines}` : "",
  ledger.readError ? "; ledger-unreadable" : "",
].join("");
```

を置き、`conditions` に足す:

```ts
      approvalRecord: {
        ok: recorded === computedHash,
        foundLine: `recorded=${recorded ? recorded.slice(0, 12) : "none"} current=${computedHash.slice(0, 12)}${notes}`,
        expected: "approvals.log records the current hash (a human says 承認 in the conversation)",
      },
```

- `isDocumentApproved` の AND に `d.conditions.approvalRecord.ok` を足す
- parent-spec-hash の照合を括り出し、`isImplementationPhase` のループ内（marker を読んで `parentSpecHash !== specHash` を見ている箇所）と `evaluateTarget` のループ内（`marker.parentSpecHash === null || marker.parentSpecHash !== specHash`）をこれに置き換える:

```ts
/**
 * Whether a plan-N.md's latest auto-review marker was stamped against the
 * current spec.md. A missing parent-spec-hash is a mismatch: the plan cannot
 * prove which spec it was approved against.
 */
function parentSpecMatches(planContent: string, specHash: string): boolean {
  const parent =
    parseLatestAutoReviewMarker(planContent)?.parentSpecHash ?? null;
  return parent !== null && parent === specHash;
}
```

- `diagnoseGate` の承認の分岐を置き換える（`approvalStatus` か `approvalRecord` が最初の不成立のとき）:

```ts
    if (
      firstFailure === primary.conditions.approvalStatus ||
      firstFailure === primary.conditions.approvalRecord
    ) {
      nextAction = `会話で「承認 ${basename(primaryPath)}」と書く（承認は人間の発話でだけ記録される）。Run \`workflow-cli status\` to see the full checklist.`;
```

spec が通った後の note と nextAction を置き換える:

```ts
note = `spec.md is approved. The plan-N.md whose ## Files section lists \`${sanitizeForDisplay(targetPath)}\` must also be complete + Review Status: pass + approved by the user saying 「承認 plan-N.md」 in the conversation (approvals.log then records its current hash), with an auto-review marker whose parent-spec-hash equals the current spec.md hash.`;
```

```ts
nextAction =
  "会話で「承認 plan-N.md」（対象を列挙している plan）と書く。`workflow-cli status <path>` で、どの plan が対象を列挙しているかと、足りない条件を確かめる。";
```

- `formatGateDiagnosis` の `order` の末尾に `["approval", d.primary.conditions.approvalRecord]` を足す
- 準備の判定と候補の一覧を足す:

```ts
export interface ApprovalReadiness {
  /** Every gate condition except the approval itself holds. */
  ready: boolean;
  /** Already approved at this exact version (Approval line and ledger agree). */
  alreadyApproved: boolean;
  /** The document's current hash, which an approval would record. */
  hash: string;
}

/**
 * Whether a human approval of `docName` (spec.md / plan.md / plan-N.md in
 * wfDir) would make it pass the gate: Plan Status, Review Status, marker
 * verdict and marker hash hold, and for plan-N.md the marker was stamped
 * against the current spec.md (spec K7).
 */
export function evaluateApprovalReadiness(
  wfDir: string,
  docName: string,
): ApprovalReadiness {
  const path = resolve(wfDir, docName);
  const d = evaluateDocument(path);
  let hash = "";
  let parentOk = true;
  try {
    const content = readFileSync(path, "utf-8");
    hash = computeDocumentHash(content, SPEC_NORMALIZERS);
    if (PLAN_NUMBERED_FILENAME_REGEX.test(docName)) {
      const specHash = computeDocumentHash(
        readFileSync(resolve(wfDir, "spec.md"), "utf-8"),
        SPEC_NORMALIZERS,
      );
      parentOk = parentSpecMatches(content, specHash);
    }
  } catch {
    return { ready: false, alreadyApproved: false, hash };
  }
  const c = d.conditions;
  const ready =
    d.exists &&
    c.planStatus.ok &&
    c.reviewStatus.ok &&
    c.markerVerdict.ok &&
    c.hashMatch.ok &&
    parentOk;
  return {
    ready,
    alreadyApproved: c.approvalStatus.ok && c.approvalRecord.ok,
    hash,
  };
}

/**
 * The documents a bare `承認` could mean: ready for approval and not already
 * approved at their current version. plan.md is listed in two-layer mode
 * too if it exists; it is then just another document to approve. A document whose ledger entry was
 * written but whose Approval line was not rewritten is still listed, so
 * saying 承認 again completes it (spec K7).
 */
export function listApprovalCandidates(wfDir: string): string[] {
  const names = ["spec.md", "plan.md"].filter((name) =>
    existsSync(resolve(wfDir, name)),
  );
  const planNumbered = findPlanNumberedFiles(wfDir).map((path) =>
    basename(path),
  );
  return [...names, ...planNumbered].filter((name) => {
    const r = evaluateApprovalReadiness(wfDir, name);
    return r.ready && !r.alreadyApproved;
  });
}
```

test-helpers.ts: `createWorkflowRepo` は plan.md を書いた後に `recordApprovalsForTest(join(repo, TEST_WORKFLOW_DIR))` を呼ぶ（pending の文書は記録されないので、pending の fixture は変わらない）。

- [ ] **Step 4: テストを実行して通過を確認**

実行: Step 2 と同じ。続けて `bun run test`、`bun run typecheck`、`bun run lint`
期待: workflow-gate.test.ts の新規 7 件と既存分が PASS。`bun run test` の fail 0。ほかに落ちるテストがあれば、承認済みの文書を作っているのに Files の 7 か所から漏れた fixture なので、同じく `recordApprovalsForTest` を足して報告する（判定を緩めて通すことはしない）

- [ ] **Step 5: コミット**

```bash
git add home/dot_claude/hooks/lib/workflow-gate.ts home/dot_claude/hooks/tests/unit/test-helpers.ts home/dot_claude/hooks/tests/unit/workflow-gate.test.ts home/dot_claude/hooks/tests/unit/document-workflow-guard.test.ts home/dot_claude/hooks/tests/unit/workflow-cli.test.ts
git commit -m "feat(hooks): require a recorded human approval of the current version"
```

### T3: 会話の「承認」を記録する hook（K7）

**Files:**

- 新規: `H/implementations/approval-recorder.ts`、`H/tests/unit/approval-recorder.test.ts`
- 編集: `home/dot_claude/.settings.hooks.json.tmpl:269-291`（UserPromptSubmit に登録）
- 参照: `H/tests/unit/test-helpers.ts`（`createUserPromptSubmitContext` は cwd `/test`、`session_id` TEST_SESSION_ID。`jsonCalls` は `payload.output` を溜める）

- [ ] **Step 1: 失敗するテストを書く**

```ts
#!/usr/bin/env node --test

import { strict as assert } from "node:assert";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import hook, {
  parseApprovalUtterance,
} from "../../implementations/approval-recorder.ts";
import {
  appendApproval,
  readLatestApprovals,
} from "../../lib/workflow-approval.ts";
import { evaluateTarget } from "../../lib/workflow-gate.ts";
import { deriveDefaultWorkflowDir } from "../../lib/workflow-paths.ts";
import {
  buildPlanContent,
  buildPlanNContent,
  computeWorkflowRepoPlanHash,
  createUserPromptSubmitContext,
  EnvironmentHelper,
  invokeRun,
  recordApprovalsForTest,
  TEST_SESSION_ID,
  type WorkflowRepoOptions,
} from "./test-helpers.ts";

const REVIEWED: WorkflowRepoOptions = {
  planStatus: "complete",
  approvalStatus: "pending",
  review: { verdict: "pass" },
};
const APPROVED: WorkflowRepoOptions = {
  ...REVIEWED,
  approvalStatus: "approved",
};

describe("parseApprovalUtterance (spec K7)", () => {
  it("accepts the bare word, document names and a trailing mark", () => {
    assert.deepEqual(parseApprovalUtterance("承認"), { docs: [] });
    assert.deepEqual(parseApprovalUtterance("  Approve!  "), { docs: [] });
    assert.deepEqual(parseApprovalUtterance("承認 plan-2.md spec.md。"), {
      docs: ["plan-2.md", "spec.md"],
    });
    assert.deepEqual(parseApprovalUtterance("承認 plan-2.md plan-2.md"), {
      docs: ["plan-2.md"],
    });
  });

  it("ignores anything else", () => {
    for (const prompt of [
      "承認します",
      "承認、ただし T3 は直して",
      "approve this?",
      "plan.md 承認",
      "承認 notes.md",
      "承認 PLAN.MD",
      "/execute-plan 承認",
      "承認\n追記",
      "ok",
    ]) {
      assert.equal(
        parseApprovalUtterance(prompt),
        null,
        JSON.stringify(prompt),
      );
    }
  });
});

describe("approval-recorder (spec K7)", () => {
  const envHelper = new EnvironmentHelper();
  let repo: string;
  let wf: string;

  beforeEach(() => {
    repo = realpathSync(mkdtempSync(join(tmpdir(), "approval-recorder-")));
    wf = join(repo, deriveDefaultWorkflowDir(TEST_SESSION_ID));
    mkdirSync(wf, { recursive: true });
    writeFileSync(join(wf, "research.md"), "x");
    envHelper.set("CLAUDE_TEST_CWD", repo);
    envHelper.set("DOCUMENT_WORKFLOW_DIR", undefined);
  });

  afterEach(() => {
    envHelper.restore();
  });

  async function say(prompt: string, extra: Record<string, unknown> = {}) {
    const ctx = createUserPromptSubmitContext(prompt);
    Object.assign(ctx.input, extra);
    await invokeRun(hook, ctx);
    return { ctx, text: JSON.stringify(ctx.jsonCalls) };
  }

  it("records the only document awaiting approval and opens the gate", async () => {
    writeFileSync(join(wf, "plan.md"), buildPlanContent(REVIEWED));
    const { text } = await say("承認");
    const { latest } = readLatestApprovals(wf);
    assert.equal(
      latest.get("plan.md")?.hash,
      computeWorkflowRepoPlanHash(readFileSync(join(wf, "plan.md"), "utf-8")),
    );
    assert.equal(latest.get("plan.md")?.session, TEST_SESSION_ID);
    assert.match(
      readFileSync(join(wf, "plan.md"), "utf-8"),
      /^- Approval Status: approved$/m,
    );
    assert.match(text, /plan\.md を hash=[0-9a-f]{12} で承認として記録/);
    assert.match(text, /"systemMessage"/);
    assert.equal(
      evaluateTarget({
        projectRoot: repo,
        wfDir: wf,
        target: join(repo, "src", "a.ts"),
      }).kind,
      "allow",
    );
  });

  it("records nothing and asks for a name when two plans await approval", async () => {
    const spec = buildPlanContent(APPROVED);
    writeFileSync(join(wf, "spec.md"), spec);
    recordApprovalsForTest(wf);
    const specHash = computeWorkflowRepoPlanHash(spec);
    writeFileSync(
      join(wf, "plan-1.md"),
      buildPlanNContent(REVIEWED, ["src/a.ts"], specHash),
    );
    writeFileSync(
      join(wf, "plan-2.md"),
      buildPlanNContent(REVIEWED, ["src/b.ts"], specHash),
    );
    const before = readFileSync(join(wf, "approvals.log"), "utf-8");
    const { text } = await say("承認");
    assert.equal(readFileSync(join(wf, "approvals.log"), "utf-8"), before);
    assert.match(text, /承認を待っている文書が 2 件/);
    assert.match(text, /承認 plan-1\.md/);
  });

  it("records every named document, or none when one of them is not ready", async () => {
    const spec = buildPlanContent(REVIEWED);
    writeFileSync(join(wf, "spec.md"), spec);
    const specHash = computeWorkflowRepoPlanHash(spec);
    writeFileSync(
      join(wf, "plan-1.md"),
      buildPlanNContent(REVIEWED, ["src/a.ts"], specHash),
    );
    writeFileSync(
      join(wf, "plan-2.md"),
      buildPlanNContent(
        { planStatus: "drafting", approvalStatus: "pending" },
        [],
        specHash,
      ),
    );

    await say("承認 spec.md plan-2.md");
    assert.equal(existsSync(join(wf, "approvals.log")), false);

    await say("承認 spec.md plan-1.md");
    assert.deepEqual([...readLatestApprovals(wf).latest.keys()].sort(), [
      "plan-1.md",
      "spec.md",
    ]);
  });

  it("completes a half-done approval when the user says it again", async () => {
    const plan = buildPlanContent(REVIEWED);
    writeFileSync(join(wf, "plan.md"), plan);
    appendApproval(wf, {
      doc: "plan.md",
      hash: computeWorkflowRepoPlanHash(plan),
      session: TEST_SESSION_ID,
      at: "t",
    });
    await say("承認");
    assert.match(
      readFileSync(join(wf, "plan.md"), "utf-8"),
      /^- Approval Status: approved$/m,
    );
    assert.equal(
      evaluateTarget({
        projectRoot: repo,
        wfDir: wf,
        target: join(repo, "src", "a.ts"),
      }).kind,
      "allow",
    );
  });

  it("does nothing for an ordinary prompt, inside a subagent, or for a prompt the user did not type", async () => {
    writeFileSync(join(wf, "plan.md"), buildPlanContent(REVIEWED));
    const ordinary = await say("T3 の方針を説明して");
    assert.deepEqual(ordinary.ctx.jsonCalls, []);
    const inSubagent = await say("承認", { agent_id: "agent-1" });
    assert.match(inSubagent.text, /記録していない/);
    for (const source of [
      "schedule_wakeup",
      "loop_wakeup",
      "poll_event",
      "system",
      "sdk",
    ]) {
      const { text } = await say("承認", { source });
      assert.match(text, new RegExp(`source=${source}.*記録していない`));
    }
    assert.equal(existsSync(join(wf, "approvals.log")), false);
    await say("承認", { source: "user" });
    assert.equal(readLatestApprovals(wf).latest.has("plan.md"), true);
  });

  it("does not rewrite a document that is a symlink, and leaves no temp file", async () => {
    const outside = join(repo, "outside-plan.md");
    writeFileSync(outside, buildPlanContent(REVIEWED));
    symlinkSync(outside, join(wf, "plan.md"));
    const { text } = await say("承認");
    assert.match(
      readFileSync(outside, "utf-8"),
      /^- Approval Status: pending$/m,
    );
    assert.match(text, /通常のファイルではない/);
    assert.deepEqual(
      readdirSync(wf).filter((name) => name.endsWith(".approval-tmp")),
      [],
    );
  });

  it("reports a failure instead of claiming success when the ledger cannot be written", async () => {
    writeFileSync(join(wf, "plan.md"), buildPlanContent(REVIEWED));
    mkdirSync(join(wf, "approvals.log"));
    const { text } = await say("承認");
    assert.match(text, /記録できなかった可能性/);
    assert.match(
      readFileSync(join(wf, "plan.md"), "utf-8"),
      /^- Approval Status: pending$/m,
    );
  });
});
```

- [ ] **Step 2: テストを実行して失敗を確認**

実行: `node --import ./home/dot_claude/hooks/tests/preload-test-env.mjs --test home/dot_claude/hooks/tests/unit/approval-recorder.test.ts`
期待: モジュールが無いので `ERR_MODULE_NOT_FOUND` で失敗する

- [ ] **Step 3: 最小実装を書く**

```ts
#!/usr/bin/env -S bun run --silent

/**
 * Records a human approval said in the conversation (spec K7). The gate
 * accepts a workflow document only when approvals.log holds its current
 * hash (spec K8), and only this hook writes that file: the guard denies
 * tool writes to the ledger and to the Approval line (spec K9). An approval
 * therefore names a version that was in front of the user, and a later
 * revision needs a new one (#221).
 *
 * Reacts only when the whole prompt is the approval and nothing else, so
 * "承認します、ただし…" or a sentence that mentions 承認 never records one,
 * and only when the user typed it: the input's `source` is "user" or absent
 * (scheduled, polled and SDK prompts carry another value), outside any
 * subagent. ADR-0022 records why an absent `source` is accepted.
 */

import { randomBytes } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import { defineHook } from "cc-hooks-ts";
import { getProjectRoot } from "../lib/project-root.ts";
import { appendApproval } from "../lib/workflow-approval.ts";
import {
  evaluateApprovalReadiness,
  evaluateDocument,
  listApprovalCandidates,
} from "../lib/workflow-gate.ts";
import { setApprovalStatusLine } from "../lib/workflow-marker.ts";
import { resolveWorkflowDir } from "../lib/workflow-resolve.ts";

// The keyword alone is case-insensitive; document names are not, so a
// case-insensitive filesystem cannot turn `PLAN.MD` into a ledger key the
// gate never looks up.
const UTTERANCE =
  /^(?:承認|[Aa][Pp][Pp][Rr][Oo][Vv][Ee])((?:[ \t　]+(?:spec\.md|plan\.md|plan-[0-9]+\.md))*)[ \t　]*[。.!！]?$/;

/** The document names in an approval utterance, or null when the prompt is not one. */
export function parseApprovalUtterance(
  prompt: string,
): { docs: string[] } | null {
  const match = UTTERANCE.exec(prompt.trim());
  if (!match) return null;
  const names = (match[1] ?? "")
    .trim()
    .split(/[ \t　]+/)
    .filter(Boolean);
  return { docs: [...new Set(names)] };
}

function approvalOutput(text: string) {
  const message = `[approval-recorder] ${text}`;
  return {
    event: "UserPromptSubmit" as const,
    output: {
      systemMessage: message,
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit" as const,
        additionalContext: message,
      },
    },
  };
}

/**
 * Rewrite the Approval line so a crash never leaves a truncated document:
 * write a uniquely named temp file opened with O_EXCL (it cannot follow a
 * planted symlink or reuse an existing name), keep the document's mode,
 * then rename over the document. A symlinked document is left alone: the
 * hook must not write outside the workflow dir. Returns whether the line
 * was rewritten (false when it already said approved or is missing).
 */
function setApprovalLineApproved(path: string): boolean {
  const stat = lstatSync(path);
  if (!stat.isFile()) return false;
  const content = readFileSync(path, "utf-8");
  const updated = setApprovalStatusLine(content, "approved");
  if (updated === null || updated === content) return false;
  const temp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.approval-tmp`;
  const fd = openSync(temp, "wx", stat.mode & 0o777);
  try {
    try {
      writeFileSync(fd, updated);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temp, path);
  } catch (error) {
    try {
      rmSync(temp, { force: true }); // any failure after the temp exists leaves nothing behind
    } catch {
      // keep the original error; a leftover temp is named *.approval-tmp and harmless
    }
    throw error;
  }
  return true;
}

/**
 * Record one document and say what state it ended in. Each document is its
 * own step, so a failure on one still reports the others; a failure after
 * the ledger line was written says so, since the gate then waits only for
 * the Approval line.
 */
function recordOne(
  wfDir: string,
  doc: string,
  hash: string,
  session: string,
  at: string,
): string {
  const path = resolve(wfDir, doc);
  let logged = false;
  try {
    appendApproval(wfDir, { doc, hash, session, at });
    logged = true;
    if (!lstatSync(path).isFile()) {
      return `${doc} は通常のファイルではない（symlink など）ので承認行を書き換えていない。log には記録したので、利用者が承認行を手で approved にすれば gate は通る。`;
    }
    const rewritten = setApprovalLineApproved(path);
    const c = evaluateDocument(path).conditions;
    if (c.approvalRecord.ok && c.approvalStatus.ok) {
      return rewritten
        ? `${doc} を hash=${hash.slice(0, 12)} で承認として記録し、承認行を approved に書き換えた。`
        : `${doc} を hash=${hash.slice(0, 12)} で承認として記録した（承認行は既に approved）。`;
    }
    return `${doc} の承認を記録しようとしたが gate の条件がそろっていない（log ${c.approvalRecord.ok ? "済" : "未"}、承認行 ${c.approvalStatus.ok ? "済" : "未"}）。もう一度「承認 ${doc}」と書くか、\`workflow-cli status\` で確認する。`;
  } catch (error) {
    const state = logged
      ? "log には記録したが、承認行の書き換えに失敗した"
      : "記録できなかった可能性がある";
    return `${doc}: ${state}（${String(error).slice(0, 120)}）。もう一度「承認 ${doc}」と書くか、\`workflow-cli status\` で確認する。`;
  }
}

/**
 * Only prompts the user typed count. Claude Code tags scheduled and relayed
 * prompts with `source` (loop_wakeup, schedule_wakeup, poll_event, system,
 * sdk); an absent field (an older Claude Code) is treated as typed.
 */
function isTypedByUser(source: string | undefined): boolean {
  return source === undefined || source === "user";
}

const hook = defineHook({
  trigger: { UserPromptSubmit: true },
  run: (context) => {
    const utterance = parseApprovalUtterance(context.input.prompt);
    if (utterance === null) {
      return context.success({});
    }
    if (
      context.input.agent_id !== undefined ||
      !isTypedByUser(context.input.source)
    ) {
      // Say so rather than drop it: if a front-end tags typed prompts with
      // another source, the user must learn the approval was not recorded.
      return context.json(
        approvalOutput(
          `承認の形のプロンプトを受け取ったが、利用者が打ったものではない（source=${context.input.source ?? "none"}${context.input.agent_id !== undefined ? ", subagent" : ""}）ので記録していない。`,
        ),
      );
    }
    try {
      const resolution = resolveWorkflowDir({
        cwd: getProjectRoot(),
        sessionId: context.input.session_id,
      });
      if (resolution.source === "unresolvable") {
        return context.json(
          approvalOutput(
            "承認の発話を受け取ったが、この session の workflow dir を解決できないので何も記録していない。",
          ),
        );
      }
      const wfDir = resolution.dir;

      let targets: string[];
      if (utterance.docs.length > 0) {
        const notReady = utterance.docs.filter(
          (doc) => !evaluateApprovalReadiness(wfDir, doc).ready,
        );
        if (notReady.length > 0) {
          return context.json(
            approvalOutput(
              `${notReady.join(", ")} は承認以外の条件（Plan / Review / marker / parent-spec-hash）を満たしていないので、何も記録していない。\`workflow-cli status\` で確認する。`,
            ),
          );
        }
        targets = utterance.docs;
      } else {
        targets = listApprovalCandidates(wfDir);
        if (targets.length !== 1) {
          return context.json(
            approvalOutput(
              targets.length === 0
                ? "承認を待っている文書が無いので、何も記録していない。"
                : `承認を待っている文書が ${targets.length} 件あるので、何も記録していない。文書名を付けて ${targets.map((doc) => `「承認 ${doc}」`).join(" / ")} と書いてもらう。`,
            ),
          );
        }
      }

      // Hashes first, then the ledger, then the display: a failure part-way
      // leaves the gate closed (it needs both), and saying 承認 again
      // finishes the job. Each document is reported on its own.
      const planned = targets.map((doc) => ({
        doc,
        hash: evaluateApprovalReadiness(wfDir, doc).hash,
      }));
      const at = new Date().toISOString();
      const notes = planned.map(({ doc, hash }) =>
        recordOne(wfDir, doc, hash, context.input.session_id, at),
      );
      notes.push(
        "編集する前に文書を読み直す。取り消すには承認行を pending に戻す。",
      );
      return context.json(approvalOutput(notes.join(" ")));
    } catch (error) {
      console.error("[approval-recorder] internal error:", error);
      return context.json(
        approvalOutput(
          `承認の記録中にエラーが起きた（${String(error).slice(0, 200)}）。記録できなかった可能性がある。\`workflow-cli status\` で確認する。`,
        ),
      );
    }
  },
});

export default hook;

if (import.meta.main) {
  const { runHook } = await import("cc-hooks-ts");
  await runHook(hook);
}
```

（`context.input.agent_id` と `context.input.source` は cc-hooks-ts 2.1.281 の UserPromptSubmit の入力型にある任意フィールド（`index.d.mts` で確認済み。`source` は `user` / `sdk` / `system` / `loop_wakeup` / `schedule_wakeup` / `poll_event`）。`approvalOutput` の戻り値は `SyncHookResultJSON` の UserPromptSubmit の形に合う（logic-validator が型で確認済み））

`H/lib/workflow-marker.ts` に承認行の書き換えを足す（承認行の書式の定義を 1 か所に置くため。hook はこれを呼ぶ）:

```ts
/**
 * The content with its Approval Status line set to `value`, or null when
 * the document has no such line. Only the first strict-form line is
 * rewritten -- the one the gate reads.
 */
export function setApprovalStatusLine(
  content: string,
  value: "approved" | "pending",
): string | null {
  const line = /^- Approval Status:.*$/m;
  if (!line.test(content)) return null;
  return content.replace(line, `- Approval Status: ${value}`);
}
```

`.settings.hooks.json.tmpl` の UserPromptSubmit の `hooks` 配列で、`user-prompt-logger.ts` の次に足す（`async` は付けない）:

```json
        {
          "type": "command",
          "command": "bun {{ .chezmoi.homeDir }}/.claude/hooks/implementations/approval-recorder.ts"
        },
```

- [ ] **Step 4: テストを実行して通過を確認**

実行: Step 2 と同じ。続けて `bun run test`（hook-target-drift の検査が tmpl の参照と実装ファイルの対応を確かめる）、`bun run typecheck`、`bun run lint`
期待: 新規 9 件 PASS、`bun run test` の fail 0

- [ ] **Step 5: コミット**

```bash
git add home/dot_claude/hooks/implementations/approval-recorder.ts home/dot_claude/hooks/lib/workflow-marker.ts home/dot_claude/hooks/tests/unit/approval-recorder.test.ts home/dot_claude/.settings.hooks.json.tmpl
git commit -m "feat(hooks): record a conversational approval in the ledger"
```

### T4: model による承認の書き込みを guard で止める（K9）

**Files:**

- 編集: `H/implementations/document-workflow-guard.ts`（run の、`const wfDir = resolution.dir;` の直後。新規の判定関数）
- テスト: `H/tests/unit/document-workflow-guard.test.ts`（"approval writes (spec K9)" の describe を新設）

- [ ] **Step 1: 失敗するテストを書く**

```ts
describe("document-workflow-guard.ts approval writes (spec K9)", () => {
  const envHelper = new EnvironmentHelper();
  const hook = documentWorkflowGuardHook;

  afterEach(() => {
    envHelper.restore();
  });

  function repoWith(options: WorkflowRepoOptions): {
    repo: string;
    wf: string;
  } {
    const repo = realpathSync(createWorkflowRepo(options));
    envHelper.set("DOCUMENT_WORKFLOW_DIR", TEST_WORKFLOW_DIR);
    envHelper.set("CLAUDE_TEST_CWD", repo);
    return { repo, wf: join(repo, TEST_WORKFLOW_DIR) };
  }

  async function run(
    tool: "Write" | "Edit" | "MultiEdit",
    input: Record<string, unknown>,
  ) {
    const ctx = createPreToolUseContextFor(hook, tool, input);
    await invokeRun(hook, ctx);
    return ctx;
  }

  it("denies an Edit or MultiEdit that turns the Approval line to approved", async () => {
    const { wf } = repoWith(pendingWorkflowRepo());
    (
      await run("Edit", {
        file_path: join(wf, "plan.md"),
        old_string: "- Approval Status: pending",
        new_string: "- Approval Status: approved",
      })
    ).assertDeny();
    (
      await run("MultiEdit", {
        file_path: join(wf, "plan.md"),
        edits: [
          {
            old_string: "- Approval Status: pending",
            new_string: "- Approval Status: approved",
          },
        ],
      })
    ).assertDeny();
  });

  it("denies a Write that creates or rewrites a document as approved, even without the hyphen", async () => {
    const { wf } = repoWith(pendingWorkflowRepo());
    (
      await run("Write", {
        file_path: join(wf, "plan-9.md"),
        content: "- Approval Status: approved\n",
      })
    ).assertDeny();
    (
      await run("Write", {
        file_path: join(wf, "plan.md"),
        content: "Approval Status: approved\n",
      })
    ).assertDeny();
  });

  it("allows revoking and rewriting an approved document without changing the value", async () => {
    const { wf } = repoWith(approvedWorkflowRepo());
    const approved = readFileSync(join(wf, "plan.md"), "utf-8");
    (
      await run("Write", {
        file_path: join(wf, "plan.md"),
        content: `${approved}\n`,
      })
    ).assertSuccess({});
    (
      await run("Edit", {
        file_path: join(wf, "plan.md"),
        old_string: "- Approval Status: approved",
        new_string: "- Approval Status: pending",
      })
    ).assertSuccess({});
  });

  it("denies tool writes to this or another session's approvals.log, in any letter case", async () => {
    const { repo, wf } = repoWith(approvedWorkflowRepo());
    for (const path of [
      join(wf, "approvals.log"),
      join(wf, "APPROVALS.LOG"),
      join(repo, ".tmp", "sessions", "otherses", "approvals.log"),
      join(repo, ".tmp", "sessions", "a", "b", "approvals.log"),
      join(repo, ".TMP", "SESSIONS", "otherses", "approvals.log"),
    ]) {
      (await run("Write", { file_path: path, content: "{}\n" })).assertDeny();
    }
  });

  it("judges a document path written with different letter case the same way", async () => {
    // Approved workflow: an off-plan write is only warned about, so K9 is the
    // only thing that can deny. Two approved lines exceed the existing one
    // whether the upper-case path aliases plan.md (macOS) or is new (Linux).
    const { repo } = repoWith(approvedWorkflowRepo());
    const upper = join(repo, TEST_WORKFLOW_DIR.toUpperCase(), "PLAN.MD");
    (
      await run("Write", {
        file_path: upper,
        content: "- Approval Status: approved\n- Approval Status: approved\n",
      })
    ).assertDeny();
  });

  it("refuses an Edit whose old_string is not found but whose new_string adds approval", async () => {
    const { wf } = repoWith(pendingWorkflowRepo());
    (
      await run("Edit", {
        file_path: join(wf, "plan.md"),
        old_string: "- Approval Status: “pending”",
        new_string: "- Approval Status: approved",
      })
    ).assertDeny();
  });
});
```

（`realpathSync` / `readFileSync` を `node:fs` の、`approvedWorkflowRepo` / `type WorkflowRepoOptions` を `./test-helpers.ts` の既存の import に足す。`createWorkflowRepo(approvedWorkflowRepo())` は T2 で log を持つので実装フェーズになっている）

- [ ] **Step 2: テストを実行して失敗を確認**

実行: `node --import ./home/dot_claude/hooks/tests/preload-test-env.mjs --test home/dot_claude/hooks/tests/unit/document-workflow-guard.test.ts`
期待: 新規 6 件のうち 5 件が FAIL（Edit / MultiEdit、Write、log の各パス、大文字のパス、見つからない old_string。承認済みの fixture では文書の近道か実装フェーズの緩和で通るので、変更前は deny されない）。Edit / MultiEdit / Write で approved にする件は、wfDir の `.md` が文書の近道で通るので deny されない。`approvals.log` の件は、承認済み（実装フェーズ）の fixture では書き込みが許されるか off-plan の緩和で通るので deny されない。取り消しと同じ値の書き換えの件は、変更前でも PASS（負例の固定）

- [ ] **Step 3: 最小実装を書く**

document-workflow-guard.ts（`APPROVALS_LOG` を `../lib/workflow-approval.ts`、`resolveWithMissingTail` を `../lib/workflow-fs.ts`、`LENIENT_APPROVED_LINE` を `../lib/workflow-marker.ts` から import。`basename` を `node:path` の import に、`existsSync` / `readFileSync` を `node:fs` の import に足す。既にあるものは足さない）:

run の中、`const wfDir = resolution.dir;` の直後（workflow の active 判定と文書の近道より前）に:

```ts
// K9: approval is a human utterance recorded by approval-recorder. A
// tool write that makes a document read as approved, or touches a
// ledger, is refused whatever phase the workflow is in -- the gate
// would still hold (K8), but the document would mislead both the
// human and the model into thinking it was approved (#221).
const approvalWriteReason = checkApprovalWrite(
  tool_name,
  tool_input,
  cwd,
  projectRoot,
  wfDir,
);
if (approvalWriteReason !== null) {
  return context.json(createDenyResponse(approvalWriteReason));
}
```

ファイル末尾近くに足す:

```ts
function countApprovedLines(content: string): number {
  return content.match(LENIENT_APPROVED_LINE)?.length ?? 0;
}

/** Paths compare without case: macOS's filesystem ignores it and Node's realpath keeps what was typed. */
function isUnder(path: string, dir: string): boolean {
  return path.toLowerCase().startsWith(`${dir.toLowerCase()}/`);
}

/**
 * Why a Write / Edit / MultiEdit must be refused as an approval write, or
 * null. Approved Approval lines are counted in their lenient form, so a
 * hyphen-less `Approval Status: approved` (which the gate's strict form
 * ignores but a reader would not) is caught, and an old text that merely
 * quotes such a line does not let the real line be flipped. Paths compare
 * as realpaths so a symlinked or aliased path into the workflow dir is
 * judged the same way.
 */
function checkApprovalWrite(
  toolName: string,
  toolInput: unknown,
  cwd: string,
  projectRoot: string,
  wfDir: string,
): string | null {
  // Fail closed: this check runs inside the guard's catch-all, which allows
  // the call on an exception. A write the guard cannot judge is refused.
  try {
    return judgeApprovalWrite(toolName, toolInput, cwd, projectRoot, wfDir);
  } catch (error) {
    return `Could not judge whether this write sets approval or touches a ledger (${sanitizeForDisplay(String(error))}); refused.`;
  }
}

function judgeApprovalWrite(
  toolName: string,
  toolInput: unknown,
  cwd: string,
  projectRoot: string,
  wfDir: string,
): string | null {
  if (!isRecord(toolInput)) return null;
  if (toolName !== "Write" && toolName !== "Edit" && toolName !== "MultiEdit")
    return null;
  const filePath = toolInput.file_path;
  if (typeof filePath !== "string") return null;
  const target = resolve(cwd, expandTilde(filePath));
  const realTarget = resolveWithMissingTail(target) ?? target;

  const sessionsDir = resolve(projectRoot, ".tmp", "sessions");
  const realSessions = resolveWithMissingTail(sessionsDir) ?? sessionsDir;
  if (
    basename(realTarget).toLowerCase() === APPROVALS_LOG &&
    isUnder(realTarget, realSessions)
  ) {
    return `${APPROVALS_LOG} is written only by approval-recorder when the user says 承認 in the conversation; tool writes to any session's ledger are refused.`;
  }

  const realWfDir = resolveWithMissingTail(wfDir) ?? wfDir;
  if (!isUnder(realTarget, realWfDir) || !/\.md$/i.test(realTarget))
    return null;
  let oldContent: string | null = null;
  try {
    oldContent = existsSync(target) ? readFileSync(target, "utf-8") : null;
  } catch {
    oldContent = null; // unreadable: judge as if new, so an approved write is refused
  }
  const newContent = contentAfterWrite(toolName, toolInput, oldContent);
  if (newContent === null) return null;
  if (countApprovedLines(newContent) <= countApprovedLines(oldContent ?? ""))
    return null;
  return `Approval is recorded only from the user's own words: ask the user to write 「承認 ${basename(target)}」 in the conversation. Writes that set \`Approval Status: approved\` are refused; setting it back to pending (revoking) is allowed.`;
}

/** The file content a Write / Edit / MultiEdit would leave, or null when it cannot be told. */
function contentAfterWrite(
  toolName: string,
  toolInput: Record<string, unknown>,
  oldContent: string | null,
): string | null {
  if (toolName === "Write") {
    return typeof toolInput.content === "string" ? toolInput.content : null;
  }
  const edits =
    toolName === "Edit"
      ? [toolInput]
      : Array.isArray(toolInput.edits)
        ? (toolInput.edits as unknown[])
        : [];
  let content = oldContent ?? "";
  for (const edit of edits) {
    if (
      !isRecord(edit) ||
      typeof edit.old_string !== "string" ||
      typeof edit.new_string !== "string"
    ) {
      return null;
    }
    const replacement = edit.new_string;
    if (!content.includes(edit.old_string)) {
      // The real tool may still match (it normalizes quotes); judge as if the
      // new text were added, so an approved line in it is counted.
      content = `${content}\n${replacement}`;
      continue;
    }
    content =
      edit.replace_all === true
        ? content.split(edit.old_string).join(replacement)
        : content.replace(edit.old_string, () => replacement);
  }
  return content;
}
```

（`String.prototype.replace` に関数を渡すのは、`new_string` の `$&` などを特殊文字として解釈させないため。`projectRoot` は run の中で plan-2 から定義済み。`sanitizeForDisplay` は guard で既に import 済み。`dirname` は使わないので import しない。NotebookEdit は `.ipynb` だけを書くので対象にしない）

`H/lib/workflow-marker.ts` に寛容な承認行の定数を足し、guard はこれを import する。冒頭の docstring の「寛容な形は表示専用」の段落に「ただし `LENIENT_APPROVED_LINE` は deny 方向の保守的な検出（K9）に使う。承認の成立（allow）には使わない」と 1 文足す:

```ts
/**
 * An Approval line that reads as approved, hyphen or not (spec K9). For
 * refusing writes only: the gate decides approval with the strict form.
 */
export const LENIENT_APPROVED_LINE =
  /^\s*-?\s*Approval Status:\s*approved\b/gim;
```

- [ ] **Step 4: テストを実行して通過を確認**

実行: Step 2 と同じ。続けて `bun run test`、`bun run typecheck`、`bun run lint`
期待: 新規 6 件 PASS、既存の guard テスト全件 PASS（承認済みの fixture は T2 で log を持ち、ツールでは承認行を書かない）。`bun run test` の fail 0

- [ ] **Step 5: コミット**

```bash
git add home/dot_claude/hooks/implementations/document-workflow-guard.ts home/dot_claude/hooks/lib/workflow-marker.ts home/dot_claude/hooks/tests/unit/document-workflow-guard.test.ts
git commit -m "feat(hooks): refuse tool writes that set approval or touch a ledger"
```

### T5: ADR-0022 と文書（K12）

**Files:**

- 新規: `docs/decisions/0022-workflow-identity.md`
- 編集: `docs/decisions/0013-workflow-dir-session-derivation.md:85-89`（Open observation items 1 に解消を追記）
- 編集: `home/dot_claude/rules/workflow.md`（共通フロー 7、二層モードの承認順、CRITICAL 節、Executive Summary の Next Action）
- 編集: `H/lib/workflow-review-core.ts:880`（hook が出す Executive Summary の雛形の Next Action）
- 編集: `.skills/document-workflow-reference/SKILL.md`（承認の手順、worktree での手順、`/clear` の節の古い 2 文）

- [ ] **Step 1: ADR-0022 を書く**

`docs/decisions/0020-boundary-deny-rephrase.md` と同じ構成（Status / Context / Decision / 却下した代替案 / Consequences / References）で書く。Status は `accepted (YYYY-MM-DD)` で、日付は実装した日（`date +%F`）を入れる。Decision には spec K1〜K12 を 1〜3 文ずつ要約し、spec からの差として次を明記する: 名前を付けた承認は全か無か（K7 の具体化）、文書名は大文字小文字を区別し `approve` だけを区別しない（K7）、`source` が `user` か無いとき・`agent_id` が無いときだけ記録する（K7）、返答を `systemMessage` でも出す（K7）、K9 は値の比較ではなく承認済みの行の数で比べ、パスは realpath と大文字小文字を無視して比べる、K9 は自分のセッションに加えて `.tmp/sessions` の下のすべての `approvals.log` を守る、読めない log は gate を閉じたまま `ledger-unreadable` と診断する（K8）、`workflow-approval.ts` は葉のモジュール（spec の Architecture 節の `document-hash ← workflow-approval` の矢印は不要だった）、K4 の検査テストの許可リストを狭めた（Consequences 9）。

Context には V1 の結果（`/clear` で `CLAUDE_CODE_SESSION_ID` は hook の `session_id` に追従し、`/resume` では維持される。research.md の実測）を書く。

Consequences には次の 13 項目を必ず含める（各 1〜3 文）。数値を書く項目（9・10）は、書く前に plan-2 / plan-4 の該当箇所（plan-2 の方針と範囲、plan-4 の T4）と突き合わせる:

1. **配備後は Claude Code を起動し直す**（spec R6）: 配備前のセッションの Bash env には旧 SessionStart の `DOCUMENT_WORKFLOW_DIR` が残り、`CLAUDE_PROJECT_DIR` は無いので CLI は失敗する。rules/workflow.md の古い記述も context に残るので、起動し直すまで model の書き込み先を信用しない
2. **進行中の workflow の再承認**（spec R1）: 配備前の承認は log に無いので gate が止める。診断の指示どおり会話で「承認 <文書名>」と書けば戻る。互換の例外は設けない
3. **承認の後に hook が文書を書き換える**: model の次の Edit が「読み込み後に変更された」で失敗しうる。読み直せばよい
4. **task-handoff の複製でも承認が引き継がれる**: log の `session` は照合に使わない。文書が同じ版なら承認は有効
5. **人間による手動の再承認**: 取り消した後で人間が承認行を手で approved に戻すと、log の最新 hash が一致していれば再発話なしで通る。model には K9 でできない
6. **log の `v` を上げるときは読み手を先に配備する**: 読み手は `v !== 1` の行を読み飛ばして `ignored-lines` を出す。書き手だけを先に上げると、すべての承認が読み飛ばされる
7. **`ignored-lines` と `ledger-unreadable` を診断に必ず出す**: 読み飛ばした行や読めない log を黙って捨てない理由。読めない log は gate を閉じたままにする（例外にすると guard が fail-open で通すため）
8. **`CLAUDE_PROJECT_DIR` は export し続ける**: Bash の env に残る値だが、`/clear` をまたいでも同じプロジェクトを指すので #197 の取り違えは起きない。`CLAUDE_TEST_CWD` が本番に漏れると優先される点は followups 課題 E で追跡中
9. **K4 の検査テストの許可リストを spec から狭めた**: spec は 4 か所を挙げたが、禁止形を含むのは guard の docstring 2 か所だけだった（session.ts と workflow-resolve.ts は `process.env.…` で禁止形に当たらず、unified-audio-config.ts は走査の対象外）
10. **spec K1 の「11 ファイル」と実際に置き換えた 9 ファイルの差**: plan-review-automation と file-access-guard はツール cwd の用途しか持たなかった（file-access-guard は K10 で `getProjectRoot()` を新たに使う）
11. **Bash による log への追記は止めない**（spec R4）: 不注意な逸脱を止める仕組みで、意図的な迂回への耐性は主張しない
12. **出どころの判定は `source` に頼る**: 公式ドキュメントの UserPromptSubmit の入力には載っていないが、cc-hooks-ts 2.1.281 の型にある `source` が `user` か無いときだけ記録する。値が無い古い Claude Code では予約したプロンプトを区別できない。model が「承認」だけのプロンプトを予約するのは意図的な迂回で R4 の外。サブエージェントの中の発火（`agent_id` あり）も記録しない。実測の結果（Step 6）を、別のコミットでここに追記する
13. **文書名なしの「承認」は、承認待ちが 1 件なら別の話題への返事でも記録される**（spec R7）: 記録したら対象・hash・取り消し方を `additionalContext` と `systemMessage` で必ず伝える

却下した代替案には spec の Alternative Approaches 節の差分最小案と、承認の経路の候補（承認行を model が書く現行のまま hash だけ記録する案、`/execute-plan` を承認として残す案、承認行を人間が手で書き換える案）を書く。References には spec / plan の置き場（`.tmp/sessions/7d715a2f/`。GC されるので要点はこの ADR に書き切る）、ADR-0013、Issue #197 / #221 / #209 / #216、実装 commit の一覧（`git log --oneline fbfe556..HEAD` の結果）を書く。

- [ ] **Step 2: ADR-0013 に解消を追記する**

Open observation items 1 の末尾に「→ ADR-0022 で解消: hook と CLI の root を `CLAUDE_PROJECT_DIR`（session 開始時の dir）に固定し、worktree / `cd` で wfDir が動かないようにした。」と足す。

- [ ] **Step 3: rules/workflow.md と Executive Summary の雛形を書き換える**

（行番号は plan-4 の書き換え後のもの。編集前に読んで内容で特定する）

- 共通フロー 7 →「7. **承認**: 人間が会話で `承認`（承認待ちが複数なら `承認 plan-2.md` のように文書名を付ける）と書く。UserPromptSubmit の hook がその時点の文書 hash を `approvals.log` に記録し、承認行を approved に書き換える（下記 CRITICAL）。」
- 二層モードの「承認順: spec.md を complete → pass → approved にしてから、…」の「approved にしてから」→「人間が会話で承認してから」
- CRITICAL 節の本文を置き換える:

```
承認は人間が会話で `承認`（必要なら文書名）と書いたときにだけ記録される。gate は `approvals.log` に記録された hash が現在の文書 hash と一致するときだけ通す。Claude は `Approval Status: approved` を書かない（guard が deny する）。`/execute-plan` は承認の後に実装を始める操作で、承認の代わりにはならない。`workflow-cli` は Approval 行に触れる変更を拒否する。

- 承認の後に文書を改訂すると hash が変わり、gate は再承認を求める（帳簿だけの変更 — Reviewer Outputs、marker、チェックボックス — は hash に含まれないので再承認は要らない。`stamp` は Review Status 行を書き換えるので、承認の後に stamp すると再承認が要る）
- hook が承認行を書き換えた直後は、文書を読み直してから編集する
- 取り消すときは承認行を pending に戻す
```

CRITICAL 節の残りの箇条書き（research/spec/plan への編集は承認前でも許可、実装系書き込みは guard が制御、off-plan の降格）はそのまま残す

- Executive Summary の Next Action（rules/workflow.md と `workflow-review-core.ts:880` の両方）→「- **Next Action**: 会話で `承認`（承認待ちが複数なら文書名を付ける）と書いてください / 追加修正を依頼してください」。`workflow-review-core.ts` の雛形を検査するテストがあれば期待値も合わせる（`grep -rn "Next Action" H/tests/unit` で確かめる）

- [ ] **Step 4: reference skill を書き換える**

- 「三状態承認」を説明している節に、承認の記録（`approvals.log` の形式、gate の条件、診断の `approval` 行と `ignored-lines` / `ledger-unreadable`、取り消し方、承認後の改訂と再承認、名前を付けた承認は全か無か）を 5〜8 行で足す
- 新しい節「## worktree で Document Workflow を使う」を足す: wfDir は Claude Code を起動した dir（`CLAUDE_PROJECT_DIR`）の `.tmp/sessions/<id 先頭8桁>` にあり、worktree に `cd` しても動かない。`workflow-cli dir` で確認する。`## Files` は repo 相対で書けば、worktree の中のファイルにもその worktree の toplevel 基準で一致する。worktree の中で起動したセッションの wfDir はその worktree の中にある
- `/clear` の節の「コピーは必ず空変数ガードとセットで同じ Bash 呼び出し内で行う:」と「変数が空のまま `cp` が走ると `cp -a <src>/. /` になりルート直下へ展開する。」の 2 文を、「`workflow-cli dir` の `wfDir=` の値をリテラルで貼ってからコピーする（シェル変数を使わないので、空の変数でルートに展開する事故が起きない）。複製すると `approvals.log` も移り、同じ版の文書の承認は引き継がれる:」の 1 文にする

- [ ] **Step 5: 確認とコミット**

実行: `bun run test`、`bun run lint`、`textlint-global docs/decisions/0022-workflow-identity.md`（`~/.local/bin/textlint-global` があれば）
期待: fail 0。K4 の検査テスト（workflow-env-references）も PASS（新しい文書に `$DOCUMENT_WORKFLOW_DIR` / `$CLAUDE_SESSION_ID` を書かない）

```bash
git add docs/decisions/0022-workflow-identity.md docs/decisions/0013-workflow-dir-session-derivation.md home/dot_claude/rules/workflow.md home/dot_claude/hooks/lib/workflow-review-core.ts .skills/document-workflow-reference/SKILL.md
git commit -m "docs(workflow): record the workflow identity decisions and the approval procedure"
```

（`workflow-review-core.ts` の雛形のテストを直した場合は、そのテストファイルも add する）

- [ ] **Step 6: 配備後の実測（実装者ではなくメインループが、利用者と行う）**

`chezmoi apply` と Claude Code の起動し直しの後に、次を確かめる。結果は ADR-0022 の Consequences 12 に追記し、T5 のコミットとは別のコミット（`docs(adr): record the approval source measurement`）にする:

- 会話で「承認」と書くと、`approvals.log` に 1 行増え、`systemMessage` が利用者に見える
- IDE 拡張・デスクトップアプリから打った「承認」が記録されるか（`source` が `user` 以外で届くと「記録していない」と返る）
- `/loop` か ScheduleWakeup で「承認」だけのプロンプトを予約したとき、approval-recorder が発火するか、発火したなら入力の `source` が `user` 以外になっていて記録されないか（`~/.claude/logs/hook-timing.jsonl` と `approvals.log` で確かめる）。`source` が届かず記録されてしまうなら、followups に起票する

## ISO 25010 具体テストケース

### セキュリティ（真正性）

- **入力**: model の Edit / MultiEdit で `- Approval Status: pending` → `approved` → **期待**: deny（T4）
- **入力**: model の Write で `Approval Status: approved`（ハイフンなし）を含む文書 → **期待**: deny（T4）
- **入力**: model の Write で自分の / 他のセッションの `approvals.log`、`APPROVALS.LOG` → **期待**: deny（T4）
- **入力**: 承認行が approved だが log が無い / log の hash が古い版 / log が読めない → **期待**: gate は deny、診断に `recorded=none` / `recorded=<古い 12 桁>` / `ledger-unreadable` と「承認 plan.md」（T2）
- **入力**: 「承認 PLAN.MD」「/execute-plan 承認」、サブエージェントの中の「承認」、`source` が `schedule_wakeup` / `loop_wakeup` / `poll_event` / `system` / `sdk` の「承認」 → **期待**: 記録しない（T3）
- **入力**: `<wfDir>/plan.md.approval-tmp` に外のファイルへの symlink を仕込んでから「承認」 → **期待**: 外のファイルは変わらない（T3）
- **入力**: `.TMP/SESSIONS/<id>/approvals.log`、`.tmp/sessions/a/b/approvals.log`、大文字のパスで書いた文書への承認済みの Write → **期待**: deny（T4）

### 機能適合性（正確性）

- **入力**: 承認待ちが plan.md 1 件の状態で発話「承認」 → **期待**: log に現在の hash と session、承認行が approved、返答に hash の先頭 12 桁（`additionalContext` と `systemMessage`）、gate が allow（T3）
- **入力**: spec は承認済みで plan-1 / plan-2 が承認待ち、発話「承認」 → **期待**: 何も書かない、「2 件」と文書名を付けた形を案内（T3）
- **入力**: 「承認 spec.md plan-2.md」で plan-2 が未完成 → **期待**: 何も書かない（T3）
- **入力**: log だけ書けて承認行が pending のまま、もう一度「承認」 → **期待**: 承認行が approved になり gate が allow（T3）
- **入力**: log の `session` が別のセッション → **期待**: hash が一致すれば gate は allow（T2）
- **入力**: 承認 → 改訂 → 元の版に戻す（log の最後の行は改訂後の承認） → **期待**: 最後の行だけを使うので、元の版の古い承認は復活しない（T1）

### 信頼性（障害許容性）

- **入力**: `approvals.log` が同名のディレクトリ → **期待**: 読み手は例外を投げず `readError`、gate は閉じたまま（T1・T2）、hook は「記録できなかった可能性」を返す（T3）

## Approval

- Plan Status: complete
- Review Status: pass
- Approval Status: approved

## Reviewer Outputs (Round 1)

### logic-validator

- verdict: needs-work
- 主指摘: 承認済みの fixture の列挙に 2 か所の漏れ（guard の `createSessionWorkflowRepo`、gate の two-layer note のテスト）→ 7 か所に修正。`reply` の型が `context.json` に合わない、`readFileSync` の import 漏れ、「2 件」のテストが spec を候補に含めて偶然通る、K4 の ledger のテストが変更前から通る（承認済みの fixture に変更）、文書名の大文字小文字（区別するよう変更）、spec が通った後の note / nextAction が古い言い方（いずれも反映済み）

### scope-justification-reviewer

- verdict: needs-work
- 主指摘: hook が出す Executive Summary の雛形（`workflow-review-core.ts:880`）の Next Action が古い → T5 に追加。冪等な再試行・取り消し・同じ値の書き換え・MultiEdit・session を照合しないことのテストを追加。ADR に V1 の結果、R4、R7、全か無かの判断、Status の日付の入れ方を追加（いずれも反映済み）

### architecture-boundary-analyzer

- verdict: needs-work
- 主指摘: 承認待ちの列挙を gate の `listApprovalCandidates` に移す、parent-spec-hash の照合を `parentSpecMatches` に括り出す、`.md` の判定を realpath に揃える、test-helpers は `STRICT_APPROVAL_STATUS` と `computeWorkflowRepoPlanHash` を使う、gate の docstring に台帳を読むことを書く（いずれも反映済み）。spec の矢印の修正は spec を変えずに ADR に記録する

### security-vulnerability-analyzer

- verdict: needs-work
- 主指摘: 旧内容が承認済みの行を引用しているだけで本物の承認行を approved にする編集が通る → 承認済みの行の数で比べる形に変更。`.md` 判定の realpath と大文字小文字、他のセッションの log、symlink の文書を hook が書き換えない、hook の入力で人間の発話かを区別できない（受け入れるリスクと ADR に記載し、`agent_id` を除外、配備後に実測）（いずれも反映済み）

### resilience-analyzer

- verdict: needs-work
- 主指摘: P0: 読めない `approvals.log` で gate の評価が例外になり guard が fail-open で通す → 読み手は `readError` を返し gate は閉じたまま。hook の失敗を利用者に伝える、書いた後に読み直して確かめる、承認行の書き換えを一時ファイルと rename にする、`systemMessage` でも返す（いずれも反映済み）

<!-- auto-review: pending -->
<!-- intent-triage: pending -->

## Reviewer Outputs (Round 2)

### logic-validator

- verdict: needs-work
- 主指摘: Round 1 の指摘はすべて解消し、件数と赤・緑の主張も整合。新規: 受け入れるリスクの前提が誤り — cc-hooks-ts 2.1.281 の UserPromptSubmit の入力型に `source`（user / sdk / system / loop_wakeup / schedule_wakeup / poll_event）がある（`index.d.mts:132`、メインループでも確認）→ hook は `source` が `user` か無いときだけ記録し、リスクと ADR の記述を改めた（反映済み）

### scope-justification-reviewer

- verdict: pass
- 主指摘: K7/K8/K9/K12 はすべて網羅、追加分に範囲の逸脱なし。軽微: ADR の「spec からの差」の一覧を増やす、配備後の実測の追記を別コミットと明記（反映済み）

### architecture-boundary-analyzer

- verdict: pass
- 主指摘: 依存の向きと責務の分担は解消。軽微: 寛容な承認行の定数と承認行の書き換えを `workflow-marker.ts` に置き、docstring の「表示専用」を deny 方向の利用を許す形に直す（反映済み）

### security-vulnerability-analyzer

- verdict: needs-work
- 主指摘: P1: macOS で JS の realpath は大文字小文字を正規化せず、`.TMP/SESSIONS/...` で K9 の 2 判定をすり抜ける（実測）→ 大文字小文字を無視して比べる形に変更。P2: 固定名の一時ファイルに symlink を仕込まれる → 一意な名前を排他作成。log の深さの判定を前方一致に。差し引きゼロの編集と wfDir の外を指す link は受け入れるリスクに記載（いずれも反映済み）

### resilience-analyzer

- verdict: needs-work
- 主指摘: P1: 固定名の一時ファイル（security と同じ）→ 排他作成と失敗時の削除。P2: 複数文書の途中の失敗で文書ごとの報告が失われる → 文書ごとに try/catch。成功の文言を承認行を実際に書き換えたときだけ「書き換えた」に（いずれも反映済み）

<!-- auto-review: verdict=needs-work; hash=400a57bf689f0d5f696a8f3da351e26b8f616355aa24999acbbad3b4560be95c; design-hash=e773e038bb70f637db5109bb7d67a9e15dbfbdd4b2380b926a5bbecc3a091f79; round=1; parent-spec-hash=4cee4ab13ef4a878444a81b6987973e04ea76a9c5639331cbd13104a470adb56; at=2026-10-02T06:51:53.513Z; reviewers=logic-validator+scope-justification-reviewer+architecture-boundary-analyzer+security-vulnerability-analyzer+resilience-analyzer -->

## Reviewer Outputs (Round 3)

### logic-validator

- verdict: needs-work
- 主指摘: 型は問題なし。「log に書けない」テストの期待文言が文書ごとの失敗の文言と食い違う → 失敗時に「記録できなかった可能性がある」を返す形に統一。仕込んだ symlink のテストと大文字のパスのテストが変更前から通る → 文書が symlink の場合のテスト、承認済みの fixture と承認済みの行 2 つの形に変更。T4 の赤の件数と hook の docstring の古い記述（いずれも反映済み）

### security-vulnerability-analyzer

- verdict: pass
- 主指摘: Write ツールで log や gate が読む承認を偽造する経路は残っていない。P2: 判定の例外で fail-open、Edit の `old_string` が見つからない場合の食い違い、log に仕込んだ symlink への追記 → fail-closed の包み、見つからないときは新しい文字列を足したものとして数える、O_NOFOLLOW（いずれも反映済み）。人間の入力でない承認の形を黙って捨てない（記録しない旨を返す、反映済み）。Unicode 正規化は受け入れるリスクに記載

### resilience-analyzer

- verdict: needs-work
- 主指摘: P1: 一時ファイルを開いた後の書き込み失敗で一時ファイルが残る → 書き込み・close・rename を 1 つの try にまとめ、失敗時に必ず消す。log 済みで承認行の書き換えに失敗した状態を返答に明示、fsync を追加、symlink のテストを差し替え（いずれも反映済み）

### scope-justification-reviewer

- verdict: pass (carried from Round 2)
- 主指摘: Round 2 で pass、再実行なし

### architecture-boundary-analyzer

- verdict: pass (carried from Round 2)
- 主指摘: Round 2 で pass、再実行なし

<!-- auto-review: verdict=needs-work; hash=5c7a241cb83fe1bf97b7fa0f076614929d2f47fdbe346827551394a66bfd252a; design-hash=59ecf0d41d491f0ac0455d754c9b25887a2d1a416fe00553752b66eb46070675; round=2; parent-spec-hash=4cee4ab13ef4a878444a81b6987973e04ea76a9c5639331cbd13104a470adb56; at=2026-10-02T06:58:17.423Z; reviewers=logic-validator+scope-justification-reviewer+architecture-boundary-analyzer+security-vulnerability-analyzer+resilience-analyzer -->

## Reviewer Outputs (Round 4)

### logic-validator

- verdict: pass
- 主指摘: Round 3 の変更はコードとテストの期待にすべて整合（O_NOFOLLOW は macOS で ELOOP、log が dir のとき EISDIR で「記録できなかった可能性」、symlink の plan.md、source の正規表現、大文字のパス、見つからない old_string）。軽微: gate のテストの `mkdirSync` は import 済み（注記を修正）

### resilience-analyzer

- verdict: pass
- 主指摘: 一時ファイルの後片付け、log 済み/未の報告、O_NOFOLLOW、K9 の fail-closed を確認。軽微: symlink の文書に「もう一度承認」と案内するのは誤り → 専用の文言に変更。後片付けの例外が元のエラーを隠す → 包んで元のエラーを保つ（いずれも反映済み）

### security-vulnerability-analyzer

- verdict: pass (carried from Round 3)
- 主指摘: Round 3 で pass、再実行なし

### scope-justification-reviewer

- verdict: pass (carried from Round 3)
- 主指摘: Round 3 で pass、再実行なし

### architecture-boundary-analyzer

- verdict: pass (carried from Round 3)
- 主指摘: Round 3 で pass、再実行なし

<!-- auto-review: verdict=needs-work; hash=d635ddbe4f39d8586a8ce7fae1c9dbd6b6b31471038cf7f5ac34c0ce27f26a95; design-hash=2d79d9ad9bb9d94d67c4b64ce3f018cc476e14162437b99ec8f13b20c5eb8869; round=3; parent-spec-hash=4cee4ab13ef4a878444a81b6987973e04ea76a9c5639331cbd13104a470adb56; at=2026-10-02T07:02:03.357Z; reviewers=logic-validator+security-vulnerability-analyzer+resilience-analyzer -->

<!-- auto-review: verdict=pass; hash=7c12be81ce255386654542942ed8f2b80d7c373cb658c96759d66871220c2c1c; design-hash=a7a59948a379405c5e7e5217dc32a3b921871d5dc64431f29ba44b42d69638d7; round=4; parent-spec-hash=4cee4ab13ef4a878444a81b6987973e04ea76a9c5639331cbd13104a470adb56; at=2026-10-02T07:04:35.231Z; reviewers=logic-validator+resilience-analyzer -->
<!-- intent-triage: adopted=46; excluded=0; at=2026-10-02T07:04:35.255Z -->
