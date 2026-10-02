/**
 * Tests for getHomeDir() in path-utils.ts
 */

import { strictEqual } from "node:assert";
import { homedir } from "node:os";
import { afterEach, beforeEach, describe, it } from "node:test";
import { getHomeDir } from "../../lib/path-utils.ts";

describe("getHomeDir", () => {
  let originalHome: string | undefined;

  beforeEach(() => {
    originalHome = process.env.HOME;
  });

  afterEach(() => {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
  });

  it("returns process.env.HOME when set", () => {
    process.env.HOME = "/tmp/fake-home-a";
    strictEqual(getHomeDir(), "/tmp/fake-home-a");
  });

  it("reflects HOME reassigned after the first call (no caching)", () => {
    process.env.HOME = "/tmp/fake-home-a";
    strictEqual(getHomeDir(), "/tmp/fake-home-a");
    process.env.HOME = "/tmp/fake-home-b";
    strictEqual(getHomeDir(), "/tmp/fake-home-b");
  });

  it("falls back to os.homedir() when HOME is empty", () => {
    process.env.HOME = "";
    strictEqual(getHomeDir(), homedir());
  });

  it("falls back to os.homedir() when HOME is unset", () => {
    delete process.env.HOME;
    strictEqual(getHomeDir(), homedir());
  });
});
