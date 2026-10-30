import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, it } from "node:test";
import {
  formatMarkerFailure,
  judgeMarker,
  reserveMarker,
} from "../../lib/worktree-marker.ts";
import { currentRoot } from "../../lib/worktree-locations.ts";

type Fixture = {
  base: string;
  commonDir: string;
  home: string;
  root: string;
};

type ChildResult = {
  code: number | null;
  stdout: string;
  stderr: string;
};

const tempPaths: string[] = [];
after(() => {
  for (const path of tempPaths) rmSync(path, { recursive: true, force: true });
});

function fixture(prefix: string): Fixture {
  const base = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  tempPaths.push(base);
  const commonDir = join(base, "repo", "proj", ".git");
  const home = join(base, "home");
  mkdirSync(commonDir, { recursive: true });
  writeFileSync(join(commonDir, "HEAD"), "ref: refs/heads/main\n");
  mkdirSync(join(commonDir, "objects"));
  return { base, commonDir, home, root: currentRoot(commonDir, home) };
}

function makeOtherCommonDir(base: string): string {
  const commonDir = join(base, "other", "proj", ".git");
  mkdirSync(commonDir, { recursive: true });
  writeFileSync(join(commonDir, "HEAD"), "ref: refs/heads/main\n");
  mkdirSync(join(commonDir, "objects"));
  return commonDir;
}

function reserveInChild(commonDir: string, home: string): Promise<ChildResult> {
  const modulePath = fileURLToPath(
    new URL("../../lib/worktree-marker.ts", import.meta.url),
  );
  const childCode = [
    `import { reserveMarker } from ${JSON.stringify(modulePath)};`,
    `const result = reserveMarker(process.env.WORKTREE_COMMON_DIR ?? "", process.env.WORKTREE_HOME ?? "");`,
    `process.stdout.write(result.kind);`,
    `if (result.kind !== "ok-same") process.exitCode = 1;`,
  ].join("\n");
  const child = spawn(
    process.execPath,
    ["--input-type=module", "-e", childCode],
    {
      env: {
        ...process.env,
        WORKTREE_COMMON_DIR: commonDir,
        WORKTREE_HOME: home,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout, stderr }));
  });
}

describe("worktree marker reservation", () => {
  it("creates the marker through an exclusive temporary file and hard link", () => {
    const state = fixture("worktree-marker-create-");
    const decision = reserveMarker(state.commonDir, state.home);
    assert.deepEqual(decision, { kind: "ok-same" });
    assert.equal(
      readFileSync(join(state.root, ".common-dir"), "utf8"),
      `${realpathSync(state.commonDir)}\n`,
    );
    assert.deepEqual(
      readdirSync(state.root).filter((name) =>
        name.startsWith(".common-dir.tmp."),
      ),
      [],
    );
  });

  it("retries an occupied temporary name without changing its contents", () => {
    const state = fixture("worktree-marker-collision-");
    mkdirSync(state.root, { recursive: true });
    const occupied = join(
      state.root,
      `.common-dir.tmp.${process.pid}.occupied`,
    );
    writeFileSync(occupied, "keep this file\n");
    let attempt = 0;
    const decision = reserveMarker(state.commonDir, state.home, state.root, {
      randomSuffix: () => (attempt++ === 0 ? "occupied" : "fresh"),
    });
    assert.deepEqual(decision, { kind: "ok-same" });
    assert.equal(readFileSync(occupied, "utf8"), "keep this file\n");
    assert.equal(
      readdirSync(state.root).some((name) => name.endsWith(".fresh")),
      false,
    );
  });

  it("lets only one of two different common dirs reserve a shared root", async () => {
    for (let iteration = 0; iteration < 20; iteration += 1) {
      const state = fixture(`worktree-marker-race-${iteration}-`);
      const otherCommonDir = makeOtherCommonDir(state.base);
      const [left, right] = await Promise.all([
        reserveInChild(state.commonDir, state.home),
        reserveInChild(otherCommonDir, state.home),
      ]);
      const winner =
        left.code === 0
          ? state.commonDir
          : right.code === 0
            ? otherCommonDir
            : "";
      assert.notEqual(
        winner,
        "",
        `iteration ${iteration}: one reservation succeeds`,
      );
      assert.equal(
        Number(left.code === 0) + Number(right.code === 0),
        1,
        `iteration ${iteration}: exactly one reservation succeeds`,
      );
      const failed = left.code === 0 ? right : left;
      assert.equal(
        failed.stdout,
        "conflict",
        `iteration ${iteration}: loser conflicts`,
      );
      assert.equal(
        readFileSync(join(state.root, ".common-dir"), "utf8"),
        `${realpathSync(winner)}\n`,
        `iteration ${iteration}: marker keeps the winner`,
      );
      assert.deepEqual(
        readdirSync(state.root).filter((name) =>
          name.startsWith(".common-dir.tmp."),
        ),
        [],
        `iteration ${iteration}: temporary files are removed`,
      );
    }
  });

  it("refuses a symlinked worktrees root without creating anything outside", () => {
    const state = fixture("worktree-marker-root-link-");
    const outside = join(state.base, "outside");
    mkdirSync(state.home);
    mkdirSync(outside);
    symlinkSync(outside, join(state.home, "worktrees"));
    const decision = reserveMarker(state.commonDir, state.home);
    assert.equal(decision.kind, "unsafe-path");
    assert.deepEqual(readdirSync(outside), []);
  });

  it("refuses a symlinked nested branch ancestor", () => {
    const state = fixture("worktree-marker-target-link-");
    const outside = join(state.base, "outside");
    mkdirSync(outside);
    mkdirSync(state.root, { recursive: true });
    symlinkSync(outside, join(state.root, "feat"));
    const decision = reserveMarker(
      state.commonDir,
      state.home,
      join(state.root, "feat", "x"),
    );
    assert.equal(decision.kind, "unsafe-path");
    assert.deepEqual(readdirSync(outside), []);
    assert.equal(readdirSync(state.root).includes(".common-dir"), false);
  });

  it("does not read or change an external file reached through a marker symlink", () => {
    const state = fixture("worktree-marker-marker-link-");
    const outside = join(state.base, "outside.txt");
    mkdirSync(state.root, { recursive: true });
    writeFileSync(outside, "outside marker target\n");
    symlinkSync(outside, join(state.root, ".common-dir"));
    assert.deepEqual(judgeMarker(state.commonDir, state.home), {
      kind: "unmarked",
      entries: 1,
    });
    assert.deepEqual(reserveMarker(state.commonDir, state.home), {
      kind: "unmarked",
      entries: 1,
    });
    assert.equal(readFileSync(outside, "utf8"), "outside marker target\n");
  });

  it("does not write through a temporary-name symlink", () => {
    const state = fixture("worktree-marker-temp-link-");
    const outside = join(state.base, "outside.txt");
    mkdirSync(state.root, { recursive: true });
    writeFileSync(outside, "preserve this\n");
    symlinkSync(
      outside,
      join(state.root, `.common-dir.tmp.${process.pid}.collision`),
    );
    const decision = reserveMarker(state.commonDir, state.home);
    assert.equal(decision.kind, "unmarked");
    assert.equal(readFileSync(outside, "utf8"), "preserve this\n");
    assert.equal(
      readdirSync(state.root).includes(
        `.common-dir.tmp.${process.pid}.collision`,
      ),
      true,
    );
  });

  it("reports a safe conflict path and omits invalid marker contents", async () => {
    const state = fixture("worktree-marker-conflict-");
    const otherCommonDir = makeOtherCommonDir(state.base);
    mkdirSync(state.root, { recursive: true });
    writeFileSync(
      join(state.root, ".common-dir"),
      `${realpathSync(otherCommonDir)}\n`,
    );
    const conflict = reserveMarker(state.commonDir, state.home);
    assert.deepEqual(conflict, {
      kind: "conflict",
      path: realpathSync(otherCommonDir),
    });
    assert.match(
      formatMarkerFailure(conflict, state.commonDir, state.home),
      new RegExp(
        realpathSync(otherCommonDir).replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"),
        "u",
      ),
    );

    writeFileSync(join(state.root, ".common-dir"), "token=abc\n");
    const stale = reserveMarker(state.commonDir, state.home);
    assert.equal(stale.kind, "stale");
    assert.doesNotMatch(
      formatMarkerFailure(stale, state.commonDir, state.home),
      /token=abc/u,
    );

    const childResult = await reserveInChild(state.commonDir, state.home);
    assert.equal(childResult.code, 1);
    assert.doesNotMatch(childResult.stderr, /token=abc/u);
    assert.equal(childResult.stderr.trimEnd().split("\n").length, 1);
    assert.match(childResult.stderr, /Stale marker content is invalid/u);
  });
});
