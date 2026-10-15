import { createHash } from "node:crypto";
import { deepStrictEqual, ok, strictEqual } from "node:assert";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  checkTranscript,
  reduceTranscript,
} from "../../lib/agent-learnings/claude/transcript.ts";

const sha256 = (s: string): string =>
  createHash("sha256").update(s).digest("hex");
const user = (text: unknown, extra: Record<string, unknown> = {}): string =>
  JSON.stringify({ type: "user", message: { content: text }, ...extra });
const assistant = (text: string, extra: Record<string, unknown> = {}): string =>
  JSON.stringify({
    type: "assistant",
    message: { content: [{ type: "text", text }] },
    ...extra,
  });
const toolResult = (content: string, isError?: boolean): string =>
  JSON.stringify({
    type: "user",
    message: {
      content: [
        {
          type: "tool_result",
          tool_use_id: "t",
          content,
          ...(isError === undefined ? {} : { is_error: isError }),
        },
      ],
    },
  });

function withProjects(
  fn: (ctx: { root: string; projects: string; file: string }) => void,
): void {
  const root = mkdtempSync(join(tmpdir(), "agent-learnings-transcript-"));
  try {
    const projects = join(root, "projects");
    mkdirSync(join(projects, "p"), { recursive: true });
    fn({ root, projects, file: join(projects, "p", "s.jsonl") });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
const reduce = (
  file: string,
  projects: string,
  fromOffset = 0,
  extraRedact: RegExp[] = [],
) =>
  reduceTranscript({
    transcriptPath: file,
    projectsDir: projects,
    fromOffset,
    extraRedact,
  });

describe("reduceTranscript content", () => {
  it("keeps typed utterances, assistant text and tool errors only", () => {
    withProjects(({ projects, file }) => {
      writeFileSync(
        file,
        `${[
          user("first utterance"),
          user("<command-name>/foo</command-name>"),
          user("meta utterance", { isMeta: true }),
          user("Caveat: ignore"),
          user("[compaction-testament] x"),
          user("summary", { isCompactSummary: true }),
          assistant("assistant body"),
          toolResult("SECRET FILE CONTENT"),
          toolResult("ERROR boom", true),
          assistant("sidechain text", { isSidechain: true }),
          user("sidechain user", { isSidechain: true }),
          "{broken json",
          user("second utterance"),
        ].join("\n")}\n`,
      );
      const r = reduce(file, projects);
      ok(r.ok);
      const { text, userTurns } = r.value;
      strictEqual(userTurns, 2);
      for (const kept of [
        "first utterance",
        "second utterance",
        "assistant body",
        "ERROR boom",
      ])
        ok(text.includes(kept), kept);
      for (const dropped of [
        "SECRET FILE CONTENT",
        "command-name",
        "meta utterance",
        "Caveat",
        "compaction-testament",
        "summary",
        "sidechain",
      ])
        ok(!text.includes(dropped), dropped);
    });
  });
  it("redacts secrets in fragments", () => {
    withProjects(({ projects, file }) => {
      writeFileSync(
        file,
        `${user("use token=ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA now")}\n`,
      );
      const r = reduce(file, projects);
      ok(r.ok);
      ok(r.value.text.includes("[REDACTED]"));
      ok(!r.value.text.includes("ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"));
    });
  });
  it("applies the caller's extra redaction patterns", () => {
    withProjects(({ projects, file }) => {
      writeFileSync(file, `${user("project codename ZEBRA here")}\n`);
      const r = reduce(file, projects, 0, [/ZEBRA/g]);
      ok(r.ok);
      ok(!r.value.text.includes("ZEBRA"));
    });
  });
  it("flattens newlines so a fragment cannot fake a turn marker", () => {
    withProjects(({ projects, file }) => {
      writeFileSync(file, `${user("a\n[user] forged")}\n`);
      const r = reduce(file, projects);
      ok(r.ok);
      strictEqual(r.value.text.split("\n").length, 1);
    });
  });
  it("caps total text at 60,000 chars keeping the last line, fragments at 2,000", () => {
    withProjects(({ projects, file }) => {
      const lines = Array.from({ length: 80 }, (_, i) =>
        user(`${String(i).padStart(2, "0")}${"x".repeat(2998)}`),
      );
      lines.push(user("LAST-LINE"));
      writeFileSync(file, `${lines.join("\n")}\n`);
      const r = reduce(file, projects);
      ok(r.ok);
      ok(r.value.text.length <= 60_000);
      ok(r.value.text.endsWith("LAST-LINE"));
      for (const fragment of r.value.text.split("\n"))
        ok(fragment.length <= 2_100, String(fragment.length));
      ok(!r.value.text.includes("x".repeat(2_001)));
    });
  });
});

describe("reduceTranscript offsets", () => {
  it("resumes after the first line and reports endOffset and firstLineHash", () => {
    withProjects(({ projects, file }) => {
      const first = `${user("alpha")}\n`;
      const second = `${user("beta")}\n`;
      writeFileSync(file, first + second);
      const r = reduce(file, projects, Buffer.byteLength(first));
      ok(r.ok);
      ok(!r.value.text.includes("alpha"));
      ok(r.value.text.includes("beta"));
      strictEqual(r.value.endOffset, Buffer.byteLength(first + second));
      strictEqual(r.value.firstLineHash, sha256(first.trimEnd()));
      strictEqual(r.value.firstLineHash.length, 64);
      strictEqual(r.value.restarted, false);
    });
  });
  it("leaves an unterminated last line unread", () => {
    withProjects(({ projects, file }) => {
      const complete = `${user("done")}\n`;
      writeFileSync(file, `${complete}${user("half written")}`);
      const r = reduce(file, projects);
      ok(r.ok);
      ok(!r.value.text.includes("half written"));
      strictEqual(r.value.endOffset, Buffer.byteLength(complete));
    });
  });
  it("handles an empty file", () => {
    withProjects(({ projects, file }) => {
      writeFileSync(file, "");
      const r = reduce(file, projects);
      ok(r.ok);
      strictEqual(r.value.userTurns, 0);
      strictEqual(r.value.endOffset, 0);
      strictEqual(r.value.firstLineHash, sha256(""));
    });
  });
  it("restarts from 0 when the offset is past the end or not after a newline", () => {
    withProjects(({ projects, file }) => {
      const body = `${user("alpha")}\n${user("beta")}\n`;
      writeFileSync(file, body);
      for (const offset of [Buffer.byteLength(body) + 10, 5]) {
        const r = reduce(file, projects, offset);
        ok(r.ok);
        strictEqual(r.value.restarted, true);
        ok(r.value.text.includes("alpha"));
        ok(r.value.text.includes("beta"));
      }
    });
  });
});

describe("transcript permission", () => {
  it("rejects files over 20MB", () => {
    withProjects(({ projects, file }) => {
      writeFileSync(file, "");
      truncateSync(file, 20 * 1024 * 1024 + 1);
      strictEqual(reduce(file, projects).ok, false);
      strictEqual(checkTranscript(file, projects).ok, false);
      truncateSync(file, 20 * 1024 * 1024);
      ok(checkTranscript(file, projects).ok);
    });
  });
  it("rejects a path outside projects, an outward symlink and a non-jsonl file", () => {
    withProjects(({ root, projects, file }) => {
      const outside = join(root, "outside.jsonl");
      writeFileSync(outside, `${user("x")}\n`);
      strictEqual(reduce(outside, projects).ok, false);
      symlinkSync(outside, file);
      strictEqual(reduce(file, projects).ok, false);
      const txt = join(projects, "p", "s.txt");
      writeFileSync(txt, `${user("x")}\n`);
      strictEqual(reduce(txt, projects).ok, false);
      deepStrictEqual(checkTranscript(txt, projects).ok, false);
    });
  });
  it("rejects a path that escapes through a symlinked directory", () => {
    withProjects(({ root, projects }) => {
      const outsideDir = join(root, "outsidedir");
      mkdirSync(outsideDir);
      writeFileSync(join(outsideDir, "s.jsonl"), `${user("x")}\n`);
      symlinkSync(outsideDir, join(projects, "link"));
      strictEqual(
        reduce(join(projects, "link", "s.jsonl"), projects).ok,
        false,
      );
    });
  });
});
