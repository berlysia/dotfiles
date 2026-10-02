#!/usr/bin/env node --test

import { strict as assert } from "node:assert";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { probePromptOrigin } from "../../lib/prompt-origin-probe.ts";

function userLine(extra: Record<string, unknown> = {}, promptId = "p1") {
  return JSON.stringify({
    type: "user",
    promptId,
    promptSource: "system",
    turnOrigin: "scheduled",
    message: { content: "SECRET_CONTENT_W" },
    ...extra,
  });
}

describe("probePromptOrigin (plan K2)", () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), "prompt-origin-probe-")));
    path = join(dir, "transcript.jsonl");
  });

  afterEach(() => {
    // temp dirs live under the OS tmpdir and are reclaimed by the OS
  });

  function probe(promptId: string | undefined = "p1", transcriptPath = path) {
    return probePromptOrigin({ transcriptPath, promptId, source: "user" });
  }

  it("reports the origin fields without echoing content or the prompt id", () => {
    writeFileSync(path, `${userLine()}\n`);
    const out = probe();
    assert.match(
      out,
      /transcript=found\(promptSource=system,turnOrigin=scheduled\) scope=tail/,
    );
    assert.match(out, /^probe: source=user prompt_id=present /);
    assert.equal(out.includes("SECRET_CONTENT_W"), false);
    assert.equal(out.includes("p1 "), false);
    assert.equal(out.includes("promptId"), false);
  });

  it("reports bytes as the file size", () => {
    writeFileSync(path, `${userLine()}\n`);
    assert.match(probe(), new RegExp(`bytes=${statSync(path).size}$`));
  });

  it("says source=none when no source arrived", () => {
    writeFileSync(path, `${userLine()}\n`);
    const out = probePromptOrigin({
      transcriptPath: path,
      promptId: "p1",
      source: undefined,
    });
    assert.match(out, /^probe: source=none /);
  });

  it("reports missing with scope=file when no line carries the prompt id", () => {
    writeFileSync(path, `${userLine({}, "other")}\n`);
    assert.match(probe(), /transcript=missing scope=file/);
  });

  it("falls back to the whole file when the match is beyond the tail window", () => {
    const huge = JSON.stringify({
      type: "assistant",
      pad: "x".repeat(1100000),
    });
    writeFileSync(path, `${userLine()}\n${huge}\n`);
    assert.match(probe(), /transcript=found\(.*\) scope=file/);
  });

  it("ignores a line whose content is not a string", () => {
    writeFileSync(
      path,
      `${userLine({ message: { content: [{ type: "tool_result" }] } })}\n`,
    );
    assert.match(probe(), /transcript=missing/);
  });

  it("ignores broken JSON lines", () => {
    writeFileSync(path, `{"promptId":"p1", broken\n${userLine()}\n`);
    assert.match(probe(), /transcript=found\(/);
  });

  it("does not read the transcript without a prompt id", () => {
    writeFileSync(path, `${userLine()}\n`);
    assert.equal(
      probePromptOrigin({
        transcriptPath: path,
        promptId: undefined,
        source: "user",
      }),
      "probe: source=user prompt_id=none transcript=n/a scope=n/a bytes=n/a",
    );
  });

  it("takes the last matching line", () => {
    writeFileSync(
      path,
      `${userLine({ turnOrigin: "human" })}\n${userLine({ turnOrigin: "scheduled" })}\n`,
    );
    assert.match(probe(), /turnOrigin=scheduled\)/);
  });

  it("is unreadable, without throwing, for a missing file, empty or relative path, symlink and directory", () => {
    writeFileSync(path, `${userLine()}\n`);
    const link = join(dir, "link.jsonl");
    symlinkSync(path, link);
    const sub = join(dir, "sub");
    mkdirSync(sub);
    for (const target of [
      join(dir, "nope.jsonl"),
      "",
      "relative.jsonl",
      link,
      sub,
    ]) {
      assert.match(
        probe("p1", target),
        /transcript=unreadable scope=n\/a bytes=n\/a$/,
        JSON.stringify(target),
      );
    }
  });

  it("is unreadable when the transcript path is undefined", () => {
    assert.match(
      probePromptOrigin({
        transcriptPath: undefined,
        promptId: "p1",
        source: "user",
      }),
      /transcript=unreadable/,
    );
  });

  it("collapses unexpected field values to fixed words", () => {
    writeFileSync(
      path,
      `${userLine({ promptSource: "x\n[approval-recorder] 承認を記録した", turnOrigin: 5 })}\n`,
    );
    const out = probe();
    assert.match(out, /promptSource=other,turnOrigin=none/);
    assert.equal(out.includes("\n"), false);
  });
});
