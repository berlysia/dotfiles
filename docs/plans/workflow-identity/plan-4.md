<!-- spec-ref: spec.md -->

# Plan: CLI のセッションと場所を hook と同じ入力で決め、出力としての env を廃止する (Execution layer)

spec K3・K4・K5（#197、#209-3）。H = `home/dot_claude/hooks`。plan-3 の実装（commit 963e073 まで）を前提にする。spec Open Questions の V1 は成立済み（research.md: `/clear` で `CLAUDE_CODE_SESSION_ID` が hook の `session_id` に追従、`/resume` で維持）。

## 方針と範囲

- T1（K3）: CLI の `import.meta.main` にある wfDir の決定を、export した `resolveCliDeps(argv, now)` に移してテストできる形にする。root は `getProjectRoot()`、セッションは `CLAUDE_CODE_SESSION_ID`、wfDir は `resolveWorkflowDir`（hook と同じ関数）。`CLAUDE_SESSION_ID` は読まない
  - `CLAUDE_PROJECT_DIR`（またはテスト用の `CLAUDE_TEST_CWD`）が無いときは失敗する。ただし `--wf-dir` があれば `process.cwd()` を root にして続ける（人間がターミナルでプロジェクトの root から実行する場合）。`getProjectRoot()` は最後に `process.cwd()` に落ちるので、呼ぶ前に env の有無を確かめる
  - `CLAUDE_CODE_SESSION_ID` が無いときも、`--wf-dir` が無ければ失敗する
  - `--wf-dir` は決定元を `override` にする。解決値と違う dir を指すときは stderr に警告する。`--wf-dir` が無いときの「解決値と session 由来の値が違う」警告はやめる。K4 で古い export が無くなるので、違うのは起動時 pin（`source=env`）の場合だけになり、それは利用者の意図だから
  - `RunWorkflowCliDeps` に `wfDirSource: "derived" | "env" | "none"` を必須で足す。テストの deps 17 か所にも足す（既定値を置くと、本番の呼び出しで書き忘れても `derived` と表示されてしまう）。`none` は「解決できず `--wf-dir` だけが dir を決められる」状態で、そのとき `wfDir` は空。仮の dir を入れて `derived` と名乗らせない
  - `--wf-dir` の判定は `parseArgs` に一本化する（`argv.includes` を使わない）。値の無い `--wf-dir` はエラーにする
  - `--wf-dir` があっても解決できるなら解決値を deps に入れ、flag が解決値（起動時 pin を含む）と違うときに警告する
  - `CLAUDE_PROJECT_DIR` は絶対パスかつ存在する dir であることを確かめる。エラー文には起動し直すこと（配備前のセッションでは旧 SessionStart が export した dir の値を使わないこと。文言は T4 の検査に当たらないよう `$` を付けない）を書く
  - env の値をエラー文に出すときは `sanitizeForDisplay` を通す（`resolveCliDeps` の 3 か所と既存の `--wf-dir` のエラー）
- T2（K5）: `stamp` / `triage` も `round` と同じく素のファイル名だけを受け付ける。書き込み系 3 つの成功出力の末尾に `wfDir=` / `source=` / `wrote=` を 1 行ずつ足す。`workflow-cli dir` を足し、`wfDir=` と `source=` の 2 行だけを出す。失敗時は stdout を空にして stderr に理由を出す（既存の `err()` の形）
  - `workflow-cli dir` は、決定元が `env` / `override` で dir が存在しないときに stderr で警告する。`derived` の dir が無いのは初回の正常な状態なので警告しない
- T3（K4）: SessionStart は `CLAUDE_SESSION_ID` と `DOCUMENT_WORKFLOW_DIR` を export しない。`DOCUMENT_WORKFLOW_DIR` の二重引用符の安全検査（`isSafeForDoubleQuotedExport` と関連の表示）は、書く先が無くなるので消す。起動時のまとめに出す wfDir の表示はそのまま
- T4（K4）: model が書き込み先やセッション ID に `$DOCUMENT_WORKFLOW_DIR` / `$CLAUDE_SESSION_ID` を使う手順を、`workflow-cli dir` と `$CLAUDE_CODE_SESSION_ID` に置き換える。漏れを検査テストで固定する
  - 置き換えないもの: 起動時 pin の手順（`DOCUMENT_WORKFLOW_DIR=<dir> claude "…"`、task-handoff と reference skill）。K3 が「入力としての起動時 pin」として残す。hook プロセスが env を読む箇所（spec K4 の列挙。`unified-audio-config.ts:57`、guard の scratch root、session.ts の userPin、workflow-resolve.ts の入力 pin）
  - 検査の対象と許可: 対象は spec K4 の 5 種のパス。禁止するのは `$DOCUMENT_WORKFLOW_DIR` / `${DOCUMENT_WORKFLOW_DIR` / `$CLAUDE_SESSION_ID` / `${CLAUDE_SESSION_ID` / `env.CLAUDE_SESSION_ID`。許可は guard の scratch root の docstring 2 か所（hook プロセスが起動時 pin を読む説明）だけ。spec が許可に挙げた残りの 3 か所は、この表記を含まない（`process.env.DOCUMENT_WORKFLOW_DIR` は禁止形に当たらない）か、対象外のディレクトリにある（`home/dot_claude/lib/unified-audio-config.ts`）
- 運用上の注意:
  - plan-2〜plan-5 の実装が終わるまで `chezmoi apply` しない
  - spec R6: 配備後は Claude Code を起動し直す。配備前に起動したセッションの Bash env には旧 SessionStart が export した `DOCUMENT_WORKFLOW_DIR` が残り、起動時 pin と同じ扱いになる。そのセッションには `CLAUDE_PROJECT_DIR` も無いので CLI は失敗する（安全側）。ADR（plan-5）に書く

## 受け入れるリスク

- `CLAUDE_CODE_SESSION_ID` は env-vars のページに載っておらず、CHANGELOG にだけ記載がある（spec R2）。値が無いときは `--wf-dir` を求めて失敗するので、黙って別の dir を使うことはない
- 人間のターミナルで `--wf-dir` を使うときは、`process.cwd()` が root になる。プロジェクトの root 以外から実行すると、`--wf-dir` の検証（`<root>/.tmp/sessions` の厳密な子孫）に通らず失敗する（安全側）
- 起動時 pin（`DOCUMENT_WORKFLOW_DIR=… claude`）で別の dir を使っているときも、CLI は警告を出さない。成功出力の `source=env` で分かる
- 起動時 pin が拒否された（`env-rejected`）ときの決定元は stdout では `derived` と表示し、拒否は stderr の警告だけで伝える。hook も同じ扱い（拒否された pin は使わない）なので、stdout の値は実際に使う dir と一致する
- model が `CLAUDE_PROJECT_DIR=/x workflow-cli round plan-1.md` のように env を前置すると、guard が評価した wfDir と違う場所に CLI が書く。意図的な迂回で、spec R4 の脅威モデルの外
- `CLAUDE_PROJECT_DIR` は K4 の後も SessionStart が export し続ける。Bash の env に残る値だが、`/clear` をまたいでも同じ Claude Code プロセスのプロジェクトを指すので、#197 の取り違えは起きない（spec K1）。ADR（plan-5）に書く
- `CLAUDE_PROJECT_DIR` が壊れた値（相対パス・消えた dir）で残っていると、`--wf-dir` を付けても失敗する。変数名を出して失敗するので安全側。人間がターミナルで使うときは `unset CLAUDE_PROJECT_DIR` してから `--wf-dir` を使う
- session.ts と CLI が、`resolveWorkflowDir` の結果から人向けの文言を別々に作る（env-rejected と unresolvable）。文言の共通化は本 plan では行わない
- K4 の検査テストの許可リストは、spec が挙げた 4 か所ではなく guard の docstring 2 か所だけにする（残りは禁止形を含まないか、走査の対象外）。spec からの差として ADR（plan-5）に書く

## Files

```
# 編集
home/dot_claude/hooks/cli/workflow.ts
home/dot_claude/hooks/implementations/session.ts
home/dot_claude/rules/workflow.md
home/dot_claude/CLAUDE.md
CLAUDE.md
.skills/document-workflow-reference/SKILL.md
.skills/task-handoff/SKILL.md
.skills/session-memo/SKILL.md
.skills/test-design/SKILL.md

# 新規作成
home/dot_claude/hooks/tests/unit/workflow-env-references.test.ts

# テスト
home/dot_claude/hooks/tests/unit/workflow-cli.test.ts
home/dot_claude/hooks/tests/unit/session.test.ts
```

## Tasks

テストの実行は、リポジトリ（worktree）のルートで `node --import ./home/dot_claude/hooks/tests/preload-test-env.mjs --test <file>`。着手前に `bun run test` の pass 数を控える（plan-3 完了時点で tests 2291 / pass 2275 / fail 0 / skipped 16）。

### T1: CLI の wfDir を `getProjectRoot()` と `CLAUDE_CODE_SESSION_ID` から決める（K3）

**Files:**

- 編集: `H/cli/workflow.ts`（冒頭の docstring :12-16、`RunWorkflowCliDeps`、`resolveTargetWfDir`、`import.meta.main`、新規 `resolveCliDeps`）
- テスト: `H/tests/unit/workflow-cli.test.ts`（既存の deps 17 か所に `wfDirSource` を足す。"workflow-cli: resolveCliDeps" の describe を新設）
- 参照: `H/lib/workflow-resolve.ts:84-143`（`resolveWorkflowDir`。`DOCUMENT_WORKFLOW_DIR` は起動時 pin としてここで `process.env` から読まれる。env を引数で渡す形にできないので、テストは `EnvironmentHelper` で `process.env` を書き換える）
- 参照: `H/lib/project-root.ts`、`H/lib/sanitize-display.ts`

- [ ] **Step 1: 失敗するテストを書く**

workflow-cli.test.ts の既存の deps に `wfDirSource: "derived",` を足す。`sessionId: "test-ses",` の行は 17 か所（:56, :86, :116, :157, :183, :206, :229, :243, :345, :923, :947, :975, :1002, :1053, :1071, :1103, :1123）。:1071 は 1 行の literal（`{ cwd: wf, wfDir: wf, sessionId: "test-ses", now: NOW }`）なので、その行の中に `wfDirSource: "derived",` を足す。残りの 16 か所は次の行に足す。:243 と :345 はヘルパーの戻り値で、`{ ...deps(wf), ledgerPath }` の形の呼び出しには自動で入る。足した後に `grep -c 'wfDirSource: "derived"'` が 17 になることを確かめる。

新設する describe:

```ts
describe("workflow-cli: resolveCliDeps (spec K3)", () => {
  const envHelper = new EnvironmentHelper();
  const NOW = new Date("2026-10-02T00:00:00.000Z");
  let root: string;

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "cli-deps-")));
    envHelper.set("CLAUDE_TEST_CWD", undefined);
    envHelper.set("CLAUDE_PROJECT_DIR", root);
    envHelper.set("CLAUDE_CODE_SESSION_ID", "abcdef1234567890");
    envHelper.set("CLAUDE_SESSION_ID", "ffffffff99999999");
    envHelper.set("DOCUMENT_WORKFLOW_DIR", undefined);
  });

  afterEach(() => {
    envHelper.restore();
  });

  it("derives the dir from CLAUDE_PROJECT_DIR and CLAUDE_CODE_SESSION_ID, ignoring CLAUDE_SESSION_ID", () => {
    const r = resolveCliDeps(["status"], NOW);
    assert.ok("deps" in r, JSON.stringify(r));
    assert.equal(r.deps.cwd, root);
    assert.equal(r.deps.wfDir, join(root, ".tmp", "sessions", "abcdef12"));
    assert.equal(r.deps.wfDirSource, "derived");
  });

  it("reports a startup pin as source env", () => {
    envHelper.set("DOCUMENT_WORKFLOW_DIR", ".tmp/sessions/pinned00");
    const r = resolveCliDeps(["status"], NOW);
    assert.ok("deps" in r);
    assert.equal(r.deps.wfDir, join(root, ".tmp", "sessions", "pinned00"));
    assert.equal(r.deps.wfDirSource, "env");
  });

  it("falls back to the derived dir with a warning when the startup pin is rejected", () => {
    envHelper.set("DOCUMENT_WORKFLOW_DIR", "../outside");
    const r = resolveCliDeps(["status"], NOW);
    assert.ok("deps" in r);
    assert.equal(r.deps.wfDirSource, "derived");
    assert.equal(r.deps.wfDir, join(root, ".tmp", "sessions", "abcdef12"));
    assert.match(
      r.warning ?? "",
      /DOCUMENT_WORKFLOW_DIR="\.\.\/outside" is not a verified descendant/,
    );
  });

  it("fails without CLAUDE_PROJECT_DIR unless --wf-dir has a value", () => {
    envHelper.set("CLAUDE_PROJECT_DIR", undefined);
    for (const argv of [["status"], ["status", "--wf-dir"]]) {
      const r = resolveCliDeps(argv, NOW);
      assert.ok("error" in r, argv.join(" "));
      assert.match(r.error, /CLAUDE_PROJECT_DIR/);
      assert.match(r.error, /restart Claude Code/);
    }
    assert.ok(
      "deps" in resolveCliDeps(["status", "--wf-dir", ".tmp/sessions/x"], NOW),
    );
  });

  it("fails when CLAUDE_PROJECT_DIR is relative or does not exist", () => {
    for (const value of ["relative/dir", join(root, "missing")]) {
      envHelper.set("CLAUDE_PROJECT_DIR", value);
      const r = resolveCliDeps(["status"], NOW);
      assert.ok("error" in r, value);
      assert.match(r.error, /CLAUDE_PROJECT_DIR/);
    }
  });

  it("fails without CLAUDE_CODE_SESSION_ID unless --wf-dir is given", () => {
    envHelper.set("CLAUDE_CODE_SESSION_ID", undefined);
    const r = resolveCliDeps(["status"], NOW);
    assert.ok("error" in r);
    assert.match(r.error, /CLAUDE_CODE_SESSION_ID/);
    assert.match(r.error, /--wf-dir/);
    const withFlag = resolveCliDeps(
      ["status", "--wf-dir", ".tmp/sessions/x"],
      NOW,
    );
    assert.ok("deps" in withFlag);
    assert.equal(withFlag.deps.wfDirSource, "none");
  });
});
```

（`resolveCliDeps` を `../../cli/workflow.ts` から、`EnvironmentHelper` を `./test-helpers.ts` から、`afterEach` / `beforeEach` を `node:test` から、既存の import に足す。`realpathSync` / `mkdtempSync` / `mkdirSync` / `tmpdir` は plan-3 T3 で足し済み。`--wf-dir` の上書きの検査は `dir` コマンドを使うので T2 に置く）

- [ ] **Step 2: テストを実行して失敗を確認**

実行: `node --import ./home/dot_claude/hooks/tests/preload-test-env.mjs --test home/dot_claude/hooks/tests/unit/workflow-cli.test.ts`
期待: `resolveCliDeps` が export されていないので、ファイル全体が `SyntaxError: ... does not provide an export named 'resolveCliDeps'` で失敗する

- [ ] **Step 3: 最小実装を書く**

冒頭の docstring :12-16 の「The `import.meta.main` block below is the only place this file touches the real process.」を「`resolveCliDeps` and the `import.meta.main` block below are the only places this file reads the real process environment; `runWorkflowCli` itself stays pure.」にする。

型と `RunWorkflowCliDeps` に足す:

```ts
/** Where a workflow dir came from. `override` is a --wf-dir flag. */
export type WfDirSource = "derived" | "env" | "override";

// in RunWorkflowCliDeps:
/**
 * Where `wfDir` came from: derived from the session id, a startup pin, or
 * `none` when nothing resolved and only a --wf-dir flag can name the dir
 * (`wfDir` is then empty and every command requires the flag).
 */
wfDirSource: Exclude<WfDirSource, "override"> | "none";
```

`resolveCliDeps` を `runWorkflowCli` の直前に足す（`existsSync` / `statSync` は `node:fs`、`isAbsolute` は `node:path`、`getProjectRoot` を `../lib/project-root.ts`、`resolveWorkflowDir` を `../lib/workflow-resolve.ts`、`sanitizeForDisplay` を `../lib/sanitize-display.ts` から import。既にあるものは足さない）:

```ts
export type ResolvedCliDeps =
  | { deps: RunWorkflowCliDeps; warning: string | null }
  | { error: string };

const RESTART_HINT =
  "restart Claude Code if this session started before the hooks were deployed (and do not rely on the DOCUMENT_WORKFLOW_DIR value the old SessionStart exported), or pass --wf-dir <dir> from the project root.";

/**
 * The CLI's root, session and workflow dir, taken from the same inputs the
 * hooks use (spec K3): the root from getProjectRoot(), the session from
 * CLAUDE_CODE_SESSION_ID (Claude Code passes it to the Bash tool and it
 * follows /clear, unlike the CLAUDE_SESSION_ID the SessionStart hook used to
 * export), the dir from resolveWorkflowDir. Without those values the CLI
 * fails instead of guessing from process.cwd(), unless --wf-dir names the
 * dir -- then the root is process.cwd() (a human at a terminal in the
 * project root) and resolveTargetWfDir validates the flag.
 */
export function resolveCliDeps(argv: string[], now: Date): ResolvedCliDeps {
  const hasWfDirFlag = Boolean(parseArgs(argv).flags["wf-dir"]);
  const rootEnv = process.env.CLAUDE_TEST_CWD || process.env.CLAUDE_PROJECT_DIR;
  if (!rootEnv && !hasWfDirFlag) {
    return {
      error: `CLAUDE_PROJECT_DIR is not set. The SessionStart hook exports it; ${RESTART_HINT}`,
    };
  }
  if (rootEnv && !isExistingAbsoluteDir(rootEnv)) {
    return {
      error: `CLAUDE_PROJECT_DIR="${sanitizeForDisplay(rootEnv)}" is not an existing absolute directory; ${RESTART_HINT}`,
    };
  }
  const cwd = getProjectRoot();
  const sessionId = process.env.CLAUDE_CODE_SESSION_ID ?? "";
  if (!sessionId) {
    if (hasWfDirFlag) {
      return {
        deps: { cwd, wfDir: "", wfDirSource: "none", sessionId, now },
        warning: null,
      };
    }
    return {
      error:
        "CLAUDE_CODE_SESSION_ID is not set (Claude Code passes it to its Bash tool). Outside Claude Code, pass --wf-dir <dir>.",
    };
  }
  const resolution = resolveWorkflowDir({ cwd, sessionId });
  if (resolution.source === "unresolvable") {
    if (hasWfDirFlag) {
      return {
        deps: { cwd, wfDir: "", wfDirSource: "none", sessionId, now },
        warning: null,
      };
    }
    return {
      error:
        resolution.reason === "invalid-session-id"
          ? `CLAUDE_CODE_SESSION_ID="${sanitizeForDisplay(sessionId)}" is not a valid session id; pass --wf-dir <dir>.`
          : `could not verify that the derived workflow dir is a strict descendant of ${cwd}/${SESSIONS_SUBDIR}; pass --wf-dir <dir>.`,
    };
  }
  return {
    deps: {
      cwd,
      wfDir: resolution.dir,
      wfDirSource: resolution.source === "env" ? "env" : "derived",
      sessionId,
      now,
    },
    warning:
      resolution.source === "env-rejected"
        ? `DOCUMENT_WORKFLOW_DIR="${sanitizeForDisplay(process.env.DOCUMENT_WORKFLOW_DIR ?? "")}" is not a verified descendant of ${cwd}/${SESSIONS_SUBDIR}; using the session-derived dir.`
        : null,
  };
}

function isExistingAbsoluteDir(path: string): boolean {
  try {
    return isAbsolute(path) && statSync(path).isDirectory();
  } catch {
    return false;
  }
}
```

（`--wf-dir` があるときも、解決できれば解決値を `deps.wfDir` に入れる。`resolveTargetWfDir` が flag と解決値を比べて警告するため。起動時 pin も「解決値」に含まれる）

`resolveTargetWfDir` を置き換える。戻り値に `source` を足し、空の flag と解決値の無い場合をエラーにし、警告の比較相手を解決値（`deps.wfDir`）にする:

```ts
/**
 * Which wfDir this invocation targets: a --wf-dir flag (validated as a strict
 * descendant of .tmp/sessions) wins over the resolved `deps.wfDir`. A flag
 * that differs from the resolved dir is honoured with a warning; an invalid
 * or empty flag is an error rather than a fallback, since the operator named
 * a target (a smoke test once inserted a round into an approved spec by
 * falling back).
 */
function resolveTargetWfDir(
  flags: Record<string, string>,
  deps: RunWorkflowCliDeps,
):
  | {
      wfDir: string;
      source: WfDirSource;
      warning: string | null;
      error?: undefined;
    }
  | { error: string } {
  if ("wf-dir" in flags && !flags["wf-dir"]) {
    return { error: "--wf-dir needs a value" };
  }
  const flagValue = flags["wf-dir"];
  if (!flagValue) {
    if (deps.wfDirSource === "none") {
      return {
        error:
          "no workflow dir was resolved for this session; pass --wf-dir <dir>",
      };
    }
    return { wfDir: deps.wfDir, source: deps.wfDirSource, warning: null };
  }
  const candidate = resolve(deps.cwd, flagValue);
  if (!isStrictlyUnderProjectSubdir(deps.cwd, SESSIONS_SUBDIR, candidate)) {
    return {
      error: `--wf-dir "${sanitizeForDisplay(flagValue)}" is not a strict descendant of ${SESSIONS_SUBDIR}; refusing rather than falling back`,
    };
  }
  const warning =
    deps.wfDirSource !== "none" && candidate !== deps.wfDir
      ? `--wf-dir points at ${candidate}, not the resolved dir ${deps.wfDir} (source=${deps.wfDirSource})`
      : null;
  return { wfDir: candidate, source: "override", warning };
}
```

（既存のテスト「refuses a --wf-dir outside .tmp/sessions」の期待 `/--wf-dir "\.tmp\/elsewhere" is not a strict descendant of \.tmp\/sessions/` は、文言の前半を変えないので通る。`deriveDefaultWorkflowDir` / `isValidSessionId` がこの関数でしか使われていなければ import から消す）

`import.meta.main` のブロックを置き換える:

```ts
if (import.meta.main) {
  const argv = process.argv.slice(2);
  const resolved = resolveCliDeps(argv, new Date());
  if ("error" in resolved) {
    process.stderr.write(`workflow-cli: ${resolved.error}\n`);
    process.exitCode = 1;
  } else {
    if (resolved.warning)
      process.stderr.write(`workflow-cli: ${resolved.warning}\n`);
    const result = runWorkflowCli(argv, resolved.deps);
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    // Not process.exit(): see docs/decisions/0002 (no-process-exit under hooks/).
    process.exitCode = result.exitCode;
  }
}
```

（既存の「wfDir が存在しない」警告はここから消し、T2 で `dir` に移す。`round` / `stamp` / `triage` は存在しない dir では `document not found` で失敗し、`status` は inactive と表示する）

- [ ] **Step 4: テストを実行して通過を確認**

実行: Step 2 と同じ。続けて `bun run test`、`bun run typecheck`
期待: resolveCliDeps の新規 6 件と既存の workflow-cli テスト全件 PASS（`--wf-dir validation` の文言の前半は変えていない）。typecheck のエラー 0（`wfDirSource` の書き忘れがあればここで型エラーになる）

- [ ] **Step 5: コミット**

```bash
git add home/dot_claude/hooks/cli/workflow.ts home/dot_claude/hooks/tests/unit/workflow-cli.test.ts
git commit -m "fix(workflow-cli): resolve the workflow dir from the hooks' own inputs"
```

### T2: 書き込み系は素のファイル名だけを受け付け、書いた場所と決定元を出す（K5）

**Files:**

- 編集: `H/cli/workflow.ts`（`runWorkflowCli` の分岐、`cmdRound` / `cmdStamp` / `cmdTriage` の名前検査と成功出力、新規 `cmdDir`）
- テスト: `H/tests/unit/workflow-cli.test.ts`（"workflow-cli: --wf-dir override (spec K3)" と "workflow-cli: output provenance (spec K5)" の describe を新設。override は `dir` コマンドで確かめるのでここに置く）
- 参照: `H/cli/workflow.ts:356-360`（`round` の素のファイル名検査）

- [ ] **Step 1: 失敗するテストを書く**

```ts
describe("workflow-cli: --wf-dir override (spec K3)", () => {
  // `dir` reads no document, so a bare <root>/.tmp/sessions/<id> is enough;
  // seedWorkflow's wf is a plain tmp dir with no project root above it.
  function sessionsRoot(): { root: string; wf: string } {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "cli-override-")));
    const wf = join(root, ".tmp", "sessions", "abcdef12");
    mkdirSync(wf, { recursive: true });
    return { root, wf };
  }

  function depsWith(
    root: string,
    wf: string,
    source: "derived" | "env" | "none",
  ) {
    return {
      cwd: root,
      wfDir: source === "none" ? "" : wf,
      wfDirSource: source,
      sessionId: "test-ses",
      now: NOW,
    };
  }

  it("dir --wf-dir reports source=override and warns when it differs from the resolved dir", () => {
    const { root, wf } = sessionsRoot();
    const other = join(wf, "..", "other000");
    mkdirSync(other, { recursive: true });
    const r = runWorkflowCli(
      ["dir", "--wf-dir", other],
      depsWith(root, wf, "derived"),
    );
    assert.equal(r.exitCode, 0, r.stderr);
    assert.equal(r.stdout, `wfDir=${other}\nsource=override\n`);
    assert.match(
      r.stderr,
      /--wf-dir points at .*other000, not the resolved dir/,
    );
  });

  it("does not warn when --wf-dir names the resolved dir itself", () => {
    const { root, wf } = sessionsRoot();
    const r = runWorkflowCli(
      ["dir", "--wf-dir", wf],
      depsWith(root, wf, "env"),
    );
    assert.equal(r.stderr, "");
  });

  it("refuses an empty --wf-dir value and a missing resolved dir", () => {
    const { root, wf } = sessionsRoot();
    const empty = runWorkflowCli(
      ["dir", "--wf-dir"],
      depsWith(root, wf, "derived"),
    );
    assert.equal(empty.exitCode, 1);
    assert.equal(empty.stdout, "");
    assert.match(empty.stderr, /--wf-dir needs a value/);
    const none = runWorkflowCli(["dir"], depsWith(root, wf, "none"));
    assert.equal(none.exitCode, 1);
    assert.match(none.stderr, /pass --wf-dir/);
  });

  it("warns when an overridden or pinned dir does not exist, but not for a fresh derived dir", () => {
    const { root, wf } = sessionsRoot();
    const missing = join(wf, "..", "missing0");
    const override = runWorkflowCli(
      ["dir", "--wf-dir", missing],
      depsWith(root, wf, "derived"),
    );
    assert.equal(override.exitCode, 0);
    assert.match(
      override.stderr,
      /missing0 does not exist \(source=override\)/,
    );
    const derived = runWorkflowCli(["dir"], depsWith(root, missing, "derived"));
    assert.doesNotMatch(derived.stderr, /does not exist/);
  });
});

describe("workflow-cli: output provenance (spec K5)", () => {
  function depsFor(wf: string) {
    return {
      cwd: wf,
      wfDir: wf,
      wfDirSource: "derived" as const,
      sessionId: "test-ses",
      now: NOW,
    };
  }

  it("round, stamp and triage end with wfDir=, source= and wrote= lines", () => {
    const { wf } = seedWorkflow({
      doc: "plan-1.md",
      round: 0,
      ledgerSlugs: ["logic-validator", "scope-justification-reviewer"],
    });
    const lastLines = (stdout: string) =>
      stdout.trimEnd().split("\n").slice(-3);
    const expected = [
      `wfDir=${wf}`,
      "source=derived",
      `wrote=${join(wf, "plan-1.md")}`,
    ];

    const round = runWorkflowCli(["round", "plan-1.md"], depsFor(wf));
    assert.equal(round.exitCode, 0, round.stderr);
    assert.deepEqual(lastLines(round.stdout), expected);

    const stamp = runWorkflowCli(
      [
        "stamp",
        "plan-1.md",
        "--verdict",
        "needs-work",
        "--reviewers",
        "logic-validator+scope-justification-reviewer",
      ],
      depsFor(wf),
    );
    assert.equal(stamp.exitCode, 0, stamp.stderr);
    assert.deepEqual(lastLines(stamp.stdout), expected);

    const triage = runWorkflowCli(
      ["triage", "plan-1.md", "--adopted", "1", "--excluded", "0"],
      depsFor(wf),
    );
    assert.equal(triage.exitCode, 0, triage.stderr);
    assert.deepEqual(lastLines(triage.stdout), expected);
  });

  it("dir prints exactly the wfDir= and source= lines", () => {
    const { wf } = seedWorkflow({
      doc: "plan-1.md",
      round: 1,
      ledgerSlugs: [],
    });
    const r = runWorkflowCli(["dir"], depsFor(wf));
    assert.equal(r.exitCode, 0);
    assert.equal(r.stdout, `wfDir=${wf}\nsource=derived\n`);
  });

  it("stamp and triage refuse a path and leave stdout empty", () => {
    const { wf } = seedWorkflow({
      doc: "plan-1.md",
      round: 1,
      ledgerSlugs: ["logic-validator"],
    });
    for (const argv of [
      [
        "stamp",
        "../plan-1.md",
        "--verdict",
        "pass",
        "--reviewers",
        "logic-validator",
      ],
      ["triage", "sub/plan-1.md", "--adopted", "1", "--excluded", "0"],
    ]) {
      const r = runWorkflowCli(argv, depsFor(wf));
      assert.equal(r.exitCode, 1, argv.join(" "));
      assert.equal(r.stdout, "");
      assert.match(r.stderr, /bare file name/);
    }
  });
});
```

（`seedWorkflow` の引数の形は既存テスト（:1078 付近の status テスト）と同じ。`round: 0` で Reviewer Outputs 節の無い文書、`ledgerSlugs` で reviewer の起動証跡を用意する。stamp が求める reviewer 集合が上の 2 名と違う場合は、既存の stamp テストが使う集合に合わせる）

- [ ] **Step 2: テストを実行して失敗を確認**

実行: T1 と同じ
期待: 新規 7 件とも FAIL（`dir` は `unknown command`、成功出力に `wfDir=` 行が無い、`stamp ../plan-1.md` は `bare file name` を含まない、存在しない override の警告が無い）

- [ ] **Step 3: 最小実装を書く**

素のファイル名の検査を共通にする（`cmdRound` :353-360 のコメントと検査をここへ移し、round からも呼ぶ）:

```ts
/**
 * Write commands take a bare document name only: the reframer record file
 * and the extension log are keyed by it, and a path like `../plan.md` would
 * write outside the workflow dir (spec K5).
 */
function bareDocumentNameError(docName: string): string | null {
  if (basename(docName) !== docName || !isBareMarkdownName(docName)) {
    return `invalid document name "${docName}": the document name must be a bare file name ending in .md (e.g. plan-1.md), not a path`;
  }
  return null;
}

/** The provenance lines every successful write command ends with (spec K5). */
function provenanceLines(wfDir: string, source: string, wrote: string): string {
  return `wfDir=${wfDir}\nsource=${source}\nwrote=${wrote}\n`;
}
```

- `cmdRound`: 既存の検査を `const nameError = bareDocumentNameError(docName); if (nameError) return err(nameError);` にする。成功の `ok(...)` の stdout の末尾に `provenanceLines(wfDir, source, docPath)` を連結する（`source` は `resolveTargetWfDir` の戻り値から受け取る）
- `cmdStamp`: `docName` が空でないことを確かめた直後に同じ検査を入れる。成功の stdout を `` `stamped ${docName}: verdict=${verdict} hash=${hash}\n${provenanceLines(wfDir, source, docPath)}` `` にする
- `cmdTriage`: 同じ検査を入れ、成功の stdout を `` `appended intent-triage marker to ${docName}\n${provenanceLines(wfDir, source, docPath)}` `` にする
- `cmdDir` を足し、`runWorkflowCli` の switch に `case "dir": return cmdDir(rest, deps);` を足す。usage の文言を `workflow-cli <status|dir|round|stamp|triage> [doc] [--flags]` にする:

```ts
/**
 * The workflow dir and where it came from, for the model to write documents
 * into (rules/workflow.md). A derived dir that does not exist yet is the
 * normal first use; a pinned or overridden one that does not exist is
 * probably a typo or an old session's dir, so that is warned about.
 */
function cmdDir(
  args: string[],
  deps: RunWorkflowCliDeps,
): RunWorkflowCliResult {
  const resolvedDir = resolveTargetWfDir(parseArgs(args).flags, deps);
  if (resolvedDir.error !== undefined) return err(resolvedDir.error);
  const warnings = [resolvedDir.warning];
  if (resolvedDir.source !== "derived" && !existsSync(resolvedDir.wfDir)) {
    warnings.push(
      `${resolvedDir.wfDir} does not exist (source=${resolvedDir.source})`,
    );
  }
  return ok(
    `wfDir=${resolvedDir.wfDir}\nsource=${resolvedDir.source}\n`,
    warnings.filter(Boolean).join("\n") || null,
  );
}
```

- [ ] **Step 4: テストを実行して通過を確認**

実行: T1 と同じ。続けて `bun run test`、`bun run typecheck`
期待: 新規 7 件 PASS。既存の成功出力の検査はすべて部分一致（`assert.match` / `includes`）なので変更は要らない（logic-validator が確認済み）。`bun run test` の fail 0

- [ ] **Step 5: コミット**

```bash
git add home/dot_claude/hooks/cli/workflow.ts home/dot_claude/hooks/tests/unit/workflow-cli.test.ts
git commit -m "feat(workflow-cli): print the workflow dir and the written path"
```

### T3: SessionStart が `CLAUDE_SESSION_ID` と `DOCUMENT_WORKFLOW_DIR` を export しない（K4）

**Files:**

- 編集: `H/implementations/session.ts:18-28`（`UNSAFE_FOR_DOUBLE_QUOTED_EXPORT` / `isSafeForDoubleQuotedExport`）、`:139-200`（export）、`:211-245`（関連の表示）
- テスト: `H/tests/unit/session.test.ts:273-354`（"DOCUMENT_WORKFLOW_DIR resolution" の 3 件）

- [ ] **Step 1: 失敗するテストに書き換える**

"DOCUMENT_WORKFLOW_DIR resolution" の describe 名を "workflow dir resolution" にし、3 件を次にする:

```ts
it("derives the workflow dir from the session id and exports neither the dir nor the session id", async () => {
  envHelper.set("DOCUMENT_WORKFLOW_DIR", undefined);
  const ctx = createSessionStartContext("cli");
  ctx.input.session_id = "abcdef1234567890";

  await invokeRun(sessionHook, ctx);

  const content = readFileSync(envFilePath, "utf-8");
  ok(
    !content.includes("DOCUMENT_WORKFLOW_DIR"),
    `unexpected export:\n${content}`,
  );
  ok(!content.includes("CLAUDE_SESSION_ID"), `unexpected export:\n${content}`);
  const systemMessage = ctx.jsonCalls[0]?.systemMessage ?? "";
  ok(systemMessage.includes(".tmp/sessions/abcdef12/"));
  ok(!systemMessage.includes("(user-specified)"));
});

it("shows a startup pin as user-specified without re-exporting it", async () => {
  envHelper.set("DOCUMENT_WORKFLOW_DIR", ".tmp/sessions/4dc42491");
  const ctx = createSessionStartContext("cli");
  ctx.input.session_id = "different-session-id";

  await invokeRun(sessionHook, ctx);

  ok(!readFileSync(envFilePath, "utf-8").includes("DOCUMENT_WORKFLOW_DIR"));
  const systemMessage = ctx.jsonCalls[0]?.systemMessage ?? "";
  ok(systemMessage.includes(".tmp/sessions/4dc42491/ (user-specified)"));
});

it("falls back to the session id when DOCUMENT_WORKFLOW_DIR is empty", async () => {
  envHelper.set("DOCUMENT_WORKFLOW_DIR", "");
  const ctx = createSessionStartContext("cli");
  ctx.input.session_id = "fallback1234abcd";

  await invokeRun(sessionHook, ctx);

  ok(
    (ctx.jsonCalls[0]?.systemMessage ?? "").includes(".tmp/sessions/fallback/"),
  );
});
```

- [ ] **Step 2: テストを実行して失敗を確認**

実行: `node --import ./home/dot_claude/hooks/tests/preload-test-env.mjs --test home/dot_claude/hooks/tests/unit/session.test.ts`
期待: 書き換えた 1・2 件目が FAIL（env ファイルに `export CLAUDE_SESSION_ID=` と `export DOCUMENT_WORKFLOW_DIR=` がある）。3 件目は変更前でも PASS（表示の固定）

- [ ] **Step 3: 最小実装を書く**

session.ts:

- `appendFileSync(envFile, \`export CLAUDE_SESSION_ID="${sessionId}"\n\`);` を消す
- `if (resolution.relative !== null) { ... }` の export ブロックと、その前の「decision 6」のコメント、変数 `workflowDirExportSkippedForUnsafeChars` とその表示（`if (workflowDirExportSkippedForUnsafeChars) {...}`）を消す
- `UNSAFE_FOR_DOUBLE_QUOTED_EXPORT` と `isSafeForDoubleQuotedExport`（:18-28）を消す
- `// Export session info to CLAUDE_ENV_FILE for skills to consume` のコメントの直後に、理由を 1 段落足す:

```ts
// The workflow dir and the session id are deliberately not exported
// (spec K4). An exported value outlives /clear in the Bash env and
// pointed `workflow-cli` and model-written paths at the previous
// session's dir (#197). Bash gets them from `workflow-cli dir` and from
// CLAUDE_CODE_SESSION_ID, which Claude Code itself keeps current.
```

- unresolvable の 2 つの表示から `; DOCUMENT_WORKFLOW_DIR is not exported.` を `; the workflow gate is not enforcing.` に替える（guard の同じ状況の文言に合わせる）
- env-rejected の表示を `` `[session] DOCUMENT_WORKFLOW_DIR="${userPin}" was rejected (not a verified descendant of ${cwd}/.tmp/sessions) and the derived directory ${resolution.relative} is used instead.` `` にする（`$DOCUMENT_WORKFLOW_DIR` を読む利用者はもういない）
- `// Resolve DOCUMENT_WORKFLOW_DIR the same way the guard does` のコメントを `// Resolve the workflow dir the same way the guard does` にする（以降の文はそのまま）

- [ ] **Step 4: テストを実行して通過を確認**

実行: Step 2 と同じ。続けて `bun run test`、`bun run typecheck`、`bun run lint`
期待: session.test.ts 全件 PASS（plan-2 の `CLAUDE_PROJECT_DIR` / `CLAUDE_TRANSCRIPT_PATH` の引用テストも含む）。`bun run test` の fail 0。lint で未使用の識別子 0

- [ ] **Step 5: コミット**

```bash
git add home/dot_claude/hooks/implementations/session.ts home/dot_claude/hooks/tests/unit/session.test.ts
git commit -m "fix(hooks): stop exporting the workflow dir and session id at session start"
```

### T4: 文書の参照を `workflow-cli dir` と `$CLAUDE_CODE_SESSION_ID` に置き換え、検査テストで固定する（K4）

**Files:**

- 新規: `H/tests/unit/workflow-env-references.test.ts`
- 編集: `home/dot_claude/rules/workflow.md:3, :5, :28`、`home/dot_claude/CLAUDE.md:9`、`CLAUDE.md:12`、`.skills/document-workflow-reference/SKILL.md:3, :43, :53, :65, :103-116, :138`、`.skills/task-handoff/SKILL.md:90-107`、`.skills/session-memo/SKILL.md:31-35`、`.skills/test-design/SKILL.md:26`

- [ ] **Step 1: 失敗するテストを書く**

```ts
#!/usr/bin/env node --test

import { strict as assert } from "node:assert";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, it } from "node:test";

const REPO_ROOT = join(import.meta.dirname, "../../../../..");

/**
 * Bash-side references to values the SessionStart hook no longer exports
 * (spec K4). A leftover one silently brings back #197: a model following the
 * text writes to, or passes, the previous session's dir.
 */
const FORBIDDEN =
  /\$\{?(DOCUMENT_WORKFLOW_DIR|CLAUDE_SESSION_ID)\b|env\.CLAUDE_SESSION_ID\b/;

/**
 * Hook-process reads of a startup pin (`DOCUMENT_WORKFLOW_DIR=… claude`), which
 * K4 keeps: the guard's interpreter scratch roots name it in their docstrings.
 */
const ALLOWED: Record<string, number> = {
  "home/dot_claude/hooks/implementations/document-workflow-guard.ts": 2,
};

function listFiles(dir: string, keep: (rel: string) => boolean): string[] {
  return readdirSync(join(REPO_ROOT, dir), {
    recursive: true,
    encoding: "utf-8",
  })
    .map((entry) => join(dir, entry))
    .filter((rel) => !rel.includes("node_modules") && keep(rel));
}

function scannedFiles(): string[] {
  return [
    ...listFiles("home/dot_claude/rules", (rel) => rel.endsWith(".md")),
    "home/dot_claude/CLAUDE.md",
    "CLAUDE.md",
    ...listFiles(".skills", (rel) => rel.endsWith(".md")),
    ...listFiles(
      "home/dot_claude/hooks",
      (rel) =>
        rel.endsWith(".ts") &&
        !rel.endsWith(".test.ts") &&
        !rel.includes("/tests/"),
    ),
  ];
}

describe("no Bash-side reference to the workflow dir or session id env (spec K4)", () => {
  it("scans a non-trivial set of files", () => {
    assert.ok(
      scannedFiles().length > 50,
      `only ${scannedFiles().length} files scanned`,
    );
  });

  it("finds the forbidden forms only where a hook reads a startup pin", () => {
    const hits: string[] = [];
    const counts: Record<string, number> = {};
    for (const rel of scannedFiles()) {
      readFileSync(join(REPO_ROOT, rel), "utf-8")
        .split("\n")
        .forEach((line, i) => {
          if (!FORBIDDEN.test(line)) return;
          counts[rel] = (counts[rel] ?? 0) + 1;
          if ((counts[rel] ?? 0) > (ALLOWED[rel] ?? 0))
            hits.push(`${rel}:${i + 1}: ${line.trim()}`);
        });
    }
    assert.deepEqual(
      hits,
      [],
      `replace with \`workflow-cli dir\` / $CLAUDE_CODE_SESSION_ID:\n${hits.join("\n")}`,
    );
  });
});
```

（`relative` は使わなければ import しない）

- [ ] **Step 2: テストを実行して失敗を確認**

実行: `node --import ./home/dot_claude/hooks/tests/preload-test-env.mjs --test home/dot_claude/hooks/tests/unit/workflow-env-references.test.ts`
期待: 2 件目が FAIL し、`rules/workflow.md:5`、`:28`、`home/dot_claude/CLAUDE.md:9`、reference skill の :43 / :53 / :65 / :110 / :111 / :138、task-handoff の :90 / :93 / :107、session-memo の :31 / :35、test-design の :26 が列挙される（cli/workflow.ts の `process.env.CLAUDE_SESSION_ID` は T1 で、session.ts の env-rejected 表示は T3 で消えているので出ない）

- [ ] **Step 3: 文書を書き換える**

各行の置き換え先（それ以外の文は変えない）:

- `rules/workflow.md`
  - :3 の「DOCUMENT_WORKFLOW_DIR 引き継ぎ」→「workflow dir の引き継ぎ」
  - :5 →「成果物の置き場は workflow dir（`<session 開始時の root>/.tmp/sessions/<session-id 先頭8桁>`）。絶対パスは `workflow-cli dir` の `wfDir=` 行で確かめる。hook はこのパスを hook 入力から自力で導出するため、環境変数が無くても enforce は効く。」
  - :28 の「`$DOCUMENT_WORKFLOW_DIR/research.md`」→「`<wfDir>/research.md`」
- `home/dot_claude/CLAUDE.md:9` の 2 か所 →「`<wfDir>/research.md`」「`<wfDir>/plan.md`」
- `CLAUDE.md:12` →「複数セッション並行可能（session ID ごとに `.tmp/sessions/<id 先頭8桁>` で分離。`workflow-cli dir` で確認）」
- `.skills/document-workflow-reference/SKILL.md`
  - :3（description）の「DOCUMENT_WORKFLOW_DIR 引き継ぎ」→「workflow dir の引き継ぎ」
  - :43 の scratch root の列挙「`$DOCUMENT_WORKFLOW_DIR`」→「起動時に pin した `DOCUMENT_WORKFLOW_DIR`」
  - :53 →「2. `workflow-cli dir` の `wfDir=` 行で wfDir を得て、リテラルパスに展開した削除コマンドをユーザーに提示し、実行を依頼する。プロンプトで `! rm -f ...` と打てば同セッション内で実行できる。」
  - :65 の例「`rm "$DOCUMENT_WORKFLOW_DIR/plan.md"`」→「`rm "$WF/plan.md"` のようにシェル変数を使った形」、続く「リテラル `$DOCUMENT_WORKFLOW_DIR/...`」→「リテラル `$WF/...`」
  - :103 の見出し →「## workflow dir の引き継ぎ」。:110-111 の 2 行を次にする:

```
  workflow-cli dir   # wfDir=<新しい dir> を確かめる
  cp -a .tmp/sessions/<旧 id 先頭8桁>/. <wfDir の値>/
```

- :138 の「または `$DOCUMENT_WORKFLOW_DIR`」→「または `CLAUDE_PROJECT_DIR` と `CLAUDE_CODE_SESSION_ID` からの導出（起動時 pin があればそれ）。`--wf-dir` が session の dir と違えば警告する。成功出力は `wfDir=` / `source=` / `wrote=` で終わる。`workflow-cli dir` は wfDir と決定元だけを出す」。あわせて「session 由来の dir と食い違うと警告する」の文は消す
- `.skills/task-handoff/SKILL.md`
  - :90 の「`$DOCUMENT_WORKFLOW_DIR` に」→「wfDir（`workflow-cli dir` の `wfDir=`）に」
  - :93 →「`workflow-cli dir && ls "<wfDir の値>"`」
  - :98 の「`DOCUMENT_WORKFLOW_DIR` は新しい」→「wfDir は新しい」
  - :107 →「`cp -a .tmp/sessions/<旧 id 先頭8桁>/. <新 session の wfDir>/`」
- `.skills/session-memo/SKILL.md`
  - :31 →「`$CLAUDE_CODE_SESSION_ID` 環境変数にセッションIDが格納されている（Claude Code が Bash ツールに渡す。`/clear` で新しい ID に変わる）。」
  - :35 →「`echo $CLAUDE_CODE_SESSION_ID`」
- `.skills/test-design/SKILL.md:26` の「`$DOCUMENT_WORKFLOW_DIR/plan.md`」→「`<wfDir>/plan.md`」

- [ ] **Step 4: テストを実行して通過を確認**

実行: Step 2 と同じ。続けて `bun run test`、`bun run lint`
期待: 新規 2 件 PASS。`bun run test` の fail 0

- [ ] **Step 5: コミット**

```bash
git add home/dot_claude/hooks/tests/unit/workflow-env-references.test.ts home/dot_claude/rules/workflow.md home/dot_claude/CLAUDE.md CLAUDE.md .skills/document-workflow-reference/SKILL.md .skills/task-handoff/SKILL.md .skills/session-memo/SKILL.md .skills/test-design/SKILL.md
git commit -m "docs(workflow): read the workflow dir from workflow-cli dir"
```

## ISO 25010 具体テストケース

### 機能適合性（正確性）

- **入力**: `CLAUDE_PROJECT_DIR=<root>`、`CLAUDE_CODE_SESSION_ID=abcdef1234567890`、`CLAUDE_SESSION_ID=ffffffff99999999` → **期待**: `resolveCliDeps` の wfDir は `<root>/.tmp/sessions/abcdef12`、source は derived（T1）
- **入力**: `round` / `stamp` / `triage` の成功 → **期待**: stdout の最後の 3 行が `wfDir=<wf>`、`source=derived`、`wrote=<wf>/plan-1.md`（T2）
- **入力**: `workflow-cli dir` → **期待**: stdout がちょうど `wfDir=<wf>\nsource=derived\n`（T2）

### セキュリティ（完全性）

- **入力**: `stamp ../plan-1.md` / `triage sub/plan-1.md` → **期待**: 終了コード 1、stdout 空、stderr に `bare file name`（T2）
- **入力**: `CLAUDE_PROJECT_DIR` が無い、または `CLAUDE_CODE_SESSION_ID` が無い（`--wf-dir` なし） → **期待**: 失敗し、不足している変数名と `--wf-dir` を案内する。`process.cwd()` から推測しない（T1）

### 互換性（共存性）

- **入力**: SessionStart の後の env ファイル → **期待**: `DOCUMENT_WORKFLOW_DIR` と `CLAUDE_SESSION_ID` の export が無い（T3）。`/clear` 後に古い値が Bash に残る経路が無くなる
- **入力**: 文書・hook の `$DOCUMENT_WORKFLOW_DIR` / `$CLAUDE_SESSION_ID` / `env.CLAUDE_SESSION_ID` → **期待**: guard の docstring 2 か所以外に無い（T4 の検査テスト）

## Approval

- Plan Status: complete
- Review Status: pass
- Approval Status: approved

## Reviewer Outputs (Round 1)

### logic-validator

- verdict: needs-work
- 主指摘: deps の literal は 24 でなく 17 か所、:1071 は 1 行の literal で行の挿入では壊れる。値の無い `--wf-dir` が sessions の root を `derived` として返す。T4 の期待の列挙に reference skill :138 が無い（いずれも反映済み）

### scope-justification-reviewer

- verdict: needs-work
- 主指摘: 件数の誤り、`source=override` と警告のテストが無い、仮の wfDir、警告の比較相手が解決値でなく session 由来値（いずれも反映済み）。許可リストの spec からの差は ADR に記録する（plan-5 に持ち越し）

### architecture-boundary-analyzer

- verdict: needs-work
- 主指摘: ファイル冒頭の純粋性の docstring が `resolveCliDeps` と食い違う、`argv.includes` と `parseArgs` の二重判定、仮の値を `derived` と名乗る deps、警告の基準（いずれも反映済み。`wfDirSource` に `none` を足した）。session.ts と CLI の文言の共通化は受け入れるリスクに記載し見送り

### security-vulnerability-analyzer

- verdict: pass
- 主指摘: stamp / triage の素のファイル名の検査は実在の穴を塞ぐ。残る export はすべて単一引用符。軽微: env の値を `sanitizeForDisplay` に通す、env の前置による迂回を受け入れるリスクに書く（いずれも反映済み）

### resilience-analyzer

- verdict: needs-work
- 主指摘: 値の無い `--wf-dir`、`dir` が存在しない pin / override を黙って返す、`CLAUDE_PROJECT_DIR` の未検証、配備前のセッションで古い rules の記述が残る（エラー文に起動し直す旨と `$DOCUMENT_WORKFLOW_DIR` を使わない旨を足した）（いずれも反映済み）

<!-- auto-review: pending -->
<!-- intent-triage: pending -->

## Reviewer Outputs (Round 2)

### logic-validator

- verdict: needs-work
- 主指摘: T1 の件数・型・既存テストとの整合は確認。T2 の override テストの root が誤り（`seedWorkflow` の wf は素の一時 dir で、上に `.tmp/sessions` を持つ root が無い）→ describe 内で `<root>/.tmp/sessions/<id>` を自前で作る形に変更。方針の箇条書きの T1/T2 の振り分けと Files の describe 名を修正（いずれも反映済み）

### scope-justification-reviewer

- verdict: pass
- 主指摘: 追加分はすべて K3/K5 と Round 1 の指摘に結び付く。軽微: env-rejected の警告のテストが無い（追加済み）。許可リストの spec からの差は plan-5 の ADR に記録する

### architecture-boundary-analyzer

- verdict: needs-work
- 主指摘: 境界の設計は妥当。新規: `RESTART_HINT` の文言が `$DOCUMENT_WORKFLOW_DIR` を含み T4 の検査に当たる → `$` の無い言い回しに変更（反映済み）

### resilience-analyzer

- verdict: pass
- 主指摘: Round 1 の 4 点は解消。P2: 壊れた `CLAUDE_PROJECT_DIR` が残ると `--wf-dir` でも失敗する（受け入れるリスクに記載）。`status` に wfDir を出す案は `dir` があるので見送り

### security-vulnerability-analyzer

- verdict: pass (carried from Round 1)
- 主指摘: Round 1 で pass、再実行なし

<!-- auto-review: verdict=needs-work; hash=f9028ab5250e110ccc66a6c99bed70e8a1a2ce05306ea39ea34ad23e001181bc; design-hash=2aa67539d750519f9825bb590864b5c4ee739627b2fe7a6543d35f9f8dc43dbd; round=1; parent-spec-hash=4cee4ab13ef4a878444a81b6987973e04ea76a9c5639331cbd13104a470adb56; at=2026-10-02T06:14:58.343Z; reviewers=logic-validator+scope-justification-reviewer+architecture-boundary-analyzer+security-vulnerability-analyzer+resilience-analyzer -->

## Reviewer Outputs (Round 3)

### logic-validator

- verdict: pass
- 主指摘: 4 点をコードで確認（`../outside` は env-rejected で導出値に落ちる、`sanitizeForDisplay` は値を変えない、未作成の子孫も厳密な子孫として通る、override の fixture は検証を通り値の無い flag は空文字になる）。初回の起動は Bash の読み取りが拒否されて未検証に終わり、利用者の判断で Read ツールを使う形で起動し直した

### architecture-boundary-analyzer

- verdict: pass
- 主指摘: `RESTART_HINT` の修正を確認。走査対象のファイルに入るスニペットに禁止表記は無い。境界の設計に後退なし

### scope-justification-reviewer

- verdict: pass (carried from Round 2)
- 主指摘: Round 2 で pass、再実行なし

### resilience-analyzer

- verdict: pass (carried from Round 2)
- 主指摘: Round 2 で pass、再実行なし

### security-vulnerability-analyzer

- verdict: pass (carried from Round 2)
- 主指摘: Round 2 で pass、再実行なし

<!-- auto-review: verdict=needs-work; hash=2e0178a0f172d177000e6115c8a5df65d5cf0c8e7f5f1d0a5b392be87b5cb995; design-hash=380e6b856af861ab68fc63143f8dad5dde45cdf9e5ad0c166163ad408075cd0c; round=2; parent-spec-hash=4cee4ab13ef4a878444a81b6987973e04ea76a9c5639331cbd13104a470adb56; at=2026-10-02T06:17:21.676Z; reviewers=logic-validator+scope-justification-reviewer+architecture-boundary-analyzer+resilience-analyzer -->

<!-- auto-review: verdict=pass; hash=44819914909d4e9d2fea7a1b85110d876cb89a1151d682ca810a4e688fe66994; design-hash=380e6b856af861ab68fc63143f8dad5dde45cdf9e5ad0c166163ad408075cd0c; round=3; parent-spec-hash=4cee4ab13ef4a878444a81b6987973e04ea76a9c5639331cbd13104a470adb56; at=2026-10-02T06:21:09.321Z; reviewers=logic-validator+architecture-boundary-analyzer -->
<!-- intent-triage: adopted=26; excluded=0; at=2026-10-02T06:21:09.346Z -->
