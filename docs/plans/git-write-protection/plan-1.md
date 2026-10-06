<!-- spec-ref: spec.md -->

# Plan 1: hold 判定の lib と、3 つのフックへの組み込み

spec の K1〜K4 を実装する。settings、`dot_gitconfig.tmpl`、本体の照合を再現するテスト、受け入れ実験は plan-2 で扱う。

不変条件:

- PreToolUse と 2a では、**hold は allow を pass に下げるだけで、deny と ask には触れない**。各フックで、allow を返す直前に hold を確かめる。
- 2b では、hold と原則 2 の skip は「LLM を呼ばない」ことで、LLM がどう判定したかに関わらず、人間の確認に残す（spec K1）。

## 実装の方針（Round 1 のレビューを受けて）

- **Bash の語の取り出しを、パーサーだけに頼らない。**
  - `bash-parser.ts` の `parseSimpleCommandFromNode`（`:521-575`）は、`word`、`string`、`raw_string` 以外の子節点（連結、変数展開、コマンド置換など）を `args` に載せない。`args` は引用符付きの生のテキストのまま。
  - そこで、parse に基づく判定（spec の Architecture どおり）に加えて、**コマンドの全文に対する上位集合の判定**を置く。
    - 原則 3: 全文に dot のパスの断片が現れたら hold。
    - 原則 2（2b）: 全文に `git` という語、または `GIT_` の代入か `export` が現れたら skip。
  - 過大に判定しても、本体の allow 規則が覆うコマンドは通る（spec K4「過大に判定しても安全側に倒れる」）。
  - 全文の判定は parse を要しないので、2b で parse を 2 回しないという spec の条件も満たす。
  - ラッパーの展開は不要になる。既存の `stripWrappers`（`command-parsing.ts:700`、非公開）の 3 本目のコピーも作らない。
- **名前の照合は、大文字と小文字を区別しない。** macOS の APFS は区別しないため。
- **fs の失敗は、すべて hold に倒す。** `lstat` が `ENOENT` / `ENOTDIR` 以外で失敗したとき、`realpath` が失敗したとき、入口で例外が出たとき。
- **Bash の語では、worktree のルート自身も worktree-content とする。** worktree の中の `git add .` などで毎回 hold しないため。Edit 系では、spec K3 どおりルート自身は対象にしない。

spec との差分（承認のときにユーザーが確認する）:

- spec の原則 2 は「ラッパーを外した head が git」と、parse した `SimpleCommand` で判定すると書いている。この plan は全文に `git` という語があるかで判定する（上位集合）。
  - 広がる範囲: git を名指すだけのコマンド（`grep git notes.txt` など）も、2b の LLM を通らず人間の確認になる。
  - 理由: パーサーとラッパーの展開の取りこぼしを避けるため（Round 1 の security、logic の指摘）。安全側への広がりで、失うのは LLM による自動承認だけ。
- `BashAssessment.commands` は spec の記述どおり返すが、2b では使わない。

## Files

```
# 新規作成
home/dot_claude/hooks/lib/write-protection.ts
home/dot_claude/hooks/lib/bash-write-hold.ts
home/dot_claude/hooks/lib/auto-approval-hold.ts

# 編集
home/dot_claude/hooks/implementations/auto-approve.ts
home/dot_claude/hooks/implementations/permission-auto-approve.ts
home/dot_claude/hooks/implementations/permission-llm-evaluator.ts
home/dot_claude/hooks/lib/permission-analyzer.ts
home/dot_claude/hooks/README.md
.skills/update-auto-approve/SKILL.md

# テスト
home/dot_claude/hooks/tests/unit/write-protection.test.ts
home/dot_claude/hooks/tests/unit/bash-write-hold.test.ts
home/dot_claude/hooks/tests/unit/auto-approval-hold.test.ts
home/dot_claude/hooks/tests/unit/auto-approve.test.ts
home/dot_claude/hooks/tests/unit/permission-auto-approve.test.ts
home/dot_claude/hooks/tests/unit/permission-llm-evaluator.test.ts
home/dot_claude/hooks/tests/unit/permission-analyzer.test.ts
home/dot_claude/hooks/tests/unit/hold-invariants.test.ts
```

## Tasks

テストは repo のルートで `node --import ./home/dot_claude/hooks/tests/preload-test-env.mjs --test <file>` で実行する。以下の各タスクでは `<file>` だけを書く。

テストの書き方は既存のものに合わせる。

- 先頭行は `#!/usr/bin/env node --test`。import は `node:assert` と `node:test`、拡張子つきの相対パス。
- フックは `run` を直接呼ぶ（`createPreToolUseContextFor` と `invokeRun`、`tests/support/test-helpers.ts:290, 303`）。
- auto-approve の allow / deny のリストは、`CLAUDE_TEST_MODE=1` で `CLAUDE_TEST_ALLOW` / `CLAUDE_TEST_DENY` から与える（`auto-approve.ts:262-290`）。
- 実ファイルが要るときは、`realpathSync(mkdtempSync(join(tmpdir(), "<prefix>-")))` を `beforeEach` で作り、`afterEach` で `rmSync(dir, { recursive: true, force: true })` する。HOME を差し替えるときも同じ形で作って消す。

### T0: 既存のフックが、git の前置の形を allow するかを確かめる（特性テスト）

spec K7 の「Goal の約束の確認」のための事前の調査。

**Files:**

- テスト: `home/dot_claude/hooks/tests/unit/permission-auto-approve.test.ts`、`home/dot_claude/hooks/tests/unit/auto-approve.test.ts`
- 参照: `home/dot_claude/hooks/implementations/permission-auto-approve.ts:122-124, 484-523`
- 参照: `home/dot_claude/hooks/implementations/auto-approve.ts:566-610`（`SAFE_BASH_PATTERNS_LAYER1` は `git` の直後にサブコマンドを要求する）

- [ ] **Step 1: 現状を記録するテストを書く**

`auto-approve.test.ts` の `:232` にある `isAllow` は `describe` の中のローカル関数なので、ファイルの先頭のスコープへ移す（中身は変えない）。

PreToolUse の段（`auto-approve.test.ts`）で、allow を空、deny を空にして、次の入力が allow にならないことを確かめる。

```ts
describe("auto-approve - git prefix forms (spec K7 Goal check)", () => {
  for (const command of [
    "git -c color.ui=never status",
    "git -C /w/p -c color.ui=never status",
    "GIT_PAGER=cat git log",
    "git --no-replace-objects log",
  ]) {
    it(`does not allow: ${command}`, async () => {
      envHelper.set("CLAUDE_TEST_ALLOW", JSON.stringify([]));
      envHelper.set("CLAUDE_TEST_DENY", JSON.stringify([]));
      const context = createPreToolUseContextFor(
        autoApproveHook,
        "Bash",
        { command },
        { cwd: "/w/p" },
      );
      await invokeRun(autoApproveHook, context);
      strictEqual(isAllow(context), false);
    });
  }
});
```

2a の段（`permission-auto-approve.test.ts`）でも、同じ入力のうち `-c` を含まない 2 つ（`GIT_PAGER=cat git log`、`git --no-replace-objects log`）が `allow` にならないことを確かめる。`-c` を含む 2 つは T6 で扱う。

```ts
describe("staticRuleEngine - git prefix forms (spec K7 Goal check)", () => {
  const bash = (command: string) =>
    staticRuleEngine({
      session_id: "s",
      tool_name: "Bash",
      tool_input: { command },
      cwd: "/home/user/project",
    });
  it("does not allow a GIT_* prefix or a long global option", () => {
    strictEqual(bash("GIT_PAGER=cat git log").behavior === "allow", false);
    strictEqual(
      bash("git --no-replace-objects log").behavior === "allow",
      false,
    );
  });
});
```

- [ ] **Step 2: 実行して結果を記録する**

- PASS した場合: 前提が成り立っている。回帰の検出として残す。
- FAIL した場合: その段が前置の形を外して allow している。PreToolUse なら T5、2a なら T6 の Step 3 で、`git` の直後に `-C <dir>` 以外の大域オプションが来る形と、`GIT_` の代入が前に付く形では allow しないよう直す。そのタスクの Step 1 に、このテストを失敗するテストとして移す。

- [ ] **Step 3: コミット**

```bash
git add home/dot_claude/hooks/tests/unit/permission-auto-approve.test.ts home/dot_claude/hooks/tests/unit/auto-approve.test.ts
git commit -m "test(claude): pin how hooks treat git prefix forms"
```

### T1: `findHoldSegment`（規則 2a と 2b、大文字と小文字を区別しない）

**Files:**

- 新規: `home/dot_claude/hooks/lib/write-protection.ts`
- テスト: `home/dot_claude/hooks/tests/unit/write-protection.test.ts`
- 参照: spec.md K2

- [ ] **Step 1: 失敗するテストを書く**

chezmoi のソースの判定を `.` を含まないパスで確かめるため、テストの `chezmoiSource` は `/src/chezmoi/home` にする（`.local` を含むと、2a の dot 規則が先に当たって (iii) を検証できない）。

```ts
#!/usr/bin/env node --test
import { strictEqual } from "node:assert";
import { describe, it } from "node:test";
import {
  CORE_PROTECTED_SOURCE,
  findHoldSegment,
} from "../../lib/write-protection.ts";

const names = { home: "/home/u", chezmoiSource: "/src/chezmoi/home" };
const holds = (p: string, rule: "outside" | "worktree") =>
  findHoldSegment(p, rule, names) !== null;

describe("findHoldSegment - outside worktrees (2a)", () => {
  it("holds any dot segment", () => {
    strictEqual(holds("/w/p/.github/ci.yml", "outside"), true);
    strictEqual(holds("/w/p/.tmp/a.md", "outside"), true);
  });
  it("leaves plain paths, '.' and '..' segments alone", () => {
    strictEqual(holds("/w/p/src/a.ts", "outside"), false);
    strictEqual(holds("./src/a.ts", "outside"), false);
  });
  it("holds bunfig.toml whatever the case", () => {
    strictEqual(holds("/w/p/bunfig.toml", "outside"), true);
    strictEqual(holds("/w/p/BunFig.TOML", "outside"), true);
  });
  it("holds chezmoi sources of the global git config, and only those", () => {
    strictEqual(holds("/src/chezmoi/home/dot_gitconfig.tmpl", "outside"), true);
    strictEqual(
      holds("/src/chezmoi/home/private_dot_config/git/ignore", "outside"),
      true,
    );
    strictEqual(holds("/src/chezmoi/home/dot_zshrc", "outside"), false);
  });
  it("does not hold a non-dot bare-repo-like name (K8 covers it)", () => {
    strictEqual(holds("/tmp/x/g.git/config", "outside"), false);
  });
});

describe("findHoldSegment - worktree interior (2b)", () => {
  it("holds core protected names whatever the case", () => {
    for (const rel of [
      ".git",
      "vendor/sub/.git",
      ".claude/settings.json",
      ".Claude/settings.json",
      ".GIT",
      ".vscode/tasks.json",
      ".config/git/config",
      ".npmrc",
      "bunfig.toml",
      ".husky/pre-commit",
    ]) {
      strictEqual(holds(rel, "worktree"), true, rel);
    }
  });
  it("leaves other dot names alone", () => {
    for (const rel of [
      ".github/workflows/ci.yml",
      ".gitignore",
      ".tmp/sessions/x/plan.md",
      "src/a.ts",
    ]) {
      strictEqual(holds(rel, "worktree"), false, rel);
    }
  });
  it("names its source and version", () => {
    strictEqual(
      /permission-modes.*2026-10-06.*2\.1\.291/.test(CORE_PROTECTED_SOURCE),
      true,
    );
  });
});
```

- [ ] **Step 2: テストを実行して失敗を確認**

`<file>` = `home/dot_claude/hooks/tests/unit/write-protection.test.ts`。期待: FAIL（`write-protection.ts` が無い）。

- [ ] **Step 3: 最小実装を書く**

```ts
// Copied from https://code.claude.com/docs/en/permission-modes.md "Protected paths",
// fetched 2026-10-06 for Claude Code 2.1.291. `ask` permission rules need this version or later.
// Inside a verified worktree core sees every path as under .git, so the hook judges with this copy.
export const CORE_PROTECTED_SOURCE =
  "permission-modes.md#protected-paths 2026-10-06 2.1.291";

// Lower case: APFS compares names without case.
const CORE_PROTECTED_DIRS = [
  ".git",
  ".vscode",
  ".idea",
  ".husky",
  ".cargo",
  ".devcontainer",
  ".yarn",
  ".mvn",
  ".claude",
];
const CORE_PROTECTED_DIR_PAIRS: ReadonlyArray<readonly [string, string]> = [
  [".config", "git"],
];
const CORE_PROTECTED_FILES = [
  ".gitconfig",
  ".gitmodules",
  ".bashrc",
  ".bash_profile",
  ".bash_login",
  ".bash_aliases",
  ".bash_logout",
  ".zshrc",
  ".zprofile",
  ".zshenv",
  ".zlogin",
  ".zlogout",
  ".profile",
  ".envrc",
  ".npmrc",
  ".yarnrc",
  ".yarnrc.yml",
  ".pnp.cjs",
  ".pnp.loader.mjs",
  ".pnpmfile.cjs",
  "bunfig.toml",
  ".bunfig.toml",
  ".bazelrc",
  ".bazelversion",
  ".bazeliskrc",
];
// The dot rule outside worktrees covers every other core name.
export const CORE_PROTECTED_NON_DOT = CORE_PROTECTED_FILES.filter(
  (name) => !name.startsWith("."),
);

export type HoldRule = "outside" | "worktree";
export interface HoldNameContext {
  home: string;
  chezmoiSource: string;
}

function segmentsOf(path: string): string[] {
  return path
    .toLowerCase()
    .split("/")
    .filter((s) => s !== "" && s !== ".");
}

function chezmoiGitSourceReason(
  path: string,
  chezmoiSource: string,
): string | null {
  const prefix = `${chezmoiSource.toLowerCase()}/`;
  const lower = path.toLowerCase();
  if (!lower.startsWith(prefix)) return null;
  const [first, second] = segmentsOf(lower.slice(prefix.length));
  if (first?.includes("dot_gitconfig"))
    return "chezmoi source of the global git config";
  if (first?.endsWith("dot_config") && second?.endsWith("git"))
    return "chezmoi source of ~/.config/git";
  return null;
}

export function findHoldSegment(
  path: string,
  rule: HoldRule,
  ctx: HoldNameContext,
): string | null {
  const segs = segmentsOf(path);
  if (rule === "outside") {
    const dot = segs.find((s) => s.startsWith(".") && s !== "..");
    if (dot) return `dot segment ${dot}`;
    const nonDot = segs.find((s) => CORE_PROTECTED_NON_DOT.includes(s));
    if (nonDot) return `protected name ${nonDot}`;
    return chezmoiGitSourceReason(path, ctx.chezmoiSource);
  }
  for (const [i, s] of segs.entries()) {
    if (CORE_PROTECTED_DIRS.includes(s) || CORE_PROTECTED_FILES.includes(s))
      return `protected name ${s}`;
    const pair = CORE_PROTECTED_DIR_PAIRS.find(
      ([a, b]) => s === a && segs[i + 1] === b,
    );
    if (pair) return `protected name ${pair[0]}/${pair[1]}`;
  }
  return null;
}
```

- [ ] **Step 4: テストを実行して通過を確認**

期待: PASS。

- [ ] **Step 5: コミット**

```bash
git add home/dot_claude/hooks/lib/write-protection.ts home/dot_claude/hooks/tests/unit/write-protection.test.ts
git commit -m "feat(claude): name the paths hooks must not auto-approve"
```

### T2: `classifyWriteTarget`（K3 の worktree の確認、physical のパス、fs の失敗）

**Files:**

- 編集: `home/dot_claude/hooks/lib/write-protection.ts`
- テスト: `home/dot_claude/hooks/tests/unit/write-protection.test.ts`
- 参照: `home/dot_claude/hooks/lib/path-containment.ts:4-8, 44, 56-111, 122-125`（`PathFs`、`errnoOf`、`resolvePhysicalPath`、`isUnderRoot` は `p === root` で true）
- 参照: `home/dot_local/bin/executable_git-worktree-create`（L218-233）

- [ ] **Step 1: 失敗するテストを書く**

```ts
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach } from "node:test";
import {
  classifyWriteTarget,
  type HoldFs,
  nodeHoldFs,
} from "../../lib/write-protection.ts";

describe("classifyWriteTarget", () => {
  let scratch = "";
  let repo = "";
  let wt = "";
  const git = (...args: string[]) =>
    execFileSync(
      "git",
      ["-c", "user.name=t", "-c", "user.email=t@t", ...args],
      { stdio: "ignore" },
    );
  const kind = (
    p: string,
    opts?: { worktreeRootIsContent?: boolean },
    fs: HoldFs = nodeHoldFs,
  ) => classifyWriteTarget(p, { ...names, fs }, opts).kind;
  beforeEach(() => {
    scratch = realpathSync(mkdtempSync(join(tmpdir(), "wp-")));
    repo = join(scratch, "repo");
    git("init", "-q", repo);
    git("-C", repo, "commit", "-q", "--allow-empty", "-m", "init");
    wt = join(repo, ".git", "worktree", "feat", "x");
    git("-C", repo, "worktree", "add", "-q", wt, "-b", "feat/x");
  });
  afterEach(() => rmSync(scratch, { recursive: true, force: true }));

  it("treats ordinary files in a verified worktree as worktree-content", () => {
    for (const rel of ["src/a.ts", ".github/ci.yml", ".gitignore"]) {
      strictEqual(kind(join(wt, rel)), "worktree-content", rel);
    }
  });
  it("holds protected names inside the worktree, whatever the case", () => {
    for (const rel of [
      ".git",
      ".claude/settings.json",
      ".CLAUDE/settings.json",
      "vendor/sub/.git",
    ]) {
      strictEqual(kind(join(wt, rel)), "hold", rel);
    }
  });
  it("holds the worktree root for Edit, and treats it as content for Bash words", () => {
    strictEqual(kind(wt), "hold");
    strictEqual(kind(wt, { worktreeRootIsContent: true }), "worktree-content");
  });
  it("holds a forged worktree whose gitfile does not point back", () => {
    const fake = join(repo, ".git", "worktree", "fake");
    mkdirSync(fake, { recursive: true });
    writeFileSync(
      join(fake, ".git"),
      `gitdir: ${join(repo, ".git", "worktrees", "x")}\n`,
    );
    strictEqual(kind(join(fake, "src/a.ts")), "hold");
  });
  it("stops at a .git that is not a regular file", () => {
    const odd = join(repo, ".git", "worktree", "odd");
    mkdirSync(join(odd, ".git"), { recursive: true });
    strictEqual(kind(join(odd, "src/a.ts")), "hold");
  });
  it("holds a path that leaves the worktree through a symlink", () => {
    symlinkSync(join(repo, ".git"), join(wt, "escape"));
    strictEqual(kind(join(wt, "escape/config")), "hold");
  });
  it("holds the main .git and is ordinary for a plain path", () => {
    strictEqual(kind(join(repo, ".git/config")), "hold");
    strictEqual(kind(join(repo, "src/a.ts")), "ordinary");
  });
  it("holds a path with '..'", () => {
    strictEqual(kind(`${repo}/src/../src/a.ts`), "hold");
  });
  it("holds when lstat fails with anything but ENOENT", () => {
    const failing: HoldFs = {
      ...nodeHoldFs,
      lstat: (p: string) => {
        if (p.endsWith("/.git"))
          throw Object.assign(new Error("denied"), { code: "EACCES" });
        return nodeHoldFs.lstat(p);
      },
    };
    strictEqual(kind(join(wt, "src/a.ts"), undefined, failing), "hold");
  });
});
```

- [ ] **Step 2: テストを実行して失敗を確認**

期待: FAIL（`classifyWriteTarget` が無い）。

- [ ] **Step 3: 最小実装を書く**

```ts
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
  errnoOf,
  isUnderRoot,
  type PathFs,
  resolvePhysicalPath,
} from "./path-containment.ts";

export type HoldFs = PathFs & { readFile(p: string): string };
export const nodeHoldFs: HoldFs = {
  realpath: realpathSync,
  lstat: lstatSync,
  readFile: (p) => readFileSync(p, "utf8"),
};
export interface HoldContext extends HoldNameContext {
  fs: HoldFs;
}
export type WriteTarget =
  | { kind: "hold"; reason: string }
  | { kind: "worktree-content"; worktreeRoot: string }
  | { kind: "ordinary" };
export interface ClassifyOptions {
  // Bash words name directories too (`git add .` in a worktree); Edit targets never are the root.
  worktreeRootIsContent?: boolean;
  // The project root (CLAUDE_PROJECT_DIR, where the session started). For a Bash word under it, the
  // dot rule counts only the segments below it, so a root that sits under a dot directory (the
  // chezmoi source under ~/.local) does not hold every word. Core-protected names still apply to
  // the whole path. A path that leaves the root through a symlink is judged whole.
  trustedBase?: string;
}

const WORKTREE_DIR = "/.git/worktree/";

type Probe = "absent" | "file" | "other" | "error";
function probe(fs: HoldFs, p: string): Probe {
  try {
    return (fs.lstat(p) as { isFile(): boolean }).isFile() ? "file" : "other";
  } catch (error) {
    const code = errnoOf(error);
    return code === "ENOENT" || code === "ENOTDIR" ? "absent" : "error";
  }
}

// The worktree root W when every K3 condition holds, else null (callers then hold).
function findVerifiedWorktree(path: string, fs: HoldFs): string | null {
  const at = path.toLowerCase().indexOf(WORKTREE_DIR);
  if (at < 0) return null;
  const base = path.slice(0, at + WORKTREE_DIR.length);
  const repoGit = path.slice(0, at + "/.git".length);
  const rest = path.slice(base.length).split("/");
  // Shallowest first; the first .git found decides.
  for (let i = 1; i <= rest.length; i++) {
    const w = join(base, ...rest.slice(0, i));
    const found = probe(fs, join(w, ".git"));
    if (found === "absent") continue;
    if (found !== "file") return null;
    try {
      const pointer = /^gitdir: (.+)\n?$/.exec(
        fs.readFile(join(w, ".git")),
      )?.[1];
      if (!pointer) return null;
      const target = fs.realpath(resolve(w, pointer));
      if (dirname(target) !== join(fs.realpath(repoGit), "worktrees"))
        return null;
      const back = fs.readFile(join(target, "gitdir")).trim();
      if (fs.realpath(back) !== fs.realpath(join(w, ".git"))) return null;
      return w;
    } catch {
      return null;
    }
  }
  return null;
}

export function classifyWriteTarget(
  absPath: string,
  ctx: HoldContext,
  opts: ClassifyOptions = {},
): WriteTarget {
  if (!isAbsolute(absPath))
    return { kind: "hold", reason: "relative path reached the classifier" };
  const physical = resolvePhysicalPath(absPath, ctx.fs);
  if (!physical.ok)
    return { kind: "hold", reason: `unresolved path (${physical.code})` };
  try {
    const w = findVerifiedWorktree(absPath, ctx.fs);
    if (w !== null) {
      const realW = ctx.fs.realpath(w);
      if (physical.path === realW && opts.worktreeRootIsContent)
        return { kind: "worktree-content", worktreeRoot: w };
      if (physical.path === realW || !isUnderRoot(physical.path, realW)) {
        return {
          kind: "hold",
          reason:
            findHoldSegment(physical.path, "outside", ctx) ??
            "path leaves the worktree",
        };
      }
      const reason =
        findHoldSegment(relative(w, absPath), "worktree", ctx) ??
        findHoldSegment(relative(realW, physical.path), "worktree", ctx);
      return reason
        ? { kind: "hold", reason }
        : { kind: "worktree-content", worktreeRoot: w };
    }
  } catch (error) {
    return {
      kind: "hold",
      reason: `worktree check failed (${errnoOf(error)})`,
    };
  }
  const base = trustedBaseFor(absPath, physical.path, ctx, opts.trustedBase);
  const reason = base
    ? // Core-protected names on the whole path (a two-segment name such as .config/git may
      // straddle the root); only the dot rule is limited to the part below the root.
      (findHoldSegment(absPath, "worktree", ctx) ??
      findHoldSegment(physical.path, "worktree", ctx) ??
      findHoldSegment(relative(base.lexical, absPath), "outside", ctx) ??
      findHoldSegment(relative(base.physical, physical.path), "outside", ctx) ??
      chezmoiGitSourceReason(absPath, ctx.chezmoiSource))
    : (findHoldSegment(absPath, "outside", ctx) ??
      findHoldSegment(physical.path, "outside", ctx));
  return reason ? { kind: "hold", reason } : { kind: "ordinary" };
}

// The base to judge below, only when the path stays under it both lexically and physically,
// and only when the base itself is not inside something core protects (a cwd of ~/.claude or
// of a .git directory must not make its contents look ordinary).
function trustedBaseFor(
  absPath: string,
  physicalPath: string,
  ctx: HoldContext,
  trustedBase: string | undefined,
): { lexical: string; physical: string } | null {
  if (!trustedBase || !isUnderRoot(absPath, trustedBase)) return null;
  try {
    const physicalBase = ctx.fs.realpath(trustedBase);
    if (
      untrustedBaseReason(trustedBase, ctx) ??
      untrustedBaseReason(physicalBase, ctx)
    )
      return null;
    return isUnderRoot(physicalPath, physicalBase)
      ? { lexical: trustedBase, physical: physicalBase }
      : null;
  } catch {
    return null;
  }
}

// Why a base cannot be trusted, or null. Shared by classifyWriteTarget and the whole-text mask
// in bash-write-hold.ts so both use one rule.
export function untrustedBaseReason(
  base: string,
  ctx: HoldContext,
): string | null {
  return (
    findHoldSegment(base, "worktree", ctx) ??
    chezmoiGitSourceReason(base, ctx.chezmoiSource)
  );
}
```

- `resolvePhysicalPath` は `..` を `EPARENT` で返すので、`..` を含むパスは hold になる。
- `errnoOf` の戻り値の形（`"ENOENT"` などの文字列）は、`path-containment.ts:44` を読んで確かめる。
- worktree が見つからない（`findVerifiedWorktree` が null）場合は、パス全体に 2a を当てるので、`.git` のセグメントで hold になる。

- [ ] **Step 4: テストを実行して通過を確認**

期待: PASS。

- [ ] **Step 5: コミット**

```bash
git add home/dot_claude/hooks/lib/write-protection.ts home/dot_claude/hooks/tests/unit/write-protection.test.ts
git commit -m "feat(claude): verify linked worktrees before hooks approve edits in them"
```

### T3: `assessBashCommand`（K4 原則 3: 語の判定と、全文の上位集合の判定）

**Files:**

- 新規: `home/dot_claude/hooks/lib/bash-write-hold.ts`
- テスト: `home/dot_claude/hooks/tests/unit/bash-write-hold.test.ts`
- 参照: `home/dot_claude/hooks/lib/bash-parser.ts:31-45, 162-178, 521-575, 602, 1117-1119, 1188, 1203`
- 参照: `home/dot_claude/hooks/lib/heredoc-data.ts:515-570`
- 参照: `home/dot_claude/hooks/tests/support/parse-budget.ts`

判定は 4 段。どれかに当たれば hold。

1. **parse の失敗**（spec Architecture）: `parsingMethod === "fallback"`、構文エラー（`parseForCollect` の木の `rootNode.hasError`）、打ち切り（`parserGiveUpReasonSince(mark)`）。`mark` は parse の前に 1 回だけ取る。`parseForCollect` の `null` は打ち切りか失敗で、理由によらず hold。
2. **確定できない形**: 全文に `$`、`` ` ``、`{` のいずれかが現れる（変数展開、コマンド置換、ブレース展開で、パスを組み立てうる）。または、単純コマンドの名前に `cd` / `pushd` / `popd` がある（cwd が変わり、語の判定の基準がずれる）。
3. **全文の上位集合**: 次の 2 つのテキストのどちらかに、下の断片が現れる（大文字と小文字を区別しない）。
   - テキスト: (a) 全文から、K3 で確かめられた worktree の中身の絶対パスの断片を取り除いたもの。(b) (a) から引用符（`'` と `"`）、バックスラッシュ、改行の継続を取り除いたもの。
   - 断片:
     - dot のパスの断片: 区切り（行頭、空白、引用符、`=`、`:`、`/`、括弧、リダイレクトと制御の演算子）の直後の `.` で、その後に `.`、`/`、区切り、行末のどれも来ないもの。
     - `bunfig.toml`。
     - `dot_gitconfig`、または `dot_config/` の後に `git` で終わるセグメント。
   - worktree の中身の絶対パスの断片とは、`/.git/worktree/` を含む絶対パスの語で、`classifyWriteTarget(..., { worktreeRootIsContent: true })` が `worktree-content` を返すもの。これを取り除くので、`git -C <worktree の絶対パス> status` は 3 段目に当たらない（ユーザーの方針で `-C` は通す）。
4. **語の判定**: 各単純コマンドの `args`（引用符を外したもの）のうち `-` で始まらない語、`-` で始まり `=` を含む語の値、`redirections` の先の語について、次のように判定する。
   - 先頭以外に `..` のセグメントを含む語は hold（`resolve` が `..` を字句的に畳み、symlink の先とずれるため。`path-containment.ts:21` の `checkParentSegments` と同じ考え）。先頭の `..` は許す。
   - それ以外は `ctx.cwd` で絶対化して `classifyWriteTarget(..., { worktreeRootIsContent: true })` に渡す。worktree の中の書き込み先（`.claude/` など）を見分けるのはこの段。

残余（hold で捕まえられない形。README に書く）:

- インタプリタ（`python -c`、`node -e` など）が実行時に文字列からパスを組み立てる形。静的な判定では原理的に見えない。防げるのは、本体の allow 規則が覆わない範囲に限られる。
- `$` を含むコマンドは一律 hold になるので、確認が増える。本体の allow 規則が覆うコマンド（`Bash(git commit *)` など）は、引き続き確認なしで通る。plan-2 の受け入れ実験で、確認の増え方を確かめる。

parse の回数: `parseBashCommand` と `parseForCollect` の 2 回。`bash-parser.ts:162-171` の `timedOutInputs` により、打ち切り済みの入力の 2 回目はすぐ打ち切りを返す。成功した parse は予算を 2 回消費する。2 回目を省くには `bash-parser.ts` に木を共有する口を足す必要があり、範囲を広げるので、この plan では採らない。

- [ ] **Step 1: 失敗するテストを書く**

```ts
#!/usr/bin/env node --test
import { strictEqual } from "node:assert";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
  assessBashCommand,
  maskProjectRoot,
} from "../../lib/bash-write-hold.ts";
import { nodeHoldFs } from "../../lib/write-protection.ts";
import { withParseBudget } from "../support/parse-budget.ts";

describe("assessBashCommand", () => {
  let cwd = "";
  beforeEach(() => {
    cwd = realpathSync(mkdtempSync(join(tmpdir(), "bwh-")));
  });
  afterEach(() => rmSync(cwd, { recursive: true, force: true }));
  const ctx = () => ({
    cwd,
    projectRoot: cwd,
    home: "/home/u",
    chezmoiSource: "/src/chezmoi/home",
    fs: nodeHoldFs,
  });
  const held = async (cmd: string) =>
    (await assessBashCommand(cmd, ctx())).reason !== null;

  it("does not hold commands without hold paths", async () => {
    for (const cmd of [
      "git status",
      "git add .",
      "git -C sub log --oneline",
      "bun run test",
      "ls src ../x ./y",
      "echo hi > /dev/null",
      "cat a.ts",
    ]) {
      strictEqual(await held(cmd), false, cmd);
    }
  });
  it("holds dot paths in every spelling", async () => {
    for (const cmd of [
      "tee .claude/settings.json",
      "tee '.claude/settings.json'",
      'tee ".claude/settings.json"',
      'tee .cl"aude"/x',
      "echo x > .git/info/exclude",
      "cp a.txt .VSCODE/a.txt",
      "ls --dir=.tmp",
      "dd of=.claude/x",
    ]) {
      strictEqual(await held(cmd), true, cmd);
    }
  });
  it("holds words it cannot resolve and cwd changes", async () => {
    for (const cmd of [
      "cat $HOME/notes.txt",
      "cp a $(pwd)/b",
      "echo a{b,c}",
      "cd sub && cat a.txt",
      "pushd sub",
    ]) {
      strictEqual(await held(cmd), true, cmd);
    }
  });
  it("holds names split by quotes or backslashes", async () => {
    for (const cmd of [
      "cat bunfig.to'ml'",
      "cat \\.claude/x",
      "cat dot_git'config'.tmpl",
    ]) {
      strictEqual(await held(cmd), true, cmd);
    }
  });
  it("holds a word with '..' after the first segment", async () => {
    strictEqual(await held("cat sub/link/../x"), true);
    strictEqual(await held("cat ../x"), false);
  });
  it("holds on a syntax error", async () => {
    strictEqual(await held("echo 'unterminated"), true);
  });
  it("holds when the parser gives up", async () => {
    await withParseBudget(0, async () => {
      strictEqual(await held("ls budget-probe-dir"), true);
    });
  });
});

describe("assessBashCommand - a project root under a dot directory", () => {
  let scratch = "";
  let root = "";
  beforeEach(() => {
    scratch = realpathSync(mkdtempSync(join(tmpdir(), "bwh-root-")));
    // Like ~/.local/share/chezmoi: the project root itself sits under a dot directory.
    root = join(scratch, ".local", "share", "repo");
    mkdirSync(join(root, "src"), { recursive: true });
  });
  afterEach(() => rmSync(scratch, { recursive: true, force: true }));
  const heldWith = async (cmd: string, cwd: string, projectRoot: string) =>
    (
      await assessBashCommand(cmd, {
        cwd,
        projectRoot,
        home: "/home/u",
        chezmoiSource: "/src/chezmoi/home",
        fs: nodeHoldFs,
      })
    ).reason !== null;
  const heldAt = (cmd: string) => heldWith(cmd, root, root);

  it("does not count dot segments above the project root, relative or absolute", async () => {
    for (const cmd of [
      "git status",
      "ls src",
      "git add .",
      `git -C ${root} status`,
      `cat ${root}/src/a.ts`,
    ]) {
      strictEqual(await heldAt(cmd), false, cmd);
    }
  });
  it("still holds dot paths below the project root", async () => {
    strictEqual(await heldAt("cat .claude/x"), true);
    strictEqual(await heldAt(`cat ${root}/.claude/x`), true);
  });
  it("leaves '..' to the word stage after masking the root", async () => {
    // The whole-text stage does not look at '..'; hasInnerParentSegment holds it.
    strictEqual(await heldAt(`cat ${root}/../x`), true);
  });
  it("judges a word whole when a symlink leads out of the project root", async () => {
    symlinkSync(join(scratch, ".local"), join(root, "up"));
    strictEqual(await heldAt("cat up/share"), true);
  });
  it("applies two-segment protected names across the project root boundary", async () => {
    const config = join(scratch, ".config");
    mkdirSync(join(config, "git"), { recursive: true });
    strictEqual(await heldWith("tee git/config", config, config), true);
  });
  it("does not trust a project root that core protects", async () => {
    for (const protectedDir of [".claude", ".git", join(".config", "git")]) {
      const dir = join(scratch, protectedDir, "sub");
      mkdirSync(dir, { recursive: true });
      strictEqual(
        await heldWith("tee settings.json", dir, dir),
        true,
        protectedDir,
      );
    }
  });
  it("masks the root only as a whole path prefix", () => {
    const c = {
      cwd: root,
      projectRoot: root,
      home: "/home/u",
      chezmoiSource: "/src/chezmoi/home",
      fs: nodeHoldFs,
    };
    strictEqual(maskProjectRoot(`cat ${root}/a`, c), "cat PROJ/a");
    strictEqual(maskProjectRoot(`cat ${root}2/a`, c), `cat ${root}2/a`);
    strictEqual(maskProjectRoot(`cat ${root}-evil/a`, c), `cat ${root}-evil/a`);
    strictEqual(maskProjectRoot(`cat /o${root}/b`, c), `cat /o${root}/b`);
  });
  it("uses the project root, not the cwd, as the base", async () => {
    // cwd below a dot directory that is not the project root: no relaxation.
    const other = join(scratch, ".ssh-like", "sub");
    mkdirSync(other, { recursive: true });
    strictEqual(await heldWith("tee notes.txt", other, root), true);
  });
});

describe("assessBashCommand - verified worktrees", () => {
  let scratch = "";
  let wt = "";
  const git = (...args: string[]) =>
    execFileSync(
      "git",
      ["-c", "user.name=t", "-c", "user.email=t@t", ...args],
      { stdio: "ignore" },
    );
  beforeEach(() => {
    scratch = realpathSync(mkdtempSync(join(tmpdir(), "bwh-wt-")));
    const repo = join(scratch, "repo");
    git("init", "-q", repo);
    git("-C", repo, "commit", "-q", "--allow-empty", "-m", "init");
    wt = join(repo, ".git", "worktree", "feat", "x");
    git("-C", repo, "worktree", "add", "-q", wt, "-b", "feat/x");
  });
  afterEach(() => rmSync(scratch, { recursive: true, force: true }));
  const heldIn = async (cmd: string, cwd: string) =>
    (
      await assessBashCommand(cmd, {
        cwd,
        projectRoot: scratch,
        home: "/home/u",
        chezmoiSource: "/src/chezmoi/home",
        fs: nodeHoldFs,
      })
    ).reason !== null;

  it("does not hold work inside the worktree, absolute or relative", async () => {
    strictEqual(await heldIn(`git -C ${wt} status`, scratch), false);
    strictEqual(await heldIn(`cat ${wt}/src/a.ts`, scratch), false);
    strictEqual(await heldIn("git add .", wt), false);
    strictEqual(await heldIn("cat .github/ci.yml", wt), true); // dot fragment in text: core's allow rules decide
  });
  it("holds protected names inside the worktree", async () => {
    strictEqual(await heldIn(`tee ${wt}/.claude/x.json`, scratch), true);
  });
});
```

- `execFileSync`、`mkdirSync`、`symlinkSync` を import に足す。
- 基準はプロジェクトのルート（`ctx.projectRoot`）で、cwd ではない。全文の判定（3 段目）でもルートの接頭辞を `PROJ` に置き換えてから断片を探すので、`git -C ${root} status` と `cat ${root}/src/a.ts` は hold しない。
- `tee git/config`（ルートが `<scratch>/.config`）は、protected の名前（`.config/git`）をパス全体に当てるので hold になる。dot の規則だけをルートより下に限る。
- `cat up/share` は、`up` がルートの外（`.local`）を指す symlink なので、physical のパスがルートの下に無く、パス全体で判定されて hold になる。
- `tee notes.txt`（cwd が `.ssh-like/sub`、ルートは別）は、cwd がルートの下に無いので緩和されず、cwd の `.ssh-like` で hold になる。
- 残余: セッションを protected の一覧に無い機微な dot ディレクトリ（`~/.ssh` など）で始めた場合は、その中の語に dot の規則が効かない。README に書く。
- `.cl"aude"/x` は、(a) では `.cl` で始まる断片として当たり、(b) では `.claude/x` として当たる。
- `cat .github/ci.yml`（cwd が worktree）は、相対の dot の断片が 3 段目に当たって hold になる。本体の `Bash(cat *)` などの allow 規則が覆うので、確認は出ない（spec K4「過大に判定しても安全側」）。worktree の中を確認なしで編集するのは Edit 系のツールで、そちらは K3 の 2b の規則で判定する。
- 打ち切りのテストの入力は、ほかのテストと重ならない文字列にする（`timedOutInputs` に残るため）。

- [ ] **Step 2: テストを実行して失敗を確認**

`<file>` = `home/dot_claude/hooks/tests/unit/bash-write-hold.test.ts`。期待: FAIL（モジュールが無い）。

- [ ] **Step 3: 最小実装を書く**

```ts
import { isAbsolute, resolve } from "node:path";
import {
  parseBashCommand,
  parseForCollect,
  parserGiveUpMark,
  parserGiveUpReasonSince,
  type SimpleCommand,
} from "./bash-parser.ts";
import {
  CORE_PROTECTED_NON_DOT,
  classifyWriteTarget,
  type HoldContext,
  untrustedBaseReason,
} from "./write-protection.ts";

export interface BashHoldContext extends HoldContext {
  cwd: string;
  // CLAUDE_PROJECT_DIR (getProjectRoot): the base below which the dot rule counts for Bash words.
  projectRoot: string;
}
export interface BashAssessment {
  reason: string | null;
  commands: SimpleCommand[];
}

const SEP = String.raw`[\s"'=:/(){}<>|;&,]`;
// A "." that starts a path segment and is followed by a name character.
const DOT_FRAGMENT = new RegExp(
  String.raw`(?:^|${SEP})\.(?![./]|${SEP}|$)`,
  "i",
);
const CHEZMOI_GIT_SOURCE = /dot_gitconfig|dot_config\/[^\s/]*git(?:[\s/"']|$)/i;
// Forms whose words cannot be pinned down statically.
const UNRESOLVED = /[$`{]/;
const CWD_CHANGERS = new Set(["cd", "pushd", "popd"]);
const REDIRECT_OP = /^\d*(?:>>|>\||>&|&>>|&>|>|<)\s*/;
// Absolute path words that reach into a .git/worktree/ directory.
const WORKTREE_PATH = /\/[^\s"';|&<>()]*\/\.git\/worktree\/[^\s"';|&<>()]*/gi;

// Removes absolute path fragments that K3 verifies as worktree content.
function maskWorktreeContent(command: string, ctx: HoldContext): string {
  return command.replace(WORKTREE_PATH, (fragment) =>
    classifyWriteTarget(fragment, ctx, { worktreeRootIsContent: true }).kind ===
    "worktree-content"
      ? "WT"
      : fragment,
  );
}

function fragmentReason(text: string): string | null {
  if (DOT_FRAGMENT.test(text)) return "dot path in command text";
  const lower = text.toLowerCase();
  if (CORE_PROTECTED_NON_DOT.some((name) => lower.includes(name)))
    return "protected name in command text";
  if (CHEZMOI_GIT_SOURCE.test(text))
    return "chezmoi git source in command text";
  return null;
}

// Replaces the project root where it stands as a whole path prefix (after a separator or at the
// start, followed by "/", a separator or the end), so that dot segments above the root (such as
// ~/.local) do not count. A sibling such as `<root>2` or a root inside another path is left alone.
// Skipped when there is no trusted root (buildHoldContext empties unusable roots) or the root
// itself is untrusted.
export function maskProjectRoot(command: string, ctx: BashHoldContext): string {
  if (!ctx.projectRoot || untrustedBaseReason(ctx.projectRoot, ctx))
    return command;
  // Same check on the physical root as trustedBaseFor; an unresolvable root is not masked.
  try {
    if (untrustedBaseReason(ctx.fs.realpath(ctx.projectRoot), ctx))
      return command;
  } catch {
    return command;
  }
  const root = ctx.projectRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(String.raw`(^|${SEP})${root}(?=/|${SEP}|$)`, "g");
  return command.replace(pattern, "$1PROJ");
}

function textReason(command: string, ctx: BashHoldContext): string | null {
  if (UNRESOLVED.test(command)) return "unresolved word";
  const masked = maskProjectRoot(maskWorktreeContent(command, ctx), ctx);
  const joined = masked.replace(/\\\n/g, "").replace(/['"\\]/g, "");
  return fragmentReason(masked) ?? fragmentReason(joined);
}

function hasInnerParentSegment(word: string): boolean {
  return word.split("/").some((seg, i) => i > 0 && seg === "..");
}

function unquote(word: string): string {
  return word.replace(/^(['"])(.*)\1$/s, "$2");
}

function pathWordsOf(cmd: SimpleCommand): string[] {
  const words: string[] = [];
  for (const raw of cmd.args) {
    const arg = unquote(raw);
    if (!arg.startsWith("-")) words.push(arg);
    else if (arg.includes("="))
      words.push(unquote(arg.slice(arg.indexOf("=") + 1)));
  }
  for (const r of cmd.redirections) {
    if (r.startsWith("<<")) continue; // heredocs carry no write target
    const target = unquote(r.replace(REDIRECT_OP, ""));
    if (target !== "" && target !== "/dev/null") words.push(target);
  }
  return words;
}

async function syntaxErrorOrGiveUp(command: string): Promise<boolean> {
  let tree: Awaited<ReturnType<typeof parseForCollect>> = null;
  try {
    tree = await parseForCollect(command);
    return tree === null || tree.rootNode.hasError;
  } finally {
    tree?.delete();
  }
}

export async function assessBashCommand(
  command: string,
  ctx: BashHoldContext,
): Promise<BashAssessment> {
  const mark = parserGiveUpMark();
  const parsed = await parseBashCommand(command, true);
  const broken =
    parsed.parsingMethod === "fallback" || (await syntaxErrorOrGiveUp(command));
  const gaveUp = parserGiveUpReasonSince(mark);
  const commands = parsed.commands;
  if (broken || gaveUp !== null)
    return { reason: `unparsed command (${gaveUp ?? "syntax"})`, commands };
  if (commands.some((c) => CWD_CHANGERS.has(c.name ?? "")))
    return { reason: "cwd changes before the words", commands };
  const text = textReason(command, ctx);
  if (text) return { reason: text, commands };
  for (const cmd of commands) {
    for (const word of pathWordsOf(cmd)) {
      if (hasInnerParentSegment(word))
        return { reason: `${word}: '..' after the first segment`, commands };
      const abs = isAbsolute(word) ? word : resolve(ctx.cwd, word);
      const target = classifyWriteTarget(abs, ctx, {
        worktreeRootIsContent: true,
        trustedBase: ctx.projectRoot,
      });
      if (target.kind === "hold")
        return { reason: `${word}: ${target.reason}`, commands };
    }
  }
  return { reason: null, commands };
}
```

- `parseBashCommand` の第 2 引数（`silent`）は、`bash-parser.ts:602-605` の定義に合わせる。
- `redirections` の文字列の形は、`bash-parser.ts:534-541` で節点のテキストをそのまま入れている。演算子の書き方を実際の出力で確かめ、`REDIRECT_OP` を合わせる。

- [ ] **Step 4: テストを実行して通過を確認**

期待: PASS。

- [ ] **Step 5: コミット**

```bash
git add home/dot_claude/hooks/lib/bash-write-hold.ts home/dot_claude/hooks/tests/unit/bash-write-hold.test.ts
git commit -m "feat(claude): hold auto-approval of Bash commands that touch protected paths"
```

### T4: `assessAutoApprovalHold` と `buildHoldContext`（単一の入口）

**Files:**

- 新規: `home/dot_claude/hooks/lib/auto-approval-hold.ts`
- テスト: `home/dot_claude/hooks/tests/unit/auto-approval-hold.test.ts`
- 参照: `home/dot_claude/hooks/lib/command-parsing.ts:334-365`（`getFilePathFromToolInput`）
- 参照: `home/dot_claude/hooks/lib/path-utils.ts:20`（`getHomeDir`）

- [ ] **Step 1: 失敗するテストを書く**

```ts
#!/usr/bin/env node --test
import { strictEqual } from "node:assert";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
  assessAutoApprovalHold,
  buildHoldContext,
} from "../../lib/auto-approval-hold.ts";

describe("assessAutoApprovalHold", () => {
  let home = "";
  beforeEach(() => {
    // A mkdtemp home, not the real HOME.
    home = realpathSync(mkdtempSync(join(tmpdir(), "aah-home-")));
    mkdirSync(join(home, ".local/share/chezmoi"), { recursive: true });
    writeFileSync(join(home, ".local/share/chezmoi/.chezmoiroot"), "home\n");
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));
  const ctx = (cwd: string) => buildHoldContext({ cwd, home });

  it("reads and trims .chezmoiroot", () => {
    strictEqual(
      ctx("/w/p").chezmoiSource,
      join(home, ".local/share/chezmoi/home"),
    );
  });
  it("follows .chezmoiroot when it names another directory", () => {
    writeFileSync(join(home, ".local/share/chezmoi/.chezmoiroot"), "other\n");
    strictEqual(
      ctx("/w/p").chezmoiSource,
      join(home, ".local/share/chezmoi/other"),
    );
  });
  it("falls back to the ask-rule path when .chezmoiroot is missing", () => {
    rmSync(join(home, ".local/share/chezmoi/.chezmoiroot"));
    strictEqual(
      ctx("/w/p").chezmoiSource,
      join(home, ".local/share/chezmoi/home"),
    );
  });
  it("drops a project root that cannot serve as a base", () => {
    for (const projectRoot of ["/", "relative/dir", home, `${home}/`]) {
      strictEqual(
        buildHoldContext({ cwd: "/w/p", home, projectRoot }).projectRoot,
        "",
        projectRoot,
      );
    }
    strictEqual(
      buildHoldContext({ cwd: "/w/p", home, projectRoot: "/w/p/" }).projectRoot,
      "/w/p",
    );
  });
  it("resolves a relative Edit path against cwd", async () => {
    strictEqual(
      (
        await assessAutoApprovalHold(
          "Edit",
          { file_path: ".claude/x.json" },
          ctx("/w/p"),
        )
      ).hold,
      true,
    );
  });
  it("covers Write, MultiEdit and NotebookEdit", async () => {
    for (const [tool, input] of [
      ["Write", { file_path: "/w/p/.vscode/a.json" }],
      ["MultiEdit", { file_path: "/w/p/.vscode/a.json" }],
      ["NotebookEdit", { notebook_path: "/w/p/.vscode/a.ipynb" }],
    ] as const) {
      strictEqual(
        (await assessAutoApprovalHold(tool, input, ctx("/w/p"))).hold,
        true,
        tool,
      );
    }
  });
  it("does not hold a plain path or a read tool", async () => {
    strictEqual(
      (
        await assessAutoApprovalHold(
          "Edit",
          { file_path: "/w/p/src/a.ts" },
          ctx("/w/p"),
        )
      ).hold,
      false,
    );
    strictEqual(
      (
        await assessAutoApprovalHold(
          "Read",
          { file_path: "/w/p/.claude/x" },
          ctx("/w/p"),
        )
      ).hold,
      false,
    );
  });
  it("holds a write tool without a path", async () => {
    strictEqual(
      (await assessAutoApprovalHold("Write", {}, ctx("/w/p"))).hold,
      true,
    );
  });
  it("routes Bash to the command check", async () => {
    strictEqual(
      (
        await assessAutoApprovalHold(
          "Bash",
          { command: "tee .claude/x" },
          ctx("/w/p"),
        )
      ).hold,
      true,
    );
    strictEqual(
      (await assessAutoApprovalHold("Bash", { command: "ls src" }, ctx("/w/p")))
        .hold,
      false,
    );
  });
});
```

- [ ] **Step 2: テストを実行して失敗を確認**

期待: FAIL（モジュールが無い）。

- [ ] **Step 3: 最小実装を書く**

```ts
import { readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import {
  type BashAssessment,
  type BashHoldContext,
  assessBashCommand,
} from "./bash-write-hold.ts";
import { getFilePathFromToolInput } from "./command-parsing.ts";
import { createMatchContext, getProjectRoot } from "./project-root.ts";
import { classifyWriteTarget, nodeHoldFs } from "./write-protection.ts";

const WRITE_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

export type HoldDecision =
  | { hold: true; reason: string; bash?: BashAssessment }
  | { hold: false; bash?: BashAssessment };

function readChezmoiSource(home: string): string {
  const root = join(home, ".local/share/chezmoi");
  try {
    const sub = readFileSync(join(root, ".chezmoiroot"), "utf8").trim();
    return sub ? join(root, sub) : root;
  } catch {
    // Same path as the ask rules in .settings.permissions.json.
    return join(root, "home");
  }
}

// Reason prefixes shared by the hooks that log a hold and by permission-analyzer, which skips them.
export const HELD_PREFIX = "held: ";
export const SKIPPED_LLM_PREFIX = "skipped-llm: ";

// Every hook builds its context from createMatchContext (project-root.ts:31), the same source
// auto-approve already uses for cwd and home, so the three hooks judge one input alike.
export function holdContextFromInput(
  inputCwd: string | undefined,
): BashHoldContext {
  return buildHoldContext({
    ...createMatchContext(inputCwd),
    projectRoot: getProjectRoot(inputCwd),
  });
}

// A root that cannot serve as a base becomes "" (no relaxation): not absolute, "/", or HOME
// itself (every dot directory under HOME would then count as "below the root").
function usableProjectRoot(root: string, home: string): string {
  if (!isAbsolute(root)) return "";
  const normalized = resolve(root);
  return normalized === "/" || normalized === resolve(home) ? "" : normalized;
}

export function buildHoldContext(env: {
  cwd: string;
  home: string;
  projectRoot?: string;
}): BashHoldContext {
  return {
    cwd: env.cwd,
    home: env.home,
    projectRoot: usableProjectRoot(env.projectRoot ?? env.cwd, env.home),
    chezmoiSource: readChezmoiSource(env.home),
    fs: nodeHoldFs,
  };
}

async function assess(
  toolName: string,
  toolInput: unknown,
  ctx: BashHoldContext,
): Promise<HoldDecision> {
  if (toolName === "Bash") {
    const command = (toolInput as { command?: unknown } | null)?.command;
    if (typeof command !== "string")
      return { hold: true, reason: "Bash input without a command" };
    const bash = await assessBashCommand(command, ctx);
    return bash.reason === null
      ? { hold: false, bash }
      : { hold: true, reason: bash.reason, bash };
  }
  if (!WRITE_TOOLS.has(toolName)) return { hold: false };
  const raw = getFilePathFromToolInput(toolName, toolInput);
  if (!raw) return { hold: true, reason: `${toolName} input without a path` };
  const target = classifyWriteTarget(
    isAbsolute(raw) ? raw : resolve(ctx.cwd, raw),
    ctx,
  );
  return target.kind === "hold"
    ? { hold: true, reason: target.reason }
    : { hold: false };
}

export async function assessAutoApprovalHold(
  toolName: string,
  toolInput: unknown,
  ctx: BashHoldContext,
): Promise<HoldDecision> {
  try {
    return await assess(toolName, toolInput, ctx);
  } catch (error) {
    // Never let a failure here turn into an approval.
    return {
      hold: true,
      reason: `hold check failed (${error instanceof Error ? error.name : typeof error})`,
    };
  }
}
```

- `createMatchContext` と `getProjectRoot` を `./project-root.ts` から import する。`getProjectRoot` は `CLAUDE_TEST_CWD` → `CLAUDE_PROJECT_DIR` → 入力の cwd → `process.cwd()` の順（`project-root.ts:16-23`）。`CLAUDE_PROJECT_DIR` は Bash の `cd` や worktree への移動では変わらない。戻り値の `{ cwd, home }` の形と、`CLAUDE_TEST_CWD` → 入力の cwd（絶対パスだけ）→ `process.cwd()` の順は、`project-root.ts:31-39` で確かめる。
- spec の `buildHoldContext({ cwd, env })` は、env から `home` を取る意味。`holdContextFromInput` がその役を担い、`buildHoldContext` はテストで home を差し替えるための口として残す。
- `WRITE_TOOLS` 以外の書き込み系のツールが将来増えた場合は、hold しない（fail-open）。現時点で Edit の規則が当たるツールはこの 4 つ（permissions.md）。R9 の確認（T9）で扱う。

- [ ] **Step 4: テストを実行して通過を確認**

期待: PASS。

- [ ] **Step 5: コミット**

```bash
git add home/dot_claude/hooks/lib/auto-approval-hold.ts home/dot_claude/hooks/tests/unit/auto-approval-hold.test.ts
git commit -m "feat(claude): add one entry point for holding hook auto-approval"
```

### T5: PreToolUse の `auto-approve` に組み込む

**Files:**

- 編集: `home/dot_claude/hooks/implementations/auto-approve.ts:83, 90-125, 142-171, 186-224`
- テスト: `home/dot_claude/hooks/tests/unit/auto-approve.test.ts`

- [ ] **Step 1: 失敗するテストを書く**

```ts
describe("auto-approve - hold (spec K1)", () => {
  let home = "";
  beforeEach(() => {
    home = realpathSync(mkdtempSync(join(tmpdir(), "aa-hold-home-"))); // a mkdtemp home, not the real HOME
    envHelper.set("HOME", home);
    envHelper.set("CLAUDE_TEST_DENY", JSON.stringify([]));
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));
  const run = async (
    tool: string,
    input: Record<string, unknown>,
    allow: string[],
    deny: string[] = [],
  ) => {
    envHelper.set("CLAUDE_TEST_ALLOW", JSON.stringify(allow));
    envHelper.set("CLAUDE_TEST_DENY", JSON.stringify(deny));
    const context = createPreToolUseContextFor(autoApproveHook, tool, input, {
      cwd: "/w/p",
    });
    await invokeRun(autoApproveHook, context);
    return context;
  };

  it("passes instead of allowing an Edit to a dot path covered by an allow rule", async () => {
    const context = await run(
      "Edit",
      { file_path: "/w/p/.claude/settings.json" },
      ["Edit(//w/p/**)"],
    );
    strictEqual(isAllow(context), false);
    strictEqual(context.jsonCalls.length, 0);
  });
  it("still allows an Edit to a plain path", async () => {
    strictEqual(
      isAllow(
        await run("Edit", { file_path: "/w/p/src/a.ts" }, ["Edit(//w/p/**)"]),
      ),
      true,
    );
  });
  it("keeps a deny when the path also holds", async () => {
    const context = await run(
      "Edit",
      { file_path: "/w/p/.git/config" },
      ["Edit(//w/p/**)"],
      ["Edit(//**/.git/config)"],
    );
    strictEqual(
      context.jsonCalls.at(-1)?.hookSpecificOutput?.permissionDecision,
      "deny",
    );
  });
  it("passes instead of allowing Bash that writes to a dot path, including sed -i", async () => {
    strictEqual(
      isAllow(
        await run("Bash", { command: "tee .claude/x.json" }, ["Bash(tee *)"]),
      ),
      false,
    );
    strictEqual(
      isAllow(
        await run("Bash", { command: "sed -i s/a/b/ .claude/x.json" }, [
          "Edit(//w/p/**)",
        ]),
      ),
      false,
    );
  });
  it("logs one decision per call", async () => {
    const sessionId = `hold-log-${process.pid}-${Date.now()}`;
    envHelper.set("CLAUDE_TEST_ALLOW", JSON.stringify(["Edit(//w/p/**)"]));
    const context = createPreToolUseContextFor(
      autoApproveHook,
      "Edit",
      { file_path: "/w/p/.claude/settings.json" },
      { cwd: "/w/p", session_id: sessionId },
    );
    await invokeRun(autoApproveHook, context);
    // preload-test-env.mjs points CLAUDE_LOGS_DIR at a mkdtemp directory (centralized-logging.ts:37, :58).
    const lines = readFileSync(
      join(process.env["CLAUDE_LOGS_DIR"] ?? "", "decisions.jsonl"),
      "utf8",
    )
      .split("\n")
      .filter((line) => line.includes(sessionId))
      .map((line) => JSON.parse(line) as { decision: string; reason: string });
    strictEqual(lines.length, 1);
    strictEqual(lines[0]?.decision, "pass");
    strictEqual(lines[0]?.reason.startsWith("held: "), true);
  });
});
```

- `readFileSync` を import に足す。
- `createPreToolUseContextFor` の第 4 引数が `session_id` を受けることは、`tests/support/test-helpers.ts:303` で確かめた（既定は `"test-session"`）。

- [ ] **Step 2: テストを実行して失敗を確認**

`<file>` = `home/dot_claude/hooks/tests/unit/auto-approve.test.ts`。期待: 1 本目、4 本目、5 本目が FAIL。

- [ ] **Step 3: 最小実装を書く**

- `:83` の直後で、hold の ctx を作る。

```ts
const holdContext = buildHoldContext({
  cwd: matchContext.cwd,
  home: matchContext.home,
});
```

- 3 つの分岐（Bash の `:90-125`、`smartPassTools` の `:142-171`、Edit 系の `:186-224`）で、判定が `allow` のときだけ、**ログを書く前に** hold を確かめる。現状は `logDecision` を判定の直後に呼んでいるので、`allow` の場合だけ hold の確認の後ろに移す。

```ts
if (decision.decision === "allow") {
  const held = await assessAutoApprovalHold(tool_name, tool_input, holdContext);
  if (held.hold) {
    logDecision(
      tool_name,
      "pass",
      `held: ${held.reason}`,
      context.input.session_id,
      tool_input,
    );
    return context.success({});
  }
}
logDecision(
  tool_name,
  decision.decision,
  decision.reason,
  context.input.session_id,
  tool_input,
);
```

- deny と ask の分岐には手を入れない。`inferSedInPlaceAllow` は Bash の allow 段の中にあるので、Bash の分岐の判定で覆われる。

- [ ] **Step 4: テストを実行して通過を確認**

期待: PASS。

- [ ] **Step 5: コミット**

```bash
git add home/dot_claude/hooks/implementations/auto-approve.ts home/dot_claude/hooks/tests/unit/auto-approve.test.ts
git commit -m "fix(claude): stop auto-approve from overriding core protected paths"
```

### T6: PermissionRequest 2a（`permission-auto-approve`）に組み込み、正規表現から `-c` を外す

**Files:**

- 編集: `home/dot_claude/hooks/implementations/permission-auto-approve.ts:122-124, 526-571, 596-640`
- テスト: `home/dot_claude/hooks/tests/unit/permission-auto-approve.test.ts:99-110` と新しい `describe`

- [ ] **Step 1: 失敗するテストを書く**

1. 既存の allow の期待の配列（`:99-110`）から `-c` を含む 4 行（`:107-110`。`-C` と `-c` を併用する `:110` を含む）を外し、次の `describe` に移す。

```ts
describe("staticRuleEngine - git global options (spec K4 principle 1)", () => {
  const bash = (command: string) =>
    staticRuleEngine({
      session_id: "s",
      tool_name: "Bash",
      tool_input: { command },
      cwd: "/home/user/project",
    });
  it("does not allow -c, alone or together with -C", () => {
    for (const command of [
      "git -c commit.gpgsign=false commit -m 'test'",
      "git -c commit.gpgsign=false pull --rebase",
      "git -c commit.gpgsign=false rebase --continue",
      "git -C /home/user/project -c core.autocrlf=false add .",
    ]) {
      strictEqual(bash(command).behavior === "allow", false, command);
    }
  });
  it("still allows -C alone", () => {
    strictEqual(bash("git -C /home/user/project status").behavior, "allow");
    strictEqual(bash("git -C /home/user/project add .").behavior, "allow");
  });
  it("does not allow a config write behind -C", () => {
    strictEqual(
      bash("git -C /home/user/project config --global user.name x").behavior ===
        "allow",
      false,
    );
  });
});
```

2. hold を確かめる。`run` の中の判定を `export async function decideStatic(input)` に切り出してテストする（`staticRuleEngine` は同期のまま残す）。

```ts
describe("decideStatic - hold (spec K1)", () => {
  const input = (file_path: string) => ({
    session_id: "s",
    tool_name: "Edit",
    tool_input: { file_path },
    cwd: "/home/user/project",
  });
  it("does not allow an Edit to a dot path under cwd", async () => {
    const result = await decideStatic(
      input("/home/user/project/.claude/x.json"),
    );
    strictEqual(result.behavior, "uncertain");
    strictEqual(result.heldReason?.length !== 0, true);
  });
  it("still allows an Edit to a plain path under cwd", async () => {
    strictEqual(
      (await decideStatic(input("/home/user/project/src/a.ts"))).behavior,
      "allow",
    );
  });
  it("keeps the deny for a dangerous path", async () => {
    strictEqual(
      (await decideStatic(input("/home/user/project/.env"))).behavior,
      "deny",
    );
  });
});
```

- [ ] **Step 2: テストを実行して失敗を確認**

`<file>` = `home/dot_claude/hooks/tests/unit/permission-auto-approve.test.ts`。期待: `-c` の 4 行と `decideStatic` のテストが FAIL。

- [ ] **Step 3: 最小実装を書く**

- `:122` と `:124` の `(-[cC]\s+\S+\s+)*` を `(-C\s+\S+\s+)*` に変える。
- `StaticDecision` の `uncertain` に、任意の `heldReason?: string` を足す（`source` の値は増やさない。既存の呼び出し側を壊さないため）。

```ts
export async function decideStatic(
  input: PermissionRequestInput,
): Promise<StaticDecision> {
  const result = staticRuleEngine(input);
  if (result.behavior !== "allow") return result;
  const held = await assessAutoApprovalHold(
    input.tool_name,
    input.tool_input,
    holdContextFromInput(input.cwd),
  );
  return held.hold
    ? { behavior: "uncertain", source: result.source, heldReason: held.reason }
    : result;
}
```

- `holdContextFromInput` と `HELD_PREFIX` を `lib/auto-approval-hold.ts` から import する。
- `run`（`:596-`）は `decideStatic` を呼ぶ。`heldReason` があるときは、spec の写像表どおり `logDecision(tool_name, "pass", \`${HELD_PREFIX}${heldReason} (Layer 2a)\`, session_id, tool_input)` を記録し、`context.success({})`を返す。既存の`uncertain`（`"ask"` で記録する）の分岐より前に置く。
- `StaticDecision` を網羅的に扱う箇所を確かめる: `git grep -n "StaticDecision\|staticRuleEngine" home/dot_claude/hooks`。`run` と tests 以外に使う箇所があれば、`heldReason` の扱いを足す。

- [ ] **Step 4: テストを実行して通過を確認**

期待: PASS。`:1208-1240` の既存のテスト（`uncertain` を期待）も PASS のまま。

- [ ] **Step 5: コミット**

```bash
git add home/dot_claude/hooks/implementations/permission-auto-approve.ts home/dot_claude/hooks/tests/unit/permission-auto-approve.test.ts
git commit -m "fix(claude): stop the static permission layer from approving git -c and protected paths"
```

### T7: PermissionRequest 2b（`permission-llm-evaluator`）に組み込む（hold と原則 2）

**Files:**

- 編集: `home/dot_claude/hooks/implementations/permission-llm-evaluator.ts:282-300`
- テスト: `home/dot_claude/hooks/tests/unit/permission-llm-evaluator.test.ts`

原則 2 は、全文に対する判定にする（「実装の方針」を参照）。

- `git-env`: 全文に、`GIT_` で始まる名前への代入（`GIT_X=`）か、`export` / `declare -x` / `typeset -x` の後の `GIT_` が現れる。
- `git-head`: 全文に `git` という語（前後が英数字、`_`、`-`、`.` 以外）が現れる。
- 両方に当たる場合は `git-env` を記録する（spec）。
- 過大に判定すると、git に触れるだけのコマンド（`grep git notes.txt` など）も LLM を通らず人間の確認になる。LLM による自動承認だけを失う。

- [ ] **Step 1: 失敗するテストを書く**

判定を `export async function reasonToSkipLLM(input): Promise<string | null>` に切り出してテストする（LLM は呼ばない）。

```ts
import { reasonToSkipLLM } from "../../implementations/permission-llm-evaluator.ts";

describe("reasonToSkipLLM (spec K1, K4 principle 2)", () => {
  const input = (tool_name: string, tool_input: unknown) => ({
    session_id: "s",
    tool_name,
    tool_input,
    cwd: "/home/user/project",
  });
  const bash = (command: string) => reasonToSkipLLM(input("Bash", { command }));
  it("skips any command that names git", async () => {
    for (const command of [
      "git push origin main",
      "cd sub && git status",
      "command git log",
      "timeout 10 git fetch",
      "nice -n 5 git gc",
      "/usr/bin/git log",
    ]) {
      strictEqual(await bash(command), "skipped-llm: git-head", command);
    }
  });
  it("skips commands that set GIT_* variables, preferring git-env", async () => {
    for (const command of [
      "GIT_PAGER=cat git log",
      "export GIT_PAGER=cat",
      "env -i GIT_PAGER=cat make",
      "declare -x GIT_PAGER=cat",
    ]) {
      strictEqual(await bash(command), "skipped-llm: git-env", command);
    }
  });
  it("holds Edit to a dot path", async () => {
    const reason = await reasonToSkipLLM(
      input("Edit", { file_path: "/home/user/project/.claude/x.json" }),
    );
    strictEqual(reason?.startsWith("held: "), true);
  });
  it("lets other commands reach the LLM", async () => {
    strictEqual(await bash("pnpm install"), null);
    strictEqual(await bash("ls src"), null);
    strictEqual(
      await reasonToSkipLLM(
        input("Edit", { file_path: "/home/user/project/src/a.ts" }),
      ),
      null,
    );
  });
  it("holds a dot fragment without treating it as git-head", async () => {
    strictEqual(
      (await bash("cat .gitignore-notes"))?.startsWith("held: "),
      true,
    );
  });
});
```

- [ ] **Step 2: テストを実行して失敗を確認**

`<file>` = `home/dot_claude/hooks/tests/unit/permission-llm-evaluator.test.ts`。期待: FAIL（`reasonToSkipLLM` が無い）。

- [ ] **Step 3: 最小実装を書く**

```ts
const GIT_ENV =
  /(?:^|[\s;&|(])(?:GIT_[A-Za-z0-9_]*=|(?:export|declare\s+-x|typeset\s+-x)\s+(?:-\S+\s+)*GIT_)/;
const GIT_WORD = /(?:^|[^A-Za-z0-9_.-])git(?![A-Za-z0-9_.-])/;

export async function reasonToSkipLLM(
  input: PermissionRequestInput,
): Promise<string | null> {
  const held = await assessAutoApprovalHold(
    input.tool_name,
    input.tool_input,
    holdContextFromInput(input.cwd),
  );
  if (held.hold) return `${HELD_PREFIX}${held.reason}`;
  if (input.tool_name !== "Bash") return null;
  const command = String(
    (input.tool_input as { command?: unknown }).command ?? "",
  );
  if (GIT_ENV.test(command)) return `${SKIPPED_LLM_PREFIX}git-env`;
  if (GIT_WORD.test(command)) return `${SKIPPED_LLM_PREFIX}git-head`;
  return null;
}
```

- `run`（`:282-`）の `USER_DECISION_TOOLS` の判定の直後で `reasonToSkipLLM` を呼ぶ。理由があれば `logDecision(tool_name, "pass", \`${reason} (Layer 2b)\`, session_id, tool_input)` を記録し、`context.success({})` を返す。`evaluateWithLLM` は呼ばない。
- `holdContextFromInput`、`HELD_PREFIX`、`SKIPPED_LLM_PREFIX` を `lib/auto-approval-hold.ts` から import する。
- `env -i GIT_PAGER=cat make` の `GIT_PAGER=` は、空白の後の `GIT_` の代入として `GIT_ENV` に当たる。
- 残余: 引用符で分割した `git`（`g''it`）は `GIT_WORD` に当たらず、LLM の評価に届く。その形でも、PreToolUse と 2a の自動承認は、正規表現が `git` で始まる形しか許さないので出ない。LLM による自動承認だけが残りうる。README に書く。

- [ ] **Step 4: テストを実行して通過を確認**

期待: PASS。

- [ ] **Step 5: コミット**

```bash
git add home/dot_claude/hooks/implementations/permission-llm-evaluator.ts home/dot_claude/hooks/tests/unit/permission-llm-evaluator.test.ts
git commit -m "fix(claude): keep the LLM layer from approving git commands and protected paths"
```

### T8: 3 つのフックの不変条件を表駆動で確かめる（spec K7）と、集計の除外

**Files:**

- 新規テスト: `home/dot_claude/hooks/tests/unit/hold-invariants.test.ts`
- 編集: `home/dot_claude/hooks/lib/permission-analyzer.ts:113-`（`loadLogEntries`）
- テスト: `home/dot_claude/hooks/tests/unit/permission-analyzer.test.ts`

- [ ] **Step 1: 失敗するテストを書く**

hold になる入力の一覧を、3 つの段（PreToolUse の `run`、2a の `decideStatic`、2b の `reasonToSkipLLM`）に流す。HOME は mkdtemp にし、`.local/share/chezmoi/.chezmoiroot`（中身 `home`）を作る。

入力の一覧（`H` は mkdtemp の HOME、`P` は cwd の `/w/p`）:

| 入力                                                             | 種別         |
| ---------------------------------------------------------------- | ------------ |
| `Edit H/.gitconfig`                                              | ask の代表 1 |
| `Edit H/.config/git/config`                                      | ask の代表 2 |
| `Edit H/.local/share/chezmoi/home/dot_gitconfig.tmpl`            | ask の代表 3 |
| `Edit H/.local/share/chezmoi/home/private_dot_config/git/ignore` | ask の代表 4 |
| `Edit P/.git/probe.txt`                                          | `.git` の中  |
| `Edit P/vendor/sub/.git`                                         | gitfile      |
| `Bash tee .claude/x.json`                                        | `tee`        |
| `Bash echo x > .vscode/a.json`                                   | リダイレクト |

worktree の中の `.claude/x` は、T2 のテストで本物の worktree を使って確かめているので、ここには入れない。

期待:

- PreToolUse: allow の規則を `Edit(//**)`、`Bash(tee *)`、`Bash(echo *)` にしても、どの入力でも allow を返さない。
- 2a: `decideStatic` の結果が `allow` ではない。
- 2b: `reasonToSkipLLM` が `held: ` で始まる理由を返す。

あわせて、ask の 4 本の代表パスが hold になることは、plan-2 の `settings-permissions-compat.test.ts` の ask の規則と同じパスを使う。plan-2 の T3 はこのテストの入力を参照して、ask の規則と hold の包含を確かめる。

`permission-analyzer.test.ts` に、`reason` が `held: ` または `skipped-llm: ` で始まる `pass` の行が、`needs_pattern` などの allow の候補の集計に入らないテストを足す。

- [ ] **Step 2: テストを実行して失敗を確認**

期待: `hold-invariants.test.ts` は T5〜T7 の後なので PASS する見込み。FAIL した場合は、その段の allow の出口に hold が通っていない。`permission-analyzer.test.ts` の新しいテストは FAIL。

- [ ] **Step 3: 実装する**

`loadLogEntries` で、`decision === "pass"` かつ `reason` が `HELD_PREFIX` または `SKIPPED_LLM_PREFIX`（`lib/auto-approval-hold.ts`）で始まる行を読み飛ばす。

- 判定は、`maxEntries` で切り詰める前の、既存の行ごとの条件判定の中に置く。hold の行が `maxEntries` の枠を食わないようにするため。
- 読み飛ばした件数は出さない。`analyze` の戻り値に件数の欄が無く、足すと戻り値の契約が変わるため。
- `.skills/update-auto-approve/SKILL.md` の手順の、ログを読む説明に「`held:` / `skipped-llm:` の `pass` は集計の対象外」と 1 行足す（Files に追加）。

- [ ] **Step 4: テストを実行して通過を確認**

期待: PASS。

- [ ] **Step 5: コミット**

```bash
git add home/dot_claude/hooks/tests/unit/hold-invariants.test.ts home/dot_claude/hooks/lib/permission-analyzer.ts home/dot_claude/hooks/tests/unit/permission-analyzer.test.ts
git commit -m "test(claude): check every hook holds the same inputs and keep holds out of allow suggestions"
```

### T9: README を更新し、テスト全体を通す

**Files:**

- 編集: `home/dot_claude/hooks/README.md:101, 115-125`

- [ ] **Step 1: README を書き換える**

- 既知の限界（`:121`）の `git -c` の例を直す。フックの静的な規則は `-c` を通さなくなった。本体の allow 規則（`Bash(git commit *)` など）が通す形は、フックでは止めない。
- `SAFE_BASH_PATTERNS` の説明（`:118-119`）に、大域オプションは `-C` だけを許すと書く。
- 理由の語彙に `held:`（hold）と `skipped-llm: git-head` / `skipped-llm: git-env`（2b の skip）を足す。`decision` はどれも `pass`。
- 2a の `uncertain` は、通常は `ask` で、hold のときは `pass`（`held:`）で記録される理由を書く。hold は「人間に判断を残した」記録で、`permission-analyzer` は allow の候補に数えない。
- hold の考え方を 3 行で書く。フックは本体の protected paths を広げない。例外は実体を確かめた worktree の内側だけ。`-C` を通すのは global の `safe.bareRepository=explicit` に依存している。
- 残余のリスクを書く（T3、T7 の注記）。
  - インタプリタが実行時に文字列からパスを組み立てる形は、静的な判定では見えない。
  - 引用符で分割した `git` は、2b の skip を外れ、LLM の評価に届きうる。
  - `$`、`{`、`cd` を含む Bash は一律に hold になり、本体の allow 規則が覆わないものは確認が出る。

- [ ] **Step 2: テスト全体を実行**

```
bun run test
```

- 期待: すべて PASS。
- 負荷をかけずに 3 回繰り返し、3 回とも PASS することを確かめる（CPU を使い切る負荷はウイルス対策の検査のせいで計器にならない。`docs/plans/test-timing-split/research.md` §5.6）。
- `bun run typecheck` と `bun run lint` も通す。

- [ ] **Step 3: allow を返す箇所がすべて hold を通ることを、コードで確かめる（spec R9）**

```
git grep -n "createAllowResponse\|behavior: \"allow\"\|kind === \"allow\"\|createPermissionRequestAllowResponse" -- home/dot_claude/hooks/implementations
```

- Bash と Edit 系の経路にある allow の出口が、`assessAutoApprovalHold`（PreToolUse）、`decideStatic`（2a）、`reasonToSkipLLM`（2b）の後にしかないことを、出力の各行について確かめる。
- 例外の 2 つ（原則 1 の正規表現、原則 2 の 2b の skip）は、T6 と T7 のテストで押さえた。

- [ ] **Step 4: コミット**

```bash
git add home/dot_claude/hooks/README.md
git commit -m "docs(claude): describe how hooks hold auto-approval"
```

## ISO 25010 具体テストケース

### セキュリティ（完全性）

- **入力**: `.claude/settings.json` への Edit（`Edit(//w/p/**)` の allow あり、cwd=`/w/p`） → **期待**: PreToolUse は判定を返さない。ログは 1 行で `pass`、`held: dot segment .claude`
- **入力**: `tee '.claude/x'`、`tee .cl"aude"/x`、`cp a.txt .VSCODE/a.txt` → **期待**: hold
- **入力**: `cat $HOME/notes.txt` → **期待**: hold（確定できない語）
- **入力**: 2a に `git -C /home/user/project -c core.autocrlf=false add .` → **期待**: `behavior` は `allow` ではない
- **入力**: 2b に `env -i GIT_PAGER=cat make` → **期待**: `skipped-llm: git-env`
- **入力**: 2b に `timeout 10 git fetch` → **期待**: `skipped-llm: git-head`
- **入力**: `gitdir:` が逆を指さない偽の worktree の中の `src/a.ts` → **期待**: `hold`
- **入力**: `.git` の `lstat` が `EACCES` で失敗する worktree の中の `src/a.ts` → **期待**: `hold`

### 機能適合性（正確性）

- **入力**: 本物の worktree（ブランチ `feat/x`）の `src/a.ts`、`.github/ci.yml`、`.gitignore` → **期待**: `worktree-content`
- **入力**: 同じ worktree の `.claude/settings.json`、`.CLAUDE/settings.json`、`vendor/sub/.git` → **期待**: `hold`
- **入力**: Bash の `git add .`（cwd は worktree のルート） → **期待**: hold しない
- **入力**: 2a に `git -C /home/user/project status` → **期待**: `allow`
- **入力**: `.git/config` への Edit（deny あり） → **期待**: `deny` のまま

### 信頼性（障害許容性）

- **入力**: `echo 'unterminated` → **期待**: hold（構文エラー）
- **入力**: parse の予算 0 での `ls budget-probe-dir` → **期待**: hold（打ち切り）
- **入力**: `.chezmoiroot` が無い home → **期待**: `chezmoiSource` は `<home>/.local/share/chezmoi/home`
- **入力**: `assessAutoApprovalHold` の中で例外 → **期待**: `hold: true`

### 対象外

- 性能効率性: fs の読み取りが増えるのは、パスに `.git/worktree/` を含むときと、既存の realpath だけ。Bash は parse が 2 回になる（T3 の注記）。
- 使用性（確認の増え方）: plan-2 の受け入れ実験で確かめる。

## Approval

- Plan Status: complete
- Review Status: pass
- Approval Status: approved

## Reviewer Outputs (Round 1)

### logic-validator

- verdict: needs-work
- 主指摘:
  - パーサーが連結や展開の語を落とし、引用符付きの語は dot の判定を外れる。
  - worktree のルート自身が hold になる。
  - ラッパーの引数を消費しない。
  - T1、T2、T3 のテストの一部が成立しない。

### scope-justification-reviewer

- verdict: needs-work（軽微）
- 主指摘:
  - PreToolUse が `-c` を通さないことのテストが無い。
  - K7 の hold の入力の一覧を、3 つのフックに流す表駆動のテストが無い。

### architecture-boundary-analyzer

- verdict: needs-work
- 主指摘:
  - T5 で allow と pass の二重ログになる。
  - 2 回 parse の予算の記述が不正確。
  - ラッパーの展開は既存の `stripWrappers` / `WRAPPER_COMMANDS` を共有する。

### security-vulnerability-analyzer

- verdict: needs-work（blocker 級 1）
- 主指摘:
  - パーサーが落とす語の型で、hold を素通りする。
  - 2b のラッパーの展開が、spec の経路を覆わない。
  - APFS は大文字と小文字を区別しない。
  - fs の失敗を hold に倒し切れていない。

### data-contract-evolution-evaluator

- verdict: needs-work
- 主指摘:
  - `permission-analyzer.ts` が `held:` の pass を allow の候補に数える。
  - 2a の uncertain が ask と pass の 2 通りで記録される理由を README に書く。
  - reason の形式を固定するテストを足す。

<!-- auto-review: pending -->
<!-- intent-triage: pending -->

<!-- parent-spec-hash は plan-review-automation hook が auto-review marker 生成時に挿入する。手で編集しない。 -->

## Reviewer Outputs (Round 2)

### logic-validator

- verdict: needs-work
- 主指摘:
  - worktree の絶対パスを含む Bash が、全文の判定で hold になる。`-C <worktree>` も含む。
  - 語の判定で、`resolve` が `..` を字句的に畳む。
  - `.chezmoiroot` のテストが、fallback と区別できない。

### scope-justification-reviewer

- verdict: pass
- 主指摘:
  - 原則 2 の全文の判定は、spec の文面より広い。spec への追記か、承認時の確認が要る。
  - ask の代表パスを fixture にして、plan-2 と共有する。

### architecture-boundary-analyzer

- verdict: pass
- 主指摘:
  - cwd と home の取得を、3 つのフックで `createMatchContext` に揃える。
  - 理由の接頭辞を定数にして共有する。

### security-vulnerability-analyzer

- verdict: pass（条件付き）
- 主指摘:
  - 全文の判定は、引用符やバックスラッシュを除いたテキストでも行う。
  - `{` を含むコマンドは hold にする。
  - `cd` / `pushd` を含むときは、語の判定に頼らない。
  - 実行時に組み立てられるパスは、残余のリスクとして書く。

### data-contract-evolution-evaluator

- verdict: pass
- 主指摘:
  - 除外は `maxEntries` の slice の前に置く。
  - 件数を統計に出すかを決める（「あれば」は曖昧）。

<!-- auto-review: verdict=needs-work; hash=8820725bad1bcdef1fc226d8011c0e8f70ef09720cc95b52e00ef996beac7590; design-hash=ab0d49088bfb6551a509c7d826c9b93de9e20bf6592b10d9f271e34e251b123c; round=1; parent-spec-hash=ef5ef9c56d89055a833b6f3aaaec3fb373ac04918b2b71021b1f2fafcc2131bd; at=2026-10-06T10:08:51.783Z; reviewers=logic-validator+scope-justification-reviewer+architecture-boundary-analyzer+security-vulnerability-analyzer+data-contract-evolution-evaluator -->

## Reviewer Outputs (Round 3)

### logic-validator

- verdict: needs-work
- 主指摘:
  - Round 2 の 3 点は、実際に正規表現とパーサーを動かして解消を確かめた。
  - cwd 自体が dot のセグメントを含むと（`~/.local/share/chezmoi`）、Bash の語がすべて hold になる。既存のテストは tmpdir を cwd にするので検出できない。

### scope-justification-reviewer

- verdict: pass (carried from Round 2)
- 主指摘: Round 2 で pass、再実行なし

### architecture-boundary-analyzer

- verdict: pass (carried from Round 2)
- 主指摘: Round 2 で pass、再実行なし

### security-vulnerability-analyzer

- verdict: pass (carried from Round 2)
- 主指摘: Round 2 で pass、再実行なし

### data-contract-evolution-evaluator

- verdict: pass (carried from Round 2)
- 主指摘: Round 2 で pass、再実行なし

<!-- auto-review: verdict=needs-work; hash=5b7731821a4ee93af6688aeeb8006a0915bd781750a2994ffd6566d0b2013af6; design-hash=f8818f0588bf8cc68cbd00455e7511b233532d8ba25acb5f94c80788c171adb7; round=2; parent-spec-hash=ef5ef9c56d89055a833b6f3aaaec3fb373ac04918b2b71021b1f2fafcc2131bd; at=2026-10-06T10:17:42.330Z; reviewers=logic-validator+scope-justification-reviewer+architecture-boundary-analyzer+security-vulnerability-analyzer+data-contract-evolution-evaluator -->

## Reviewer Outputs (Round 4)

延長の記録: Round 4 は自己延長（non-pass 2→1）。security は、判定を緩める変更のため手順の外で追加した。

### logic-validator

- verdict: needs-work（plan で吸収可）
- 主指摘:
  - cwd が `~/.config` で語が `git/config` のとき、2 セグメントの protected の名前が基準の境界をまたいで ordinary になる。
  - protected の一覧に無い dot ディレクトリが cwd のときの緩和を、残余として書く。

### security-vulnerability-analyzer（追加）

- verdict: pass（条件付き）
- 主指摘:
  - logic と同じ境界の穴。protected の名前はパス全体に当て、dot の規則だけを基準より下に当てる。
  - 信頼する基準を cwd ではなく、プロジェクトのルートに限る。

### scope-justification-reviewer

- verdict: pass (carried from Round 3)
- 主指摘: Round 3 で pass、再実行なし

### architecture-boundary-analyzer

- verdict: pass (carried from Round 3)
- 主指摘: Round 3 で pass、再実行なし

### security-vulnerability-analyzer

- verdict: pass (carried from Round 3)
- 主指摘: Round 3 で pass、再実行なし

### data-contract-evolution-evaluator

- verdict: pass (carried from Round 3)
- 主指摘: Round 3 で pass、再実行なし

<!-- auto-review: verdict=needs-work; hash=623ba7fffb8f7214db09528dd40ca00883728c33f76ae224c34f706d07a46fe6; design-hash=4848c46fc812d536482fc630e3c5109ec0985194bef5605d710be8093fa21117; round=3; parent-spec-hash=ef5ef9c56d89055a833b6f3aaaec3fb373ac04918b2b71021b1f2fafcc2131bd; at=2026-10-06T10:22:28.752Z; reviewers=logic-validator -->

## Reviewer Outputs (Round 5)

延長の記録: Round 5 は自己延長。security は、判定の基準を変える変更のため手順の外で追加した。

### logic-validator

- verdict: needs-work（plan で吸収可）
- 主指摘:
  - `maskProjectRoot` が境界を見ず、兄弟（`repo2`）やパスの途中でも置き換える（node で実測）。
  - ルートが `/` のとき、区切りそのものを壊す。
  - `findHoldSegment`、`createMatchContext`、`getProjectRoot` の import が無い。

### security-vulnerability-analyzer（追加 2）

- verdict: pass（条件付き）
- 主指摘:
  - Round 4 の 2 条件は閉じた。
  - マスクの境界と、短すぎるルート（`/`、HOME）を直す。
  - ルートの保護の判定を `trustedBaseFor` と揃える。

### security-vulnerability-analyzer（追加）

- verdict: pass (carried from Round 4)
- 主指摘: Round 4 で pass、再実行なし

### scope-justification-reviewer

- verdict: pass (carried from Round 4)
- 主指摘: Round 4 で pass、再実行なし

### architecture-boundary-analyzer

- verdict: pass (carried from Round 4)
- 主指摘: Round 4 で pass、再実行なし

### security-vulnerability-analyzer

- verdict: pass (carried from Round 4)
- 主指摘: Round 4 で pass、再実行なし

### data-contract-evolution-evaluator

- verdict: pass (carried from Round 4)
- 主指摘: Round 4 で pass、再実行なし

<!-- auto-review: verdict=needs-work; hash=d32f6d370c155aa6daeaac0cf2cb58e76e5a82848e29d707d7edaa5379532b30; design-hash=b8d1d7777dd3406c723da547ed4f15d56fe68fbb6915972653e7b851d8fbfe06; round=4; parent-spec-hash=ef5ef9c56d89055a833b6f3aaaec3fb373ac04918b2b71021b1f2fafcc2131bd; at=2026-10-06T10:24:38.270Z; reviewers=logic-validator+security-vulnerability-analyzer -->

## Reviewer Outputs (Round 6)

延長の記録: Round 6 は自己延長の上限。security は手順の外で追加した（下の行）。

### logic-validator

- verdict: pass
- 主指摘:
  - マスクの正規表現を node で再現し、境界、兄弟、埋め込み、連続を確かめた。
  - 軽微: `..` は語の判定に委ねることをテストで固定する（反映済み）。

### security-vulnerability-analyzer（Round 6 で追加）

- verdict: pass（条件付き、反映済み）
- 主指摘:
  - Round 5 の 3 条件は閉じた。
  - マスクの側でも、ルートの realpath を確かめる（反映済み）。

### security-vulnerability-analyzer（追加）

- verdict: pass (carried from Round 5)
- 主指摘: Round 5 で pass、再実行なし

### scope-justification-reviewer

- verdict: pass (carried from Round 5)
- 主指摘: Round 5 で pass、再実行なし

### architecture-boundary-analyzer

- verdict: pass (carried from Round 5)
- 主指摘: Round 5 で pass、再実行なし

### security-vulnerability-analyzer

- verdict: pass (carried from Round 5)
- 主指摘: Round 5 で pass、再実行なし

### data-contract-evolution-evaluator

- verdict: pass (carried from Round 5)
- 主指摘: Round 5 で pass、再実行なし

<!-- auto-review: verdict=needs-work; hash=42782d0b1f60669aaec17f704c0a91e8bdf07f87963c2269667eb8944304c46b; design-hash=e0ff4a08da04aeafcd8e0f8aa3b67dc75c5a020c45769cb7d7c4d8ec9c98921d; round=5; parent-spec-hash=ef5ef9c56d89055a833b6f3aaaec3fb373ac04918b2b71021b1f2fafcc2131bd; at=2026-10-06T10:27:05.377Z; reviewers=logic-validator+security-vulnerability-analyzer -->

<!-- auto-review: verdict=pass; hash=b6a4cb5a54a540cccefb58203f7d492d57ce8b2c648631be1ea5173f2c892959; design-hash=b58f1382cdc37febc72ec0b87527266ae20e511e72c2dc010227ea9b52f0c187; round=6; parent-spec-hash=ef5ef9c56d89055a833b6f3aaaec3fb373ac04918b2b71021b1f2fafcc2131bd; at=2026-10-06T10:29:01.864Z; reviewers=logic-validator+security-vulnerability-analyzer -->
<!-- intent-triage: adopted=20; excluded=0; at=2026-10-06T10:29:19.258Z -->
