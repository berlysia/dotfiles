import { deepStrictEqual } from "node:assert";
import { describe, it } from "node:test";
import { ruleNamesFor } from "../../lib/permission-rule-names.ts";

describe("ruleNamesFor", () => {
  const cases: Array<[string, string[]]> = [
    ["Edit", ["Edit"]],
    ["Write", ["Write", "Edit"]],
    ["MultiEdit", ["MultiEdit", "Edit"]],
    ["NotebookEdit", ["NotebookEdit", "Edit"]],
    ["Read", ["Read"]],
    ["Grep", ["Grep"]],
    ["Glob", ["Glob"]],
    ["Bash", ["Bash"]],
  ];
  for (const [tool, expected] of cases) {
    it(tool, () => deepStrictEqual(ruleNamesFor(tool), expected));
  }
});
