#!/usr/bin/env node --test

import { ok, strictEqual } from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { runFormat } from "../../implementations/quality-loop.ts";
import {
  cleanupTempDirs,
  installBin,
  setupFormatRepo,
  writeFile,
} from "../support/quality-loop-helpers.ts";

after(cleanupTempDirs);

describe("runFormat", () => {
  it("reports a configured formatter that is not installed", () => {
    const { root, file } = setupFormatRepo();
    writeFile(join(root, ".prettierrc"), "{}");
    const result = runFormat(file, root);
    strictEqual(result?.tool, "formatter");
    strictEqual(
      result?.output,
      "prettier is configured but not installed (node_modules/.bin/prettier not found)",
    );
  });

  it("falls back to the candidate whose bin exists", () => {
    const { root, file } = setupFormatRepo();
    writeFile(join(root, ".oxfmtrc.json"), "{}");
    writeFile(join(root, ".prettierrc"), "{}");
    const log = join(root, "args.log");
    installBin(root, "prettier", `echo "$@" > "${log}"`);
    strictEqual(runFormat(file, root), null);
    ok(readFileSync(log, "utf-8").includes(`--write --ignore-unknown ${file}`));
  });

  it("treats oxfmt exit 2 with the excluded-file message as normal", () => {
    const { root, file } = setupFormatRepo();
    writeFile(join(root, ".oxfmtrc.json"), "{}");
    installBin(
      root,
      "oxfmt",
      'echo "Expected at least one target file" >&2; exit 2',
    );
    strictEqual(runFormat(file, root), null);
  });

  it("treats oxfmt exit 2 with another message as a failure", () => {
    const { root, file } = setupFormatRepo();
    writeFile(join(root, ".oxfmtrc.json"), "{}");
    installBin(root, "oxfmt", 'echo "config parse error" >&2; exit 2');
    const result = runFormat(file, root);
    strictEqual(result?.tool, "formatter");
    strictEqual(result?.output, "oxfmt failed: config parse error");
  });

  it("collapses newlines and caps stderr at 300 chars", () => {
    const { root, file } = setupFormatRepo();
    writeFile(join(root, ".oxfmtrc.json"), "{}");
    installBin(
      root,
      "oxfmt",
      'i=0; while [ $i -lt 100 ]; do printf "line%s\\n" "$i" >&2; i=$((i+1)); done; exit 1',
    );
    const result = runFormat(file, root);
    const detail = (result?.output ?? "").replace(/^oxfmt failed: /, "");
    ok(result?.output.startsWith("oxfmt failed: "));
    strictEqual(detail.length, 300);
    ok(!/[\r\n]/.test(detail));
  });

  it("fails with a message when the formatter times out", () => {
    const { root, file } = setupFormatRepo();
    writeFile(join(root, ".oxfmtrc.json"), "{}");
    installBin(root, "oxfmt", "exec sleep 5");
    const result = runFormat(file, root, 200);
    ok(result?.output.startsWith("oxfmt failed:"));
  });
});
