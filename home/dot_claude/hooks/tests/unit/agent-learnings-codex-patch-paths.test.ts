import { deepStrictEqual } from "node:assert";
import { describe, it } from "node:test";
import { patchTargetPaths } from "../../lib/agent-learnings/codex/patch-paths.ts";

describe("patchTargetPaths", () => {
  it("reads the shape observed on codex-cli 0.163.0", () => {
    const patch = [
      "*** Begin Patch",
      "*** Delete File: /r/a.txt",
      "*** Add File: /r/a.txt",
      "+bye",
      "*** End Patch",
    ].join("\n");
    deepStrictEqual(patchTargetPaths(patch), ["/r/a.txt", "/r/a.txt"]);
  });
  it("returns both the source and the destination of a move", () => {
    const patch = "*** Update File: /r/a.ts\n*** Move to: /r/b.ts\n@@\n-x\n+y";
    deepStrictEqual(patchTargetPaths(patch), ["/r/a.ts", "/r/b.ts"]);
  });
  it("ignores header look-alikes inside the diff body", () => {
    const patch = [
      "+*** Update File: x",
      " *** Update File: y",
      "-*** Add File: z",
    ].join("\n");
    deepStrictEqual(patchTargetPaths(patch), []);
  });
  it("drops lines with CR, NUL, over 4096 bytes, or an empty path", () => {
    const patch = [
      "*** Update File: /r/cr.ts\r",
      "*** Update File: /r/nul\u0000.ts",
      `*** Update File: /${"a".repeat(4097)}`,
      "*** Update File: ",
      "*** Update File: /r/ok.ts",
    ].join("\n");
    deepStrictEqual(patchTargetPaths(patch), ["/r/ok.ts"]);
  });
  it("stops at 64 paths", () => {
    const patch = Array.from(
      { length: 70 },
      (_, i) => `*** Add File: /r/f${i}.ts`,
    ).join("\n");
    deepStrictEqual(patchTargetPaths(patch).length, 64);
  });
});
