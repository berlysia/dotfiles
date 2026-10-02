#!/usr/bin/env node --test

import { deepStrictEqual, ok, strictEqual } from "node:assert";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, beforeEach, describe, it } from "node:test";
import { BOUNDARY_DENY_GUIDANCE } from "../../lib/context-helpers.ts";
import denyNodeModulesHook from "../../implementations/deny-node-modules.ts";
import {
  ConsoleCapture,
  createPreToolUseContext,
  defineHook,
  EnvironmentHelper,
  invokeRun,
} from "./test-helpers.ts";

describe("deny-node-modules.ts hook behavior", () => {
  const consoleCapture = new ConsoleCapture();
  const envHelper = new EnvironmentHelper();

  beforeEach(() => {
    consoleCapture.start();
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

  describe("node_modules detection", () => {
    it("should allow Read operations on node_modules files", async () => {
      const hook = denyNodeModulesHook;

      const context = createPreToolUseContext("Read", {
        file_path: "/project/node_modules/express/index.js",
      });
      await invokeRun(hook, context);

      context.assertSuccess({});
    });

    it("should block Write operations to node_modules", async () => {
      const hook = denyNodeModulesHook;

      const context = createPreToolUseContext("Write", {
        file_path: "/project/node_modules/package/file.js",
        content: "malicious code",
      });
      await invokeRun(hook, context);

      context.assertDeny();
      const reason =
        context.jsonCalls[0].hookSpecificOutput?.permissionDecisionReason || "";
      ok(reason.includes("node_modules"));
    });

    it("should block Edit operations in node_modules", async () => {
      const hook = denyNodeModulesHook;

      const context = createPreToolUseContext("Edit", {
        file_path: "./node_modules/lodash/index.js",
        old_string: "original",
        new_string: "modified",
      });
      await invokeRun(hook, context);

      context.assertDeny();
    });

    it("should block MultiEdit in node_modules", async () => {
      const hook = denyNodeModulesHook;

      const context = createPreToolUseContext("MultiEdit", {
        file_path: "node_modules/react/lib/React.js",
        edits: [],
      });
      await invokeRun(hook, context);

      context.assertDeny();
    });

    it("should block Bash commands operating on node_modules", async () => {
      const hook = denyNodeModulesHook;

      const context = createPreToolUseContext("Bash", {
        command: "rm -rf node_modules/some-package",
      });
      await invokeRun(hook, context);

      context.assertDeny();
      const reason2 =
        context.jsonCalls[0].hookSpecificOutput?.permissionDecisionReason || "";
      ok(reason2.includes("node_modules"));
    });

    it("should allow ls commands in node_modules", async () => {
      const hook = denyNodeModulesHook;

      const context = createPreToolUseContext("Bash", {
        command: "ls node_modules/",
      });
      await hook.run(context);

      context.assertSuccess({});
    });

    it("should allow read-only commands (cat, grep, find)", async () => {
      const hook = denyNodeModulesHook;

      const readOnlyCommands = [
        "cat node_modules/package/package.json",
        "grep version node_modules/*/package.json",
        "find node_modules -name '*.js'",
        "cd node_modules && pwd",
      ];

      for (const command of readOnlyCommands) {
        const context = createPreToolUseContext("Bash", { command });
        await hook.run(context);

        context.assertSuccess({});
        context.reset();
      }
    });

    it("should ask for unknown operations", async () => {
      const hook = denyNodeModulesHook;

      const context = createPreToolUseContext("Bash", {
        command: "custom-tool node_modules/file",
      });
      await hook.run(context);

      // Should return ask response
      strictEqual(context.jsonCalls.length, 1);
      const askReason =
        context.jsonCalls[0].hookSpecificOutput?.permissionDecisionReason || "";
      ok(askReason.includes("Unknown node_modules operation"));
    });

    it("should handle compound commands correctly", async () => {
      const hook = denyNodeModulesHook;

      // Should deny if any part is destructive
      const destructiveContext = createPreToolUseContext("Bash", {
        command: "cd /tmp && rm -rf node_modules",
      });
      await hook.run(destructiveContext);

      strictEqual(destructiveContext.jsonCalls.length, 1);
      const denyReason =
        destructiveContext.jsonCalls[0].hookSpecificOutput
          ?.permissionDecisionReason || "";
      ok(denyReason.includes("Destructive operation detected"));

      destructiveContext.reset();

      // Should allow if all parts are safe
      const safeContext = createPreToolUseContext("Bash", {
        command: "cd node_modules && ls && pwd",
      });
      await hook.run(safeContext);

      safeContext.assertSuccess({});
    });
  });

  describe("Path variations", () => {
    it("should detect node_modules in various path formats", async () => {
      const hook = denyNodeModulesHook;

      const pathVariations = [
        "node_modules/package/file.js",
        "./node_modules/package/file.js",
        "../node_modules/package/file.js",
        "/absolute/path/node_modules/file.js",
        "some/deep/path/node_modules/nested/file.js",
      ];

      for (const path of pathVariations) {
        const context = createPreToolUseContext("Write", {
          file_path: path,
          content: "asdf",
        });
        await hook.run(context);

        context.assertDeny();
      }
    });

    it("should allow operations outside node_modules", async () => {
      const hook = denyNodeModulesHook;

      const allowedPaths = [
        "/project/src/index.js",
        "./components/Button.tsx",
        "../shared/utils.js",
        "package.json",
        "node_modules_backup/file.js", // Similar name but not exact
        "my_node_modules_copy/file.js",
      ];

      for (const path of allowedPaths) {
        const context = createPreToolUseContext("Read", {
          file_path: path,
        });
        await hook.run(context);

        context.assertSuccess({});
        strictEqual(context.failCalls.length, 0, `Should allow path: ${path}`);
      }
    });
  });

  describe("Command detection", () => {
    it("should block various bash commands targeting node_modules", async () => {
      const hook = denyNodeModulesHook;

      const blockedCommands = [
        "rm -rf node_modules/some-package",
        "echo 'test' > node_modules/file.txt",
        "chmod 777 node_modules/script.sh",
      ];

      for (const command of blockedCommands) {
        const context = createPreToolUseContext("Bash", {
          command,
        });
        await hook.run(context);

        context.assertDeny();
      }
    });

    it("should allow bash commands not targeting node_modules", async () => {
      const hook = denyNodeModulesHook;

      const allowedCommands = [
        "npm install",
        "npm run build",
        "ls src/",
        "cat package.json",
        "echo 'test'",
        "pwd",
      ];

      for (const command of allowedCommands) {
        const context = createPreToolUseContext("Bash", {
          command,
        });
        await hook.run(context);

        context.assertSuccess({});
        strictEqual(
          context.failCalls.length,
          0,
          `Should allow command: ${command}`,
        );
      }
    });
  });

  describe("Tool filtering", () => {
    it("should ignore non-file tools", async () => {
      const hook = denyNodeModulesHook;

      const context = createPreToolUseContext("WebFetch", {
        url: "https://example.com",
        prompt: "node_modules documentation",
      });
      await hook.run(context);

      context.assertSuccess({});
    });

    it("should handle missing tool_input gracefully", async () => {
      const hook = denyNodeModulesHook;

      const context = createPreToolUseContext("Read", { file_path: "" });
      await hook.run(context);

      context.assertSuccess({});
    });

    it("should handle missing file_path gracefully", async () => {
      const hook = denyNodeModulesHook;

      const context = createPreToolUseContext("Read", { file_path: "" });
      await hook.run(context);

      context.assertSuccess({});
    });
  });

  describe("Error messages", () => {
    it("should provide clear error message for blocked operations", async () => {
      const hook = denyNodeModulesHook;

      const context = createPreToolUseContext("Write", {
        file_path: "node_modules/package/secret.key",
        content: "test",
      });
      await hook.run(context);

      context.assertDeny();
      const denyMsg =
        context.jsonCalls[0].hookSpecificOutput?.permissionDecisionReason || "";
      ok(
        denyMsg.includes("node_modules") ||
          denyMsg.includes("denied") ||
          denyMsg.includes("not allowed"),
      );
    });

    it("should mention security in error message", async () => {
      const hook = denyNodeModulesHook;

      const context = createPreToolUseContext("Write", {
        file_path: "node_modules/malicious/payload.js",
        content: "evil code",
      });
      await hook.run(context);

      context.assertDeny();
      const errorMsg =
        context.jsonCalls[0].hookSpecificOutput?.permissionDecisionReason || "";
      ok(
        errorMsg.includes("denied") ||
          errorMsg.includes("not allowed") ||
          errorMsg.includes("node_modules"),
      );
    });
  });
});

describe("deny-node-modules.ts boundary behaviour", () => {
  const tempDirs: string[] = [];
  after(() => {
    for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  });

  const root = mkdtempSync(join(tmpdir(), "dnm-"));
  tempDirs.push(root);
  ok(/^[A-Za-z0-9_\/.@+=:,-]+$/.test(root), root);
  mkdirSync(join(root, "target"));
  mkdirSync(join(root, "a"));
  mkdirSync(join(root, "c"));
  mkdirSync(join(root, "b", "node_modules"), { recursive: true });
  symlinkSync(join(root, "target"), join(root, "a", "node_modules"));
  symlinkSync(join(root, "target"), join(root, "c", "node_modules"));
  symlinkSync(join(root, "b"), join(root, "s"));
  writeFileSync(join(root, "f"), "x");
  const L = join(root, "a", "node_modules");
  const D = join(root, "b", "node_modules");
  const S = join(root, "s");

  async function runBash(command: string) {
    const context = createPreToolUseContext("Bash", { command });
    await invokeRun(denyNodeModulesHook, context);
    return context;
  }
  function reasonOf(context: { jsonCalls: any[] }): string {
    return (
      context.jsonCalls[0].hookSpecificOutput?.permissionDecisionReason || ""
    );
  }

  const successCmds = [
    `rm ${L}`,
    `rm -f ${L}`,
    `rm -f -f ${L}`,
    `unlink ${L}`,
    `rm ${L} ${join(root, "c", "node_modules")}`,
    "grep rm node_modules/x",
    "grep -rn unlink node_modules/x",
    "ls node_modules",
    'grep "a|rm" node_modules/x',
    'grep -e "rm -rf ${X}" node_modules/x',
  ];
  for (const cmd of successCmds) {
    it(`allows: ${cmd}`, async () => {
      const context = await runBash(cmd);
      context.assertSuccess({});
    });
  }

  const denyCmds = [
    `rm ${D}`,
    `rm -f ${D}`,
    `unlink ${D}`,
    `rm ${L}/`,
    `rm ${L}/.`,
    `rm ${L}/../node_modules`,
    `rm -rf ${L}`,
    `rm -- ${L}`,
    `rm "${L}"`,
    `rm ${L}/.bin/x`,
    `rm ${L} ${D}`,
    `unlink ${L} ${L}`,
    `rm ${S}/node_modules`,
    `rm ${root}/missing/node_modules`,
    `rm ${root}/f/node_modules`,
    `rm ${L};`,
    `W=${root}/a; rm $W/node_modules`,
    `ln -s /x ${root}/a/node_modules; rm ${root}/a/node_modules`,
    "rm -rf NODE_MODULES",
    "ls node_modules; rm -rf node_modules",
    "cat x | rm node_modules",
    "bash -c 'rm -rf node_modules'",
    "find . -name x | xargs rm -rf node_modules",
    "(rm -rf node_modules)",
    "echo $(rm -rf node_modules)",
    "find node_modules -delete",
    "find node_modules -exec env mv {} /tmp \\;",
    "sudo find node_modules -delete",
    "find node_modules -exec echo {} \\; > node_modules/x",
    "find x -name rm node_modules",
    "ls node_modules; grep rm node_modules/x",
    "\\grep rm node_modules/x",
    // parser returns "fallback" for this input (pinned in bash-parser.test.ts)
    'grep -e "rm" -e "xargs" node_modules/x',
  ];
  for (const cmd of denyCmds) {
    it(`denies with guidance: ${cmd}`, async () => {
      const context = await runBash(cmd);
      context.assertDeny();
      ok(reasonOf(context).includes(BOUNDARY_DENY_GUIDANCE));
    });
  }

  it("explains the standalone unlink route when a real directory is removed", async () => {
    const reason = reasonOf(await runBash(`rm -rf ${D}`));
    ok(reason.includes("Destructive operation detected"));
    ok(reason.includes("standalone"));
    ok(reason.includes("unlink"));
  });
  it("does not suggest unlink for find -delete", async () => {
    const reason = reasonOf(await runBash("find node_modules -delete"));
    ok(!reason.includes("unlink"));
  });

  describe("deny-side superset (spec K3)", () => {
    it("denies a heredoc-fed shell that removes node_modules", async () => {
      const context = await runBash("bash <<EOF\nrm -rf node_modules/x\nEOF");
      context.assertDeny();
    });
    it("does not pair a delete word and node_modules from different commands when the AST covers the input", async () => {
      (await runBash("ls && rm foo && ls node_modules")).assertSuccess({});
    });
    // Compound bodies such as `(rm foo; ls node_modules) 2>&1` are already
    // returned whole by the base fragmentation, so deny-node-modules denies them
    // today (a pre-existing false positive, F3b). K3 does not change that, and
    // the "not added whole" guarantee is pinned in bash-parser.test.ts.
  });

  const askCmds = [
    "python3 -c 'import shutil; shutil.rmtree(\"node_modules\")'",
    "git clean -fdx node_modules",
    "rsync -a --delete empty/ node_modules/",
    "/bin/ls node_modules",
    "\\ls node_modules",
    "find node_modules -exec echo {} \\;",
  ];
  for (const cmd of askCmds) {
    it(`asks: ${cmd}`, async () => {
      const context = await runBash(cmd);
      strictEqual(
        context.jsonCalls[0].hookSpecificOutput?.permissionDecision,
        "ask",
      );
    });
  }

  it("keeps the guidance on file-tool denies", async () => {
    const context = createPreToolUseContext("Write", {
      file_path: join(root, "a", "node_modules", "x"),
      content: "x",
    });
    await invokeRun(denyNodeModulesHook, context);
    context.assertDeny();
    ok(reasonOf(context).includes(BOUNDARY_DENY_GUIDANCE));
  });

  it("does not attach the guidance to the internal-error deny", () => {
    const src = readFileSync(
      join(
        import.meta.dirname,
        "..",
        "..",
        "implementations",
        "deny-node-modules.ts",
      ),
      "utf8",
    );
    const lines = src.split("\n");
    const idx = lines.findIndex((l) =>
      l.includes("Error in node_modules access check"),
    );
    ok(idx >= 0, "internal error line exists");
    const near = lines.slice(Math.max(0, idx - 2), idx + 1).join("\n");
    ok(near.includes("createDenyResponse("));
    ok(!near.includes("createBoundaryDenyResponse"));
  });
});
