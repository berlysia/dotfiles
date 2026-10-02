<!-- spec-ref: spec.md -->

# Plan: workflow dir の基準を session 開始時の root に固定する (Execution layer)

spec K1・K10（#209 の場所の同一性）。H = `home/dot_claude/hooks`。

## 方針と範囲

- `CLAUDE_TEST_CWD` を読む箇所を 2 種に分け、**root を決める箇所だけ** `getProjectRoot()` に置き換える。ツール入力の相対パスを解決する箇所（ツール呼び出し時点の cwd を表す値）は変えない
  - root（置き換える）: document-workflow-guard :89 の wfDir 解決と、`isOutsideProject` / `areAllTargetsOutsideProject`（:330-339）の「プロジェクトの内か外か」の境界、workflow-bash-sync :84 の wfDir 解決、spec-plan-placeholder-scan :18、spec-plan-self-audit :25、block-plan-mode :22、reviewer-run-recorder :66、resume-incomplete-work :120、session :131、compaction-testament :231-237（移設元）
    - `isOutsideProject` の境界をツール cwd のままにすると、`cd sub` の後に `<repo>/src/a.ts` が「プロジェクトの外」と判定されて gate を素通りする（logic-validator が scratch コピーで再現）。対象パスの解決にはツール cwd を、内外の境界には root を使う
  - ツール cwd（変えない）: document-workflow-guard の相対パスの解決（:315, :331, :450）・`parseFilesSection`、workflow-bash-sync の `checkTripwire(wfDir, cwd)` と :317、compaction-testament の `getWorkingDirectory`（:219-221）、plan-review-automation の `getWorkingDirectory`（:183-191、編集対象の相対パス解決のみ）、file-access-guard の `resolvePath`（:338）と step 1.5（:462-464）
  - spec K1 の「11 ファイル」のうち plan-review-automation と file-access-guard は、調べた結果ツール cwd の用途しか持たなかった。file-access-guard は K10 の wfDir 許可のために `getProjectRoot()` を新たに使う
- `parseFilesSection` の基準は plan-3（K2）で変えるまで現行のツール cwd のままにする。ここで root に変えると、K2 の前に worktree 内の対象が `## Files` に一致しなくなる
- session.ts と、inputCwd を渡していない hook は `getProjectRoot()` を引数なしで呼ぶ（フォールバックが現行の `process.cwd()` と同じになる）。inputCwd を渡すのは移設元の compaction-testament だけ
- guard と bash-sync では、ツール cwd を返す `getWorkingDirectory` を `getToolCwd` に改名し、root は `projectRoot` という名前で束縛する。どちらも string なので、名前で取り違えを防ぐ（plan-3 で `parseFilesSection` の基準を切り替えるときの誤りを避ける）
- **運用上の注意**: plan-2〜plan-5 の実装が終わるまで `chezmoi apply` しない。この plan を配備すると、本セッション（worktree 内で作業中）の wfDir が本体の `.tmp/sessions/7d715a2f` に移り、worktree 側の spec / plan を guard が見なくなる。plan-1 は他と独立なので、いつ配備してもよい

## 受け入れるリスク

- `CLAUDE_PROJECT_DIR` が存在しない dir を指す（プロジェクト自体を消した）と、wfDir も存在せず workflow は inactive になる。プロジェクトを消した状態での作業は想定しない
- 本番で `CLAUDE_TEST_CWD` が設定されていると、wfDir の基準と T5 の許可範囲の両方が差し替わる。移設前の 9 hook と同じ前提で、許可は `<root>/.tmp/sessions/<id>` の下に限られる（followups 課題 E で追跡中）
- SessionStart の `appendFileSync` が失敗すると Bash に `CLAUDE_PROJECT_DIR` が届かない。plan-4 で CLI はこの値が無ければ失敗するので、黙って別の dir を使うことはない
- file-access-guard の wfDir 許可は `isWithinTempRoots` を再利用するので、リンク先が存在しない symlink や `..` は fail closed になる。wfDir の中の、存在する dir への symlink を辿った先が wfDir の外なら、物理パスの比較で deny される

## Files

```
# 新規作成
home/dot_claude/hooks/lib/project-root.ts
home/dot_claude/hooks/lib/shell-quote.ts
home/dot_claude/hooks/tests/unit/project-root.test.ts
home/dot_claude/hooks/tests/unit/workflow-anchor.test.ts

# 編集
home/dot_claude/hooks/implementations/compaction-testament.ts
home/dot_claude/hooks/implementations/document-workflow-guard.ts
home/dot_claude/hooks/implementations/workflow-bash-sync.ts
home/dot_claude/hooks/implementations/spec-plan-placeholder-scan.ts
home/dot_claude/hooks/implementations/spec-plan-self-audit.ts
home/dot_claude/hooks/implementations/block-plan-mode.ts
home/dot_claude/hooks/implementations/reviewer-run-recorder.ts
home/dot_claude/hooks/implementations/resume-incomplete-work.ts
home/dot_claude/hooks/implementations/session.ts
home/dot_claude/hooks/implementations/file-access-guard.ts
home/dot_claude/hooks/tests/preload-test-env.mjs

# テスト
home/dot_claude/hooks/tests/unit/session.test.ts
home/dot_claude/hooks/tests/unit/file-access-guard.test.ts
```

## Tasks

テストの実行は、リポジトリ（worktree）のルートで `node --import ./home/dot_claude/hooks/tests/preload-test-env.mjs --test <file>`。

### T1: `getProjectRoot` と `shellSingleQuote` を作る

**Files:**

- 新規: `H/lib/project-root.ts`、`H/lib/shell-quote.ts`
- 編集: `H/tests/preload-test-env.mjs:27-44`（Step 3 の末尾。T3 で hook が `CLAUDE_PROJECT_DIR` を読み始める前に、テストから外しておく）
- テスト: `H/tests/unit/project-root.test.ts`
- 参照: `H/implementations/compaction-testament.ts:231-237`（移設元 `getProjectDirectory`）
- 参照: `H/implementations/session.ts:24-27`（現行の `isSafeForDoubleQuotedExport`。拒否するだけで引用しない）

- [ ] **Step 1: 失敗するテストを書く**

```ts
#!/usr/bin/env node --test

import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { getProjectRoot } from "../../lib/project-root.ts";
import { shellSingleQuote } from "../../lib/shell-quote.ts";
import { EnvironmentHelper } from "./test-helpers.ts";

describe("getProjectRoot", () => {
  const envHelper = new EnvironmentHelper();
  afterEach(() => envHelper.restore());

  it("prefers CLAUDE_TEST_CWD, then CLAUDE_PROJECT_DIR, then inputCwd, then process.cwd()", () => {
    envHelper.set("CLAUDE_TEST_CWD", "/t");
    envHelper.set("CLAUDE_PROJECT_DIR", "/p");
    assert.equal(getProjectRoot("/i"), "/t");
    envHelper.set("CLAUDE_TEST_CWD", undefined);
    assert.equal(getProjectRoot("/i"), "/p");
    envHelper.set("CLAUDE_PROJECT_DIR", undefined);
    assert.equal(getProjectRoot("/i"), "/i");
    assert.equal(getProjectRoot(), process.cwd());
  });

  it("treats an empty CLAUDE_PROJECT_DIR or inputCwd as unset", () => {
    envHelper.set("CLAUDE_TEST_CWD", undefined);
    envHelper.set("CLAUDE_PROJECT_DIR", "");
    assert.equal(getProjectRoot("/i"), "/i");
    assert.equal(getProjectRoot(""), process.cwd());
  });
});

describe("shellSingleQuote", () => {
  for (const value of [
    "plain",
    "it's",
    'say "hi"',
    "$(touch /tmp/pwned)",
    "`id`",
    "back\\slash",
    "line1\nline2",
    "",
  ]) {
    it(`round-trips ${JSON.stringify(value)} through bash source`, () => {
      const dir = mkdtempSync(join(tmpdir(), "shell-quote-"));
      const envFile = join(dir, "env");
      writeFileSync(envFile, `export V=${shellSingleQuote(value)}\n`);
      const result = spawnSync(
        "bash",
        ["-c", `. "$1"; printf %s "$V"`, "_", envFile],
        {
          encoding: "utf-8",
        },
      );
      assert.equal(result.status, 0);
      assert.equal(result.stdout, value);
    });
  }
});
```

- [ ] **Step 2: テストを実行して失敗を確認**

実行: `node --import ./home/dot_claude/hooks/tests/preload-test-env.mjs --test home/dot_claude/hooks/tests/unit/project-root.test.ts`
期待: FAIL（`Cannot find module '../../lib/project-root.ts'`）

- [ ] **Step 3: 最小実装を書く**

`H/lib/project-root.ts`:

```ts
/**
 * The project root that workflow identity anchors on. Claude Code sets
 * CLAUDE_PROJECT_DIR to the directory the session started in and keeps it
 * there across Bash `cd` and worktree entry, so the workflow dir does not move
 * with the tool cwd. CLAUDE_TEST_CWD is the test-only override the hooks
 * already honour; it wins even in production if it leaks into the
 * environment. inputCwd is kept for callers that used it before.
 */
export function getProjectRoot(inputCwd?: string): string {
  return (
    process.env["CLAUDE_TEST_CWD"] ||
    process.env["CLAUDE_PROJECT_DIR"] ||
    inputCwd ||
    process.cwd()
  );
}
```

`H/lib/shell-quote.ts`:

```ts
/**
 * Quote a value so that sourcing `export NAME=<quoted>` in a POSIX shell
 * yields the value byte for byte. Inside single quotes nothing is special
 * except the quote itself, which is closed, escaped and reopened.
 */
export function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}
```

`H/tests/preload-test-env.mjs`: 削除する env の一覧の直後に、次のブロックを足す:

```js
// The SessionStart hook exports CLAUDE_PROJECT_DIR into the Bash environment
// this suite is often started from. Hooks under test read it through
// getProjectRoot(), so a leaked value would anchor every fixture on the real
// repository instead of the process.chdir() / CLAUDE_TEST_CWD the test set up.
delete process.env.CLAUDE_PROJECT_DIR;
```

- [ ] **Step 4: テストを実行して通過を確認**

実行: Step 2 と同じ
期待: PASS（getProjectRoot 2 件、shellSingleQuote 8 件）

- [ ] **Step 5: コミット**

```bash
git add home/dot_claude/hooks/lib/project-root.ts home/dot_claude/hooks/lib/shell-quote.ts home/dot_claude/hooks/tests/unit/project-root.test.ts home/dot_claude/hooks/tests/preload-test-env.mjs
git commit -m "feat(hooks): add getProjectRoot and shellSingleQuote"
```

### T2: compaction-testament の私有関数を `getProjectRoot` に置き換える

**Files:**

- 編集: `H/implementations/compaction-testament.ts:223-237`（`getProjectDirectory` を削除し、:633 の呼び出しを `getProjectRoot(input.cwd)` に）
- テスト: 既存 `H/tests/unit/compaction-testament.test.ts:1076-1137`（"project dir anchoring"）
- 参照: `H/lib/project-root.ts`（T1）

- [ ] **Step 1: 置き換える**

`getProjectDirectory` の定義（docstring を含む :223-237）を削除し、`import { getProjectRoot } from "../lib/project-root.ts";` を足して、:633 を `const projectDir = getProjectRoot(input.cwd);` にする。優先順は移設前と同じ（`CLAUDE_TEST_CWD` → `CLAUDE_PROJECT_DIR` → `input.cwd` → `process.cwd()`）なので挙動は変わらない。

- [ ] **Step 2: 既存テストで挙動不変を確認**

実行: `node --import ./home/dot_claude/hooks/tests/preload-test-env.mjs --test home/dot_claude/hooks/tests/unit/compaction-testament.test.ts`
期待: 置き換え前と同じ件数が PASS、FAIL 0

- [ ] **Step 3: コミット**

```bash
git add home/dot_claude/hooks/implementations/compaction-testament.ts
git commit -m "refactor(hooks): use the shared getProjectRoot in compaction testament"
```

### T3: workflow dir を解決する hook の root を `getProjectRoot()` にする

**Files:**

- 編集: `H/implementations/document-workflow-guard.ts:89-93, :109, :156, :230, :292-294, :330-339`、`H/implementations/workflow-bash-sync.ts:84-88, :136`、`H/implementations/spec-plan-placeholder-scan.ts:18`、`H/implementations/spec-plan-self-audit.ts:25`、`H/implementations/block-plan-mode.ts:22`、`H/implementations/reviewer-run-recorder.ts:66`、`H/implementations/resume-incomplete-work.ts:120`
- テスト: `H/tests/unit/workflow-anchor.test.ts`（新規）
- 参照: `H/tests/unit/test-helpers.ts`（`draftPlanRepo` :682、`EnvironmentHelper` :450、`createPreToolUseContextFor` :295、`createPostToolUseContextFor` :319、`invokeRun` :282）
- 参照: `H/tests/unit/reviewer-run-recorder.test.ts:30-45`（recorder の呼び方）

- [ ] **Step 1: 失敗するテストを書く**

`cd` でサブディレクトリに入った状態（`process.cwd()` = `<repo>/sub`、`CLAUDE_PROJECT_DIR` = `<repo>`）で、guard と recorder が `<repo>/.tmp/sessions/test-ses` を見ることを確かめる。`DOCUMENT_WORKFLOW_DIR` はテストを走らせるシェルに入っていることがあるので必ず外す。

```ts
#!/usr/bin/env node --test

import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import guardHook from "../../implementations/document-workflow-guard.ts";
import recorderHook from "../../implementations/reviewer-run-recorder.ts";
import { deriveDefaultWorkflowDir } from "../../lib/workflow-paths.ts";
import {
  createPostToolUseContextFor,
  createPreToolUseContextFor,
  draftPlanRepo,
  EnvironmentHelper,
  invokeRun,
  TEST_SESSION_ID,
} from "./test-helpers.ts";

describe("workflow dir anchors on CLAUDE_PROJECT_DIR, not the tool cwd", () => {
  const envHelper = new EnvironmentHelper();
  const originalCwd = process.cwd();
  let repo: string;

  beforeEach(() => {
    repo = realpathSync(draftPlanRepo());
    mkdirSync(join(repo, "sub"), { recursive: true });
    envHelper.set("CLAUDE_TEST_CWD", undefined);
    envHelper.set("DOCUMENT_WORKFLOW_DIR", undefined);
    envHelper.set("CLAUDE_PROJECT_DIR", repo);
    process.chdir(join(repo, "sub"));
  });

  afterEach(() => {
    process.chdir(originalCwd);
    envHelper.restore();
  });

  it("document-workflow-guard denies an implementation write while the plan is pending", async () => {
    const ctx = createPreToolUseContextFor(guardHook, "Write", {
      file_path: join(repo, "src", "a.ts"),
      content: "x",
    });
    await invokeRun(guardHook, ctx);
    ctx.assertDeny();
  });

  it("reviewer-run-recorder writes the ledger under the project root", async () => {
    const ctx = createPostToolUseContextFor(recorderHook, "Agent", {
      subagent_type: "logic-validator",
    });
    await invokeRun(recorderHook, ctx);
    const ledger = join(
      repo,
      deriveDefaultWorkflowDir(TEST_SESSION_ID),
      "reviewer-runs.log",
    );
    assert.ok(existsSync(ledger), `ledger missing: ${ledger}`);
    assert.match(readFileSync(ledger, "utf-8"), /logic-validator/);
  });

  it("every workflow-dir hook imports getProjectRoot", () => {
    const implDir = join(import.meta.dirname, "../../implementations");
    for (const name of [
      "document-workflow-guard",
      "workflow-bash-sync",
      "spec-plan-placeholder-scan",
      "spec-plan-self-audit",
      "block-plan-mode",
      "reviewer-run-recorder",
      "resume-incomplete-work",
      "compaction-testament",
    ]) {
      const source = readFileSync(join(implDir, `${name}.ts`), "utf-8");
      assert.match(
        source,
        /from "\.\.\/lib\/project-root\.ts"/,
        `${name}.ts does not import getProjectRoot`,
      );
    }
  });
});
```

- [ ] **Step 2: テストを実行して失敗を確認**

実行: `node --import ./home/dot_claude/hooks/tests/preload-test-env.mjs --test home/dot_claude/hooks/tests/unit/workflow-anchor.test.ts`
期待: 3 件とも FAIL。guard は `<repo>/sub/.tmp/sessions/test-ses` を見て workflow が inactive になり allow する（`assertDeny` が失敗）。recorder は ledger を `<repo>/sub/...` に書く（`ledger missing`）。import 検査は compaction-testament（T2 済み）以外の 7 ファイルで失敗する

- [ ] **Step 3: 最小実装を書く**

各ファイルに `import { getProjectRoot } from "../lib/project-root.ts";` を足し、wfDir 解決に渡す値を置き換える。

document-workflow-guard.ts（:89-93）。`getWorkingDirectory`（:292-294）を `getToolCwd` に改名し、docstring を「ツール入力の相対パスを解決する、ツール呼び出し時点の cwd。workflow dir とプロジェクトの内外の基準は getProjectRoot」とする。`cwd` は相対パスの解決と `parseFilesSection` に使い続ける:

```ts
const cwd = getToolCwd();
const projectRoot = getProjectRoot();
const resolution = resolveWorkflowDir({
  cwd: projectRoot,
  sessionId: context.input.session_id,
});
```

同ファイル :109 の unresolvable のメッセージ中の `${cwd}/.tmp/sessions` は `${projectRoot}/.tmp/sessions` にする。

内外の判定（:330-339）は、対象パスの解決と境界を分ける:

```ts
function isOutsideProject(
  toolCwd: string,
  projectRoot: string,
  path: string,
): boolean {
  const normalized = resolve(toolCwd, expandTilde(path));
  return (
    !normalized.startsWith(`${projectRoot}/`) && normalized !== projectRoot
  );
}

function areAllTargetsOutsideProject(
  toolCwd: string,
  projectRoot: string,
  targets: string[],
): boolean {
  if (targets.length === 0) {
    return false;
  }
  return targets.every((target) =>
    isOutsideProject(toolCwd, projectRoot, target),
  );
}
```

呼び出し側は :156 を `areAllTargetsOutsideProject(cwd, projectRoot, analysis.targets)`、:230 を `isOutsideProject(cwd, projectRoot, targetPath)` にする。`CLAUDE_PROJECT_DIR` もテスト用の override も無いときは `projectRoot === cwd` なので、判定は置き換え前と同じになる。

workflow-bash-sync.ts（:84-88）。こちらも `getWorkingDirectory`（:136）を `getToolCwd` に改名する。`checkTripwire(wfDir, cwd)`（:111）と :317 は `cwd` のまま:

```ts
const cwd = getToolCwd();
const projectRoot = getProjectRoot();
const resolution = resolveWorkflowDir({
  cwd: projectRoot,
  sessionId: context.input.session_id,
});
```

spec-plan-placeholder-scan.ts :18、spec-plan-self-audit.ts :25、block-plan-mode.ts :22、reviewer-run-recorder.ts :66、resume-incomplete-work.ts :120 は、いずれも次の 1 行を置き換える:

```ts
const cwd = getProjectRoot();
```

（置き換え前は `const cwd = process.env.CLAUDE_TEST_CWD || process.cwd();`。各ファイルでこの `cwd` は `resolveWorkflowDir` にしか渡していないことを確認済み）

- [ ] **Step 4: テストを実行して通過を確認**

実行: Step 2 と同じ。続けて `bun run test`
期待: 新規 3 件 PASS（guard の deny は wfDir の解決と内外の境界の両方を root にして初めて通る。境界が `<repo>/sub` のままだと `<repo>/src/a.ts` が「外」になり allow される）。既存テストは全件 PASS

- [ ] **Step 5: コミット**

```bash
git add home/dot_claude/hooks/implementations/{document-workflow-guard,workflow-bash-sync,spec-plan-placeholder-scan,spec-plan-self-audit,block-plan-mode,reviewer-run-recorder,resume-incomplete-work}.ts home/dot_claude/hooks/tests/unit/workflow-anchor.test.ts
git commit -m "fix(hooks): anchor workflow dir resolution on the project root"
```

### T4: SessionStart が root を使い、`CLAUDE_PROJECT_DIR` を引用付きで export する

**Files:**

- 編集: `H/implementations/session.ts:126-160`（cwd の決定、export）、`:244-248`（cwd 不一致の表示）
- テスト: `H/tests/unit/session.test.ts`（"DOCUMENT_WORKFLOW_DIR resolution" の describe に追加）、`H/tests/unit/workflow-anchor.test.ts`（import 検査に session を足す）
- 参照: `H/tests/unit/session.test.ts:~285`（`CLAUDE_ENV_FILE` を読み戻すテストの形）
- 参照: `H/lib/shell-quote.ts`（T1）

- [ ] **Step 1: 失敗するテストを書く**

```ts
it("exports CLAUDE_PROJECT_DIR single-quoted so sourcing returns it verbatim", async () => {
  const weird = `/tmp/proj it's "q" $(touch x) \`id\``;
  envHelper.set("CLAUDE_PROJECT_DIR", weird);
  envHelper.set("DOCUMENT_WORKFLOW_DIR", undefined);
  const ctx = createSessionStartContext("cli");
  ctx.input.session_id = "abcdef1234567890";
  await invokeRun(sessionHook, ctx);
  // A minimal env keeps the user's BASH_ENV / exported functions out of the
  // child shell, so only the env file decides what $CLAUDE_PROJECT_DIR is.
  const result = spawnSync(
    "bash",
    ["-c", `. "$1"; printf %s "$CLAUDE_PROJECT_DIR"`, "_", envFilePath],
    { encoding: "utf-8", env: { PATH: process.env.PATH ?? "" } },
  );
  strictEqual(result.status, 0);
  strictEqual(result.stdout, weird);
});

it("quotes the transcript path export the same way", async () => {
  const ctx = createSessionStartContext("cli", {
    transcript_path: `/tmp/t it's $(id).jsonl`,
  });
  ctx.input.session_id = "abcdef1234567890";
  await invokeRun(sessionHook, ctx);
  const result = spawnSync(
    "bash",
    ["-c", `. "$1"; printf %s "$CLAUDE_TRANSCRIPT_PATH"`, "_", envFilePath],
    { encoding: "utf-8", env: { PATH: process.env.PATH ?? "" } },
  );
  strictEqual(result.status, 0);
  strictEqual(result.stdout, `/tmp/t it's $(id).jsonl`);
});
```

（`spawnSync` は既存の `execFileSync` と同じ `node:child_process` の import に足す。`strictEqual` は既存の `node:assert` の import にある）

`H/tests/unit/workflow-anchor.test.ts` の import 検査のリストに `"session"` を足す（T3 では session.ts をまだ変えないので、T3 のコミットを red にしないためにここで足す）。

- [ ] **Step 2: テストを実行して失敗を確認**

実行: `node --import ./home/dot_claude/hooks/tests/preload-test-env.mjs --test home/dot_claude/hooks/tests/unit/session.test.ts`
期待: 新規 2 件が FAIL（1 件目は `CLAUDE_PROJECT_DIR` が export されず空文字、2 件目は二重引用符の中で `$(id)` が展開されて値が変わる）

- [ ] **Step 3: 最小実装を書く**

session.ts:

```ts
import { getProjectRoot } from "../lib/project-root.ts";
import { shellSingleQuote } from "../lib/shell-quote.ts";
```

:126-134 の cwd の決定を置き換え、:126-130 のコメントを「root は getProjectRoot()。本番では Claude Code が渡す CLAUDE_PROJECT_DIR（session 開始時の dir）で、Bash の cd や worktree への移動で変わらない。input.cwd は使わない」に書き換える:

```ts
const cwd = getProjectRoot();
```

export のうち次の 4 つを `shellSingleQuote` で書く（`CLAUDE_SESSION_ID` と `DOCUMENT_WORKFLOW_DIR` の 2 行は plan-4 で削除するのでここでは変えない）:

```ts
appendFileSync(envFile, `export CLAUDE_PROJECT_DIR=${shellSingleQuote(cwd)}\n`);
appendFileSync(
  envFile,
  `export CLAUDE_TRANSCRIPT_PATH=${shellSingleQuote(transcriptPath)}\n`,
);
appendFileSync(
  envFile,
  `export CLAUDE_PROJECT_HASH=${shellSingleQuote(projectHash)}\n`,
);
// inside the existing `if (taskListId)` block:
appendFileSync(
  envFile,
  `export CLAUDE_TASK_LIST_ID=${shellSingleQuote(taskListId)}\n`,
);
```

:244-248 の不一致表示:

```ts
if (context.input.cwd !== cwd) {
  messages.push(
    `cwd mismatch: context.input.cwd=${context.input.cwd} but the project root is ${cwd}.`,
  );
}
```

（preload-test-env.mjs での `CLAUDE_PROJECT_DIR` の削除は T1 で済んでいる。新規テストは `envHelper.set` で値を入れ直す）

- [ ] **Step 4: テストを実行して通過を確認**

実行: Step 2 と同じ。続けて `node --import ./home/dot_claude/hooks/tests/preload-test-env.mjs --test home/dot_claude/hooks/tests/unit/workflow-anchor.test.ts` と `bun run test`
期待: 新規 2 件 PASS。workflow-anchor の import 検査も PASS。既存の session テスト（`export DOCUMENT_WORKFLOW_DIR=".tmp/sessions/abcdef12"` の二重引用符を含む）も全件 PASS

- [ ] **Step 5: コミット**

```bash
git add home/dot_claude/hooks/implementations/session.ts home/dot_claude/hooks/tests/unit/session.test.ts home/dot_claude/hooks/tests/unit/workflow-anchor.test.ts
git commit -m "fix(hooks): export the project root and single-quote session exports"
```

### T5: file-access-guard が解決済みの wfDir への書き込みを許可する

**Files:**

- 編集: `H/implementations/file-access-guard.ts:1-20`（`getProjectRoot` を `../lib/project-root.ts`、`resolveWorkflowDir` を `../lib/workflow-resolve.ts` から import）、`:55-82`（run で wfDir の root を求めて `validatePath` に渡す）、`:441-478`（`validatePath` に引数を足し、step 1.5 の直後、step 2 のシステム dir 拒否より前で判定）
- テスト: `H/tests/unit/file-access-guard.test.ts`
- 参照: `H/tests/unit/file-access-guard.test.ts:~58`（`CLAUDE_TEST_REPO_ROOT` / `CLAUDE_TEST_CWD` の設定と `assertDeny`）、`:378-387`（`HOME` を一時 dir にして実設定を隔離する）
- 参照: `H/lib/workflow-resolve.ts:84-143`（`resolveWorkflowDir`）

- [ ] **Step 1: 失敗するテストを書く**

worktree 内の作業を模して、repo root を `<root>/.git/worktree/b`、プロジェクト root を `<root>` にする。`<root>` は OS の一時 dir の外に作る（step 1.5 の一時 dir 許可に先に一致させないため。worktree の `.tmp/` の下に作る）。

```ts
// process.cwd() is the repository the suite runs in (bun run test starts
// there); its .tmp/ is gitignored and outside os.tmpdir().
describe("workflow dir under the project root (spec K10)", () => {
  let root: string;
  beforeEach(() => {
    mkdirSync(join(process.cwd(), ".tmp"), { recursive: true });
    root = realpathSync(mkdtempSync(join(process.cwd(), ".tmp", "fag-k10-")));
    envHelper.set("HOME", mkdtempSync(join(tmpdir(), "fag-home-")));
    envHelper.set("CLAUDE_TEST_CWD", root);
    envHelper.set("CLAUDE_TEST_REPO_ROOT", join(root, ".git", "worktree", "b"));
    envHelper.set("DOCUMENT_WORKFLOW_DIR", undefined);
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    envHelper.restore();
  });

  it("allows writing a doc in the session's workflow dir outside the repo root", async () => {
    const wfDir = join(root, deriveDefaultWorkflowDir(TEST_SESSION_ID));
    const ctx = createPreToolUseContextFor(fileAccessGuardHook, "Write", {
      file_path: join(wfDir, "plan.md"),
      content: "x",
    });
    await invokeRun(fileAccessGuardHook, ctx);
    ctx.assertSuccess({});
  });

  it("still denies another session's dir and a prefix look-alike", async () => {
    const wfDir = join(root, deriveDefaultWorkflowDir(TEST_SESSION_ID));
    for (const filePath of [
      join(root, ".tmp", "sessions", "otherses", "plan.md"),
      `${wfDir}-evil/plan.md`,
      `${wfDir}/../../../outside.md`,
    ]) {
      const ctx = createPreToolUseContextFor(fileAccessGuardHook, "Write", {
        file_path: filePath,
        content: "x",
      });
      await invokeRun(fileAccessGuardHook, ctx);
      ctx.assertDeny();
    }
  });
});
```

（`mkdirSync` / `mkdtempSync` / `realpathSync` / `rmSync` は `node:fs`、`tmpdir` は `node:os`、`deriveDefaultWorkflowDir` は `../../lib/workflow-paths.ts`、`TEST_SESSION_ID` は `./test-helpers.ts` から import に足す）

- [ ] **Step 2: テストを実行して失敗を確認**

実行: `node --import ./home/dot_claude/hooks/tests/preload-test-env.mjs --test home/dot_claude/hooks/tests/unit/file-access-guard.test.ts`
期待: 1 件目が FAIL（validatePath 末尾の既定の拒否「Default: deny access outside repository」で deny される）。2 件目は変更前でも PASS（負例の固定）

- [ ] **Step 3: 最小実装を書く**

run（:55 の後）。wfDir が解決できなくても、この hook の他の判定は続けたいので、例外は握って「wfDir 無し」として扱う:

```ts
const workflowDirRoots = getWorkflowDirRoots(context.input.session_id);
```

```ts
/**
 * The session's workflow dir, both as resolved and physically, for the
 * isWithinTempRoots check. Empty when it cannot be resolved: the hook then
 * judges paths exactly as before K10.
 */
function getWorkflowDirRoots(sessionId: string): string[] {
  try {
    const resolution = resolveWorkflowDir({ cwd: getProjectRoot(), sessionId });
    if (resolution.source === "unresolvable") return [];
    const roots = [resolution.dir];
    try {
      roots.push(realpathSync(resolution.dir));
    } catch {
      // Not created yet: the lexical root is all there is to compare with.
    }
    return [...new Set(roots)];
  } catch (error) {
    console.error(
      `file-access-guard: workflow dir not resolved: ${String(error)}`,
    );
    return [];
  }
}
```

`validatePath` に第 6 引数 `workflowDirRoots: string[]` を足し、:75-82 の呼び出しで渡す。step 1.5（一時 dir の許可）の直後に、同じ `isWithinTempRoots` を wfDir に向けて使う:

```ts
// 1.6. The session's workflow dir. It stays under the project root even
// when the repo root is a linked worktree (spec K10), so it is outside
// repoRoot whenever work happens inside a worktree. isWithinTempRoots
// already rejects `..`, compares the physical path after resolving the
// nearest existing ancestor, and fails closed on dangling symlinks.
if (
  workflowDirRoots.length > 0 &&
  isWithinTempRoots(rawAbs, workflowDirRoots, realpathSync, lstatSync)
) {
  return { isAllowed: true, resolvedPath: absPath };
}
```

（`rawAbs` は step 1.5 が作る `..` を残した絶対パス。`isWithinTempRoots` は名前に反して汎用の「root の下か」判定で、一時 dir 以外の root を渡しても挙動は同じ。`<wfDir>/../../../outside.md` は `..` を含むので通らず、validatePath 末尾の既定の拒否で deny される。許可の戻り値の形は step 1 の allow と同じにする）

- [ ] **Step 4: テストを実行して通過を確認**

実行: Step 2 と同じ。続けて `bun run test` と `bun run typecheck`
期待: 新規 2 件 PASS、既存テスト全件 PASS、typecheck のエラー 0

- [ ] **Step 5: コミット**

```bash
git add home/dot_claude/hooks/implementations/file-access-guard.ts home/dot_claude/hooks/tests/unit/file-access-guard.test.ts
git commit -m "fix(hooks): let file-access-guard write the session workflow dir"
```

## ISO 25010 具体テストケース

### 機能適合性（正確性）

- **入力**: `CLAUDE_PROJECT_DIR=<repo>`、`process.cwd()=<repo>/sub`、`<repo>/.tmp/sessions/test-ses/plan.md` が pending → **期待**: guard は `<repo>/src/a.ts` への Write を deny、recorder は `<repo>/.tmp/sessions/test-ses/reviewer-runs.log` に追記（T3）
- **入力**: `CLAUDE_TEST_CWD` も `CLAUDE_PROJECT_DIR` も無く `process.cwd()` だけ → **期待**: 置き換え前と同じ dir を解決する（既存テスト全件 PASS で確認）

### セキュリティ（真正性・完全性）

- **入力**: `CLAUDE_PROJECT_DIR` に `'` `"` `$(…)` バッククォートを含む値 → **期待**: env ファイルを bash で source した値が元の文字列と一致し、`$(…)` は実行されない（T4）
- **入力**: `shellSingleQuote` に改行を含む値 → **期待**: source した値に改行がそのまま残る。改行は拒否せず値として保つ（単一引用符の中の改行は文字列の一部として扱われる。T1）
- **入力**: file-access-guard に `<wfDir>-evil/plan.md`、別セッションの dir、`<wfDir>/../../../outside.md` → **期待**: いずれも deny（T5）

### 互換性（共存性）

- **入力**: テストを `CLAUDE_PROJECT_DIR` が入ったシェルから実行 → **期待**: preload が削除するので、fixture は `process.chdir` / `CLAUDE_TEST_CWD` の dir を使う（T1）

## Approval

- Plan Status: complete
- Review Status: pass
- Approval Status: approved

## Reviewer Outputs (Round 1)

### logic-validator

- verdict: needs-work
- 主指摘: T3 の guard テストは wfDir だけ root にしても、`isOutsideProject` の境界がツール cwd（`<repo>/sub`）のままなので allow され red のまま。T3 の import 検査に session を含めると T3 のコミットが red（いずれも反映済み）

### scope-justification-reviewer

- verdict: pass
- 主指摘: T1〜T5 とも K1・K10 に直結。軽微: 運用上の注意の範囲（plan-1 は独立）を明記（反映済み）

### architecture-boundary-analyzer

- verdict: pass
- 主指摘: lib への集約は依存方向を保つ。軽微: ツール cwd と root が同じ string 型で取り違えやすいので名前で区別する（`getToolCwd` / `projectRoot`、反映済み）

### security-vulnerability-analyzer

- verdict: pass
- 主指摘: `shellSingleQuote` で export の注入は閉じる。軽微: wfDir 許可の symlink と `..` の扱い、本番の `CLAUDE_TEST_CWD`（`isWithinTempRoots` の再利用と受け入れるリスク節で反映済み）

### resilience-analyzer

- verdict: needs-work
- 主指摘: file-access-guard で wfDir の解決が例外を投げると hook 全体が落ちる。テストの child bash がユーザー環境の影響を受ける。空文字の env の扱いが未テスト（いずれも反映済み）

<!-- auto-review: pending -->
<!-- intent-triage: pending -->

## Reviewer Outputs (Round 2)

### logic-validator

- verdict: pass
- 主指摘: Round 1 の 2 点は解消し、各タスクの赤・緑の期待（失敗件数を含む）はコードと整合。T5 の正例と 3 つの負例も追跡どおり。軽微: 「step 7」はコードに無い表記、T3 前に開発シェルの `CLAUDE_PROJECT_DIR` が既存テストに漏れうる（preload の削除を T1 に移して反映済み）

### resilience-analyzer

- verdict: pass
- 主指摘: 3 点とも十分。`isWithinTempRoots` の再利用は fail closed。P2 の 2 件（unresolvable 時の stderr 出力、realpath の遅延評価）は不採用: unresolvable は workflow を使わない通常状態なので、出力すると全ファイル操作で出る警告になる

### scope-justification-reviewer

- verdict: pass (carried from Round 1)
- 主指摘: Round 1 で pass、再実行なし

### architecture-boundary-analyzer

- verdict: pass (carried from Round 1)
- 主指摘: Round 1 で pass、再実行なし

### security-vulnerability-analyzer

- verdict: pass (carried from Round 1)
- 主指摘: Round 1 で pass、再実行なし

<!-- auto-review: verdict=needs-work; hash=304b3518b4008fe9320ed111bbd48dfd232cd660cc2b7df51a535b46f2fb866b; design-hash=8ee1365f7c52bf6ee41933db7f9b26b839a7e8e04d7de15d90cbf4158f3ee7e1; round=1; parent-spec-hash=4cee4ab13ef4a878444a81b6987973e04ea76a9c5639331cbd13104a470adb56; at=2026-10-02T05:22:36.390Z; reviewers=logic-validator+scope-justification-reviewer+architecture-boundary-analyzer+security-vulnerability-analyzer+resilience-analyzer -->

<!-- auto-review: verdict=pass; hash=f45051bcdfdaca5463dc93a1a1b553ab929b150ba59e7819f044dc4a594e7be1; design-hash=6d23cee529eb26c5ebc2faa9c8d15e66b831534b3f54a9b13d8bdbeb86862ece; round=2; parent-spec-hash=4cee4ab13ef4a878444a81b6987973e04ea76a9c5639331cbd13104a470adb56; at=2026-10-02T05:25:43.728Z; reviewers=logic-validator+resilience-analyzer -->
<!-- intent-triage: adopted=10; excluded=0; at=2026-10-02T05:25:43.748Z -->
