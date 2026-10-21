import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { describe, it } from "node:test";
import {
  ASSERT1_HINT,
  IMPL_PREFIX,
  REPO_ROOT,
  namesFromLsFiles,
  raw,
  referencedNames,
  symmetricDiff,
} from "../support/hook-target-drift-fixture.ts";

function lsFilesOutput(): string {
  return execFileSync(
    "git",
    [
      "-c",
      "core.quotePath=false",
      "ls-files",
      "--cached",
      "--others",
      "--exclude-standard",
      "--",
      IMPL_PREFIX,
    ],
    { cwd: REPO_ROOT, encoding: "utf-8" },
  );
}

describe("hook target drift（実リポジトリ）", () => {
  it("assert 1: 参照集合と実体集合が双方向一致する", () => {
    const impls = namesFromLsFiles(lsFilesOutput(), (p) =>
      existsSync(`${REPO_ROOT}${p}`),
    );
    // 両方向を 1 つの deepStrictEqual で見る。逐次 assert にすると
    // リネーム未追随（両方向が同時に立つ）で片方しか表示されない。
    assert.deepStrictEqual(
      symmetricDiff(referencedNames(raw), impls),
      { onlyRefs: [], onlyImpls: [] },
      ASSERT1_HINT,
    );
  });
});
