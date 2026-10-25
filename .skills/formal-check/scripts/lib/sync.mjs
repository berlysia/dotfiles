// Compares the covered implementation files with the hashes recorded when the
// model was last checked. It only reports states; turning them into warnings
// is verdict.mjs's job. No git: the answer must be the same in a shallow
// clone, after a squash, and for uncommitted edits.
import { sha256File } from "./hash.mjs";

const PRIORITY = ["missing", "changed", "unrecorded", "clean"];

export function computeSync(check) {
  if (check.sync === null) return { state: "none", files: [] };
  if (check.sync.covers.length === 0) return { state: "empty", files: [] };
  const files = check.sync.covers.map((cover) => {
    const current = sha256File(cover.abs);
    const state =
      current === null
        ? "missing"
        : cover.sha256 === null
          ? "unrecorded"
          : current === cover.sha256
            ? "clean"
            : "changed";
    return { path: cover.rel, state, recorded: cover.sha256, current };
  });
  const state = PRIORITY.find((s) => files.some((f) => f.state === s));
  return { state, files };
}
