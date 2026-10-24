// Upper bounds only. The behaviour of the same inputs is covered in
// unit/translationese-scan.test.ts.
import { ok, strictEqual } from "node:assert";
import { execFileSync, spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  realpathSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  toNewShape,
  WORD_LIST_RELATIVE_PATH,
} from "../../implementations/translationese-scan.ts";
import {
  compileEntries,
  findHits,
  validateWordList,
} from "../../../japanese-check/words.ts";

const REPO_LIST = join(
  import.meta.dirname,
  "../../../../../.skills/ja-notation/references/translationese-words.json",
);
const HOOK_PATH = join(
  import.meta.dirname,
  "../../implementations/translationese-scan.ts",
);
const rawList = JSON.parse(readFileSync(REPO_LIST, "utf-8")) as {
  word: string;
}[];
const validated = validateWordList(toNewShape(rawList));
ok(validated.ok);
const { compiled } = compileEntries(validated.entries);

function elapsedMs(fn: () => void): number {
  const started = performance.now();
  fn();
  return performance.now() - started;
}

describe("translationese-scan time bounds", () => {
  it("each entry survives hostile 2,000-char lines (< 100 ms per entry)", () => {
    for (const [i, entry] of compiled.entries()) {
      const firstChar = (rawList[i]?.word ?? "あ").charAt(0);
      for (const line of ["あ".repeat(2000), firstChar.repeat(2000)]) {
        const ms = elapsedMs(() => findHits(line, [entry]));
        ok(ms < 100, `${rawList[i]?.word}: ${ms} ms`);
      }
    }
  });

  it("large inputs finish under 2 s each", () => {
    const inputs = [
      "道具立てを使う。\n".repeat(1000),
      `${"あ".repeat(100_000)}道具立て`,
      "道具立て".repeat(1000),
    ];
    for (const text of inputs) {
      const ms = elapsedMs(() => findHits(text, compiled));
      ok(ms < 2000, `${ms} ms`);
    }
  });
});

describe("translationese-scan as a process, worst-case inputs", () => {
  function setup() {
    const home = realpathSync(mkdtempSync(join(tmpdir(), "tscan-perf-")));
    const target = join(home, WORD_LIST_RELATIVE_PATH);
    mkdirSync(join(target, ".."), { recursive: true });
    copyFileSync(REPO_LIST, target);
    return { home, target };
  }

  function spawnHook(input: unknown, home: string) {
    const started = performance.now();
    const result = spawnSync("bun", [HOOK_PATH], {
      input: JSON.stringify(input),
      encoding: "utf-8",
      env: { PATH: process.env.PATH ?? "", HOME: home },
      timeout: 10_000,
    });
    return { result, ms: performance.now() - started };
  }

  function hookInput(home: string, tool_name: string, tool_input: unknown) {
    return {
      session_id: "perf1",
      transcript_path: join(home, "t.jsonl"),
      cwd: home,
      hook_event_name: "PostToolUse",
      tool_name,
      tool_use_id: "t1",
      tool_input,
      tool_response: {},
    };
  }

  // 256 KB of 2,000-char lines: repeated chars, first chars of each word, runs of 核
  function worstText(): string {
    const units = ["あ", "道", "核", "握", "仕", "編"];
    const lines: string[] = [];
    for (let size = 0; size < 256 * 1024; lines.length++) {
      const line = (units[lines.length % units.length] ?? "あ").repeat(2000);
      lines.push(line);
      size += line.length + 1;
    }
    return lines.join("\n");
  }

  it("Write of a 256 KB hostile document ends within 4 s", () => {
    const { home } = setup();
    try {
      const { result, ms } = spawnHook(
        hookInput(home, "Write", {
          file_path: "docs/a.md",
          content: worstText(),
        }),
        home,
      );
      strictEqual(result.status, 0, result.stderr);
      console.error(`Write 256 KB: ${ms.toFixed(0)} ms`);
      ok(ms < 4000, `${ms} ms`);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("apply_patch with 64 .md sections of hostile lines ends within 4 s", () => {
    const { home } = setup();
    try {
      const line = `+${"あ".repeat(2000)}`;
      const perSection = Math.floor((256 * 1024) / 64 / 2001);
      const sections = Array.from({ length: 64 }, (_, i) =>
        [
          `*** Add File: docs/s${i}.md`,
          ...Array.from({ length: perSection }, () => line),
        ].join("\n"),
      );
      const patch = ["*** Begin Patch", ...sections, "*** End Patch"].join(
        "\n",
      );
      const { result, ms } = spawnHook(
        hookInput(home, "apply_patch", { command: patch }),
        home,
      );
      strictEqual(result.status, 0, result.stderr);
      console.error(`apply_patch 64 sections: ${ms.toFixed(0)} ms`);
      ok(ms < 4000, `${ms} ms`);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("a FIFO, a directory or a symlink at the list path is refused within 1 s of work", () => {
    for (const make of ["fifo", "dir", "symlink"] as const) {
      const { home, target } = setup();
      try {
        rmSync(target);
        if (make === "fifo") execFileSync("mkfifo", [target]);
        else if (make === "dir") mkdirSync(target);
        else symlinkSync(REPO_LIST, target);
        const { result, ms } = spawnHook(
          hookInput(home, "Write", {
            file_path: "docs/a.md",
            content: "道具立てを使う",
          }),
          home,
        );
        strictEqual(result.status, 0, result.stderr);
        ok(
          result.stdout.includes("全体を使わない"),
          `${make}: ${result.stdout}`,
        );
        console.error(`${make}: ${ms.toFixed(0)} ms`);
        ok(ms < 4000, `${make}: ${ms} ms`);
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    }
  });
});
