import { strict as assert } from "node:assert";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

// Settings run each file under implementations/ as `bun <file>`, so a file
// without an `import.meta.main` entrypoint is deployed but does nothing. Unit
// tests usually call the hook's run() directly and cannot notice that, which
// is how commit-sign-failure-ask.ts first shipped inert. The rule follows the
// location: being under implementations/ is what makes a file a hook command.
// The entrypoint may call runHook (cc-hooks-ts) or a local main().
const REPO_ROOT = fileURLToPath(new URL("../../../../../", import.meta.url));
const IMPL_DIR = "home/dot_claude/hooks/implementations/";
const ENTRYPOINT = /^if \(import\.meta\.main\) \{/m;

// The directory listing, not `git ls-files`: unit tests must not start git
// (tests/README_TESTING.md), and chezmoi deploys what is on disk, tracked or not.
function implementationFiles(): string[] {
  return readdirSync(join(REPO_ROOT, IMPL_DIR), { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
    .map((entry) => `${IMPL_DIR}${entry.name}`);
}

describe("hook implementations entrypoint", () => {
  it("finds the implementation files", () => {
    assert.ok(implementationFiles().length > 0);
  });

  it("every implementations/*.ts has an import.meta.main entrypoint", () => {
    const missing = implementationFiles().filter(
      (rel) => !ENTRYPOINT.test(readFileSync(join(REPO_ROOT, rel), "utf-8")),
    );
    assert.deepEqual(
      missing,
      [],
      'Add `if (import.meta.main) { const { runHook } = await import("cc-hooks-ts"); await runHook(hook); }` ' +
        "(or call the file's main()). Without it `bun <file>` exits 0 and the hook silently does nothing.",
    );
  });
});
