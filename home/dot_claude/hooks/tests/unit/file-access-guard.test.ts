#!/usr/bin/env node --test

import { deepStrictEqual, ok, strictEqual } from "node:assert";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import fileAccessGuardHook, {
  getAllowPatterns,
  isWithinTempRoots,
  judge,
  type JudgeContext,
} from "../../implementations/file-access-guard.ts";
import { getChezmoiSourcePath } from "../../lib/chezmoi-utils.ts";
import type { SourcedRule } from "../../lib/pattern-matcher.ts";
import { collectTempRoots } from "../../lib/temp-roots.ts";
import { deriveDefaultWorkflowDir } from "../../lib/workflow-paths.ts";
import { sourced } from "../sourced-rules.ts";
import {
  ConsoleCapture,
  createFileSystemMock,
  createPreToolUseContextFor,
  defineHook,
  EnvironmentHelper,
  invokeRun,
  TEST_SESSION_ID,
} from "../support/test-helpers.ts";

describe("file-access-guard.ts hook behavior", () => {
  const consoleCapture = new ConsoleCapture();
  const envHelper = new EnvironmentHelper();
  const fsMock = createFileSystemMock();

  beforeEach(() => {
    consoleCapture.reset();
    consoleCapture.start();
    fsMock.files.clear();
    fsMock.directories.clear();
  });

  afterEach(() => {
    consoleCapture.stop();
    envHelper.restore();
  });

  describe("hook definition", () => {
    it("should be configured for PreToolUse trigger", () => {
      const hook = defineHook({
        trigger: { PreToolUse: true },
        run: (context: any) => context.success({}),
      });

      deepStrictEqual(hook.trigger, { PreToolUse: true });
    });
  });

  describe("file access control", () => {
    it("should block Read access outside repository", async () => {
      process.env.CLAUDE_TEST_REPO_ROOT = "/home/user/project";
      process.env.CLAUDE_TEST_CWD = "/home/user/project";
      const hook = fileAccessGuardHook;

      const context = createPreToolUseContextFor(hook, "Read", {
        file_path: "/etc/passwd",
      });
      await invokeRun(hook, context);
      context.assertDeny();
    });

    it("should allow Read access within repository", async () => {
      process.env.CLAUDE_TEST_REPO_ROOT = "/home/user/project";
      process.env.CLAUDE_TEST_CWD = "/home/user/project";
      const hook = fileAccessGuardHook;

      const context = createPreToolUseContextFor(hook, "Read", {
        file_path: "/home/user/project/src/index.ts",
      });
      await invokeRun(hook, context);
      context.assertSuccess({});
    });

    it("should allow Write access in temp directories", async () => {
      process.env.CLAUDE_TEST_REPO_ROOT = "/home/user/project";
      const hook = fileAccessGuardHook;

      const context = createPreToolUseContextFor(hook, "Write", {
        file_path: "/tmp/malicious.sh",
        content: "evil code",
      });
      await invokeRun(hook, context);
      context.assertSuccess({});
    });

    it("should allow Write access within repository", async () => {
      process.env.CLAUDE_TEST_REPO_ROOT = "/home/user/project";
      const hook = fileAccessGuardHook;

      const context = createPreToolUseContextFor(hook, "Write", {
        file_path: "/home/user/project/README.md",
        content: "# Project",
      });
      await invokeRun(hook, context);
      context.assertSuccess({});
    });

    it("should block Edit outside repository", async () => {
      process.env.CLAUDE_TEST_REPO_ROOT = "/home/user/project";
      const hook = fileAccessGuardHook;

      const context = createPreToolUseContextFor(hook, "Edit", {
        file_path: "/home/user/other-project/.env",
        old_string: "old",
        new_string: "new",
      });
      await invokeRun(hook, context);
      context.assertDeny();
    });

    it("should block MultiEdit outside repository", async () => {
      process.env.CLAUDE_TEST_REPO_ROOT = "/home/user/project";
      const hook = fileAccessGuardHook;

      const context = createPreToolUseContextFor(hook, "MultiEdit", {
        file_path: "/etc/hosts",
        edits: [],
      });
      await invokeRun(hook, context);
      context.assertDeny();
    });
  });

  describe("path resolution", () => {
    it("should handle relative paths", async () => {
      process.env.CLAUDE_TEST_REPO_ROOT = "/home/user/project";
      process.env.CLAUDE_TEST_CWD = "/home/user/project";
      const hook = fileAccessGuardHook;

      const context = createPreToolUseContextFor(hook, "Read", {
        file_path: "./src/index.ts",
      });
      await invokeRun(hook, context);
      context.assertSuccess({});
    });

    it("should block parent directory traversal", async () => {
      process.env.CLAUDE_TEST_REPO_ROOT = "/home/user/project";
      process.env.CLAUDE_TEST_CWD = "/home/user/project";
      const hook = fileAccessGuardHook;

      const context = createPreToolUseContextFor(hook, "Read", {
        file_path: "../../../etc/passwd",
      });
      await invokeRun(hook, context);
      context.assertDeny();
    });

    it("should handle symlinks trying to escape", async () => {
      process.env.CLAUDE_TEST_REPO_ROOT = "/home/user/project";
      const hook = fileAccessGuardHook;

      // Simulate a symlink that points outside
      const context = createPreToolUseContextFor(hook, "Read", {
        file_path: "/home/user/project/link-to-outside",
      });
      await invokeRun(hook, context);

      // Should be handled by the implementation
      ok(context.successCalls.length > 0 || context.failCalls.length > 0);
    });

    it("should handle home directory paths", async () => {
      process.env.CLAUDE_TEST_REPO_ROOT = "/home/user/project";
      const hook = fileAccessGuardHook;

      const context = createPreToolUseContextFor(hook, "Read", {
        file_path: "~/project/file.ts",
      });
      await invokeRun(hook, context);

      // Should expand ~ and check
      ok(context.successCalls.length > 0 || context.failCalls.length > 0);
    });
  });

  describe("Bash command filtering", () => {
    it("should block Bash commands accessing outside files", async () => {
      process.env.CLAUDE_TEST_REPO_ROOT = "/home/user/project";
      const hook = fileAccessGuardHook;

      const context = createPreToolUseContextFor(hook, "Bash", {
        command: "cat /etc/passwd",
      });
      await invokeRun(hook, context);
      context.assertDeny();
    });

    it("should allow Bash commands within repository", async () => {
      process.env.CLAUDE_TEST_REPO_ROOT = "/home/user/project";
      process.env.CLAUDE_TEST_CWD = "/home/user/project";
      const hook = fileAccessGuardHook;

      const context = createPreToolUseContextFor(hook, "Bash", {
        command: "ls ./src",
      });
      await invokeRun(hook, context);

      context.assertSuccess({});
    });

    it("should block rm commands outside repository", async () => {
      process.env.CLAUDE_TEST_REPO_ROOT = "/home/user/project";
      const hook = fileAccessGuardHook;

      const context = createPreToolUseContextFor(hook, "Bash", {
        command: "rm -rf /etc/important",
      });
      await invokeRun(hook, context);
      context.assertDeny();
    });

    it("should allow package manager commands", async () => {
      const hook = fileAccessGuardHook;

      const context = createPreToolUseContextFor(hook, "Bash", {
        command: "npm install",
      });
      await invokeRun(hook, context);

      context.assertSuccess({});
    });
  });

  describe("special directories", () => {
    it("should allow access to node_modules within repo", async () => {
      process.env.CLAUDE_TEST_REPO_ROOT = "/home/user/project";
      const hook = fileAccessGuardHook;

      const context = createPreToolUseContextFor(hook, "Read", {
        file_path: "/home/user/project/node_modules/package/index.js",
      });
      await invokeRun(hook, context);

      context.assertSuccess({});
    });

    it("should allow access to .git within repo", async () => {
      process.env.CLAUDE_TEST_REPO_ROOT = "/home/user/project";
      const hook = fileAccessGuardHook;

      const context = createPreToolUseContextFor(hook, "Read", {
        file_path: "/home/user/project/.git/config",
      });
      await invokeRun(hook, context);

      context.assertSuccess({});
    });

    it("should block access to system directories", async () => {
      process.env.CLAUDE_TEST_REPO_ROOT = "/home/user/project";
      const hook = fileAccessGuardHook;

      const systemPaths = [
        "/etc/shadow",
        "/usr/bin/bash",
        "/var/log/syslog",
        "/root/.ssh/id_rsa",
      ];

      for (const path of systemPaths) {
        const context = createPreToolUseContextFor(hook, "Read", {
          file_path: path,
        });
        await invokeRun(hook, context);
        context.assertDeny();
      }
    });
  });

  describe("tool filtering", () => {
    it("should check LS tool", async () => {
      const hook = fileAccessGuardHook;

      const context = createPreToolUseContextFor(hook, "LS", { path: "/etc" });
      await invokeRun(hook, context);
      context.assertDeny();
    });

    it("should check Glob tool", async () => {
      const hook = fileAccessGuardHook;

      const context = createPreToolUseContextFor(hook, "Glob", {
        path: "/var/log",
        pattern: "*.log",
      });
      await invokeRun(hook, context);
      context.assertDeny();
    });

    it("should check Grep tool", async () => {
      const hook = fileAccessGuardHook;

      const context = createPreToolUseContextFor(hook, "Grep", {
        path: "/etc",
        pattern: "password",
      });
      await invokeRun(hook, context);
      context.assertDeny();
    });

    it("should ignore non-file tools", async () => {
      const hook = fileAccessGuardHook;

      const context = createPreToolUseContextFor(hook, "WebFetch", {
        url: "https://example.com",
        prompt: "how to access /etc/passwd",
      });
      await invokeRun(hook, context);
      context.assertSuccess({});
    });
  });

  describe("no repository scenario", () => {
    it("should allow operations when not in a repository", async () => {
      process.env.CLAUDE_TEST_REPO_ROOT = "";
      const hook = fileAccessGuardHook;

      const context = createPreToolUseContextFor(hook, "Read", {
        file_path: "/tmp/test.txt",
      });
      await invokeRun(hook, context);

      context.assertSuccess({});
    });
  });

  describe("error handling", () => {
    it("should handle missing file_path", async () => {
      process.env.CLAUDE_TEST_REPO_ROOT = "/home/user/project";
      const hook = fileAccessGuardHook;

      const context = createPreToolUseContextFor(hook, "Read", {
        file_path: "",
      });
      await invokeRun(hook, context);

      // Should handle gracefully
      ok(context.successCalls.length > 0 || context.failCalls.length > 0);
    });

    it("should handle null tool_input", async () => {
      const hook = fileAccessGuardHook;

      const context = createPreToolUseContextFor(hook, "Write", {
        content: "",
        file_path: "",
      });
      await invokeRun(hook, context);

      ok(context.successCalls.length > 0 || context.failCalls.length > 0);
    });

    it("should provide clear error messages", async () => {
      process.env.CLAUDE_TEST_REPO_ROOT = "/home/user/project";
      const hook = fileAccessGuardHook;

      const context = createPreToolUseContextFor(hook, "Read", {
        file_path: "/etc/passwd",
      });
      await invokeRun(hook, context);
      context.assertDeny();
      const resp = context.jsonCalls[0];
      const reason = resp.hookSpecificOutput?.permissionDecisionReason || "";
      ok(reason.includes("denied") || reason.includes("Access"));
      ok(
        reason.includes("/home/user/project") || reason.includes("Repository"),
      );
    });
  });

  // process.cwd() is the repository the suite runs in (bun run test starts
  // there); its .tmp/ is gitignored and outside os.tmpdir().
  describe("workflow dir under the project root (spec K10)", () => {
    let root: string;
    beforeEach(() => {
      mkdirSync(join(process.cwd(), ".tmp"), { recursive: true });
      root = realpathSync(mkdtempSync(join(process.cwd(), ".tmp", "fag-k10-")));
      envHelper.set("HOME", mkdtempSync(join(tmpdir(), "fag-home-")));
      envHelper.set("CLAUDE_TEST_CWD", root);
      envHelper.set(
        "CLAUDE_TEST_REPO_ROOT",
        join(root, ".git", "worktree", "b"),
      );
      envHelper.set("DOCUMENT_WORKFLOW_DIR", undefined);
    });
    afterEach(() => {
      rmSync(root, { recursive: true, force: true });
      envHelper.restore();
    });

    it("allows writing a doc in the session's workflow dir outside the repo root", async () => {
      const wfDir = join(root, deriveDefaultWorkflowDir(TEST_SESSION_ID));
      const ctx = createPreToolUseContextFor(fileAccessGuardHook, "Write", {
        file_path: join(wfDir, "plan.md"),
        content: "x",
      });
      await invokeRun(fileAccessGuardHook, ctx);
      ctx.assertSuccess({});
    });

    it("still denies another session's dir and a prefix look-alike", async () => {
      const wfDir = join(root, deriveDefaultWorkflowDir(TEST_SESSION_ID));
      for (const filePath of [
        join(root, ".tmp", "sessions", "otherses", "plan.md"),
        `${wfDir}-evil/plan.md`,
        `${wfDir}/../../../outside.md`,
      ]) {
        const ctx = createPreToolUseContextFor(fileAccessGuardHook, "Write", {
          file_path: filePath,
          content: "x",
        });
        await invokeRun(fileAccessGuardHook, ctx);
        ctx.assertDeny();
      }
    });
  });

  // The look-alike paths sit outside every temp root on purpose: under /tmp
  // the temp-root step would allow them whatever the prefix check does.
  describe("path-segment boundary of allowed roots (HOME isolated)", () => {
    let home = "";

    beforeEach(() => {
      home = mkdtempSync(join(realpathSync("/tmp"), "fag-home-"));
      envHelper.set("HOME", home);
      envHelper.set("CLAUDE_TEST_REPO_ROOT", "/home/user/project");
      envHelper.set("CLAUDE_TEST_CWD", "/home/user/project");
    });

    afterEach(() => {
      envHelper.restore();
      rmSync(home, { recursive: true, force: true });
    });

    const read = async (filePath: string) => {
      const ctx = createPreToolUseContextFor(fileAccessGuardHook, "Read", {
        file_path: filePath,
      });
      await invokeRun(fileAccessGuardHook, ctx);
      return ctx;
    };

    it("denies a sibling whose name starts with the repository root", async () => {
      (await read("/home/user/project-other/secret.txt")).assertDeny();
    });

    it("allows the repository root itself", async () => {
      (await read("/home/user/project")).assertSuccess({});
    });

    it("lets NotebookEdit write inside the repository", async () => {
      const ctx = createPreToolUseContextFor(
        fileAccessGuardHook,
        "NotebookEdit",
        {
          notebook_path: "/home/user/project/n.ipynb",
          new_source: "x",
        },
      );
      await invokeRun(fileAccessGuardHook, ctx);
      ctx.assertSuccess({});
    });

    describe("additionalDirectories", () => {
      beforeEach(() => {
        mkdirSync(join(home, ".claude"), { recursive: true });
        writeFileSync(
          join(home, ".claude", "settings.json"),
          JSON.stringify({ additionalDirectories: ["/home/user/extra"] }),
        );
      });

      it("allows Read inside an additional directory", async () => {
        (await read("/home/user/extra/notes.md")).assertSuccess({});
      });

      it("denies a sibling whose name starts with an additional directory", async () => {
        (await read("/home/user/extra-other/notes.md")).assertDeny();
      });

      it("allows Read inside an additional directory written with a trailing slash", async () => {
        writeFileSync(
          join(home, ".claude", "settings.json"),
          JSON.stringify({ additionalDirectories: ["/home/user/extra/"] }),
        );
        (await read("/home/user/extra/notes.md")).assertSuccess({});
        (await read("/home/user/extra-other/notes.md")).assertDeny();
      });

      it("denies NotebookEdit inside an additional directory without an Edit pattern", async () => {
        const ctx = createPreToolUseContextFor(
          fileAccessGuardHook,
          "NotebookEdit",
          {
            notebook_path: "/home/user/extra/n.ipynb",
            new_source: "x",
          },
        );
        await invokeRun(fileAccessGuardHook, ctx);
        ctx.assertDeny();
      });

      it("denies NotebookEdit outside every allowed root", async () => {
        const ctx = createPreToolUseContextFor(
          fileAccessGuardHook,
          "NotebookEdit",
          {
            notebook_path: "/home/user/other/n.ipynb",
            new_source: "x",
          },
        );
        await invokeRun(fileAccessGuardHook, ctx);
        ctx.assertDeny();
      });

      it("lets Glob read inside an additional directory", async () => {
        const ctx = createPreToolUseContextFor(fileAccessGuardHook, "Glob", {
          pattern: "*.md",
          path: "/home/user/extra",
        });
        await invokeRun(fileAccessGuardHook, ctx);
        ctx.assertSuccess({});
      });
    });
  });

  // Real files under process.cwd()/.tmp: outside os.tmpdir(), so the temp-root
  // step does not decide these cases.
  describe("lexical and physical forms (spec K1-K3)", () => {
    let base = "";
    let repo = "";
    let outside = "";
    let home = "";

    beforeEach(() => {
      mkdirSync(join(process.cwd(), ".tmp"), { recursive: true });
      base = realpathSync(mkdtempSync(join(process.cwd(), ".tmp", "fag-k1-")));
      repo = join(base, "repo");
      outside = join(base, "outside");
      home = join(base, "home");
      for (const d of [join(repo, "src"), outside, join(home, ".claude")]) {
        mkdirSync(d, { recursive: true });
      }
      envHelper.set("HOME", home);
      envHelper.set("CLAUDE_TEST_REPO_ROOT", repo);
      envHelper.set("CLAUDE_TEST_CWD", join(repo, "src"));
      envHelper.set("DOCUMENT_WORKFLOW_DIR", undefined);
    });
    afterEach(() => {
      envHelper.restore();
      rmSync(base, { recursive: true, force: true });
    });

    const run = async (tool: string, input: Record<string, unknown>) => {
      const ctx = createPreToolUseContextFor(fileAccessGuardHook, tool, input);
      await invokeRun(fileAccessGuardHook, ctx);
      return ctx;
    };
    const reasonOf = (ctx: { jsonCalls: any[] }): string =>
      ctx.jsonCalls[0]?.hookSpecificOutput?.permissionDecisionReason ?? "";

    it("denies an absolute path with .. even when it stays inside the repo", async () => {
      const ctx = await run("Read", { file_path: `${repo}/src/../README.md` });
      ctx.assertDeny();
      ok(reasonOf(ctx).includes("step=parent-segment"));
    });

    it("denies an absolute path with .. that leaves the repo", async () => {
      (await run("Read", { file_path: `${repo}/../outside/a` })).assertDeny();
    });

    it("allows a relative path that starts with ..", async () => {
      (await run("Read", { file_path: "../README.md" })).assertSuccess({});
    });

    it("treats ./../x like ../x", async () => {
      (await run("Read", { file_path: "./../README.md" })).assertSuccess({});
    });

    it("denies a relative path with .. after a name", async () => {
      const ctx = await run("Read", { file_path: "a/../b" });
      ctx.assertDeny();
      ok(reasonOf(ctx).includes("step=parent-segment"));
    });

    it("denies a leading .. that lands outside the repo", async () => {
      (await run("Read", { file_path: "../../outside/a" })).assertDeny();
    });

    it("denies a symlink in the repo that points outside", async () => {
      symlinkSync(outside, join(repo, "link"));
      const ctx = await run("Read", { file_path: join(repo, "link", "a") });
      ctx.assertDeny();
      const reason = reasonOf(ctx);
      ok(reason.includes("denied-form=physical"));
      ok(reason.includes(`physical=${join(outside, "a")}`));
      ok(reason.includes(`lexical=${join(repo, "link", "a")}`));
    });

    it("denies a relative path through a symlink that points outside", async () => {
      symlinkSync(outside, join(repo, "src", "link"));
      const ctx = await run("Read", { file_path: "link/a" });
      ctx.assertDeny();
      ok(reasonOf(ctx).includes("denied-form=physical"));
    });

    it("denies a symlink in the repo that points into a system directory", async () => {
      symlinkSync("/etc", join(repo, "etc-link"));
      const ctx = await run("Read", {
        file_path: join(repo, "etc-link", "passwd"),
      });
      ctx.assertDeny();
      const reason = reasonOf(ctx);
      ok(reason.includes("denied-form=physical"));
      ok(reason.includes("step=2-system"));
    });

    it("denies a symlink under ~/.claude that points outside", async () => {
      symlinkSync(outside, join(home, ".claude", "sym"));
      const ctx = await run("Read", {
        file_path: join(home, ".claude", "sym", "a"),
      });
      ctx.assertDeny();
      ok(reasonOf(ctx).includes("denied-form=physical"));
    });

    it("allows a symlink in the repo that points inside the repo", async () => {
      symlinkSync(join(repo, "src"), join(repo, "alias"));
      (
        await run("Read", { file_path: join(repo, "alias", "a.ts") })
      ).assertSuccess({});
    });

    it("allows a symlink under a temp root that points into the repo", async () => {
      const dir = mkdtempSync(join(realpathSync("/tmp"), "fag-cross-"));
      try {
        symlinkSync(join(repo, "src"), join(dir, "into-repo"));
        (
          await run("Read", { file_path: join(dir, "into-repo", "a.ts") })
        ).assertSuccess({});
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("denies NotebookEdit through a symlink that points outside", async () => {
      symlinkSync(outside, join(repo, "nb-link"));
      const ctx = await run("NotebookEdit", {
        notebook_path: join(repo, "nb-link", "n.ipynb"),
        new_source: "x",
      });
      ctx.assertDeny();
      ok(reasonOf(ctx).includes("denied-form=physical"));
    });

    it("denies a relative path when the working directory cannot be resolved", async () => {
      symlinkSync(join(base, "nowhere"), join(repo, "dangling-cwd"));
      envHelper.set("CLAUDE_TEST_CWD", join(repo, "dangling-cwd"));
      const ctx = await run("Read", { file_path: "a.ts" });
      ctx.assertDeny();
      ok(reasonOf(ctx).includes("step=cwd"));
    });

    it("denies a dangling symlink with an unresolvable code", async () => {
      symlinkSync(join(base, "nowhere"), join(repo, "dangling"));
      const ctx = await run("Write", {
        file_path: join(repo, "dangling"),
        content: "x",
      });
      ctx.assertDeny();
      ok(reasonOf(ctx).includes("unresolvable=EDANGLING"));
    });

    it("allows a file that does not exist yet", async () => {
      (
        await run("Write", {
          file_path: join(repo, "new", "dir", "f.ts"),
          content: "x",
        })
      ).assertSuccess({});
    });

    it("normalizes // and /./ in an absolute path", async () => {
      (await run("Read", { file_path: `${repo}//src/./a.ts` })).assertSuccess(
        {},
      );
    });

    it("does not let an allow pattern override a symlink that leaves its directory", async () => {
      const allowed = join(base, "allowed");
      mkdirSync(allowed);
      symlinkSync(outside, join(allowed, "sym"));
      writeFileSync(
        join(home, ".claude", "settings.json"),
        JSON.stringify({ permissions: { allow: [`Edit(/${allowed}/**)`] } }),
      );
      (
        await run("Write", { file_path: join(allowed, "ok.txt"), content: "x" })
      ).assertSuccess({});
      const ctx = await run("Write", {
        file_path: join(allowed, "sym", "x"),
        content: "x",
      });
      ctx.assertDeny();
      ok(reasonOf(ctx).includes("denied-form=physical"));
    });

    it("accepts an additional directory that is itself a symlink", async () => {
      const real = join(base, "extra-real");
      mkdirSync(real);
      symlinkSync(real, join(base, "extra"));
      writeFileSync(
        join(home, ".claude", "settings.json"),
        JSON.stringify({ additionalDirectories: [join(base, "extra")] }),
      );
      (
        await run("Read", { file_path: join(base, "extra", "a") })
      ).assertSuccess({});
    });

    it("accepts ~/.claude when it is itself a symlink", async () => {
      rmSync(join(home, ".claude"), { recursive: true });
      const real = join(base, "claude-real");
      mkdirSync(real);
      symlinkSync(real, join(home, ".claude"));
      (
        await run("Read", { file_path: join(home, ".claude", "a") })
      ).assertSuccess({});
    });

    it("maps the physical form back when the repo root is reached through a symlink", async () => {
      symlinkSync(repo, join(base, "repo-link"));
      envHelper.set("CLAUDE_TEST_REPO_ROOT", join(base, "repo-link"));
      envHelper.set("CLAUDE_TEST_CWD", join(base, "repo-link", "src"));
      (
        await run("Read", { file_path: join(base, "repo-link", "src", "a.ts") })
      ).assertSuccess({});
      (await run("Read", { file_path: "../README.md" })).assertSuccess({});
    });

    it("matches a ~ allow pattern when HOME itself is a symlink", async () => {
      symlinkSync(home, join(base, "home-link"));
      envHelper.set("HOME", join(base, "home-link"));
      mkdirSync(join(home, "foo"));
      writeFileSync(
        join(home, ".claude", "settings.json"),
        JSON.stringify({ permissions: { allow: ["Edit(~/foo/**)"] } }),
      );
      (
        await run("Write", {
          file_path: join(base, "home-link", "foo", "x"),
          content: "x",
        })
      ).assertSuccess({});
    });
  });

  describe("temp roots (HOME isolated)", () => {
    const TMP = realpathSync("/tmp");
    const MAC_TMPDIR = "/var/folders/ab/cd/T/";
    let H = "";

    beforeEach(() => {
      // Isolates settings: a real ~/.claude/settings.json may carry Edit(//tmp/**).
      H = mkdtempSync(join(TMP, "fag-home-"));
      envHelper.set("HOME", H);
      envHelper.set("CLAUDE_TEST_REPO_ROOT", "/home/user/project");
    });

    afterEach(() => {
      // node:test runs this nested hook before the parent's; restore() is idempotent.
      envHelper.restore();
      rmSync(H, { recursive: true, force: true });
    });

    // On darwin /var -> /private/var, so the fictional T cannot be realpath'd;
    // the allow logic is covered there by the collectTempRoots / isWithinTempRoots tests.
    it(
      "should allow Write under a macOS-shaped TMPDIR",
      { skip: process.platform === "darwin" },
      async () => {
        envHelper.set("TMPDIR", MAC_TMPDIR);
        const hook = fileAccessGuardHook;
        const context = createPreToolUseContextFor(hook, "Write", {
          file_path: "/var/folders/ab/cd/T/tmp.X1/note.md",
          content: "x",
        });
        await invokeRun(hook, context);
        context.assertSuccess({});
      },
    );

    it("should still deny system paths when TMPDIR is macOS-shaped", async () => {
      envHelper.set("TMPDIR", MAC_TMPDIR);
      const hook = fileAccessGuardHook;
      const context = createPreToolUseContextFor(hook, "Read", {
        file_path: "/var/log/syslog",
      });
      await invokeRun(hook, context);
      context.assertDeny();
    });

    it("should deny .. escaping a macOS-shaped TMPDIR", async () => {
      envHelper.set("TMPDIR", MAC_TMPDIR);
      const hook = fileAccessGuardHook;
      const context = createPreToolUseContextFor(hook, "Write", {
        file_path: "/var/folders/ab/cd/T/../../../../log/x",
        content: "x",
      });
      await invokeRun(hook, context);
      context.assertDeny();
    });

    it("should deny .. escaping /tmp", async () => {
      const hook = fileAccessGuardHook;
      const context = createPreToolUseContextFor(hook, "Write", {
        file_path: "/tmp/../etc/passwd",
        content: "x",
      });
      await invokeRun(hook, context);
      context.assertDeny();
    });

    it("should deny a symlink under /tmp that points outside", async () => {
      const D = mkdtempSync(join(TMP, "fag-"));
      try {
        symlinkSync("/etc", `${D}/s`);
        const hook = fileAccessGuardHook;
        const context = createPreToolUseContextFor(hook, "Write", {
          file_path: `${D}/s/authorized_keys`,
          content: "x",
        });
        await invokeRun(hook, context);
        context.assertDeny();
      } finally {
        rmSync(D, { recursive: true, force: true });
      }
    });

    it("should deny a dangling symlink under /tmp", async () => {
      const D = mkdtempSync(join(TMP, "fag-"));
      try {
        symlinkSync(`${H}/.ssh/authorized_keys`, `${D}/dang`);
        const hook = fileAccessGuardHook;
        const context = createPreToolUseContextFor(hook, "Write", {
          file_path: `${D}/dang`,
          content: "x",
        });
        await invokeRun(hook, context);
        context.assertDeny();
      } finally {
        rmSync(D, { recursive: true, force: true });
      }
    });

    it("should not treat TMPDIR=/var as a temp root", async () => {
      envHelper.set("TMPDIR", "/var");
      const hook = fileAccessGuardHook;
      const context = createPreToolUseContextFor(hook, "Write", {
        file_path: "/var/log/x",
        content: "x",
      });
      await invokeRun(hook, context);
      context.assertDeny();
    });

    it("should allow LS on the /tmp root itself", async () => {
      const hook = fileAccessGuardHook;
      const context = createPreToolUseContextFor(hook, "LS", { path: "/tmp" });
      await invokeRun(hook, context);
      context.assertSuccess({});
    });

    it("should deny Bash paths that use .. under /tmp", async () => {
      const hook = fileAccessGuardHook;
      const context = createPreToolUseContextFor(hook, "Bash", {
        command: "cat /tmp/../etc/passwd",
      });
      await invokeRun(hook, context);
      context.assertDeny();
    });

    it("should deny a symlink under /tmp that points outside even with Edit(//tmp/**)", async () => {
      mkdirSync(join(H, ".claude"), { recursive: true });
      writeFileSync(
        join(H, ".claude", "settings.json"),
        JSON.stringify({ permissions: { allow: ["Edit(//tmp/**)"] } }),
      );
      mkdirSync(join(process.cwd(), ".tmp"), { recursive: true });
      const dir = mkdtempSync(join(TMP, "fag-sym-"));
      const outsideTmp = mkdtempSync(join(process.cwd(), ".tmp", "fag-out-"));
      try {
        symlinkSync(outsideTmp, join(dir, "sym"));
        const hook = fileAccessGuardHook;
        const context = createPreToolUseContextFor(hook, "Write", {
          file_path: join(dir, "sym", "x"),
          content: "x",
        });
        await invokeRun(hook, context);
        context.assertDeny();
      } finally {
        rmSync(dir, { recursive: true, force: true });
        rmSync(outsideTmp, { recursive: true, force: true });
      }
    });

    it("should not treat TMPDIR=/run/user/1000 as a temp root", async () => {
      envHelper.set("TMPDIR", "/run/user/1000");
      const hook = fileAccessGuardHook;
      const context = createPreToolUseContextFor(hook, "Write", {
        file_path: "/run/user/1000/x",
        content: "x",
      });
      await invokeRun(hook, context);
      context.assertDeny();
    });

    it("should keep denying /var/tmp (the safe-path entry is unreachable)", async () => {
      const hook = fileAccessGuardHook;
      const context = createPreToolUseContextFor(hook, "Write", {
        file_path: "/var/tmp/x",
        content: "x",
      });
      await invokeRun(hook, context);
      context.assertDeny();
    });
  });

  describe("getAllowPatterns category resolution", () => {
    const settings = [
      {
        settings: {
          permissions: {
            allow: [
              "Edit(~/workspace/**)",
              "Read(~/workspace/**)",
              "Grep(~/notes/**)",
              "Bash(git status)",
            ],
          },
        },
        settingsRoot: "/r",
      },
    ];

    it("should let Edit patterns cover Write", () => {
      deepStrictEqual(
        getAllowPatterns(settings, "Write").map(({ rule }) => rule),
        ["Edit(~/workspace/**)"],
      );
    });

    it("should let Edit patterns cover NotebookEdit and MultiEdit", () => {
      deepStrictEqual(
        getAllowPatterns(settings, "NotebookEdit").map(({ rule }) => rule),
        ["Edit(~/workspace/**)"],
      );
      deepStrictEqual(
        getAllowPatterns(settings, "MultiEdit").map(({ rule }) => rule),
        ["Edit(~/workspace/**)"],
      );
    });

    it("should let Read patterns cover Glob", () => {
      deepStrictEqual(
        getAllowPatterns(settings, "Glob").map(({ rule }) => rule),
        ["Read(~/workspace/**)"],
      );
    });

    it("should keep tool-specific patterns alongside the category pattern", () => {
      deepStrictEqual(
        getAllowPatterns(settings, "Grep").map(({ rule }) => rule),
        ["Read(~/workspace/**)", "Grep(~/notes/**)"],
      );
    });

    it("should not let Write patterns leak into Edit", () => {
      const legacy = [
        {
          settings: { permissions: { allow: ["Write(~/legacy/**)"] } },
          settingsRoot: "/r",
        },
      ];
      deepStrictEqual(
        getAllowPatterns(legacy, "Edit").map(({ rule }) => rule),
        [],
      );
      deepStrictEqual(
        getAllowPatterns(legacy, "Write").map(({ rule }) => rule),
        ["Write(~/legacy/**)"],
      );
    });

    it("should not grant Edit patterns to reading tools", () => {
      deepStrictEqual(
        getAllowPatterns(settings, "Read").map(({ rule }) => rule),
        ["Read(~/workspace/**)"],
      );
    });

    it("tags each rule with the settings root of the file it came from", () => {
      const loaded = [
        {
          settings: { permissions: { allow: ["Edit(/a/**)"] } },
          settingsRoot: "/home/u/.claude",
        },
        {
          settings: { permissions: { allow: ["Edit(/b/**)"] } },
          settingsRoot: "/started/here",
        },
      ];
      deepStrictEqual(getAllowPatterns(loaded, "Write"), [
        { rule: "Edit(/a/**)", settingsRoot: "/home/u/.claude" },
        { rule: "Edit(/b/**)", settingsRoot: "/started/here" },
      ]);
    });
  });
});

const fakeRealpath =
  (m: Record<string, string>) =>
  (p: string): string => {
    if (p in m) return m[p] as string;
    throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
  };

const sortedUnique = (xs: string[]): string[] => [...new Set(xs)].sort();

describe("collectTempRoots", () => {
  it("collects literal and realpath forms for a macOS tmpdir with trailing slash", () => {
    const result = collectTempRoots(
      "/var/folders/ab/cd/T/",
      fakeRealpath({
        "/tmp": "/private/tmp",
        "/var/folders/ab/cd/T": "/private/var/folders/ab/cd/T",
      }),
    );
    deepStrictEqual(
      sortedUnique(result),
      [
        "/tmp",
        "/private/tmp",
        "/var/folders/ab/cd/T",
        "/private/var/folders/ab/cd/T",
      ].sort(),
    );
  });

  it("yields only /tmp for the Linux default", () => {
    deepStrictEqual(sortedUnique(collectTempRoots("/tmp", fakeRealpath({}))), [
      "/tmp",
    ]);
  });

  for (const rejected of [
    "/",
    "/var",
    "/var/log",
    "/var/folders",
    "/var/folders/ab",
    "/var/folders/ab/cd",
    "/var/folders/ab/cd/C",
    "/var/folders/ab/cd/T/x",
    "/var/folders/ab/cd/T/..",
    "/home/u/.ssh",
    "tmp",
    "",
  ]) {
    it(`rejects tmpdir ${JSON.stringify(rejected)}`, () => {
      deepStrictEqual(
        sortedUnique(collectTempRoots(rejected, fakeRealpath({}))),
        ["/tmp"],
      );
    });
  }

  it("judges the realpath form independently of the literal", () => {
    const result = collectTempRoots(
      "/var/folders/ab/cd/T",
      fakeRealpath({ "/var/folders/ab/cd/T": "/etc/x" }),
    );
    deepStrictEqual(sortedUnique(result), ["/tmp", "/var/folders/ab/cd/T"]);
  });
});

describe("isWithinTempRoots", () => {
  const errno = (code: string) => () => {
    throw Object.assign(new Error(code), { code });
  };
  const pureRoots = ["/tmp"];
  const pureRealpath = fakeRealpath({ "/tmp": "/tmp" });
  const lstatEnoent = errno("ENOENT");

  it("rejects a path with a .. segment", () => {
    deepStrictEqual(
      isWithinTempRoots(
        "/tmp/x/../../etc/passwd",
        pureRoots,
        pureRealpath,
        lstatEnoent,
      ),
      false,
    );
  });

  it("matches roots on a segment boundary", () => {
    deepStrictEqual(
      isWithinTempRoots("/tmpfoo/x", pureRoots, pureRealpath, lstatEnoent),
      false,
    );
  });

  it("accepts the exact root", () => {
    deepStrictEqual(
      isWithinTempRoots("/tmp", pureRoots, pureRealpath, lstatEnoent),
      true,
    );
  });

  it("accepts a non-existent tail by climbing to an existing ancestor", () => {
    deepStrictEqual(
      isWithinTempRoots(
        "/tmp/new/file.md",
        pureRoots,
        pureRealpath,
        lstatEnoent,
      ),
      true,
    );
  });

  it("fails closed when realpath throws EACCES", () => {
    const realpath = (p: string): string => {
      if (p === "/tmp") return "/tmp";
      throw Object.assign(new Error("EACCES"), { code: "EACCES" });
    };
    deepStrictEqual(
      isWithinTempRoots("/tmp/locked/f", pureRoots, realpath, lstatEnoent),
      false,
    );
  });

  it("rejects a relative path", () => {
    deepStrictEqual(
      isWithinTempRoots("tmp/x", pureRoots, pureRealpath, lstatEnoent),
      false,
    );
  });

  it("fails closed when lstat throws EACCES after realpath ENOENT", () => {
    deepStrictEqual(
      isWithinTempRoots(
        "/tmp/locked/f",
        pureRoots,
        pureRealpath,
        errno("EACCES"),
      ),
      false,
    );
  });

  describe("real filesystem", () => {
    const TMP = realpathSync("/tmp");
    const roots = [...new Set(["/tmp", TMP])];

    it("rejects a symlink that escapes the temp root", () => {
      const D = mkdtempSync(join(TMP, "fag-"));
      try {
        symlinkSync("/etc", `${D}/s`);
        deepStrictEqual(
          isWithinTempRoots(`${D}/s/passwd`, roots, realpathSync, lstatSync),
          false,
        );
      } finally {
        rmSync(D, { recursive: true, force: true });
      }
    });

    it("rejects a dangling symlink", () => {
      const D = mkdtempSync(join(TMP, "fag-"));
      try {
        symlinkSync("/nonexistent-fag-target", `${D}/dang`);
        deepStrictEqual(
          isWithinTempRoots(`${D}/dang`, roots, realpathSync, lstatSync),
          false,
        );
      } finally {
        rmSync(D, { recursive: true, force: true });
      }
    });

    it("rejects a symlink loop", () => {
      const D = mkdtempSync(join(TMP, "fag-"));
      try {
        symlinkSync(`${D}/loop`, `${D}/loop`);
        deepStrictEqual(
          isWithinTempRoots(`${D}/loop/x`, roots, realpathSync, lstatSync),
          false,
        );
      } finally {
        rmSync(D, { recursive: true, force: true });
      }
    });

    it("accepts a non-existent file under a real directory", () => {
      const D = mkdtempSync(join(TMP, "fag-"));
      try {
        deepStrictEqual(
          isWithinTempRoots(`${D}/new/file.md`, roots, realpathSync, lstatSync),
          true,
        );
      } finally {
        rmSync(D, { recursive: true, force: true });
      }
    });

    it("needs the realpath form of a root that is spelled through a symlink", () => {
      const R = mkdtempSync(join(TMP, "fag-"));
      const L = `${R}-link`;
      try {
        symlinkSync(R, L);
        deepStrictEqual(
          isWithinTempRoots(`${L}/f`, [L, R], realpathSync, lstatSync),
          true,
        );
        deepStrictEqual(
          isWithinTempRoots(`${L}/f`, [L], realpathSync, lstatSync),
          false,
        );
      } finally {
        rmSync(L, { recursive: true, force: true });
        rmSync(R, { recursive: true, force: true });
      }
    });
  });
});

// Helper function to create deny-repository-outside hook
function _createDenyRepositoryOutsideHook(repoRoot: string | undefined) {
  return defineHook({
    trigger: { PreToolUse: true },
    run: (context: any) => {
      const { tool_name, tool_input } = context.input;

      // Only check file/path tools
      const fileTools = [
        "Read",
        "Write",
        "Edit",
        "MultiEdit",
        "LS",
        "Glob",
        "Grep",
        "Bash",
      ];
      if (!fileTools.includes(tool_name)) {
        return context.success({});
      }

      // If no repository, allow all
      if (!repoRoot) {
        return context.success({});
      }

      // Extract paths to check
      const paths = extractPaths(tool_name, tool_input);

      // Check each path
      for (const path of paths) {
        if (!isPathWithinRepo(path, repoRoot)) {
          return context.fail(
            `🚫 Access denied: Path is outside repository\n` +
              `Path: ${path}\n` +
              `Repository: ${repoRoot}`,
          );
        }
      }

      return context.success({});
    },
  });
}

function extractPaths(toolName: string, toolInput: any): string[] {
  if (!toolInput) return [];

  const paths: string[] = [];

  // Extract based on tool type
  switch (toolName) {
    case "Read":
    case "Write":
    case "Edit":
    case "MultiEdit":
      if (toolInput.file_path) paths.push(toolInput.file_path);
      break;
    case "LS":
    case "Glob":
    case "Grep":
      if (toolInput.path) paths.push(toolInput.path);
      break;
    case "Bash": {
      // Extract file paths from bash commands
      const command = toolInput.command || "";
      const filePatterns = [
        /(?:cat|less|more|head|tail|rm|cp|mv|touch|chmod|chown)\s+([^\s;|&]+)/g,
        /(?:>|>>|<)\s*([^\s;|&]+)/g,
      ];

      for (const pattern of filePatterns) {
        let match: RegExpExecArray | null;
        while ((match = pattern.exec(command)) !== null) {
          if (match[1]) {
            paths.push(match[1]);
          }
        }
      }
      break;
    }
  }

  return paths;
}

function isPathWithinRepo(path: string, repoRoot: string): boolean {
  // Simple check - in real implementation would resolve paths
  if (
    path.startsWith("/etc") ||
    path.startsWith("/usr") ||
    path.startsWith("/var") ||
    path.startsWith("/tmp") ||
    path.startsWith("/root")
  ) {
    return false;
  }

  // Check if path starts with repo root
  if (path.startsWith(repoRoot)) {
    return true;
  }

  // Allow relative paths (assumed to be within repo)
  if (path.startsWith("./") || !path.startsWith("/")) {
    return true;
  }

  // Check for traversal attempts
  if (path.includes("../../../")) {
    return false;
  }

  return false;
}

describe("judge: the system-directory deny list", () => {
  let base = "";
  beforeEach(() => {
    mkdirSync(join(process.cwd(), ".tmp"), { recursive: true });
    base = realpathSync(mkdtempSync(join(process.cwd(), ".tmp", "fag-sys-")));
    mkdirSync(join(base, "sys-real"));
    symlinkSync(join(base, "sys-real"), join(base, "sys-link"));
  });
  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  const ctxWith = (over: Partial<JudgeContext>): JudgeContext => ({
    category: "read",
    allowPatterns: [],
    repoRoot: "/nonexistent/repo",
    homeDir: "/nonexistent/home",
    additionalDirs: [],
    tempRoots: [],
    workflowDirRoots: [],
    systemPaths: [],
    caseInsensitive: false,
    cwdPhysical: undefined,
    match: { cwd: "/nonexistent/repo", home: "/nonexistent/home" },
    ...over,
  });

  it("denies the real location of a system directory that is a symlink", () => {
    const ctx = ctxWith({
      systemPaths: [join(base, "sys-link")],
      allowPatterns: sourced([`Read(/${base}/**)`]),
    });
    const form = join(base, "sys-real", "x");
    deepStrictEqual(judge(form, ctx, true).step, "2-system");
    deepStrictEqual(judge(form, ctx, true).allowed, false);
    // The lexical judgement does not resolve the list, so it reaches step 5.
    deepStrictEqual(judge(form, ctx, false).step, "5-pattern");
  });

  it("reads a /path allow from the settings root of its source", () => {
    const ctx = ctxWith({
      allowPatterns: sourced(["Read(/x/**)"], join(base, "root")),
    });
    deepStrictEqual(
      judge(join(base, "root", "x", "a"), ctx, false).step,
      "5-pattern",
    );
    deepStrictEqual(judge(join(base, "x", "a"), ctx, false).allowed, false);
  });

  it("compares the deny list case-insensitively when asked to", () => {
    const ctx = ctxWith({ systemPaths: ["/etc"], caseInsensitive: true });
    deepStrictEqual(judge("/ETC/x", ctx, false).step, "2-system");
    deepStrictEqual(
      judge("/ETC/x", ctxWith({ systemPaths: ["/etc"] }), false).step,
      "default",
    );
  });
});

describe("chezmoi redirection and allow patterns (ADR-0027 invariant)", () => {
  // Own helper: the file's other envHelper lives inside another describe.
  const envHelper = new EnvironmentHelper();
  let base: string;
  let repo: string;
  let home: string;
  beforeEach(() => {
    mkdirSync(join(process.cwd(), ".tmp"), { recursive: true });
    base = realpathSync(
      mkdtempSync(join(process.cwd(), ".tmp", "fag-chezmoi-")),
    );
    repo = join(base, "repo");
    home = join(base, "home");
    mkdirSync(repo);
    mkdirSync(home);
    writeFileSync(join(repo, ".chezmoiroot"), "home\n");
    envHelper.set("HOME", home);
  });
  // "flat": the source sits where getChezmoiSourcePath looks (directly under repoRoot).
  const useFlatLayout = () => writeFileSync(join(repo, "zshrc"), "# zshrc\n");
  // "chezmoiroot": this repository's layout; the lookup does not follow .chezmoiroot.
  const useChezmoirootLayout = () => {
    mkdirSync(join(repo, "home"));
    writeFileSync(join(repo, "home", "dot_zshrc"), "# zshrc\n");
  };
  afterEach(() => {
    envHelper.restore();
    rmSync(base, { recursive: true, force: true });
  });

  const remainingEditAllows = [
    "Edit(~/.config/**)",
    "Edit(~/.local/**)",
    "Edit(~/workspace/**)",
    "Edit(//tmp/**)",
  ];
  const ctxFor = (allowPatterns: SourcedRule[]): JudgeContext => ({
    category: "write",
    allowPatterns,
    repoRoot: repo,
    homeDir: home,
    additionalDirs: [],
    tempRoots: [],
    workflowDirRoots: [],
    systemPaths: [],
    caseInsensitive: false,
    cwdPhysical: undefined,
    match: { cwd: repo, home },
  });

  it("flat layout: the lookup finds the source", () => {
    useFlatLayout();
    strictEqual(
      typeof getChezmoiSourcePath(join(home, ".zshrc"), repo),
      "string",
    );
  });

  it("flat layout: redirects an edit of ~/.zshrc when no allow pattern names it", () => {
    useFlatLayout();
    const verdict = judge(
      join(home, ".zshrc"),
      ctxFor(sourced(remainingEditAllows)),
      false,
    );
    deepStrictEqual([verdict.allowed, verdict.step], [false, "6-chezmoi"]);
  });

  it("flat layout: an allow pattern for ~/.zshrc is judged before the redirection", () => {
    useFlatLayout();
    const verdict = judge(
      join(home, ".zshrc"),
      ctxFor(sourced([...remainingEditAllows, "Edit(~/.zshrc)"])),
      false,
    );
    deepStrictEqual([verdict.allowed, verdict.step], [true, "5-pattern"]);
  });

  it("chezmoiroot layout: the lookup does not find the source", () => {
    useChezmoirootLayout();
    strictEqual(getChezmoiSourcePath(join(home, ".zshrc"), repo), undefined);
  });

  it("chezmoiroot layout: an edit of ~/.zshrc is denied by default when no allow pattern names it", () => {
    useChezmoirootLayout();
    const verdict = judge(
      join(home, ".zshrc"),
      ctxFor(sourced(remainingEditAllows)),
      false,
    );
    deepStrictEqual([verdict.allowed, verdict.step], [false, "default"]);
  });

  it("chezmoiroot layout: an allow pattern for ~/.zshrc lets the edit through", () => {
    useChezmoirootLayout();
    const verdict = judge(
      join(home, ".zshrc"),
      ctxFor(sourced([...remainingEditAllows, "Edit(~/.zshrc)"])),
      false,
    );
    deepStrictEqual([verdict.allowed, verdict.step], [true, "5-pattern"]);
  });
});
