<!-- spec-ref: spec.md -->

# Plan 1: フックのタイムアウト注入と hook-timer :456 (Execution layer)

spec の K1, K2, K3, K4, K10 を実装する。bash-parser（K11）は plan-2、perf の分離（K5〜K9）は plan-3 で扱う。

共通事項:

- テストは repo ルートで `node --import ./home/dot_claude/hooks/tests/preload-test-env.mjs --test <file>` を実行する（以下 `RUN <file>`）
- パスは `home/dot_claude/hooks/` からの相対で書く（以下 `H/`）
- 本番のタイムアウト値（200 / 2000）は変えない。各フックの `defaultEnv()` は、タイムアウトの値を定数のまま返し、`process.env` から読まない（complexity-delta の既存の `pathEnv: process.env.PATH` はタイムアウトではないので対象外）
- `tests/support/` は spec の Architecture では plan-3 の項目に挙げたが、plan-1 の T0 が先に作る。plan-3 はこのディレクトリに helper を追加する
- タイムアウト経路のテストでは、fake git が何回呼ばれたかを「ちょうど 1 回」とは assert しない。fake git が呼び出しを記録する前に、短いタイムアウトでプロセスが kill されうるため（飽和負荷で 0 回になりうる）。経路を通ったことは、フックの出力と状態で確かめる
- 長い値は各テストファイルで `const PATIENT_TIMEOUT_MS = 10_000;`（fingerprint は `PATIENT_DEADLINE_MS = 30_000`）。complexity-delta.test.ts は既存の定数（:38）を使う

## Files

```
# 新規作成
home/dot_claude/hooks/tests/support/fake-git.ts

# 編集
home/dot_claude/hooks/implementations/workflow-bash-sync.ts
home/dot_claude/hooks/implementations/complexity-delta.ts
home/dot_claude/hooks/implementations/compaction-testament.ts
home/dot_claude/hooks/lib/working-tree-fingerprint.ts

# テスト
home/dot_claude/hooks/tests/unit/workflow-bash-sync.test.ts
home/dot_claude/hooks/tests/unit/working-tree-fingerprint.test.ts
home/dot_claude/hooks/tests/unit/complexity-delta.test.ts
home/dot_claude/hooks/tests/unit/compaction-testament.test.ts
home/dot_claude/hooks/tests/unit/hook-timer.test.ts
```

## Tasks

### T0: ブロックする fake git の helper

**Files:**

- 新規: `H/tests/support/fake-git.ts`
- 参照: `H/tests/unit/hook-timer.test.ts:31-32`（`tests/` 直下からの相対パス解決の前例）、spec K1 / K2 / K10

T1・T2・T4 のタイムアウト経路のテストが共有する。`*.test.ts` ではないので、テストとしては実行されない。

```ts
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type BlockingGit = {
  /** Put first on PATH. */
  binDir: string;
  /** How many calls hit the blocking branch so far. */
  blockedCalls: () => number;
  cleanup: () => void;
};

/**
 * A `git` that blocks when any argument equals `blockOn` and runs the real git
 * otherwise. In block mode `exec sleep` makes the sleep the process the
 * caller's timeout kills, so no sleeper outlives the test. With
 * `delaySeconds`, the matching call sleeps that long and then runs the real
 * git; use it only under a timeout well above the delay, which tells a patient
 * injected timeout apart from the production one.
 *
 * Call it before changing PATH: the real git is resolved here.
 */
export function createBlockingGit(
  blockOn: string,
  options: { delaySeconds?: number } = {},
): BlockingGit {
  const realGit = execFileSync("sh", ["-c", "command -v git"], {
    encoding: "utf8",
  }).trim();
  const binDir = mkdtempSync(join(tmpdir(), "blocking-git-"));
  const callsFile = join(binDir, "blocked-calls");
  // Values are embedded in single quotes below.
  for (const value of [blockOn, realGit, callsFile]) {
    if (value.includes("'")) {
      throw new Error(`createBlockingGit cannot quote: ${value}`);
    }
  }
  const onMatch =
    options.delaySeconds === undefined
      ? ["    exec sleep 30"]
      : [`    sleep ${options.delaySeconds}`, "    break"];
  const script = [
    "#!/bin/sh",
    'for arg in "$@"; do',
    `  if [ "$arg" = '${blockOn}' ]; then`,
    `    echo blocked >> '${callsFile}'`,
    ...onMatch,
    "  fi",
    "done",
    `exec '${realGit}' "$@"`,
    "",
  ].join("\n");
  writeFileSync(join(binDir, "git"), script);
  chmodSync(join(binDir, "git"), 0o755);
  return {
    binDir,
    blockedCalls: () =>
      existsSync(callsFile)
        ? readFileSync(callsFile, "utf8").trim().split("\n").length
        : 0,
    cleanup: () => rmSync(binDir, { recursive: true, force: true }),
  };
}
```

- [ ] **Step 1**: 上のファイルを作成する
- [ ] **Step 2**: `bun run typecheck` は tests を除外しているので（tsconfig の `exclude`）、`bun run lint:oxlint` が通ることを確認する

### T1: workflow-bash-sync の注入点（K1）

**Files:**

- 編集: `H/implementations/workflow-bash-sync.ts:69-118, :264-293, :340-349, :464`
- テスト: `H/tests/unit/workflow-bash-sync.test.ts:16, :148-260`
- 参照: `H/implementations/complexity-delta.ts:50-53, :78-83, :409-452`（同形の前例）、`H/tests/unit/workflow-bash-sync.test.ts:231-248`（PATH を書き換える前例）

- [ ] **Step 1: 失敗するテストを書く**

import を差し替え、既存の全テストは注入した長い timeout の `hook` を使う。

```ts
import defaultHook, {
  createHook,
} from "../../implementations/workflow-bash-sync.ts";
import { createBlockingGit } from "../support/fake-git.ts";

const PATIENT_TIMEOUT_MS = 10_000;
const hook = createHook(() => ({ tripwireGitTimeoutMs: PATIENT_TIMEOUT_MS }));
```

`describe("workflow-bash-sync.ts: tripwire (K2)")` の末尾に追加する。

```ts
it("disables itself when git status exceeds the production 200ms timeout", async () => {
  const repo = createGitWorkflowRepo();
  envHelper.set("CLAUDE_TEST_CWD", repo);
  // After the fixture: createGitWorkflowRepo runs the real git.
  const git = createBlockingGit("status");
  envHelper.set("PATH", `${git.binDir}:${process.env.PATH ?? ""}`);
  try {
    const ctx1 = createPostToolUseContextFor(defaultHook, "Bash", {
      command: "true",
    });
    await invokeRun(defaultHook, ctx1);
    match(additionalContextOf(ctx1), /tripwire disabled/);
    // The literal 200 pins the production default; do not derive it.
    match(
      readFileSync(join(repo, wfRel, ".tripwire-disabled"), "utf-8"),
      /git status timed out after 200ms/,
    );
    const blockedAfterFirst = git.blockedCalls();

    // The latch: the doc recommendation was cached by ctx1 and the disabled
    // marker skips the tripwire, so the second call reports nothing and does
    // not run git status again.
    const ctx2 = createPostToolUseContextFor(defaultHook, "Bash", {
      command: "true",
    });
    await invokeRun(defaultHook, ctx2);
    strictEqual(ctx2.jsonCalls.length, 0);
    strictEqual(git.blockedCalls(), blockedAfterFirst);
  } finally {
    git.cleanup();
  }
});
```

`git.blockedCalls()` を「1」と比べないのは、200ms のタイムアウトが fake git の記録より先に来うるため（共通事項）。経路を通ったことは文言と `.tripwire-disabled` の内容で確かめる。

- [ ] **Step 2: 失敗を確認する** — `RUN H/tests/unit/workflow-bash-sync.test.ts`。期待: `createHook` が export されていないため SyntaxError（import の解決失敗）で失敗する
- [ ] **Step 3: 最小実装**

変更は次の 5 か所だけで、ほかの行（文言・コメント・処理）は変えない。

1. :69 の定数の直後に型と既定値を足す

```ts
const TRIPWIRE_GIT_TIMEOUT_MS = 200;

type HookEnv = {
  tripwireGitTimeoutMs: number;
};

function defaultEnv(): HookEnv {
  return { tripwireGitTimeoutMs: TRIPWIRE_GIT_TIMEOUT_MS };
}
```

2. :73 の `const hook = defineHook({` を `export function createHook(getEnv: () => HookEnv = defaultEnv) {` + `return defineHook({` に変え、対応する `});`（:124）の後に `}` を足す。`defineHook` に渡すオブジェクト（`trigger` と `run` の本体）はそのまま
3. `run` の中の tripwire 呼び出し（:113）を次の形に変える

```ts
const tripwireMessage = await checkTripwire(
  wfDir,
  cwd,
  getEnv().tripwireGitTimeoutMs,
);
```

4. `checkTripwire` のシグネチャを `async function checkTripwire(wfDir: string, cwd: string, timeoutMs: number): Promise<string | null>` にし、`execFileAsync` の options を `{ timeout: timeoutMs, encoding: "utf-8" }`、catch 内を `writeDisabledMarker(disabledPath, describeGitFailure(error, timeoutMs));` にする
5. `describeGitFailure(error: unknown, timeoutMs: number): string` にし、`err.killed` の分岐を ``return `git status timed out after ${timeoutMs}ms`;`` にする。:464 の `export default hook;` の直前に `const hook = createHook();` を置く

`describeGitFailure` の呼び出し元が 1 か所だけであることを、実装前に `grep -n "describeGitFailure" H/implementations/workflow-bash-sync.ts` で確かめる（定義と呼び出しの 2 行）。

- [ ] **Step 4: 通過を確認する** — `RUN H/tests/unit/workflow-bash-sync.test.ts`。期待: 全件 PASS。追加したテストの所要は 1 秒未満（200ms のタイムアウト 1 回）。`exec sleep 30` なので、タイムアウトの SIGTERM は sleep 自身に届き、プロセスは残らない（別途の確認はしない）

### T2: working-tree-fingerprint の deadline 引数（K2）

**Files:**

- 編集: `H/lib/working-tree-fingerprint.ts:245-270`
- テスト: `H/tests/unit/working-tree-fingerprint.test.ts:100-106` ほか直接呼び出し（:201, :203, :225, :234, :235, :240, :273, :284, :294, :323, :325）
- 参照: `H/lib/working-tree-fingerprint.ts:27, :42-57, :131-135`、`H/implementations/completion-gate.ts:163, :185`

- [ ] **Step 1: 失敗するテストを書く**

import を 2 行足し、既存の `saveCurrent` と `stateOf`（:100-106）を次の内容で **置き換える**（同名の関数を 2 つ目として足さない）。

```ts
import { createBlockingGit } from "../support/fake-git.ts";
import { EnvironmentHelper } from "./test-helpers.ts";

const PATIENT_DEADLINE_MS = 30_000;

function saveCurrent(stateDir: string, repo: string): void {
  saveBaseline(
    stateDir,
    "s1",
    computeTreeFingerprint(repo, PATIENT_DEADLINE_MS),
  );
}

function stateOf(stateDir: string, repo: string): string {
  return checkTreeChange(stateDir, "s1", repo, PATIENT_DEADLINE_MS).state;
}
```

直接呼び出しの `computeTreeFingerprint(x)` と `checkTreeChange(a, b, c)` に、すべて `PATIENT_DEADLINE_MS` を足す（#16 の `computeTreeFingerprint(repo, 0)`（:278）だけは 0 のまま）。`describe("fail-safe")` に 2 本追加する。

```ts
it("forwards the deadline: checkTreeChange with 0 is unknown despite a valid baseline", () => {
  const repo = makeRepo();
  const stateDir = makeTempDir();
  saveCurrent(stateDir, repo);
  deepStrictEqual(checkTreeChange(stateDir, "s1", repo, 0), {
    state: "unknown",
    reason: "fingerprint unavailable",
  });
});

it("gives up at the production default deadline when git diff blocks", () => {
  const repo = makeRepo();
  const stateDir = makeTempDir();
  saveCurrent(stateDir, repo);
  const env = new EnvironmentHelper();
  const git = createBlockingGit("diff");
  env.set("PATH", `${git.binDir}:${process.env.PATH ?? ""}`);
  try {
    // Three arguments: the production default (2000ms) must expire. The
    // deadline may run out on the earlier rev-parse calls under load, so
    // only the result is asserted, not that diff was reached.
    strictEqual(checkTreeChange(stateDir, "s1", repo).state, "unknown");
  } finally {
    env.restore();
    git.cleanup();
  }
});
```

- [ ] **Step 2: 失敗を確認する** — `RUN H/tests/unit/working-tree-fingerprint.test.ts`。期待: 「forwards the deadline」が `state: "unchanged"` を返して FAIL する（4 番目の引数が無視されるため）
- [ ] **Step 3: 最小実装**

変更は 2 行だけ。シグネチャに引数を 1 つ足し、本体の `const current = computeTreeFingerprint(cwd);`（:263）に引数を渡す。

```ts
export function checkTreeChange(
  stateDir: string,
  sessionId: string,
  cwd: string,
  deadlineMs: number = DEFAULT_DEADLINE_MS,
): TreeChangeResult {
```

```ts
const current = computeTreeFingerprint(cwd, deadlineMs);
```

- [ ] **Step 4: 通過を確認する** — 同じコマンドで全件 PASS。「gives up at the production default deadline」の所要は約 2 秒（結果だけを assert し、経過時間は assert しない。spec K8）

### T3: complexity-delta の git timeout と :387 の修正（K3）

**Files:**

- 編集: `H/implementations/complexity-delta.ts:43, :50-53, :78-83, :166-177, :414-419`
- テスト: `H/tests/unit/complexity-delta.test.ts:59-72, :251-255, :387-398`
- 参照: `H/implementations/complexity-delta.ts:419`（`getEnv()` は呼び出しごとに評価される）

- [ ] **Step 1: 失敗するテストを書く**

`setup()`（:59-127）を、呼び出しごとに cccc の timeout を切り替えられる形にする。変えるのは次の 3 か所だけ。

1. :68-72 の `const hook = createHook(...)` を次の内容に置き換える

```ts
let ccccTimeoutMs = options.timeoutMs ?? PATIENT_TIMEOUT_MS;
const hook = createHook(() => ({
  stateDir,
  pathEnv: binDir,
  ccccTimeoutMs,
  gitTimeoutMs: PATIENT_TIMEOUT_MS,
}));
/** Applies to the next hook call: getEnv is read on every run. */
const setTimeoutMs = (ms: number) => {
  ccccTimeoutMs = ms;
};
```

2. :118 からの `return { repo, stateDir, ..., logs, ... }` のオブジェクトに `setTimeoutMs,` を 1 行足す
3. ほかの行は変えない

:251 の `createHook(() => ({ ... }))` にも `gitTimeoutMs: PATIENT_TIMEOUT_MS` を足す。:387 を書き換える。

```ts
it("counts a stop timeout and resets the count on a success", async () => {
  const t = setup();
  t.respond(report([fn("f", 24)]));
  await t.prompt();
  // Only the hanging call races the short timeout.
  t.setTimeoutMs(200);
  t.script("exec sleep 30");
  assert.equal((await t.stop()).jsonCalls.length, 0);
  assert.equal(t.state().timeouts, 1);
  t.setTimeoutMs(PATIENT_TIMEOUT_MS);
  t.respond(report([fn("f", 24)]));
  await t.prompt();
  assert.equal(t.state().timeouts, 0);
  assert.equal(t.state().disabled, undefined);
});
```

注入した git の timeout が実際に使われることを示すテストを、`describe("complexity-delta: giving up")` の前に追加する。`rev-parse` を 3 秒遅らせてから本物の git に委譲する fake を使う。本番の 2000ms なら必ずタイムアウトし、注入した 10_000ms なら通る。

```ts
it("uses the injected git timeout to find the repository root", async () => {
  const t = setup();
  t.respond(report([fn("f", 24)]));
  const envHelper = new EnvironmentHelper();
  const git = createBlockingGit("rev-parse", { delaySeconds: 3 });
  envHelper.set("PATH", `${git.binDir}:${process.env.PATH ?? ""}`);
  try {
    await t.prompt();
    // The prompt only records a baseline after resolveRoot succeeded.
    assert.notEqual(t.state().baseline, null);
    // At least once: the delayed rev-parse was really on the path.
    assert.ok(git.blockedCalls() >= 1);
  } finally {
    envHelper.restore();
    git.cleanup();
  }
});
```

import に `createBlockingGit`（`../support/fake-git.ts`）と `EnvironmentHelper`（`./test-helpers.ts`）を足す。

- [ ] **Step 2: 失敗を確認する** — `RUN H/tests/unit/complexity-delta.test.ts`。期待: 追加したテストが FAIL する。`resolveRoot` が本番の 2000ms でタイムアウトして `null` を返し、state ファイルが作られないので、`t.state()` の `readFileSync` が ENOENT を投げる
- [ ] **Step 3: 最小実装**

変更は次の 4 か所だけ。

1. `HookEnv`（:50-54）に 1 項目足す

```ts
type HookEnv = {
  stateDir: string;
  pathEnv: string | undefined;
  ccccTimeoutMs: number;
  gitTimeoutMs: number;
};
```

2. `defaultEnv()`（:78-84）に 1 項目足す

```ts
function defaultEnv(): HookEnv {
  return {
    stateDir: join(getHomeDir(), ".claude", "state", "complexity-delta"),
    pathEnv: process.env.PATH,
    ccccTimeoutMs: DEFAULT_CCCC_TIMEOUT_MS,
    gitTimeoutMs: GIT_TIMEOUT_MS,
  };
}
```

3. `resolveRoot`（:166-177）のシグネチャを `function resolveRoot(cwd: string, timeoutMs: number): string | null` にし、`execFileSync` の options の `timeout: GIT_TIMEOUT_MS` を `timeout: timeoutMs` にする
4. `createHook` の `run`（:414-419）で、`getEnv()` を `resolveRoot` より前に呼ぶ

```ts
        const { cwd, session_id: sessionId } = context.input;
        if (!SESSION_ID_PATTERN.test(sessionId)) return context.success({});
        const env = getEnv();
        const root = resolveRoot(cwd, env.gitTimeoutMs);
        if (root === null) return context.success({});

        const call: Call = {
```

（元の :419 の `const env = getEnv();` は上に移したので消す）

- [ ] **Step 4: 通過を確認する** — `RUN H/tests/unit/complexity-delta.test.ts` で全件 PASS、`bun run typecheck` で 0 エラー。追加したテストの所要は約 3 秒（結果だけを assert する）
- [ ] **Step 5: 負荷を足さずに確認する** — ISO の手順（下記）で complexity-delta.test.ts を 3 回実行し、3 回とも失敗 0 件。変更前は :387 がアイドル時に、:147 / :173 が CPU 飽和時に落ちていた（research.md §2, §5.5）

### T4: compaction-testament の注入点（K10）

**Files:**

- 編集: `H/implementations/compaction-testament.ts:63, :408-437, :445-456, :487-510, :607-719`
- テスト: `H/tests/unit/compaction-testament.test.ts:21, :1149-1161, :1190-1213`
- 参照: `H/implementations/compaction-testament.ts:453`（「timeout は not ignored」の既存の方針）

- [ ] **Step 1: 失敗するテストを書く**

```ts
import defaultHook, {
  createHook,
} from "../../implementations/compaction-testament.ts";
import { createBlockingGit } from "../support/fake-git.ts";

const PATIENT_TIMEOUT_MS = 10_000;
const hook = createHook(() => ({ gitTimeoutMs: PATIENT_TIMEOUT_MS }));
```

`compact` helper に、使うフックを選ぶ引数を足す: `async (env, transcript, custom = null, target = hook) => { ...; const result = await invokeRun(target, ctx); ... }`。`describe` 内の「treats a broken git dir」の後に追加する。

```ts
it("treats a git check-ignore over the production 2000ms timeout as not ignored", async () => {
  const env = setup({ git: true, ignoreTmp: true });
  const git = createBlockingGit("check-ignore");
  envHelper.set("PATH", `${git.binDir}:${process.env.PATH ?? ""}`);
  try {
    await compact(env, transcriptAt(env, 500_000), null, defaultHook);
    const snap = snapshotOf(env);
    assert.doesNotMatch(snap, /SECRET-UTTERANCE/);
    assert.match(snap, /ignore されていないため省略/);
  } finally {
    git.cleanup();
  }
});
```

`.tmp` を ignore する repo（`ignoreTmp: true`）なので、`check-ignore` が成功すれば詳細を書く（:1177 の既存テスト）。詳細が省略されたことが、`check-ignore` がタイムアウトして「ignore されていない」側に倒れた証拠になる。fake git の呼び出し回数は assert しない（共通事項）。

既存の `import hook from "../../implementations/compaction-testament.ts";`（:21）は上の 2 つの import に置き換える。ファイル内の既存の `hook` の参照（`post` / `compact` など）は、注入した長い timeout のフックを指すようになる。

- [ ] **Step 2: 失敗を確認する** — `RUN H/tests/unit/compaction-testament.test.ts`。期待: `createHook` が export されていないため import の解決で失敗する
- [ ] **Step 3: 最小実装**

変更は次の 6 か所だけで、ほかの行は変えない。

1. :63 の `GIT_TIMEOUT_MS` の直後に型と既定値を足す

```ts
type HookEnv = {
  gitTimeoutMs: number;
};

function defaultEnv(): HookEnv {
  return { gitTimeoutMs: GIT_TIMEOUT_MS };
}
```

2. `runGit`（:410-437）の引数に `timeoutMs: number` を足し、`execFileSync` の options の `timeout: GIT_TIMEOUT_MS` を `timeout: timeoutMs` にする。戻り値の型は今のまま

```ts
function runGit(
  cwd: string,
  args: string[],
  timeoutMs: number,
):
  | { ok: true; stdout: string }
  | { ok: false; status: number | null; stderr: string } {
```

3. `classifyGit`（:445）を `function classifyGit(cwd: string, snapshotPath: string, timeoutMs: number): GitContext` にし、中の 2 か所を `runGit(cwd, ["rev-parse", "--is-inside-work-tree"], timeoutMs)` と `runGit(cwd, ["check-ignore", "-q", snapshotPath], timeoutMs)` にする
4. `handlePreCompact` の input 型（:487-493）に `gitTimeoutMs: number;` を **必須の項目として** 足す（既定値を持たせない。大きな既定値はタイムアウトを成功に変え、プライバシーの判定を変えうるため）。本体の `classifyGit(input.projectDir, realSnapshot)`（:499）、`runGit(input.projectDir, ["branch", "--show-current"])`（:504）、`runGit(input.projectDir, ["status", "--short"])`（:507）に、それぞれ `input.gitTimeoutMs` を最後の引数として渡す
5. :607 の `const hook = defineHook({` を `export function createHook(getEnv: () => HookEnv = defaultEnv) {` + `return defineHook({` に変え、対応する `});` の後に `}` を足す。`run` の中の `handlePreCompact({ ... })`（:677-683）の引数に `gitTimeoutMs: getEnv().gitTimeoutMs,` を足す
6. :719 の `export default hook;` の直前に `const hook = createHook();` を置く

- [ ] **Step 4: 通過を確認する** — 同じコマンドで全件 PASS、`bun run typecheck` で 0 エラー。追加したテストの所要は約 2 秒

### T5: hook-timer :456 を marker で同期する（K4）

**Files:**

- テスト: `H/tests/unit/hook-timer.test.ts:456-480`
- 参照: `H/tests/unit/hook-timer.test.ts:91-104`（`waitForFile`、上限 5000ms）、`:483-500`（同期の前例）

- [ ] **Step 1: 書き換える**

```ts
it("waits for a child that traps TERM before flushing stdout", async () => {
  const logDir = makeTempDir();
  const marker = join(makeTempDir(), "trapped");
  const child = spawn(
    "sh",
    [
      wrapper,
      "PreToolUse",
      "0",
      `trap "echo bye; exit 0" TERM; touch '${marker}'; sleep 5 & wait`,
    ],
    { env: baseEnv(logDir) },
  );
  child.stdin.write("{}");
  child.stdin.end();

  let stdoutData = "";
  child.stdout.on("data", (chunk) => {
    stdoutData += chunk.toString();
  });
  const closed = new Promise<void>((resolve) => {
    child.on("close", () => resolve());
  });

  // Kill only after the trap is installed; a blind delay can land first.
  await waitForFile(marker);
  child.kill("SIGTERM");
  await closed;
  ok(stdoutData.includes("bye"), stdoutData);
});
```

- [ ] **Step 2: 通過を確認する** — `RUN H/tests/unit/hook-timer.test.ts` で全件 PASS

### T6: 確認とコミット

- [ ] **Step 1**: `bun run test`、`bun run typecheck`、`bun run lint` がすべて成功する
- [ ] **Step 2**: ISO の手順で、plan-1 で触れた 5 ファイルを負荷を足さずに 3 回実行し、3 回とも失敗 0 件
- [ ] **Step 3**: コミット（`/commit` を使う。type は `test` と `refactor` の 2 コミットに分けるかは差分を見て決める）

## ISO 25010 具体テストケース

負荷の手順: 負荷を足さない（spec の ISO 25010、research.md §5.6）。`RUN` に複数のファイルを渡すと、`bun run test` と同じく各ファイルが並列の子プロセスで走る。

### 信頼性（成熟性）

- **入力**: `RUN` に plan-1 の 5 テストファイルを渡して 3 回実行 → **期待**: 3 回とも `ℹ fail 0`
- **入力**: 変更前のコードで同じ負荷（実施済み、research.md §5.5）→ **期待**: complexity-delta :147 / :173、compaction-testament「outside any git repository」が失敗する（前提の確認）

### 機能適合性（機能正確性）

- **入力**: default export の workflow-bash-sync フック + `status` で sleep する fake git → **期待**: 文言が `/tripwire disabled/` に一致し、`.tripwire-disabled` に `git status timed out after 200ms` を含む。2 回目の呼び出しは `jsonCalls` が 0 件で、blocked の回数は 1 回目の後の値から増えない
- **入力**: `checkTreeChange(stateDir, "s1", repo, 0)`（正しい baseline あり）→ **期待**: `{ state: "unknown", reason: "fingerprint unavailable" }`
- **入力**: 引数 3 つの `checkTreeChange` + `diff` で sleep する fake git → **期待**: `state` が `"unknown"`
- **入力**: default export の compaction-testament フック + `check-ignore` で sleep する fake git、`.tmp` を ignore する repo → **期待**: snapshot に `SECRET-UTTERANCE` を含まず、`ignore されていないため省略` を含む
- **入力**: complexity-delta :387 の手順（成功 → 200ms で sleep 30 → 成功）→ **期待**: `timeouts` が 1 → 0、`disabled` が `undefined`
- **入力**: complexity-delta の `setup()`（git timeout 10_000）+ `rev-parse` を 3 秒遅らせる fake git → **期待**: prompt の後で `baseline` が `null` でない、blocked の回数が 1

### 保守性（試験性）

- **入力**: 各フックの `createHook(() => ({ ...: 10_000 }))` → **期待**: ロジックテストが本番の 200 / 2000ms と無関係に結果を決められる（上の信頼性のケースで確認）

## Approval

- Plan Status: complete
- Review Status: pass
- Approval Status: approved

## Reviewer Outputs (Round 1)

### logic-validator

- verdict: pass
- 主指摘: 各 Task の Red / Green はコードの読みで成り立つ。fake git が一致する引数は各フックで意図した呼び出しだけ。T2 は既存の `saveCurrent` / `stateOf` を置き換える（2 つ目を足さない）ことを明記すべき

### scope-justification-reviewer

- verdict: pass
- 主指摘: 全 Task が K1〜K4・K10 に対応し、drift も欠落もない。`tests/support/` を plan-1 が先に作る点と、K3 の注入確認テストの根拠を一言書くとよい

### architecture-boundary-analyzer

- verdict: pass
- 主指摘: `createHook` で包んでもモジュールレベルの状態は変わらない。T1・T3・T4 の擬似コードに残る placeholder（`/* 既存の戻り値型 */`、`// ...`）を具体的に書き換えるべき

### security-vulnerability-analyzer

- verdict: pass
- 主指摘: 本番の既定値とプライバシー判定は保たれる。「`process.env` を読まない」はタイムアウトの値に限定して書く（complexity-delta の `pathEnv` は既存で読む）。fake git の引用符への埋め込みを硬くする

### resilience-analyzer

- verdict: needs-work
- 主指摘: `blockedCalls() === 1` が、短いタイムアウトと fake git の `echo` との競争になり、飽和負荷で 0 になりうる（T1 の 200ms、T2・T4 の 2000ms）。T1 Step 5 の `pgrep` は無関係なプロセスに一致しうる

<!-- auto-review: pending -->
<!-- intent-triage: pending -->

## Reviewer Outputs (Round 2)

### logic-validator

- verdict: pass
- 主指摘: 具体化した差分はコードの行と一致する。T1 の `ctx2.jsonCalls.length === 0` は既存 :231 と同じ理由で成り立つ。`defineHook` を閉じる `});` は :118 ではなく :124 → 反映済み

### resilience-analyzer

- verdict: pass
- 主指摘: Round 1 の P1・P2 は解消し、T0〜T5 にタイムアウトと競争する assert は残っていない。T3 の回数の assert は `>= 1` の方が将来の変更に強い → 反映済み。`pkill -x yes` は他の `yes` も止めうる（承認済みの spec の手順なので変えない）

### scope-justification-reviewer

- verdict: pass (carried from Round 1)
- 主指摘: Round 1 で pass、再実行なし

### architecture-boundary-analyzer

- verdict: pass (carried from Round 1)
- 主指摘: Round 1 で pass、再実行なし

### security-vulnerability-analyzer

- verdict: pass (carried from Round 1)
- 主指摘: Round 1 で pass、再実行なし

<!-- auto-review: verdict=needs-work; hash=401269400499dc2f7bd6b986e094794a0e956a2f9dcea2415a5af513b9c29297; design-hash=4966ec28610060a04f9df209183bcc0d8fa3ee1fe72d2b7bf0a8fa423823ae3c; round=1; parent-spec-hash=36a179d137aa3116e9ecbb5ddb950d4815896d431fee0fe3f28f2ab8139f2766; at=2026-10-05T21:56:28.626Z; reviewers=logic-validator+scope-justification-reviewer+architecture-boundary-analyzer+security-vulnerability-analyzer+resilience-analyzer -->
<!-- intent-triage: adopted=13; excluded=0; at=2026-10-05T21:56:28.661Z -->

## Reviewer Outputs (Round 3)

### logic-validator

- verdict: pass
- 主指摘: T6 と ISO の手順は新しい基準に揃っている。T3 Step 5 の見出し「負荷下で確認する」だけが古かった → 「負荷を足さずに確認する」に直した

### resilience-analyzer

- verdict: pass (carried from Round 2)
- 主指摘: Round 2 で pass、再実行なし

### scope-justification-reviewer

- verdict: pass (carried from Round 2)
- 主指摘: Round 2 で pass、再実行なし

### architecture-boundary-analyzer

- verdict: pass (carried from Round 2)
- 主指摘: Round 2 で pass、再実行なし

### security-vulnerability-analyzer

- verdict: pass (carried from Round 2)
- 主指摘: Round 2 で pass、再実行なし

<!-- auto-review: verdict=pass; hash=1e2637feb980afe22f059367c3635f501bc09fdb30ca824ade76212bc6e64ef6; design-hash=fbd3bd001a3bf545c935a6969ef0e787ea20e0e1a179d2be2eb647d55f35d2fb; round=2; parent-spec-hash=36a179d137aa3116e9ecbb5ddb950d4815896d431fee0fe3f28f2ab8139f2766; at=2026-10-05T22:00:43.165Z; reviewers=logic-validator+resilience-analyzer -->
<!-- intent-triage: adopted=2; excluded=0; at=2026-10-05T22:00:43.285Z -->

<!-- auto-review: verdict=pass; hash=738f8f66aaa7cc7138d8e287f7763e753687f084ec22b417a686c21cdd56aea3; design-hash=927f5651b53ff6393c6d21e3fcc0fc992267f8b60bbbac55730ba69c3c39c19a; round=3; parent-spec-hash=08fcc6597c6f756dee0437c64d84e0501f1d214545bde2f2b74a0a57714fe9d0; at=2026-10-05T22:58:18.351Z; reviewers=logic-validator -->
<!-- intent-triage: adopted=1; excluded=0; at=2026-10-05T22:58:18.511Z -->
