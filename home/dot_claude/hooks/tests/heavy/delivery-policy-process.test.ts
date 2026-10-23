import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import {
  buildDeliveryPolicyQuestion,
  ledgerPath,
} from "../../lib/delivery-policy.ts";
import { hasBun } from "../support/claude-worktree-entry-fixture.ts";

// Starts the recording hook and the CLI as processes, so a broken entrypoint
// wiring fails here even when the exported functions pass their unit tests.
// Every run gets its own home: the real ~/.claude/state stays untouched.

const HOOKS_DIR = join(import.meta.dirname, "..", "..");
const RECORDER = join(
  HOOKS_DIR,
  "implementations",
  "delivery-policy-recorder.ts",
);
const CLI = join(HOOKS_DIR, "cli", "delivery-policy.ts");
const roots: string[] = [];

function freshDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  roots.push(dir);
  return dir;
}

after(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
});

const VIEW = JSON.stringify({
  nameWithOwner: "berlysia/dotfiles",
  owner: { id: "x", login: "berlysia" },
  isInOrganization: false,
  defaultBranchRef: { name: "main" },
  url: "https://github.com/berlysia/dotfiles",
});

// The real entry builds its deps from the passwd home and the real gh. This
// small entry runs the same hook through cc-hooks-ts's runHook with a temp
// home and a fake gh, run from the hooks dir so bare imports resolve.
const FAKE_DEPS_ENTRY = `
const { runHook } = await import("cc-hooks-ts");
const { createRecorderHook } = await import(${JSON.stringify(RECORDER)});
const cfg = JSON.parse(process.env.DP_TEST_CONFIG);
const hook = createRecorderHook({
  home: cfg.home,
  ghFor: () => async () => ({ status: 0, stdout: cfg.view, stderr: "" }),
  now: () => new Date(cfg.now),
});
await runHook(hook);
`;

function postToolUse(response: unknown): string {
  return JSON.stringify({
    hook_event_name: "PostToolUse",
    session_id: "abcd1234-0000-0000-0000-000000000000",
    cwd: tmpdir(),
    transcript_path: "/tmp/transcript",
    tool_name: "AskUserQuestion",
    tool_input: {},
    tool_use_id: "toolu_test",
    tool_response: response,
  });
}

describe(
  "delivery-policy-recorder entry",
  { skip: !hasBun && "bun is not on PATH" },
  () => {
    it("records the answer and prints the prefixed line when started as a process", () => {
      const home = freshDir("dp-recorder-home-");
      const questions = buildDeliveryPolicyQuestion(
        "berlysia/dotfiles",
        "https://github.com/berlysia/dotfiles",
      );
      const key = (questions[0] as { question: string }).question;
      const r = spawnSync("bun", ["-e", FAKE_DEPS_ENTRY], {
        cwd: HOOKS_DIR,
        env: {
          PATH: process.env.PATH ?? "",
          DP_TEST_CONFIG: JSON.stringify({
            home,
            view: VIEW,
            now: "2026-10-23T01:02:03.000Z",
          }),
        },
        input: postToolUse({ questions, answers: { [key]: "merge" } }),
        encoding: "utf8",
      });
      assert.equal(r.status, 0, r.stderr);
      assert.match(
        r.stdout,
        /\[delivery-policy-recorder\] berlysia\/dotfiles を merge と記録した/,
      );
      const line = JSON.parse(
        readFileSync(ledgerPath(home), "utf-8").trim(),
      ) as Record<string, unknown>;
      assert.deepEqual(line, {
        v: 1,
        repo: "berlysia/dotfiles",
        scope: "merge",
        at: "2026-10-23T01:02:03.000Z",
      });
    });

    it("the real entry stays silent for an ordinary question", () => {
      const r = spawnSync("bun", [RECORDER], {
        cwd: HOOKS_DIR,
        env: { PATH: process.env.PATH ?? "" },
        input: postToolUse({
          questions: [{ question: "進めてよいか", options: [] }],
          answers: { 進めてよいか: "はい" },
        }),
        encoding: "utf8",
      });
      assert.equal(r.status, 0, r.stderr);
      assert.doesNotMatch(r.stdout, /delivery-policy-recorder/);
    });
  },
);

describe(
  "delivery-policy CLI entry",
  { skip: !hasBun && "bun is not on PATH" },
  () => {
    it("takes the home from the passwd database, not from HOME", () => {
      const fakeHome = freshDir("dp-cli-fakehome-");
      const entry = `
const { resolveCliDeps } = await import(${JSON.stringify(CLI)});
const resolved = resolveCliDeps(["--cwd", ${JSON.stringify(tmpdir())}, "show"]);
console.log(JSON.stringify({ ok: resolved.ok, home: resolved.deps?.home }));
`;
      const r = spawnSync("bun", ["-e", entry], {
        cwd: HOOKS_DIR,
        env: { PATH: process.env.PATH ?? "", HOME: fakeHome },
        encoding: "utf8",
      });
      assert.equal(r.status, 0, r.stderr);
      assert.deepEqual(JSON.parse(r.stdout), {
        ok: true,
        home: userInfo().homedir,
      });
      assert.notEqual(userInfo().homedir, fakeHome);
    });

    it("show runs as a process in a git repo with a fake gh first on PATH", () => {
      const repo = freshDir("dp-cli-repo-");
      const git = spawnSync("git", ["init", "-q", repo], { encoding: "utf8" });
      assert.equal(git.status, 0, git.stderr);
      const bin = freshDir("dp-cli-bin-");
      const fakeGh = join(bin, "gh");
      writeFileSync(
        fakeGh,
        `#!/usr/bin/env bash
if [ "$1" = "repo" ] && [ "$2" = "view" ]; then
  echo '{"nameWithOwner":"dp-fake-owner/dp-fake-repo","owner":{"id":"x","login":"dp-fake-owner"},"isInOrganization":false,"defaultBranchRef":{"name":"main"},"url":"https://github.com/dp-fake-owner/dp-fake-repo"}'
  exit 0
fi
echo "unexpected gh call: $*" >&2
exit 1
`,
      );
      chmodSync(fakeGh, 0o755);
      const r = spawnSync("bun", [CLI, "--cwd", repo, "show"], {
        cwd: HOOKS_DIR,
        env: { PATH: `${bin}:${process.env.PATH ?? ""}` },
        encoding: "utf8",
      });
      assert.equal(r.status, 0, r.stderr);
      assert.equal(r.stdout, "delivery-policy: scope: unrecorded\n");
    });

    it("exits 2 without --cwd, as a process", () => {
      const r = spawnSync("bun", [CLI, "show"], {
        cwd: HOOKS_DIR,
        env: { PATH: process.env.PATH ?? "" },
        encoding: "utf8",
      });
      assert.equal(r.status, 2);
      assert.match(r.stderr, /--cwd/);
    });
  },
);
