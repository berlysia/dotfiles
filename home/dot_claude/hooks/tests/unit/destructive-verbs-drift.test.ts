import { deepStrictEqual } from "node:assert";
import { describe, it } from "node:test";
import {
  FIND_DESTRUCTIVE_EXEC,
  FIND_EXEC_FLAGS as HOME_FIND_EXEC_FLAGS,
} from "../../lib/command-parsing.ts";
import {
  DELETE_VERBS,
  FIND_EXEC_FLAGS,
  MOVE_VERBS,
} from "../../lib/destructive-verbs.ts";

// rmdir only removes empty directories, so the home guard's recursive-delete defence does not need it.
const HOME_GUARD_EXCLUDED = ["rmdir"];

describe("destructive verb lists stay in sync", () => {
  it("home guard find -exec verbs = DELETE ∪ MOVE minus declared exclusions", () => {
    const shared = [...DELETE_VERBS, ...MOVE_VERBS]
      .filter((v) => !HOME_GUARD_EXCLUDED.includes(v))
      .sort();
    deepStrictEqual([...FIND_DESTRUCTIVE_EXEC].sort(), shared);
  });
  it("find exec flags match", () => {
    deepStrictEqual(
      [...HOME_FIND_EXEC_FLAGS].sort(),
      [...FIND_EXEC_FLAGS].sort(),
    );
  });
});
