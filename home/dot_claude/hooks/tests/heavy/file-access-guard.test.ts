#!/usr/bin/env node --test

import { afterEach, beforeEach, describe, it } from "node:test";
import fileAccessGuardHook from "../../implementations/file-access-guard.ts";
import {
  ConsoleCapture,
  createFileSystemMock,
  createPreToolUseContextFor,
  EnvironmentHelper,
  invokeRun,
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
});
