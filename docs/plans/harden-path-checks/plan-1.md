<!-- spec-ref: spec.md -->

# Plan 1: file-access-guard のパス判定の強化 (Execution layer)

spec.md の K1〜K8 を実装する。パスは repo のルート相対。テストは次で実行する（以下 `TEST <file>` と書く）:

```bash
node --import ./home/dot_claude/hooks/tests/preload-test-env.mjs --test <file>
```

T1 で入口の確認を 2 つ作る（spec R8）。以後、**すべてのタスクの最後の実行手順で、この 2 つを走らせる**（以下 `ENTRY` と書く）:

```bash
node --import ./home/dot_claude/hooks/tests/preload-test-env.mjs --test home/dot_claude/hooks/tests/unit/hook-entrypoints.test.ts
for f in file-access-guard permission-auto-approve document-workflow-guard auto-approve; do
  bun -e "await import('./home/dot_claude/hooks/implementations/$f.ts')" || echo "IMPORT FAILED: $f"
done
```

期待: node の 4 件が PASS。bun の 4 回が何も出力せずに終わる（`IMPORT FAILED` が出ない）。hook は実行時に bun で動くので、bun での import も見る。

`lib/bash-parser.ts`、`lib/deny-input.ts`、`hooks/executable_run-guard.sh` は編集しない。`extractPathsFromBashCommand`（Bash の分岐）は触らず、テストも足さない（spec K8）。`permission-auto-approve.ts` の `segments[0] !== "tmp"` は変えない（spec K5）。

`file-access-guard.test.ts` は今 75 件（2026-10-04 に実行して確認）。

## Files

```
# 新規作成
home/dot_claude/hooks/lib/path-containment.ts
home/dot_claude/hooks/lib/temp-roots.ts
home/dot_claude/hooks/tests/unit/path-containment.test.ts
home/dot_claude/hooks/tests/unit/hook-entrypoints.test.ts

# 編集
home/dot_claude/hooks/lib/workflow-fs.ts
home/dot_claude/hooks/lib/pattern-matcher.ts
home/dot_claude/hooks/implementations/file-access-guard.ts
home/dot_claude/hooks/implementations/permission-auto-approve.ts
home/dot_claude/hooks/implementations/document-workflow-guard.ts
home/dot_claude/.settings.hooks.json.tmpl

# テスト
home/dot_claude/hooks/tests/unit/file-access-guard.test.ts
home/dot_claude/hooks/tests/unit/interpreter-write-classify.test.ts
home/dot_claude/hooks/tests/unit/pattern-matching.test.ts
```

## Tasks

### T1: `resolveWithMissingTail` を `lib/path-containment.ts` に移し、入口の確認を足す

このタスクでは挙動を変えない。

**Files:**

- 新規: `home/dot_claude/hooks/lib/path-containment.ts`
- 新規: `home/dot_claude/hooks/tests/unit/hook-entrypoints.test.ts`
- 編集: `home/dot_claude/hooks/lib/workflow-fs.ts:89-142`
- 参照: `home/dot_claude/hooks/lib/workflow-fs.ts:109-142`（移す関数 `resolveWithMissingTail` と、それだけが使う `entryExists`）
- 参照: `home/dot_claude/hooks/lib/workflow-files.ts:10`、`home/dot_claude/hooks/implementations/document-workflow-guard.ts:24`（`workflow-fs.ts` から import している呼び出し元。再 export で無改修にする）

- [ ] **Step 1: 入口の確認のテストを書く**

`home/dot_claude/hooks/tests/unit/hook-entrypoints.test.ts`:

```ts
#!/usr/bin/env node --test

import { ok } from "node:assert";
import { describe, it } from "node:test";

// The shared lib/ modules are imported by several hooks; a broken one would
// stop all of them at once. Importing each entry point resolves its whole
// module graph without running the hook (they run only under import.meta.main).
const ENTRY_POINTS = [
  "../../implementations/file-access-guard.ts",
  "../../implementations/permission-auto-approve.ts",
  "../../implementations/document-workflow-guard.ts",
  "../../implementations/auto-approve.ts",
];

describe("hook entry points load", () => {
  for (const entry of ENTRY_POINTS) {
    it(`imports ${entry}`, async () => {
      const mod = await import(entry);
      ok(mod.default, `${entry} has a default export`);
    });
  }
});
```

- [ ] **Step 2: 実行して通ることを確認**（移動の前の基準）

実行: `ENTRY`
期待: node の 4 件 PASS、bun の 4 回が出力なし

- [ ] **Step 3: 関数を移す**

`home/dot_claude/hooks/lib/path-containment.ts` を作り、`workflow-fs.ts:89-142` の `resolveWithMissingTail` と `entryExists` を、doc コメントごとそのまま移す。import は `lstatSync, realpathSync`（`node:fs`）と `basename, dirname, join`（`node:path`）。`workflow-fs.ts` からは 2 つの関数の定義を消し、次の 2 行にする。`workflow-fs.ts` の import のうち、使わなくなったもの（`lstatSync`、`basename`、`dirname`、`join`）を消す。`realpathSync` と `resolve` は `realpathInsideWorkflowDir` と `isStrictlyUnderProjectSubdir` が使うので残す。

```ts
import { resolveWithMissingTail } from "./path-containment.ts";

export { resolveWithMissingTail };
```

- [ ] **Step 4: テストを実行**

実行: `TEST home/dot_claude/hooks/tests/unit/workflow-fs.test.ts`、`ENTRY`、`bun run typecheck`
期待: すべて PASS。`workflow-fs.test.ts` は変更なしで通る

- [ ] **Step 5: コミット**

```bash
git add home/dot_claude/hooks/lib/path-containment.ts home/dot_claude/hooks/lib/workflow-fs.ts home/dot_claude/hooks/tests/unit/hook-entrypoints.test.ts
git commit -m "refactor(hooks): move resolveWithMissingTail into lib/path-containment"
```

### T2: `collectTempRoots`、`isUnderRoot`、`hasParentSegment` を `lib/` に移す

挙動は変えない。

**Files:**

- 新規: `home/dot_claude/hooks/lib/temp-roots.ts`
- 編集: `home/dot_claude/hooks/lib/path-containment.ts`
- 編集: `home/dot_claude/hooks/implementations/file-access-guard.ts:339-385`
- テスト: `home/dot_claude/hooks/tests/unit/file-access-guard.test.ts:15-19`（import 先の変更だけ）
- 参照: `home/dot_claude/hooks/implementations/file-access-guard.ts:339-385`（`MACOS_USER_TMPDIR_SHAPE`、`hasParentSegment`、`collectTempRoots`、`isUnderRoot`）

- [ ] **Step 1: 移す**

- `path-containment.ts` に `isUnderRoot` と `hasParentSegment` を、コメントごと移して `export` する
- `temp-roots.ts` を作り、`MACOS_USER_TMPDIR_SHAPE` と `collectTempRoots` を doc コメントごと移す。`hasParentSegment` は `./path-containment.ts` から、`resolve` は `node:path` から import する
- `file-access-guard.ts` は 2 つの lib から import する。`collectTempRoots` の `export` は `file-access-guard.ts` から無くす（再 export は置かない）:

```ts
import { hasParentSegment, isUnderRoot } from "../lib/path-containment.ts";
import { collectTempRoots } from "../lib/temp-roots.ts";
```

- `file-access-guard.test.ts:15-19` の import を分ける:

```ts
import fileAccessGuardHook, {
  getAllowPatterns,
  isWithinTempRoots,
} from "../../implementations/file-access-guard.ts";
import { collectTempRoots } from "../../lib/temp-roots.ts";
```

- [ ] **Step 2: テストを実行**

実行: `TEST home/dot_claude/hooks/tests/unit/file-access-guard.test.ts`、`ENTRY`、`bun run typecheck`
期待: `file-access-guard.test.ts` は 75 件が PASS（変えたのは import の 2 文だけ）

- [ ] **Step 3: コミット**

```bash
git add home/dot_claude/hooks/lib/path-containment.ts home/dot_claude/hooks/lib/temp-roots.ts home/dot_claude/hooks/implementations/file-access-guard.ts home/dot_claude/hooks/tests/unit/file-access-guard.test.ts
git commit -m "refactor(hooks): move temp roots and containment helpers into lib"
```

### T3: `checkParentSegments` と `resolvePhysicalPath` を足し、`resolveWithMissingTail` をその上に載せる（spec K2、K3）

「存在する祖先まで遡る」ループを 1 本にする。`resolveWithMissingTail` の挙動は次の 2 点で変わる。どちらも「検査できなかった」を失敗にする向きで、意図した変更としてコミットメッセージに書く:

- lstat が `ENOENT` 以外で失敗したとき（`EACCES` など）: 今は「無い」とみなして上へ遡る。変更後は `null`
- `..` のセグメントを含む、または `/` で始まらないパス: 今は呼ぶ側の前提に任せている。変更後は `null`

既存の呼び出し元はどれも `resolve()` を通した絶対パスを渡すので、2 点目には当たらない。1 点目に当たるのは、realpath が `ENOENT` で lstat が `EACCES` などになる入力だけ。`isStrictlyUnderProjectSubdir` は `null` を「配下でない」として扱うので厳しくなる。`document-workflow-guard.ts:979-990` は `null` のとき字句の比較に落ちる（`?? target`）ので、この入力に限っては、解決できなかったパスを文字列で比べる範囲が広がる。spec は「移す。再 export する」とだけ書いているので、この変更はコミットメッセージの `decision:` 行と、承認の依頼の要約に載せる。

**Files:**

- 編集: `home/dot_claude/hooks/lib/path-containment.ts`
- 新規: `home/dot_claude/hooks/tests/unit/path-containment.test.ts`
- 参照: `home/dot_claude/hooks/lib/workflow-fs.ts:89-108`（`resolveWithMissingTail` の契約。「字句の正規化済みの絶対パス」が前提で、`ENOENT` 以外の失敗は `null`）
- 参照: `home/dot_claude/hooks/lib/workflow-fs.ts:68-87`、`home/dot_claude/hooks/lib/workflow-files.ts:10`、`home/dot_claude/hooks/implementations/document-workflow-guard.ts:24`（`resolveWithMissingTail` の呼び出し元。どれも `resolve()` を通した絶対パスを渡す）

- [ ] **Step 1: 失敗するテストを書く**

`home/dot_claude/hooks/tests/unit/path-containment.test.ts`:

```ts
#!/usr/bin/env node --test

import { deepStrictEqual, strictEqual } from "node:assert";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
  checkParentSegments,
  resolvePhysicalPath,
  resolveWithMissingTail,
} from "../../lib/path-containment.ts";

describe("checkParentSegments", () => {
  const cases: [string, ReturnType<typeof checkParentSegments>][] = [
    ["/a/b", { ok: true }],
    ["/a/../b", { ok: false, kind: "absolute" }],
    ["/a/..//b", { ok: false, kind: "absolute" }],
    ["/a/b/..", { ok: false, kind: "absolute" }],
    ["/a/b..c/d", { ok: true }],
    ["/a/.../b", { ok: true }],
    ["../x", { ok: true }],
    ["../../x", { ok: true }],
    ["./../x", { ok: true }],
    ["a/../b", { ok: false, kind: "relative" }],
    ["../a/../b", { ok: false, kind: "relative" }],
    ["a/b", { ok: true }],
    ["", { ok: true }],
  ];
  for (const [input, expected] of cases) {
    it(`${JSON.stringify(input)} -> ${JSON.stringify(expected)}`, () => {
      deepStrictEqual(checkParentSegments(input), expected);
    });
  }
});

describe("resolvePhysicalPath", () => {
  // process.cwd() is the repository; its .tmp/ is gitignored. realpathSync so
  // that the expectations hold when the checkout is reached through a symlink.
  let base = "";
  beforeEach(() => {
    mkdirSync(join(process.cwd(), ".tmp"), { recursive: true });
    base = realpathSync(mkdtempSync(join(process.cwd(), ".tmp", "pc-")));
    mkdirSync(join(base, "real"));
    symlinkSync(join(base, "real"), join(base, "link"));
    symlinkSync(join(base, "nowhere"), join(base, "dangling"));
    symlinkSync(join(base, "loop"), join(base, "loop"));
  });
  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  it("returns an existing path unchanged", () => {
    deepStrictEqual(resolvePhysicalPath(join(base, "real")), {
      ok: true,
      path: join(base, "real"),
    });
  });
  it("resolves a symlink", () => {
    deepStrictEqual(resolvePhysicalPath(join(base, "link", "x")), {
      ok: true,
      path: join(base, "real", "x"),
    });
  });
  it("re-attaches a missing tail", () => {
    deepStrictEqual(resolvePhysicalPath(join(base, "real", "new", "f")), {
      ok: true,
      path: join(base, "real", "new", "f"),
    });
  });
  it("reports a dangling symlink", () => {
    deepStrictEqual(resolvePhysicalPath(join(base, "dangling")), {
      ok: false,
      code: "EDANGLING",
    });
  });
  it("reports a symlink loop", () => {
    deepStrictEqual(resolvePhysicalPath(join(base, "loop", "x")), {
      ok: false,
      code: "ELOOP",
    });
  });
  it("rejects a path with a .. segment", () => {
    deepStrictEqual(resolvePhysicalPath(`${base}/real/../x`), {
      ok: false,
      code: "EPARENT",
    });
  });
  it("rejects a relative path and a NUL byte", () => {
    deepStrictEqual(resolvePhysicalPath("a/b"), { ok: false, code: "EINVAL" });
    deepStrictEqual(resolvePhysicalPath("/a\0b"), {
      ok: false,
      code: "EINVAL",
    });
  });
  it("reports the errno of an injected realpath failure", () => {
    const fs = {
      realpath: (): string => {
        throw Object.assign(new Error("EACCES"), { code: "EACCES" });
      },
      lstat: () => ({}),
    };
    deepStrictEqual(resolvePhysicalPath("/x/y", fs), {
      ok: false,
      code: "EACCES",
    });
  });
  it("fails when lstat fails with something other than ENOENT", () => {
    const fs = {
      realpath: (): string => {
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      },
      lstat: (): unknown => {
        throw Object.assign(new Error("EACCES"), { code: "EACCES" });
      },
    };
    deepStrictEqual(resolvePhysicalPath("/x/y", fs), {
      ok: false,
      code: "EACCES",
    });
  });
  it("treats ENOTDIR as unresolvable, not as missing", () => {
    const fs = {
      realpath: (): string => {
        throw Object.assign(new Error("ENOTDIR"), { code: "ENOTDIR" });
      },
      lstat: () => ({}),
    };
    deepStrictEqual(resolvePhysicalPath("/x/file/y", fs), {
      ok: false,
      code: "ENOTDIR",
    });
  });
});

describe("resolveWithMissingTail on top of resolvePhysicalPath", () => {
  it("returns the path for a resolvable input and null otherwise", () => {
    const here = realpathSync(process.cwd());
    strictEqual(
      resolveWithMissingTail(join(here, "no-such-dir", "f")),
      join(here, "no-such-dir", "f"),
    );
    strictEqual(resolveWithMissingTail(`${here}/a/../b`), null);
    strictEqual(resolveWithMissingTail("relative/path"), null);
  });
});
```

- [ ] **Step 2: 実行して失敗を確認**

実行: `TEST home/dot_claude/hooks/tests/unit/path-containment.test.ts`
期待: FAIL（`checkParentSegments` と `resolvePhysicalPath` が export されていない）

- [ ] **Step 3: 実装**

`path-containment.ts` に足し、T1 で移した `resolveWithMissingTail` の本体と `entryExists` を、下の載せ替えた形に置き換える（doc コメントは残し、挙動の差 2 点を 1 文で足す）:

```ts
export interface PathFs {
  realpath(p: string): string;
  lstat(p: string): unknown;
}

const nodeFs: PathFs = { realpath: realpathSync, lstat: lstatSync };

export type ParentSegmentCheck =
  { ok: true } | { ok: false; kind: "absolute" | "relative" };

/**
 * An absolute path may not contain `..` at all. A relative path may only
 * start with `..` segments: from a physical cwd, going up never crosses a
 * symlink, while `sub/sym/..` resolves differently depending on whether the
 * opener collapses it lexically or lets the kernel walk it.
 */
export function checkParentSegments(path: string): ParentSegmentCheck {
  const segments = path.split("/");
  if (path.startsWith("/")) {
    return segments.includes("..")
      ? { ok: false, kind: "absolute" }
      : { ok: true };
  }
  let seenName = false;
  for (const segment of segments) {
    if (segment === "" || segment === ".") continue;
    if (segment !== "..") {
      seenName = true;
      continue;
    }
    if (seenName) return { ok: false, kind: "relative" };
  }
  return { ok: true };
}

export type PhysicalPath =
  { ok: true; path: string } | { ok: false; code: string };

export function errnoOf(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return typeof code === "string" ? code : "EUNKNOWN";
}

/**
 * Where an absolute, `..`-free path lands after every symlink is followed.
 * A path that does not exist yet resolves through its nearest existing
 * ancestor. Never throws: anything that prevents the check from running is
 * returned as a code, so the caller can deny with a reason instead of
 * crashing.
 */
export function resolvePhysicalPath(
  absPath: string,
  fs: PathFs = nodeFs,
): PhysicalPath {
  if (!absPath.startsWith("/") || absPath.includes("\0")) {
    return { ok: false, code: "EINVAL" };
  }
  if (hasParentSegment(absPath)) {
    return { ok: false, code: "EPARENT" };
  }
  const missing: string[] = [];
  let current = absPath;
  for (;;) {
    try {
      const real = fs.realpath(current);
      return {
        ok: true,
        path: missing.length === 0 ? real : join(real, ...missing),
      };
    } catch (error) {
      const code = errnoOf(error);
      if (code !== "ENOENT") return { ok: false, code };
    }
    // ENOENT with an entry present means a dangling symlink.
    try {
      fs.lstat(current);
      return { ok: false, code: "EDANGLING" };
    } catch (error) {
      const code = errnoOf(error);
      if (code !== "ENOENT") return { ok: false, code };
    }
    const parent = dirname(current);
    if (parent === current) return { ok: false, code: "ENOENT" };
    missing.unshift(basename(current));
    current = parent;
  }
}

export function resolveWithMissingTail(path: string): string | null {
  const resolved = resolvePhysicalPath(path);
  return resolved.ok ? resolved.path : null;
}
```

- [ ] **Step 4: 実行して通過を確認**

実行: `TEST home/dot_claude/hooks/tests/unit/path-containment.test.ts`、`TEST home/dot_claude/hooks/tests/unit/workflow-fs.test.ts`、`bun run test`、`ENTRY`、`bun run typecheck`
期待: 全件 PASS。`resolveWithMissingTail` の挙動を変えたので、ここでは全テスト（`bun run test`）を走らせる。`workflow-fs.test.ts` ほか既存のテストが落ちた場合は、落ちたテスト名と入力を書き出し、上の「挙動の差 2 点」のどちらに当たるかを確かめる。当たらない失敗は実装の誤りなので、テストではなく実装を直す

- [ ] **Step 5: コミット**

```bash
git add home/dot_claude/hooks/lib/path-containment.ts home/dot_claude/hooks/tests/unit/path-containment.test.ts
git commit -m "feat(hooks): add checkParentSegments and resolvePhysicalPath"
```

コミットメッセージの本文に `decision:` 行で、`resolveWithMissingTail` が lstat の `ENOENT` 以外の失敗と、`..` を含む・相対のパスで `null` を返すようになったことを書く。

### T4: `validatePath` を `judge(form, ctx)` に組み直す（spec K8）

この時点では字句の形だけを判定し、step 1.5 / 1.6 は `validatePath` の中に今の形で残す。物理の形は T5 で足す。起動されるツールで結果が変わるのは NotebookEdit だけ。

**Files:**

- 編集: `home/dot_claude/hooks/implementations/file-access-guard.ts:55-101, 462-631`
- テスト: `home/dot_claude/hooks/tests/unit/file-access-guard.test.ts`
- 参照: `home/dot_claude/hooks/implementations/file-access-guard.ts:552-579`（step 4。書き込みの分岐が `Edit`、`Write`、`MultiEdit` だけ。読み取りの自動許可は `Read` と `LS` だけ）、`:589-623`（step 6 の `toolName` の分岐）
- 参照: `home/dot_claude/hooks/implementations/file-access-guard.ts:177-212`（`PERMISSION_CATEGORY` と `getAllowPatterns`。変えない）

- [ ] **Step 1: テストを書く**

`file-access-guard.test.ts` の `describe("path-segment boundary of allowed roots (HOME isolated)", …)` の中に足す。`home`、`read` は同じ describe の既存のもの。最初の 1 件は describe の直下、残りは `describe("additionalDirectories", …)` の中:

```ts
it("lets NotebookEdit write inside the repository", async () => {
  const ctx = createPreToolUseContextFor(fileAccessGuardHook, "NotebookEdit", {
    notebook_path: "/home/user/project/n.ipynb",
    new_source: "x",
  });
  await invokeRun(fileAccessGuardHook, ctx);
  ctx.assertSuccess({});
});
```

```ts
it("denies NotebookEdit inside an additional directory without an Edit pattern", async () => {
  const ctx = createPreToolUseContextFor(fileAccessGuardHook, "NotebookEdit", {
    notebook_path: "/home/user/extra/n.ipynb",
    new_source: "x",
  });
  await invokeRun(fileAccessGuardHook, ctx);
  ctx.assertDeny();
});

it("denies NotebookEdit outside every allowed root", async () => {
  const ctx = createPreToolUseContextFor(fileAccessGuardHook, "NotebookEdit", {
    notebook_path: "/home/user/other/n.ipynb",
    new_source: "x",
  });
  await invokeRun(fileAccessGuardHook, ctx);
  ctx.assertDeny();
});

it("lets Glob read inside an additional directory", async () => {
  const ctx = createPreToolUseContextFor(fileAccessGuardHook, "Glob", {
    pattern: "*.md",
    path: "/home/user/extra",
  });
  await invokeRun(fileAccessGuardHook, ctx);
  ctx.assertSuccess({});
});
```

- [ ] **Step 2: 実行して確認**

実行: `TEST home/dot_claude/hooks/tests/unit/file-access-guard.test.ts`
期待: `lets Glob read inside an additional directory` が FAIL（今の step 4 は `Read` と `LS` だけを自動許可する）。ほかの 3 件は今も PASS する（NotebookEdit は `PERMISSION_CATEGORY` で `Edit` に写るので、step 5 までの結果は変わらない）。構造の置き換えの退行は、既存の 75 件が見張る

- [ ] **Step 3: 実装**

`validatePath` のシグネチャを `(path: string, ctx: JudgeContext)` に変え、step 1、2、3、4、5、6 と既定の拒否を `judge` に移す。step 1.5 / 1.6（`isWithinTempRoots` の 2 回の呼び出し）は `validatePath` の中の、`judge` を呼ぶ前に今の形のまま残す（`isWithinTempRoots` が `true` なら allow を返し、そうでなければ `judge` へ進む）。

```ts
type Category = "read" | "write";

// Maps each tool to the kind of access it performs. Bash has no entry: steps 4
// and 6 skip it and it falls to the default deny, exactly as before.
// PERMISSION_CATEGORY above answers a different question (which allow-pattern
// prefix covers a tool); keep the two in step when a tool is added.
const TOOL_CATEGORY: Record<string, Category> = {
  Read: "read",
  NotebookRead: "read",
  LS: "read",
  Glob: "read",
  Grep: "read",
  Write: "write",
  Edit: "write",
  MultiEdit: "write",
  NotebookEdit: "write",
};

const SYSTEM_PATHS = [
  "/etc",
  "/usr",
  "/var",
  "/opt",
  "/bin",
  "/sbin",
  "/lib",
  "/lib64",
  "/boot",
  "/proc",
  "/sys",
  "/dev",
];

export interface JudgeContext {
  category: Category | undefined;
  allowPatterns: string[];
  repoRoot: string;
  homeDir: string;
  additionalDirs: string[]; // already absolute, no trailing slash
  tempRoots: string[]; // T4: read by validatePath (step 1.5). T5: read by judge
  workflowDirRoots: string[]; // T4: read by validatePath (step 1.6). T5: read by judge
  systemPaths: string[]; // SYSTEM_PATHS in production; tests may narrow it
  caseInsensitive: boolean; // process.platform === "darwin" in production
}

export interface Judgement {
  allowed: boolean;
  step: string;
  reason?: string;
}

export function judge(form: string, ctx: JudgeContext): Judgement;
```

T5 で 3 つ目の引数 `physical: boolean` を足す。このタスクでは 2 引数のまま。

`judge` の中身は今の step の並びのまま。置き換える点:

- step 1: `isUnderRoot(form, ctx.repoRoot)` → `{ allowed: true, step: "1-repo" }`
- step 2: `ctx.systemPaths` の各値 `s` について `form.startsWith(`${s}/`)` → `{ allowed: false, step: "2-system", reason: 今の文言 }`
- step 3: 今のまま → `"3-safe"`
- step 4: `toolName === "Read" || toolName === "LS"` を `ctx.category === "read"` に、`Edit` / `Write` / `MultiEdit` の分岐を `ctx.category === "write"` に置き換える → `"4-additional"`。`ctx.additionalDirs` は呼び出し側で絶対パスにしておく（今の `resolve(resolvePath(addDir))` の結果）
- step 5: 今のまま → `"5-pattern"`
- step 6: `isWriteOperation` を `ctx.category === "write"`、`isReadOperation` を `ctx.category === "read"` に置き換える → `"6-chezmoi"`
- 既定の拒否 → `{ allowed: false, step: "default", reason: "File is outside repository root and not explicitly allowed" }`

hook の本体（:55-101）は `JudgeContext` を 1 回作り、`validatePath(filePath, ctx)` を呼ぶ。`category` は `TOOL_CATEGORY[tool_name]`、`systemPaths` は `SYSTEM_PATHS`、`caseInsensitive` は `process.platform === "darwin"`、`tempRoots` は `collectTempRoots(tmpdir(), realpathSync)`。`validatePath` は `PathValidationResult` を返す形を保ち、`judge` の結果を `isAllowed`、`resolvedPath`、`reason` に写す。

- [ ] **Step 4: 実行して通過を確認**

実行: `TEST home/dot_claude/hooks/tests/unit/file-access-guard.test.ts`、`ENTRY`、`bun run typecheck`
期待: 79 件 PASS（75 + 4）

- [ ] **Step 5: コミット**

```bash
git add home/dot_claude/hooks/implementations/file-access-guard.ts home/dot_claude/hooks/tests/unit/file-access-guard.test.ts
git commit -m "refactor(hooks): judge file access by read/write category"
```

### T5: `..` の検査と、字句の形・物理の形の両方の判定を入れる（spec K1、K2、K3）

**Files:**

- 編集: `home/dot_claude/hooks/implementations/file-access-guard.ts`（`validatePath`、`judge`、`resolvePath`、`isWithinTempRoots`、:87-101 の deny の文言）
- テスト: `home/dot_claude/hooks/tests/unit/file-access-guard.test.ts`
- 参照: `home/dot_claude/hooks/lib/path-containment.ts`（T3 の `checkParentSegments`、`resolvePhysicalPath`、`errnoOf`）
- 参照: `home/dot_claude/hooks/tests/unit/file-access-guard.test.ts:383-427`（実ファイルシステムを `process.cwd()/.tmp` に作る既存の describe。同じ置き場を使う）
- 参照: `spec.md` の「`validatePath` の流れ」1〜8

- [ ] **Step 1: 失敗するテストを書く**

(1) `file-access-guard.test.ts` の `describe("file-access-guard.ts hook behavior", …)` の中、`describe("temp roots (HOME isolated)", …)` の前に足す:

```ts
// Real files under process.cwd()/.tmp: outside os.tmpdir(), so the temp-root
// step does not decide these cases.
describe("lexical and physical forms (spec K1-K3)", () => {
  let base = "";
  let repo = "";
  let outside = "";
  let home = "";

  beforeEach(() => {
    mkdirSync(join(process.cwd(), ".tmp"), { recursive: true });
    base = realpathSync(mkdtempSync(join(process.cwd(), ".tmp", "fag-k1-")));
    repo = join(base, "repo");
    outside = join(base, "outside");
    home = join(base, "home");
    for (const d of [join(repo, "src"), outside, join(home, ".claude")]) {
      mkdirSync(d, { recursive: true });
    }
    envHelper.set("HOME", home);
    envHelper.set("CLAUDE_TEST_REPO_ROOT", repo);
    envHelper.set("CLAUDE_TEST_CWD", join(repo, "src"));
    envHelper.set("DOCUMENT_WORKFLOW_DIR", undefined);
  });
  afterEach(() => {
    envHelper.restore();
    rmSync(base, { recursive: true, force: true });
  });

  const run = async (tool: string, input: Record<string, unknown>) => {
    const ctx = createPreToolUseContextFor(fileAccessGuardHook, tool, input);
    await invokeRun(fileAccessGuardHook, ctx);
    return ctx;
  };
  const reasonOf = (ctx: { jsonCalls: any[] }): string =>
    ctx.jsonCalls[0]?.hookSpecificOutput?.permissionDecisionReason ?? "";

  it("denies an absolute path with .. even when it stays inside the repo", async () => {
    const ctx = await run("Read", { file_path: `${repo}/src/../README.md` });
    ctx.assertDeny();
    ok(reasonOf(ctx).includes("step=parent-segment"));
  });

  it("denies an absolute path with .. that leaves the repo", async () => {
    (await run("Read", { file_path: `${repo}/../outside/a` })).assertDeny();
  });

  it("allows a relative path that starts with ..", async () => {
    (await run("Read", { file_path: "../README.md" })).assertSuccess({});
  });

  it("treats ./../x like ../x", async () => {
    (await run("Read", { file_path: "./../README.md" })).assertSuccess({});
  });

  it("denies a relative path with .. after a name", async () => {
    const ctx = await run("Read", { file_path: "a/../b" });
    ctx.assertDeny();
    ok(reasonOf(ctx).includes("step=parent-segment"));
  });

  it("denies a leading .. that lands outside the repo", async () => {
    (await run("Read", { file_path: "../../outside/a" })).assertDeny();
  });

  it("denies a symlink in the repo that points outside", async () => {
    symlinkSync(outside, join(repo, "link"));
    const ctx = await run("Read", { file_path: join(repo, "link", "a") });
    ctx.assertDeny();
    const reason = reasonOf(ctx);
    ok(reason.includes("denied-form=physical"));
    ok(reason.includes(`physical=${join(outside, "a")}`));
    ok(reason.includes(`lexical=${join(repo, "link", "a")}`));
  });

  it("denies a relative path through a symlink that points outside", async () => {
    symlinkSync(outside, join(repo, "src", "link"));
    const ctx = await run("Read", { file_path: "link/a" });
    ctx.assertDeny();
    ok(reasonOf(ctx).includes("denied-form=physical"));
  });

  it("denies a symlink in the repo that points into a system directory", async () => {
    symlinkSync("/etc", join(repo, "etc-link"));
    const ctx = await run("Read", {
      file_path: join(repo, "etc-link", "passwd"),
    });
    ctx.assertDeny();
    const reason = reasonOf(ctx);
    ok(reason.includes("denied-form=physical"));
    ok(reason.includes("step=2-system"));
  });

  it("denies a symlink under ~/.claude that points outside", async () => {
    symlinkSync(outside, join(home, ".claude", "sym"));
    const ctx = await run("Read", {
      file_path: join(home, ".claude", "sym", "a"),
    });
    ctx.assertDeny();
    ok(reasonOf(ctx).includes("denied-form=physical"));
  });

  it("allows a symlink in the repo that points inside the repo", async () => {
    symlinkSync(join(repo, "src"), join(repo, "alias"));
    (
      await run("Read", { file_path: join(repo, "alias", "a.ts") })
    ).assertSuccess({});
  });

  it("allows a symlink under a temp root that points into the repo", async () => {
    const dir = mkdtempSync(join(realpathSync("/tmp"), "fag-cross-"));
    try {
      symlinkSync(join(repo, "src"), join(dir, "into-repo"));
      (
        await run("Read", { file_path: join(dir, "into-repo", "a.ts") })
      ).assertSuccess({});
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("denies NotebookEdit through a symlink that points outside", async () => {
    symlinkSync(outside, join(repo, "nb-link"));
    const ctx = await run("NotebookEdit", {
      notebook_path: join(repo, "nb-link", "n.ipynb"),
      new_source: "x",
    });
    ctx.assertDeny();
    ok(reasonOf(ctx).includes("denied-form=physical"));
  });

  it("denies a relative path when the working directory cannot be resolved", async () => {
    symlinkSync(join(base, "nowhere"), join(repo, "dangling-cwd"));
    envHelper.set("CLAUDE_TEST_CWD", join(repo, "dangling-cwd"));
    const ctx = await run("Read", { file_path: "a.ts" });
    ctx.assertDeny();
    ok(reasonOf(ctx).includes("step=cwd"));
  });

  it("denies a dangling symlink with an unresolvable code", async () => {
    symlinkSync(join(base, "nowhere"), join(repo, "dangling"));
    const ctx = await run("Write", {
      file_path: join(repo, "dangling"),
      content: "x",
    });
    ctx.assertDeny();
    ok(reasonOf(ctx).includes("unresolvable=EDANGLING"));
  });

  it("allows a file that does not exist yet", async () => {
    (
      await run("Write", {
        file_path: join(repo, "new", "dir", "f.ts"),
        content: "x",
      })
    ).assertSuccess({});
  });

  it("normalizes // and /./ in an absolute path", async () => {
    (await run("Read", { file_path: `${repo}//src/./a.ts` })).assertSuccess({});
  });

  it("does not let an allow pattern override a symlink that leaves its directory", async () => {
    const allowed = join(base, "allowed");
    mkdirSync(allowed);
    symlinkSync(outside, join(allowed, "sym"));
    writeFileSync(
      join(home, ".claude", "settings.json"),
      JSON.stringify({ permissions: { allow: [`Edit(${allowed}/**)`] } }),
    );
    (
      await run("Write", { file_path: join(allowed, "ok.txt"), content: "x" })
    ).assertSuccess({});
    const ctx = await run("Write", {
      file_path: join(allowed, "sym", "x"),
      content: "x",
    });
    ctx.assertDeny();
    ok(reasonOf(ctx).includes("denied-form=physical"));
  });

  it("accepts an additional directory that is itself a symlink", async () => {
    const real = join(base, "extra-real");
    mkdirSync(real);
    symlinkSync(real, join(base, "extra"));
    writeFileSync(
      join(home, ".claude", "settings.json"),
      JSON.stringify({ additionalDirectories: [join(base, "extra")] }),
    );
    (await run("Read", { file_path: join(base, "extra", "a") })).assertSuccess(
      {},
    );
  });

  it("accepts ~/.claude when it is itself a symlink", async () => {
    rmSync(join(home, ".claude"), { recursive: true });
    const real = join(base, "claude-real");
    mkdirSync(real);
    symlinkSync(real, join(home, ".claude"));
    (
      await run("Read", { file_path: join(home, ".claude", "a") })
    ).assertSuccess({});
  });

  it("maps the physical form back when the repo root is reached through a symlink", async () => {
    symlinkSync(repo, join(base, "repo-link"));
    envHelper.set("CLAUDE_TEST_REPO_ROOT", join(base, "repo-link"));
    envHelper.set("CLAUDE_TEST_CWD", join(base, "repo-link", "src"));
    (
      await run("Read", { file_path: join(base, "repo-link", "src", "a.ts") })
    ).assertSuccess({});
    (await run("Read", { file_path: "../README.md" })).assertSuccess({});
  });

  it("matches a ~ allow pattern when HOME itself is a symlink", async () => {
    symlinkSync(home, join(base, "home-link"));
    envHelper.set("HOME", join(base, "home-link"));
    mkdirSync(join(home, "foo"));
    writeFileSync(
      join(home, ".claude", "settings.json"),
      JSON.stringify({ permissions: { allow: ["Edit(~/foo/**)"] } }),
    );
    (
      await run("Write", {
        file_path: join(base, "home-link", "foo", "x"),
        content: "x",
      })
    ).assertSuccess({});
  });
});
```

(2) `describe("temp roots (HOME isolated)", …)` に足す（`H` と `TMP` は同じ describe の既存のもの）:

```ts
it("should deny a symlink under /tmp that points outside even with Edit(/tmp/**)", async () => {
  mkdirSync(join(H, ".claude"), { recursive: true });
  writeFileSync(
    join(H, ".claude", "settings.json"),
    JSON.stringify({ permissions: { allow: ["Edit(/tmp/**)"] } }),
  );
  mkdirSync(join(process.cwd(), ".tmp"), { recursive: true });
  const dir = mkdtempSync(join(TMP, "fag-sym-"));
  const outsideTmp = mkdtempSync(join(process.cwd(), ".tmp", "fag-out-"));
  try {
    symlinkSync(outsideTmp, join(dir, "sym"));
    const hook = fileAccessGuardHook;
    const context = createPreToolUseContextFor(hook, "Write", {
      file_path: join(dir, "sym", "x"),
      content: "x",
    });
    await invokeRun(hook, context);
    context.assertDeny();
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(outsideTmp, { recursive: true, force: true });
  }
});

it("should not treat TMPDIR=/run/user/1000 as a temp root", async () => {
  envHelper.set("TMPDIR", "/run/user/1000");
  const hook = fileAccessGuardHook;
  const context = createPreToolUseContextFor(hook, "Write", {
    file_path: "/run/user/1000/x",
    content: "x",
  });
  await invokeRun(hook, context);
  context.assertDeny();
});

it("should keep denying /var/tmp (the safe-path entry is unreachable)", async () => {
  const hook = fileAccessGuardHook;
  const context = createPreToolUseContextFor(hook, "Write", {
    file_path: "/var/tmp/x",
    content: "x",
  });
  await invokeRun(hook, context);
  context.assertDeny();
});
```

(3) ファイルの末尾に、`judge` を直接呼ぶ describe を足す。import に `judge` と `type JudgeContext`（`../../implementations/file-access-guard.ts`）を足す:

```ts
describe("judge: the system-directory deny list", () => {
  let base = "";
  beforeEach(() => {
    mkdirSync(join(process.cwd(), ".tmp"), { recursive: true });
    base = realpathSync(mkdtempSync(join(process.cwd(), ".tmp", "fag-sys-")));
    mkdirSync(join(base, "sys-real"));
    symlinkSync(join(base, "sys-real"), join(base, "sys-link"));
  });
  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  const ctxWith = (over: Partial<JudgeContext>): JudgeContext => ({
    category: "read",
    allowPatterns: [],
    repoRoot: "/nonexistent/repo",
    homeDir: "/nonexistent/home",
    additionalDirs: [],
    tempRoots: [],
    workflowDirRoots: [],
    systemPaths: [],
    caseInsensitive: false,
    cwdPhysical: undefined,
    ...over,
  });

  it("denies the real location of a system directory that is a symlink", () => {
    const ctx = ctxWith({
      systemPaths: [join(base, "sys-link")],
      allowPatterns: [`Read(${base}/**)`],
    });
    const form = join(base, "sys-real", "x");
    deepStrictEqual(judge(form, ctx, true).step, "2-system");
    deepStrictEqual(judge(form, ctx, true).allowed, false);
    // The lexical judgement does not resolve the list, so it reaches step 5.
    deepStrictEqual(judge(form, ctx, false).step, "5-pattern");
  });

  it("compares the deny list case-insensitively when asked to", () => {
    const ctx = ctxWith({ systemPaths: ["/etc"], caseInsensitive: true });
    deepStrictEqual(judge("/ETC/x", ctx, false).step, "2-system");
    deepStrictEqual(
      judge("/ETC/x", ctxWith({ systemPaths: ["/etc"] }), false).step,
      "default",
    );
  });
});
```

- [ ] **Step 2: 実行して失敗を確認**

実行: `TEST home/dot_claude/hooks/tests/unit/file-access-guard.test.ts`
期待: (3) の 2 件は、T4 の `judge` が 3 つ目の引数を見ないので期待値の不一致で FAIL。(1)(2) のうち次の 13 件が FAIL し、残りの 12 件は今も PASS する（退行の検出用）:

- `denies an absolute path with .. even when it stays inside the repo`
- `denies an absolute path with .. that leaves the repo`（今の step 1 は生の文字列を見るので allow。research 3.3）
- `denies a relative path with .. after a name`
- `denies a symlink in the repo that points outside`
- `denies a relative path through a symlink that points outside`
- `denies a symlink in the repo that points into a system directory`
- `denies a symlink under ~/.claude that points outside`
- `denies a dangling symlink with an unresolvable code`
- `does not let an allow pattern override a symlink that leaves its directory`
- `allows a symlink under a temp root that points into the repo`（今は `isWithinTempRoots` が物理の位置を一時ディレクトリの外と見て落とし、字句の形はどのルートにも当たらないので deny）
- `denies NotebookEdit through a symlink that points outside`
- `denies a relative path when the working directory cannot be resolved`（今は `resolve(cwd, path)` の字句の形が repo の配下なので allow）
- `should deny a symlink under /tmp that points outside even with Edit(/tmp/**)`

今も PASS する 12 件のうち、symlink を含むもの（`matches a ~ allow pattern when HOME itself is a symlink`、`accepts ~/.claude when it is itself a symlink`、`accepts an additional directory that is itself a symlink`、`maps the physical form back when the repo root is reached through a symlink`、`allows a symlink in the repo that points inside the repo`）は、今の実装が symlink を解決せずに文字列だけで通しているために PASS している。物理の形の判定を入れた後も PASS し続けることを確かめるのが目的。

この一覧と実際の結果が食い違ったら、先へ進む前に、食い違った件の今の実装での経路をたどって理由を書き出す。

- [ ] **Step 3: 実装**

import に足す: `posix`（`node:path`）、`checkParentSegments`、`errnoOf`、`resolvePhysicalPath`（`../lib/path-containment.ts`）。

`JudgeContext` に 1 欄足す:

```ts
cwdPhysical: string | undefined; // resolvePhysicalPath(CLAUDE_TEST_CWD || process.cwd()), undefined when it cannot be resolved
```

hook の本体で `cwdPhysical` を 1 回求める。`resolvePhysicalPath(process.env.CLAUDE_TEST_CWD || process.cwd())` が `ok` ならその `path`、`ok` でなければ `undefined` にする。`ctx.additionalDirs` は、`/` で始まる値は `resolve(addDir)`、そうでない値は `cwdPhysical` があれば `resolve(cwdPhysical, addDir)`、無ければ捨てる。

補助の関数（`file-access-guard.ts` の中）:

```ts
function stripTrailingSlash(p: string): string {
  return p.length > 1 && p.endsWith("/") ? p.slice(0, -1) : p;
}

// No cache: one invocation judges a handful of paths, and module-level state
// would leak between tests that rebuild symlinks under the same name.
function realpathOrUndefined(p: string): string | undefined {
  const resolved = resolvePhysicalPath(p);
  return resolved.ok ? resolved.path : undefined;
}

/** Rewrites a realpath(HOME) / realpath(repoRoot) prefix to the written root. */
function mapToWrittenRoots(form: string, ctx: JudgeContext): string {
  let best: { real: string; written: string } | undefined;
  // repoRoot first, so that it wins when both prefixes have the same length.
  for (const written of [ctx.repoRoot, ctx.homeDir]) {
    const real = realpathOrUndefined(written);
    if (real === undefined || real === written || !isUnderRoot(form, real))
      continue;
    if (best === undefined || real.length > best.real.length)
      best = { real, written };
  }
  return best === undefined
    ? form
    : best.written + form.slice(best.real.length);
}

interface DenyFields {
  message: string;
  lexical: string;
  physical?: string;
  unresolvable?: string;
  form?: "lexical" | "physical";
  step: string;
}

function deny(fields: DenyFields): PathValidationResult;
```

`deny` は次の行をこの順に改行でつないで `reason` にし、`{ isAllowed: false, resolvedPath: fields.physical ?? fields.lexical, reason }` を返す:

```
<fields.message>
lexical=<fields.lexical>
physical=<fields.physical>            （fields.physical があるとき）
unresolvable=<fields.unresolvable>    （fields.unresolvable があるとき）
denied-form=<fields.form>             （fields.form があるとき）
step=<fields.step>
hint: <1 行>                          （下の表に当たるとき）
```

| 条件                           | hint                                                                                                                             |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| `form === "physical"`          | `the path resolves through a symlink to <physical>; to allow it, add that location to additionalDirectories or an allow pattern` |
| `unresolvable === "EDANGLING"` | `the path is a symlink whose target does not exist; create the target or remove the link`                                        |
| `unresolvable === "ELOOP"`     | `the path goes through a symlink loop; remove the loop`                                                                          |
| `unresolvable === "EACCES"`    | `a directory on the path cannot be read; check its permissions`                                                                  |

`judge` に 3 つ目の引数 `physical: boolean` を足す。変える点:

- step 1.5: `ctx.tempRoots.some((root) => isUnderRoot(form, root))` → `{ allowed: true, step: "1.5-temp" }`（`collectTempRoots` が書かれた形と realpath の形の両方を返すので、`physical` によらず同じ照合でよい）
- step 1.6: `ctx.workflowDirRoots.some((root) => isUnderRoot(form, root))` → `"1.6-workflow"`
- step 2: `ctx.systemPaths` の各値 `s` について、候補を `physical ? [s, realpathOrUndefined(s)] : [s]` とする（`undefined` は捨てる。realpath を求められなくても、書かれた値は必ず残る）。`ctx.caseInsensitive` が true なら `form` と候補を小文字にしてから比べる。候補のどれかについて `form.startsWith(`${候補}/`)` なら `{ allowed: false, step: "2-system", reason: 今の文言 }`
- step 3（`join(ctx.homeDir, ".claude")` と `/var/tmp`）と step 4（`ctx.additionalDirs`）: 各ルート `r` について、候補を `physical ? [r, realpathOrUndefined(r)] : [r]` とし、候補のどれかについて `isUnderRoot(form, 候補)` なら当たり
- step 5、step 6、既定の拒否は T4 のまま

`validatePath`:

```ts
function validatePath(path: string, ctx: JudgeContext): PathValidationResult {
  try {
    // 1. `..`
    const parent = checkParentSegments(path);
    if (!parent.ok) {
      return deny({
        message:
          parent.kind === "absolute"
            ? "An absolute path may not contain a .. segment. Write the path without .."
            : "A relative path may only start with .. segments. Collapse the .. or use an absolute path without ..",
        lexical: path,
        step: "parent-segment",
      });
    }

    // 2. lexical and physical forms
    const isAbsolute = path.startsWith("/");
    let lexical: string;
    if (isAbsolute) {
      lexical = stripTrailingSlash(posix.normalize(path));
    } else {
      if (ctx.cwdPhysical === undefined) {
        return deny({
          message: "The working directory cannot be resolved",
          lexical: path,
          unresolvable: "ECWD",
          step: "cwd",
        });
      }
      lexical = resolve(ctx.cwdPhysical, path);
    }
    const physical = resolvePhysicalPath(lexical);
    if (!physical.ok) {
      return deny({
        message:
          "The path cannot be resolved, so where it lands cannot be checked",
        lexical,
        unresolvable: physical.code,
        step: "resolve",
      });
    }

    // 3. map realpath(HOME) / realpath(repoRoot) prefixes back to the written form.
    // A relative path was resolved from the physical cwd, so it gets the same mapping.
    const physicalForm = mapToWrittenRoots(physical.path, ctx);
    const lexicalForm = isAbsolute ? lexical : mapToWrittenRoots(lexical, ctx);

    // 4-5. both forms must be allowed. The physical judgement is never skipped:
    // only it compares the deny list and the roots in their realpath form.
    const lexicalJudgement = judge(lexicalForm, ctx, false);
    if (!lexicalJudgement.allowed) {
      return deny({
        message: lexicalJudgement.reason ?? "Access is not allowed",
        lexical: lexicalForm,
        physical: physicalForm,
        form: "lexical",
        step: lexicalJudgement.step,
      });
    }
    const physicalJudgement = judge(physicalForm, ctx, true);
    if (!physicalJudgement.allowed) {
      return deny({
        message: physicalJudgement.reason ?? "Access is not allowed",
        lexical: lexicalForm,
        physical: physicalForm,
        form: "physical",
        step: physicalJudgement.step,
      });
    }
    return { isAllowed: true, resolvedPath: lexicalForm };
  } catch (error) {
    return deny({
      message: "The path could not be checked",
      lexical: path,
      unresolvable: errnoOf(error),
      step: "exception",
    });
  }
}
```

あわせて:

- T4 で `validatePath` の中に残した step 1.5 / 1.6 の呼び出しと `rawAbs` を消す（`judge` に入った）
- `isWithinTempRoots`（export。既存の単体テストが使う）は、名前とシグネチャ `(absTarget, roots, realpath, lstat)` を保つ。`/` で始まらない、または `hasParentSegment(absTarget)` なら `false`。それ以外は `resolvePhysicalPath(absTarget, { realpath, lstat })` を求め、`ok` で、`absTarget` と解決後のパスの両方が `roots` のどれかの配下（`isUnderRoot`）なら `true`
- 使わなくなる `resolvePath` と `isMissingPathError` を消す
- deny の応答は今の `Access denied: ${validation.reason}\nPath: …\nRepository: …` の形を保つ。外側の catch（:97-101）は残す

- [ ] **Step 4: 実行して通過を確認**

実行: `TEST home/dot_claude/hooks/tests/unit/file-access-guard.test.ts`、`ENTRY`、`bun run typecheck`
期待: 全件 PASS（T4 の後の 79 件 + このタスクの 27 件 = 106 件。27 件の内訳は (1) 22 件、(2) 3 件、(3) 2 件）。

`isWithinTempRoots` の既存の単体テストが落ちた場合の手順: 落ちたテスト名と入力を書き出す。原因が「今の実装は `ENOTDIR` を存在しないパスとして上へ遡るが、spec K3 は `ENOTDIR` を解決できない扱いにする」ことであれば、そのテストの期待値を `false` に直し、コミットメッセージの `decision:` 行に、テスト名と、spec K3 に合わせて期待値を変えたことを書く。原因がそれ以外なら実装の誤りなので、テストは変えずに実装を直す

- [ ] **Step 5: コミット**

```bash
git add home/dot_claude/hooks/implementations/file-access-guard.ts home/dot_claude/hooks/tests/unit/file-access-guard.test.ts
git commit -m "fix(hooks): judge file access on both the lexical and the physical path"
```

### T6: permission-auto-approve と document-workflow-guard が共有の部品を使う（spec K4、K5）

**Files:**

- 編集: `home/dot_claude/hooks/implementations/permission-auto-approve.ts:390`
- 編集: `home/dot_claude/hooks/implementations/document-workflow-guard.ts:582-667`
- テスト: `home/dot_claude/hooks/tests/unit/interpreter-write-classify.test.ts`
- 参照: `home/dot_claude/hooks/implementations/document-workflow-guard.ts:611-619`（リテラルを cwd で解決しない理由。この方針は変えない）

- [ ] **Step 1: 失敗するテストを書く**

`interpreter-write-classify.test.ts` の describe の中、`denies /tmpx/e as outside /tmp` の後に足す:

```ts
it("allows a /tmp literal whose name merely contains two dots", async () => {
  const repo = createWorkflowRepo(pendingWorkflowRepo());
  envHelper.set("CLAUDE_TEST_CWD", repo);
  const ctx = createPreToolUseContextFor(hook, "Bash", {
    command: `python3 -c "open('/tmp/a..b','w')"`,
  });
  await invokeRun(hook, ctx);
  ctx.assertSuccess({});
});

it("still denies a /tmp literal with a .. segment", async () => {
  const repo = createWorkflowRepo(pendingWorkflowRepo());
  envHelper.set("CLAUDE_TEST_CWD", repo);
  const ctx = createPreToolUseContextFor(hook, "Bash", {
    command: `python3 -c "open('/tmp/../etc/x','w')"`,
  });
  await invokeRun(hook, ctx);
  ctx.assertDeny();
});
```

- [ ] **Step 2: 実行して失敗を確認**

実行: `TEST home/dot_claude/hooks/tests/unit/interpreter-write-classify.test.ts`
期待: `allows a /tmp literal whose name merely contains two dots` が FAIL（今は `includes("..")` で拒否）。もう 1 件は PASS

- [ ] **Step 3: 実装**

- `document-workflow-guard.ts`:
  - `isUnderSegmentRoot`（:582-584）を消し、`isUnderRoot` を `../lib/path-containment.ts` から import して置き換える
  - `absoluteInterpreterScratchRoots`（:595-604）の `["/tmp"]` を `collectTempRoots("", realpathSync)` に置き換える（`../lib/temp-roots.ts`）
  - `isPathWithinInterpreterScratch`（:652）の `literal.includes("..")` を `hasParentSegment(literal)` に置き換える
- `permission-auto-approve.ts:390` の `filePath.split("/").includes("..")` を `hasParentSegment(filePath)` に置き換える（`../lib/path-containment.ts`）。挙動は変わらない

- [ ] **Step 4: 実行して通過を確認**

実行: `TEST home/dot_claude/hooks/tests/unit/interpreter-write-classify.test.ts`、`TEST home/dot_claude/hooks/tests/unit/document-workflow-guard.test.ts`、`TEST home/dot_claude/hooks/tests/unit/permission-auto-approve.test.ts`、`ENTRY`、`bun run typecheck`
期待: 全件 PASS。`document-workflow-guard.test.ts` と `permission-auto-approve.test.ts` は変更なしで通る

- [ ] **Step 5: コミット**

```bash
git add home/dot_claude/hooks/implementations/document-workflow-guard.ts home/dot_claude/hooks/implementations/permission-auto-approve.ts home/dot_claude/hooks/tests/unit/interpreter-write-classify.test.ts
git commit -m "refactor(hooks): share temp roots and .. checks across guards"
```

### T7: find の開始パスの判定を直す（spec K4）

**Files:**

- 編集: `home/dot_claude/hooks/lib/pattern-matcher.ts:116-146`
- テスト: `home/dot_claude/hooks/tests/unit/pattern-matching.test.ts`
- 参照: `home/dot_claude/hooks/lib/pattern-matcher.ts:149-160`（`isSafeBuiltinCommand` が `find` を `isSafeFindCommand` に渡す）
- 参照: `spec.md` K4 の表（pattern-matcher は `collectTempRoots("", realpathSync)` と `isUnderRoot` と `hasParentSegment` を使う）

- [ ] **Step 1: 失敗するテストを書く**

`pattern-matching.test.ts` の末尾に足す。`isSafeBuiltinCommand` を import に足す（`../../lib/pattern-matcher.ts`）:

```ts
describe("find start path under temp roots", () => {
  const cases: [string, boolean][] = [
    ["find /tmp -name x", true],
    ["find /tmp/a -name x", true],
    ["find /tmpx/y -name x", false],
    ["find /tmp/../etc -name x", false],
    ["find /var/tmp/a -name x", true],
    ["find /var/tmpx -name x", false],
  ];
  for (const [command, expected] of cases) {
    it(`${command} -> ${expected}`, () => {
      strictEqual(isSafeBuiltinCommand(command), expected);
    });
  }
});
```

- [ ] **Step 2: 実行して失敗を確認**

実行: `TEST home/dot_claude/hooks/tests/unit/pattern-matching.test.ts`
期待: `find /tmpx/y`、`find /tmp/../etc`、`find /var/tmpx` の 3 件が FAIL（今は `true`）

- [ ] **Step 3: 実装**

`isSafeFindCommand` の `safeAbsolutePaths`（:128-140）のうち `/^\/tmp/` と `/^\/var\/tmp/` を消し、正規表現のループの前に次を足す。`/home/<user>` の正規表現は変えない:

```ts
if (startPath.startsWith("/")) {
  if (hasParentSegment(startPath)) {
    return false;
  }
  const tempRoots = [...collectTempRoots("", realpathSync), "/var/tmp"];
  if (tempRoots.some((root) => isUnderRoot(startPath, root))) {
    return true;
  }
}
```

import: `realpathSync`（`node:fs`）、`hasParentSegment` と `isUnderRoot`（`./path-containment.ts`）、`collectTempRoots`（`./temp-roots.ts`）。pattern-matcher はこれまでファイルシステムを読んでいない。ここで増えるのは、開始パスが絶対パスの `find` を判定するときの `realpath("/tmp")` 1 回で、`collectTempRoots` は realpath の失敗を握って literal の `/tmp` だけを返すので、失敗しても判定は続く。

- [ ] **Step 4: 実行して通過を確認**

実行: `TEST home/dot_claude/hooks/tests/unit/pattern-matching.test.ts`、`ENTRY`、`bun run typecheck`
期待: 全件 PASS

- [ ] **Step 5: コミット**

```bash
git add home/dot_claude/hooks/lib/pattern-matcher.ts home/dot_claude/hooks/tests/unit/pattern-matching.test.ts
git commit -m "fix(hooks): match the find start path against temp roots on a path boundary"
```

### T8: matcher に NotebookEdit を足す（spec K8）

**Files:**

- 編集: `home/dot_claude/.settings.hooks.json.tmpl:35`
- 参照: `home/dot_claude/.settings.hooks.json.tmpl:35-39`（file-access-guard の登録）
- 参照: `research.md` 5.1（英数字と `|` だけの matcher は完全一致の並びとして扱われる。2026-10-04 に公式ドキュメントで確認）

- [ ] **Step 1: 編集**

:35 の `"matcher": "Read|Write|Edit",` を `"matcher": "Read|Write|Edit|NotebookEdit",` にする。

- [ ] **Step 2: 描画して確認**

```bash
chezmoi execute-template < home/dot_claude/.settings.hooks.json.tmpl \
  | jq -r '.hooks.PreToolUse[] | select(any(.hooks[]; .command | test("file-access-guard"))) | .matcher'
```

期待: `Read|Write|Edit|NotebookEdit` の 1 行

- [ ] **Step 3: 全体を実行**

実行: `bun run test`、`ENTRY`、`bun run typecheck`、`bun run lint`
期待: test は fail 0。typecheck は出力なし。lint は、このプランが触っていないファイル（`read-only-command.test.ts`）の warning だけ

- [ ] **Step 4: コミット**

```bash
git add home/dot_claude/.settings.hooks.json.tmpl
git commit -m "fix(claude): run file-access-guard on NotebookEdit"
```

### T9: #241 に書くコメントの下書き

**Files:**

- 参照: `spec.md`（「提供しない体験」、Risks、K5、K6、K7）、`research.md`（5 節、6 節）

- [ ] **Step 1: 下書きを会話に出す**

repo のファイルは作らない。次の内容を、事実と推測を分けた日本語のコメントとして会話に出す:

- この PR で直したこと: 項目 1（`d6ce00a`）、項目 4（symlink）、`..` を含む絶対パスと相対パスの途中の `..` の拒否、NotebookEdit の登録、項目 2 のうち file-access-guard・document-workflow-guard・pattern-matcher の分
- 挙動が変わる点（spec R1、R2、R9）: repo の中の、外を指す symlink 経由の読み書きが止まる。allow パターンの対象のディレクトリが symlink のときは物理の形のパスでパターンを書く。repo の中にとどまる `..` 入りの絶対パスも deny になる
- file-access-guard は Bash で起動されていないこと（research 5.1、5.2 の表）。項目 3 は別の spec で扱うこと
- 項目 5 を提供しない理由と、設定の書き方（`additionalDirectories` と `Edit(<dir>/**)`）
- 提供しないもの（spec「提供しない体験」の全項目）: `..` を含む絶対パスを解決して通すこと、Bash のパスの検査、独自の `$TMPDIR`、permission-auto-approve の `/tmp` の判定の共通化（K5）、Glob と Grep の検査、dotfiles の repo での HOME 配下の読み取り（step 6b）
- 残る制限: `alwaysSafePaths` の `/var/tmp` が到達しないこと（K7）、HOME を `process.env.HOME` から取っていること、R3、R4、R6、R7（macOS の大文字と小文字。実機では未確認）
- 未確認のこと: Claude Code 本体が `file_path` を正規化してから hook に渡すか（R5）。macOS の実機での挙動

- [ ] **Step 2: ユーザーの確認を待つ**

投稿（`gh issue comment 241`）は、ユーザーが文面を確認して投稿を指示した後に行う。

## ISO 25010 具体テストケース

### セキュリティ（機密性・完全性）

- **入力**: allow に `Edit(<dir>/**)`、Write `<dir>/sym/x`（`sym` は `<dir>` の外を指す symlink）→ **期待**: deny。理由に `denied-form=physical`
- **入力**: allow に `Edit(/tmp/**)`、Write `/tmp/<d>/sym/x`（`sym` は `/tmp` の外を指す）→ **期待**: deny
- **入力**: Read `<repo>/link/a`（`link` は repo の外を指す）→ **期待**: deny。理由に `physical=<外のパス>/a`
- **入力**: Read `<repo>/etc-link/passwd`（`etc-link` は `/etc` を指す）→ **期待**: deny。理由に `step=2-system` と `denied-form=physical`
- **入力**: Read `<home>/.claude/sym/a`（`sym` は外を指す）→ **期待**: deny。理由に `denied-form=physical`
- **入力**: `judge("<base>/sys-real/x", systemPaths=["<base>/sys-link"], allow=Read(<base>/**), physical=true)`（`sys-link` は `sys-real` を指す）→ **期待**: `step` が `2-system`、`allowed` が `false`
- **入力**: `judge("/ETC/x", systemPaths=["/etc"], caseInsensitive=true)` → **期待**: `step` が `2-system`
- **入力**: Read `<repo>/../outside/a` → **期待**: deny
- **入力**: Read `<repo>/src/../README.md` → **期待**: deny。理由に `step=parent-segment`
- **入力**: Read `a/../b`（相対）→ **期待**: deny。理由に `step=parent-segment`
- **入力**: NotebookEdit `notebook_path=/home/user/other/n.ipynb`（repoRoot は `/home/user/project`）→ **期待**: deny
- **入力**: NotebookEdit `notebook_path=<repo>/nb-link/n.ipynb`（`nb-link` は repo の外を指す）→ **期待**: deny。理由に `denied-form=physical`
- **入力**: Write `/run/user/1000/x`、`TMPDIR=/run/user/1000` → **期待**: deny
- **入力**: Write `/var/tmp/x` → **期待**: deny
- **入力**: `find /tmpx/y -name x`、`find /tmp/../etc -name x`、`find /var/tmpx -name x` → **期待**: `isSafeBuiltinCommand` が `false`

### 機能適合性（正確性）

- **入力**: Read `../README.md`、cwd は `<repo>/src` → **期待**: allow
- **入力**: Read `./../README.md`、cwd は `<repo>/src` → **期待**: allow
- **入力**: Write `<repo>/new/dir/f.ts`（存在しない）→ **期待**: allow
- **入力**: Read `<repo>//src/./a.ts` → **期待**: allow
- **入力**: Read `<repo>/alias/a.ts`（`alias` は `<repo>/src` を指す）→ **期待**: allow
- **入力**: Read `/tmp/<d>/into-repo/a.ts`（`into-repo` は `<repo>/src` を指す）→ **期待**: allow（字句の形は一時ディレクトリ、物理の形は repo で、別々のルートで許可される）
- **入力**: additionalDirectories に `<base>/extra`（`<base>/extra-real` への symlink）、Read `<base>/extra/a` → **期待**: allow
- **入力**: `<home>/.claude` が `<base>/claude-real` への symlink、Read `<home>/.claude/a` → **期待**: allow
- **入力**: `CLAUDE_TEST_REPO_ROOT=<base>/repo-link`（repo への symlink）、Read `<base>/repo-link/src/a.ts` と Read `../README.md` → **期待**: どちらも allow
- **入力**: `HOME=<base>/home-link`（home への symlink）、allow に `Edit(~/foo/**)`、Write `<base>/home-link/foo/x` → **期待**: allow
- **入力**: NotebookEdit `notebook_path=/home/user/project/n.ipynb`（repoRoot は `/home/user/project`）→ **期待**: allow
- **入力**: Glob `path=/home/user/extra`、additionalDirectories に `/home/user/extra` → **期待**: allow
- **入力**: `python3 -c "open('/tmp/a..b','w')"`（gate が閉じている）→ **期待**: document-workflow-guard が allow
- **入力**: `find /tmp/a -name x`、`find /var/tmp/a -name x` → **期待**: `isSafeBuiltinCommand` が `true`
- **入力**: 既存の `file-access-guard.test.ts` の 75 件 → **期待**: 期待値を変えずに PASS（T5 の Step 4 に書いた `ENOTDIR` の件が出た場合を除く）

### 信頼性（障害許容性）

- **入力**: Write `<repo>/dangling`（指す先が無い symlink）→ **期待**: deny。理由に `unresolvable=EDANGLING` と、`create the target or remove the link` という hint
- **入力**: `resolvePhysicalPath("<base>/loop/x")`（`loop` は自分を指す symlink）→ **期待**: `{ ok: false, code: "ELOOP" }`
- **入力**: `resolvePhysicalPath("/x/y", { realpath が EACCES を投げる })` → **期待**: `{ ok: false, code: "EACCES" }`。例外は出ない
- **入力**: `resolvePhysicalPath("/x/y", { realpath が ENOENT、lstat が EACCES を投げる })` → **期待**: `{ ok: false, code: "EACCES" }`
- **入力**: `resolvePhysicalPath("/a\0b")` → **期待**: `{ ok: false, code: "EINVAL" }`
- **入力**: `resolvePhysicalPath("/x/file/y", { realpath が ENOTDIR を投げる })` → **期待**: `{ ok: false, code: "ENOTDIR" }`
- **入力**: Read `a.ts`、`CLAUDE_TEST_CWD` は指す先が無い symlink → **期待**: deny。理由に `step=cwd`

### 保守性（モジュール性）

- **操作**: `ENTRY` を実行 → **期待**: file-access-guard、permission-auto-approve、document-workflow-guard、auto-approve の 4 つの入口の import が、node と bun の両方で成功
- **操作**: `git grep -n "isUnderSegmentRoot" home/dot_claude/hooks` → **期待**: 0 件
- **操作**: `git grep -n "entryExists" home/dot_claude/hooks` → **期待**: 0 件（遡るループが `resolvePhysicalPath` の 1 本になっている）

## Approval

- Plan Status: complete
- Review Status: pass
- Approval Status: approved

## Reviewer Outputs (Round 1)

### logic-validator

- verdict: needs-work
- 主指摘: T5 の「修正前に FAIL する」一覧に 1 件漏れがある（`..` で repo の外に出る絶対パスは今 allow）。既存テストは 80 件ではなく 75 件。T5 の擬似コードに定義の無い名前（`errnoOf`、`realpathOrUndefined`、`deny` の型）がある。`/tmp` の symlink のテストが `.tmp` を作っていない。

### scope-justification-reviewer

- verdict: needs-work
- 主指摘: spec が「テストで固定する」とした項目のうち、HOME 自体が symlink の場合と、NotebookEdit の repo の中への書き込みのテストが無い。入口の確認が node の import だけで、spec R8 の bun での起動を見ていない。

### architecture-boundary-analyzer

- verdict: needs-work
- 主指摘: `resolveWithMissingTail` と `resolvePhysicalPath` が同じ「存在する祖先まで遡る」ループを 2 本持つ。載せ替えて 1 本にし、挙動の差を意図した変更として書く。`collectTempRoots` の再 export は置かず、テストの import 先を直す。循環 import は無い。

### security-vulnerability-analyzer

- verdict: needs-work
- 主指摘: 字句の形と物理の形が同じ文字列のときに物理の形の判定を省くのは安全でない。物理の形の判定だけが拒否の一覧の realpath を照合するため（high）。システムディレクトリを指す symlink と、`~/.claude` の配下の symlink が外を指す場合のテストが無い。

<!-- auto-review: pending -->
<!-- intent-triage: pending -->

<!-- parent-spec-hash は plan-review-automation hook が auto-review marker 生成時に挿入する。手で編集しない。 -->

## Reviewer Outputs (Round 2)

### logic-validator

- verdict: needs-work
- 主指摘: T5 で足すテストは 23 件ではなく 24 件（19 + 3 + 2）で、合計は 103 件。「修正前に FAIL する」一覧の `matches a ~ allow pattern when HOME itself is a symlink` は今の実装で PASS するので、PASS の側へ移す。T3 の載せ替えで既存の呼び出し元の結果は変わらない（確認済み）。

### scope-justification-reviewer

- verdict: pass
- 主指摘: Round 1 の指摘は解消。T3 の `resolveWithMissingTail` の挙動の変更（lstat が ENOENT 以外で失敗したとき null）は spec が明示していない fail-closed 向きの変更なので、コミットメッセージと承認の依頼の要約に載せる（軽微）。

### architecture-boundary-analyzer

- verdict: needs-work
- 主指摘: モジュールの先頭の `realpathCache` は、同じプロセスで繰り返し判定するテストで前の結果を拾う（`~/.claude` の symlink を張り直すテストなど）。キャッシュを削り、`realpathOrUndefined` が `resolvePhysicalPath` を直接呼ぶ形にする。`judge` と `JudgeContext` の export は妥当。

### security-vulnerability-analyzer

- verdict: pass
- 主指摘: Round 1 の指摘は解消。字句の形と物理の形が別々のルートで許可される場合と、symlink 経由の NotebookEdit、cwd を解決できない場合のテストが無い。件数は 103 件が正しい（いずれも low）。

<!-- auto-review: verdict=needs-work; hash=5b40eef006444ca278be96a3f773f0f2316f31e5254c54d99d6c392c23f422b7; design-hash=caa854e075bdad946fd8e250244a4ebcf278c60ebb0bb20140cf7b8102e95be9; round=1; parent-spec-hash=51ab752781c3c37442efe8064f0adb4e7dc132c409d0fe68fb20186704b14171; at=2026-10-04T12:17:40.155Z; reviewers=logic-validator+scope-justification-reviewer+architecture-boundary-analyzer+security-vulnerability-analyzer -->
<!-- intent-triage: adopted=21; excluded=0; at=2026-10-04T12:17:40.174Z -->

## Reviewer Outputs (Round 3)

### logic-validator

- verdict: pass
- 主指摘: 件数（T5 で 27 件、合計 106 件。FAIL 13 件、PASS 12 件）は合っている。足した 3 件の「今は FAIL する」理由と、変更後に通る経路は実コードからたどれる。`ctxWith` に `cwdPhysical` を足す、`cwdPhysical` を `undefined` にする条件を書く（いずれも軽微。反映済み）。

### architecture-boundary-analyzer

- verdict: pass
- 主指摘: Round 2 の指摘は解消。`realpathCache` は消え、モジュールの先頭に可変の状態は残っていない。同じルートを 1 回の判定で何度か解決する形は、対象が設定の値だけなので問題にならない。

### scope-justification-reviewer

- verdict: pass (carried from Round 2)
- 主指摘: Round 2 で pass、再実行なし

### security-vulnerability-analyzer

- verdict: pass (carried from Round 2)
- 主指摘: Round 2 で pass、再実行なし

<!-- auto-review: verdict=needs-work; hash=c51df16afef1ded2443faf0ef342d9c3d24ba479e41e1f15bb12338e2df4d9a5; design-hash=d7ffea7ed4ddb7623d97fd970630f67df8fbeca99e4f52bd5b57da9212dc0f15; round=2; parent-spec-hash=51ab752781c3c37442efe8064f0adb4e7dc132c409d0fe68fb20186704b14171; at=2026-10-04T12:24:05.369Z; reviewers=logic-validator+scope-justification-reviewer+architecture-boundary-analyzer+security-vulnerability-analyzer -->
<!-- intent-triage: adopted=12; excluded=0; at=2026-10-04T12:24:05.389Z -->

<!-- auto-review: verdict=pass; hash=bd707f7d2c631bd3e9a818dc6fbdc09af1e0f5f6c6c88db46092b9d7d71e291e; design-hash=df02c1c88b4b21fcdc092663274e60a309ad628e87b356876d5153c9f28afb9c; round=3; parent-spec-hash=51ab752781c3c37442efe8064f0adb4e7dc132c409d0fe68fb20186704b14171; at=2026-10-04T12:26:21.760Z; reviewers=logic-validator+scope-justification-reviewer+architecture-boundary-analyzer+security-vulnerability-analyzer -->
<!-- intent-triage: adopted=3; excluded=0; at=2026-10-04T12:26:21.779Z -->
