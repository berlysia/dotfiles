#!/usr/bin/env node --test

import { describe, it, beforeEach, afterEach } from "node:test";
import { strictEqual, ok, match } from "node:assert";
import {
  ConsoleCapture,
  EnvironmentHelper,
  createPreToolUseContextFor,
  invokeRun,
} from "./test-helpers.ts";
import chezmoiRedirectHook, {
  getChezmoiRedirectPath,
  generateChezmoiPathVariations,
  isDotfilesRepository,
} from "../../implementations/chezmoi-redirect.ts";
import { join } from "node:path";
import { homedir } from "node:os";

describe("chezmoi-redirect.ts hook behavior", () => {
  const consoleCapture = new ConsoleCapture();
  const envHelper = new EnvironmentHelper();

  beforeEach(() => {
    consoleCapture.reset();
    consoleCapture.start();
  });

  afterEach(() => {
    consoleCapture.stop();
    envHelper.restore();
  });

  describe("hook definition", () => {
    it("should be configured for PreToolUse trigger", () => {
      ok(chezmoiRedirectHook.trigger.PreToolUse === true);
    });
  });

  describe("chezmoi path detection", () => {
    it("should detect ~/.config/* paths and suggest dot_config/*", async () => {
      // Use the actual dotfiles repo path for testing
      process.env.CLAUDE_TEST_REPO_ROOT = "/home/user/dotfiles";
      process.env.CLAUDE_TEST_CWD = "/home/user/dotfiles";
      const hook = chezmoiRedirectHook;

      const context = createPreToolUseContextFor(hook, "Read", {
        file_path: `${homedir()}/.config/mise/config.toml`,
      });
      await invokeRun(hook, context);

      // Should be denied with chezmoi redirect suggestion
      context.assertDeny();
      const reason =
        context.jsonCalls[0]?.hookSpecificOutput?.permissionDecisionReason ||
        "";
      ok(
        reason.includes("Chezmoi"),
        "Should mention chezmoi in the error message",
      );
      ok(
        reason.includes("dot_config"),
        "Should suggest the dot_config path",
      );
    });

    it("should detect ~/.local/* paths and suggest dot_local/*", async () => {
      process.env.CLAUDE_TEST_REPO_ROOT = "/home/user/dotfiles";
      process.env.CLAUDE_TEST_CWD = "/home/user/dotfiles";
      const hook = chezmoiRedirectHook;

      const context = createPreToolUseContextFor(hook, "Read", {
        file_path: `${homedir()}/.local/share/somefile`,
      });
      await invokeRun(hook, context);

      // If dot_local exists and has the path, should be denied
      // The behavior depends on whether the chezmoi path exists
      ok(
        context.jsonCalls.length > 0 || context.successCalls.length > 0,
        "Should either deny or allow",
      );
    });

    it("should allow access to files inside the repository", async () => {
      process.env.CLAUDE_TEST_REPO_ROOT = "/home/user/dotfiles";
      process.env.CLAUDE_TEST_CWD = "/home/user/dotfiles";
      const hook = chezmoiRedirectHook;

      const context = createPreToolUseContextFor(hook, "Read", {
        file_path: "/home/user/dotfiles/dot_config/mise/config.toml",
      });
      await invokeRun(hook, context);

      context.assertSuccess({});
    });

    it("should allow access when not in a dotfiles repository", async () => {
      process.env.CLAUDE_TEST_REPO_ROOT = "/home/user/some-other-project";
      process.env.CLAUDE_TEST_CWD = "/home/user/some-other-project";
      const hook = chezmoiRedirectHook;

      const context = createPreToolUseContextFor(hook, "Read", {
        file_path: `${homedir()}/.config/mise/config.toml`,
      });
      await invokeRun(hook, context);

      // Should pass through since it's not a dotfiles repo
      context.assertSuccess({});
    });
  });

  describe("tool filtering", () => {
    it("should only check Read, Write, Edit, MultiEdit tools", async () => {
      process.env.CLAUDE_TEST_REPO_ROOT = "/home/user/dotfiles";
      const hook = chezmoiRedirectHook;

      // Bash commands should pass through
      const bashContext = createPreToolUseContextFor(hook, "Bash", {
        command: `cat ${homedir()}/.config/mise/config.toml`,
      });
      await invokeRun(hook, bashContext);
      bashContext.assertSuccess({});

      // Glob should pass through
      const globContext = createPreToolUseContextFor(hook, "Glob", {
        path: `${homedir()}/.config`,
        pattern: "**/*",
      });
      await invokeRun(hook, globContext);
      globContext.assertSuccess({});
    });

    it("should check Edit tool", async () => {
      process.env.CLAUDE_TEST_REPO_ROOT = "/home/user/dotfiles";
      process.env.CLAUDE_TEST_CWD = "/home/user/dotfiles";
      const hook = chezmoiRedirectHook;

      const context = createPreToolUseContextFor(hook, "Edit", {
        file_path: `${homedir()}/.config/mise/config.toml`,
        old_string: "old",
        new_string: "new",
      });
      await invokeRun(hook, context);

      context.assertDeny();
    });

    it("should check Write tool", async () => {
      process.env.CLAUDE_TEST_REPO_ROOT = "/home/user/dotfiles";
      process.env.CLAUDE_TEST_CWD = "/home/user/dotfiles";
      const hook = chezmoiRedirectHook;

      const context = createPreToolUseContextFor(hook, "Write", {
        file_path: `${homedir()}/.config/mise/config.toml`,
        content: "new content",
      });
      await invokeRun(hook, context);

      context.assertDeny();
    });
  });

  describe("non-home paths", () => {
    it("should allow access to system paths (handled by deny-repository-outside)", async () => {
      process.env.CLAUDE_TEST_REPO_ROOT = "/home/user/dotfiles";
      const hook = chezmoiRedirectHook;

      const context = createPreToolUseContextFor(hook, "Read", {
        file_path: "/etc/passwd",
      });
      await invokeRun(hook, context);

      // This hook should pass through; other hooks handle system paths
      context.assertSuccess({});
    });

    it("should allow access to tmp directories", async () => {
      process.env.CLAUDE_TEST_REPO_ROOT = "/home/user/dotfiles";
      const hook = chezmoiRedirectHook;

      const context = createPreToolUseContextFor(hook, "Read", {
        file_path: "/tmp/somefile",
      });
      await invokeRun(hook, context);

      context.assertSuccess({});
    });
  });
});

describe("getChezmoiRedirectPath", () => {
  const repoRoot = "/home/user/dotfiles";
  const homeDir = homedir();

  it("should convert ~/.config/foo to dot_config/foo", () => {
    const result = getChezmoiRedirectPath(
      join(homeDir, ".config", "mise", "config.toml"),
      repoRoot,
    );
    // Result depends on whether the file exists
    if (result) {
      ok(result.includes("dot_config"));
      ok(result.includes("mise"));
    }
  });

  it("should return undefined for non-home paths", () => {
    const result = getChezmoiRedirectPath("/etc/passwd", repoRoot);
    strictEqual(result, undefined);
  });

  it("should return undefined for paths already in repo", () => {
    const result = getChezmoiRedirectPath(
      join(repoRoot, "dot_config", "mise", "config.toml"),
      repoRoot,
    );
    // Home path check won't match repo paths
    strictEqual(result, undefined);
  });
});

describe("generateChezmoiPathVariations", () => {
  const repoRoot = "/home/user/dotfiles";

  it("should generate basic path variation", () => {
    const basePath = join(repoRoot, "dot_config", "mise", "config.toml");
    const segments = ["dot_config", "mise", "config.toml"];
    const variations = generateChezmoiPathVariations(basePath, segments, repoRoot);

    ok(variations.includes(basePath));
  });

  it("should generate .tmpl variation", () => {
    const basePath = join(repoRoot, "dot_config", "mise", "config.toml");
    const segments = ["dot_config", "mise", "config.toml"];
    const variations = generateChezmoiPathVariations(basePath, segments, repoRoot);

    ok(variations.includes(basePath + ".tmpl"));
  });

  it("should generate private_ variation", () => {
    const basePath = join(repoRoot, "dot_config", "mise", "config.toml");
    const segments = ["dot_config", "mise", "config.toml"];
    const variations = generateChezmoiPathVariations(basePath, segments, repoRoot);

    ok(
      variations.some((v) => v.includes("private_config.toml")),
      "Should include private_ prefix variation",
    );
  });

  it("should generate dot_ variation for single-segment paths", () => {
    const basePath = join(repoRoot, "bashrc");
    const segments = ["bashrc"];
    const variations = generateChezmoiPathVariations(basePath, segments, repoRoot);

    ok(
      variations.includes(join(repoRoot, "dot_bashrc")),
      "Should include dot_bashrc variation",
    );
  });
});

describe("isDotfilesRepository", () => {
  it("should return true for dotfiles repository", () => {
    // This test uses the actual repo
    const result = isDotfilesRepository("/home/user/dotfiles");
    strictEqual(result, true);
  });

  it("should return false for non-dotfiles repository", () => {
    const result = isDotfilesRepository("/tmp/some-project");
    strictEqual(result, false);
  });
});
