import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { after, describe, it } from "node:test";
import {
  gitDocumentCandidates,
  spawnGit,
} from "../../lib/japanese-document-gate/discovery.ts";
import { createBlockingGit } from "../support/fake-git.ts";

describe("gitDocumentCandidates deadline", () => {
  const root = realpathSync(
    mkdtempSync(join(tmpdir(), "japanese-document-gate-deadline-")),
  );
  after(() => rmSync(root, { recursive: true, force: true }));
  execFileSync("git", ["init", "-q", root]);

  for (const blocked of ["rev-parse", "status"]) {
    it(`gives up within the shared deadline when git ${blocked} hangs`, () => {
      const blocking = createBlockingGit(blocked);
      const savedPath = process.env.PATH ?? "";
      process.env.PATH = `${blocking.binDir}${delimiter}${savedPath}`;
      const started = performance.now();
      try {
        const result = gitDocumentCandidates(root, spawnGit);
        const elapsed = performance.now() - started;
        assert.deepEqual(result, { ok: false, reason: "timeout" });
        assert.ok(elapsed < 1500, `took ${Math.round(elapsed)}ms`);
        assert.ok(blocking.blockedCalls() >= 1);
      } finally {
        process.env.PATH = savedPath;
        blocking.cleanup();
      }
    });
  }
});
