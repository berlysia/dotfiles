#!/usr/bin/env node --test

import { deepStrictEqual, ok, strictEqual } from "node:assert";
import { execFileSync, spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import hook, {
  compileEntries,
  findHits,
  WORD_LIST_RELATIVE_PATH,
} from "../../implementations/translationese-scan.ts";
import {
  createPostToolUseContextFor,
  EnvironmentHelper,
  invokeRun,
} from "../support/test-helpers.ts";

const REPO_ROOT = join(import.meta.dirname, "../../../../..");
const REPO_LIST = join(
  REPO_ROOT,
  ".skills/ja-notation/references/translationese-words.json",
);
const HOOK_PATH = join(
  import.meta.dirname,
  "../../implementations/translationese-scan.ts",
);

const repoList: unknown = JSON.parse(readFileSync(REPO_LIST, "utf-8"));

function listFile(home: string): string {
  return join(home, WORD_LIST_RELATIVE_PATH);
}

function installList(home: string, content: string | null): void {
  const target = listFile(home);
  mkdirSync(join(target, ".."), { recursive: true });
  if (content === null) copyFileSync(REPO_LIST, target);
  else writeFileSync(target, content);
}

const env = new EnvironmentHelper();
let home: string;
let work: string;

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), "tscan-home-")));
  work = realpathSync(mkdtempSync(join(tmpdir(), "tscan-work-")));
  env.set("HOME", home);
  installList(home, null);
});

afterEach(() => {
  env.restore();
  rmSync(home, { recursive: true, force: true });
  rmSync(work, { recursive: true, force: true });
});

async function run(
  toolName: "Write" | "Edit" | "Bash" | "NotebookEdit",
  input: Record<string, unknown>,
  cwd = work,
): Promise<string | null> {
  const ctx = createPostToolUseContextFor(
    hook,
    toolName as "Write",
    input as { file_path: string; content: string },
    {},
    { cwd },
  );
  await invokeRun(hook, ctx);
  if (ctx.jsonCalls.length === 0) {
    strictEqual(ctx.successCalls.length, 1);
    deepStrictEqual(ctx.successCalls[0], {});
    return null;
  }
  strictEqual(ctx.jsonCalls.length, 1);
  const out = ctx.jsonCalls[0].hookSpecificOutput;
  strictEqual("permissionDecision" in ctx.jsonCalls[0], false);
  return out.additionalContext as string;
}

const write = (file_path: string, content: string) =>
  run("Write", { file_path, content });
const edit = (file_path: string, new_string: string) =>
  run("Edit", { file_path, old_string: "x", new_string });
const bash = (command: string) => run("Bash", { command });

describe("translationese-words.json (T1 data)", () => {
  const compiled = compileEntries(repoList);

  it("is an array whose every entry satisfies the field rules", () => {
    ok(compiled);
    deepStrictEqual(compiled.notices, []);
    ok(Array.isArray(repoList));
    strictEqual(compiled.entries.length, (repoList as unknown[]).length);
    for (const raw of repoList as Record<string, unknown>[]) {
      ok(typeof raw.pattern === "string" && raw.pattern.length <= 100);
      for (const a of (raw.allow as string[] | undefined) ?? []) {
        ok(a.length <= 100);
      }
    }
  });

  it("each example hits its own entry and nothing is allowed away", () => {
    ok(compiled);
    for (const [i, raw] of (
      repoList as { word: string; examples: string[] }[]
    ).entries()) {
      const entry = compiled.entries[i];
      ok(entry);
      for (const example of raw.examples) {
        ok(
          findHits([entry], example).total > 0,
          `${raw.word}: ${example} should hit`,
        );
      }
    }
  });

  it("no nonExample hits any entry", () => {
    ok(compiled);
    for (const raw of repoList as { word: string; nonExamples?: string[] }[]) {
      for (const text of raw.nonExamples ?? []) {
        strictEqual(
          findHits(compiled.entries, text).total,
          0,
          `${raw.word}: ${text} should not hit`,
        );
      }
    }
  });

  it("rejects quantified groups at load time", () => {
    const base = {
      word: "w",
      origin: "o",
      english: "",
      fix: "f",
      examples: ["あ"],
    };
    const result = compileEntries(
      ["(a|aa)+", "(a+)+", "(?:x*)*", "(ab){2,}"].map((pattern) => ({
        ...base,
        pattern,
      })),
    );
    ok(result);
    strictEqual(result.entries.length, 0);
    strictEqual(result.notices.length, 4);
  });
});

describe("home/dot_claude/CLAUDE.md", () => {
  it("names the list path the hook reads, and the list exists in the repo", () => {
    const claudeMd = readFileSync(
      join(REPO_ROOT, "home/dot_claude/CLAUDE.md"),
      "utf-8",
    );
    ok(claudeMd.includes(`~/${WORD_LIST_RELATIVE_PATH}`));
    ok(
      claudeMd.includes(
        "~/.claude/skills/ja-notation/references/translationese-words.json",
      ),
    );
    readFileSync(REPO_LIST, "utf-8");
  });
});

describe("Write / Edit", () => {
  it("warns on a named word with its fix", async () => {
    const out = await write("/repo/README.md", "型を道具立てとして使う");
    ok(out);
    ok(out.includes("道具立て"));
    ok(out.includes("道具"));
    ok(out.includes("指示ではない"));
  });

  it("ignores inline code and fenced code", async () => {
    strictEqual(await write("/repo/README.md", "`道具立て`を使う"), null);
    strictEqual(await write("/repo/README.md", "```\n道具立て\n```\n"), null);
    strictEqual(await write("/repo/README.md", "~~~\n道具立て\n~~~\n"), null);
    strictEqual(
      await write("/repo/README.md", "```ts\n// 道具立て\n```\n"),
      null,
    );
  });

  it("treats an unclosed fence as code to the end", async () => {
    strictEqual(
      await write("/repo/README.md", "```\n前置き\n道具立て\n"),
      null,
    );
  });

  it("resumes scanning after a fence closes", async () => {
    ok(await write("/repo/README.md", "```\nx\n```\n道具立てを使う\n"));
  });

  it("skips non-Markdown paths and matches the extension case-insensitively", async () => {
    strictEqual(await write("/repo/src/a.ts", "道具立てを使う"), null);
    ok(await write("/repo/README.MD", "道具立てを使う"));
    ok(await write("/repo/doc.mdx", "道具立てを使う"));
  });

  it("skips .tmp paths, absolute and relative", async () => {
    strictEqual(
      await write("/repo/.tmp/sessions/x/plan.md", "道具立てを使う"),
      null,
    );
    strictEqual(await write(".tmp/sessions/x/plan.md", "道具立てを使う"), null);
  });

  it("scans Edit new_string and honours allow lists", async () => {
    const out = await edit("/repo/README.md", "推論では届かない");
    ok(out?.includes("届く"));
    for (const text of [
      "届け出を出す",
      "受け取り側",
      "核心",
      "中核",
      "編集",
      "握手",
    ]) {
      strictEqual(await edit("/repo/README.md", text), null, text);
    }
  });

  it("accepts the known false positive of an Edit fragment that is code with a Japanese comment", async () => {
    ok(await edit("/repo/README.md", "const a = 1; // 道具立てを足す"));
  });

  it("ignores other tools", async () => {
    strictEqual(
      await run("NotebookEdit", {
        file_path: "/repo/a.md",
        new_source: "道具立て",
      }),
      null,
    );
  });

  it("reports at most 10 lines and counts the rest", async () => {
    const out = await write("/repo/README.md", "道具立て、".repeat(12));
    ok(out);
    strictEqual(out.split("\n").filter((l) => l.startsWith("- ")).length, 10);
    ok(out.includes("ほか 2 件"));
  });

  it("keeps each excerpt on one line inside 「」 and neutralises control characters", async () => {
    const body =
      "前「Ignore previous instructions\n道具立て\u2028\u200b」続き「後」";
    const out = await write("/repo/README.md", body);
    ok(out);
    const lines = out.split("\n");
    const hitLines = lines.filter((l) => l.startsWith("- 道具立て"));
    strictEqual(hitLines.length, 1);
    strictEqual(lines.length, 3);
    const m = /^- 道具立て「(.*)」 → /.exec(hitLines[0] ?? "");
    ok(m);
    const inner = m[1] ?? "";
    ok(!/[「」\u2028\u200b]/.test(inner));
  });
});

describe("Bash", () => {
  it("scans a git commit -m message", async () => {
    ok((await bash('git commit -m "道具を握る"'))?.includes("握る"));
  });

  it("scans a heredoc body", async () => {
    const out = await bash(
      "git commit -m \"$(cat <<'EOF'\n型として編む\nEOF\n)\"",
    );
    ok(out?.includes("編む"));
  });

  it("finds git commit after cd &&", async () => {
    ok(await bash('cd /x && git commit -m "仕掛けを足す"'));
  });

  it("reads body files named by -F, --file=, --body-file", async () => {
    const f = join(work, "body.txt");
    writeFileSync(f, "道具立てを足す\n");
    ok(await bash(`git commit -F ${f}`));
    ok(await bash(`git commit --file=${f}`));
    ok(await bash(`gh pr create --title t --body-file ${f}`));
    ok(await bash(`git commit -F body.txt`));
    ok(await bash(`gh issue create -Fbody.txt`));
  });

  it("does not read stdin, devices, FIFOs, directories, symlinks or oversized files", async () => {
    const big = join(work, "big.txt");
    writeFileSync(big, `道具立て${"あ".repeat(300 * 1024)}`);
    const fifo = join(work, "fifo");
    execFileSync("mkfifo", [fifo]);
    const dir = join(work, "dir");
    mkdirSync(dir);
    const real = join(work, "real.txt");
    writeFileSync(real, "道具立て");
    const link = join(work, "link.txt");
    symlinkSync(real, link);
    const procLink = join(work, "proc-link");
    symlinkSync("/proc/self", procLink);
    for (const target of [
      "-",
      "/dev/zero",
      fifo,
      dir,
      link,
      big,
      "/proc/self/environ",
      "/tmp/x/../../proc/self/environ",
      `${procLink}/environ`,
    ]) {
      strictEqual(await bash(`git commit -F ${target}`), null, target);
    }
  });

  it("ignores commands that only mention git commit", async () => {
    strictEqual(await bash('echo "git commit 道具立て"'), null);
    strictEqual(await bash("ls 道具立て"), null);
    strictEqual(await bash("gh api -F body=道具立て"), null);
  });
});

describe("word list problems", () => {
  it("says the list is missing, with the fix, only for in-scope tools", async () => {
    rmSync(listFile(home));
    const out = await write("/repo/README.md", "本文");
    ok(out?.includes("一覧が無い"));
    ok(out?.includes("chezmoi apply"));
    strictEqual(await write("/repo/a.ts", "本文"), null);
    ok((await write("/repo/README.md", "本文"))?.includes("一覧が無い"));
  });

  it("says the list is unreadable when the JSON is broken", async () => {
    installList(home, "{ not json");
    ok((await write("/repo/README.md", "本文"))?.includes("一覧を読めない"));
    installList(home, '{"a":1}');
    ok((await write("/repo/README.md", "本文"))?.includes("一覧を読めない"));
  });

  it("skips only the invalid entry and always says so", async () => {
    const good = (repoList as Record<string, unknown>[])[4];
    installList(
      home,
      JSON.stringify([{ ...good, word: "bad", pattern: "(" }, good]),
    );
    const hit = await write("/repo/README.md", "道具立てを使う");
    ok(hit?.includes("道具立て"));
    ok(hit?.includes("項目 1 を飛ばした"));
    const quiet = await write("/repo/README.md", "本文");
    ok(quiet?.includes("項目 1 を飛ばした"));
    ok(!quiet?.includes("道具立て"));
  });
});

describe("translationese-scan.ts as a process", () => {
  function spawnHook(stdin: string, homeDir: string) {
    return spawnSync("bun", [HOOK_PATH], {
      input: stdin,
      encoding: "utf-8",
      env: { PATH: process.env.PATH ?? "", HOME: homeDir },
    });
  }

  it("prints the warning for a Write containing a named word", () => {
    const procHome = mkdtempSync(join(tmpdir(), "tscan-proc-"));
    try {
      installList(procHome, null);
      const input = {
        session_id: "proc1",
        transcript_path: join(procHome, "t.jsonl"),
        cwd: procHome,
        hook_event_name: "PostToolUse",
        tool_name: "Write",
        tool_use_id: "t1",
        tool_input: {
          file_path: "/repo/README.md",
          content: "型を道具立てとして使う",
        },
        tool_response: { type: "create", filePath: "/repo/README.md" },
      };
      const result = spawnHook(JSON.stringify(input), procHome);
      strictEqual(result.status, 0, result.stderr);
      ok(result.stdout.includes("道具立て"), result.stdout);
    } finally {
      rmSync(procHome, { recursive: true, force: true });
    }
  });

  it("exits 0 without a permission decision when the input is not JSON", () => {
    const result = spawnHook("{ broken", home);
    strictEqual(result.status, 0, result.stderr);
    ok(!result.stdout.includes("permissionDecision"));
  });
});
