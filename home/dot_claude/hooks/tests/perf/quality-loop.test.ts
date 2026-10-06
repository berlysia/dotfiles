import { ok } from "node:assert";
import { after, describe, it } from "node:test";
import { runFormat } from "../../implementations/quality-loop.ts";
import {
  cleanupTempDirs,
  installBin,
  setupFormatRepo,
  writeFile,
} from "../support/quality-loop-helpers.ts";
import { join } from "node:path";

after(cleanupTempDirs);

describe("runFormat", () => {
  it("aborts a hanging formatter within 3 s", () => {
    const { root, file } = setupFormatRepo();
    writeFile(join(root, ".oxfmtrc.json"), "{}");
    installBin(root, "oxfmt", "exec sleep 5");
    const started = performance.now();
    const result = runFormat(file, root, 200);
    ok(performance.now() - started < 3000);
    ok(result?.output.startsWith("oxfmt failed:"));
  });
});
