#!/usr/bin/env node --test

import { deepStrictEqual, ok, strictEqual } from "node:assert";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { createUnifiedVoiceConfig } from "../../../lib/unified-audio-config.ts";
import { speakNotification } from "../../../lib/unified-audio-engine.ts";
import type { UnifiedVoiceConfig } from "../../../lib/unified-audio-types.ts";

describe("voice mute (CLAUDE_VOICE_ENABLED)", () => {
  const originalValue = process.env.CLAUDE_VOICE_ENABLED;
  const originalFetch = globalThis.fetch;
  let testDir = "";

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), "test-voice-mute-"));
  });

  afterEach(() => {
    if (originalValue === undefined) delete process.env.CLAUDE_VOICE_ENABLED;
    else process.env.CLAUDE_VOICE_ENABLED = originalValue;
    globalThis.fetch = originalFetch;
    rmSync(testDir, { recursive: true, force: true });
  });

  describe("createUnifiedVoiceConfig", () => {
    it("enables voice when the variable is unset", () => {
      delete process.env.CLAUDE_VOICE_ENABLED;
      strictEqual(createUnifiedVoiceConfig().behavior.voiceEnabled, true);
    });

    for (const value of ["false", "0"]) {
      it(`disables voice when the variable is "${value}"`, () => {
        process.env.CLAUDE_VOICE_ENABLED = value;
        strictEqual(createUnifiedVoiceConfig().behavior.voiceEnabled, false);
      });
    }

    it('enables voice when the variable is "true"', () => {
      process.env.CLAUDE_VOICE_ENABLED = "true";
      strictEqual(createUnifiedVoiceConfig().behavior.voiceEnabled, true);
    });
  });

  describe("speakNotification", () => {
    function createMutedConfig(): UnifiedVoiceConfig {
      process.env.CLAUDE_VOICE_ENABLED = "false";
      const config = createUnifiedVoiceConfig();
      return {
        ...config,
        paths: {
          soundsDir: join(testDir, "sounds"),
          tempDir: join(testDir, "tmp"),
          logFile: join(testDir, "log", "voice-synthesis.log"),
          prefixFile: join(testDir, "sounds", "Prefix.wav"),
        },
      };
    }

    it("returns without contacting the synthesis engine when muted", async () => {
      const requestedUrls: string[] = [];
      globalThis.fetch = (async (input: unknown) => {
        requestedUrls.push(String(input));
        throw new Error("fetch must not be called while muted");
      }) as typeof fetch;

      const config = createMutedConfig();
      const result = await speakNotification("test", "Stop", config, {
        sessionId: "test",
        sessionDir: join(testDir, "tmp", "sessions", "test"),
        currentWavFile: null,
      });

      deepStrictEqual(requestedUrls, []);
      deepStrictEqual(result, { success: false, method: "none" });
      ok(
        readFileSync(config.paths.logFile, "utf-8").includes(
          "CLAUDE_VOICE_ENABLED",
        ),
        "the log names the variable that muted the notification",
      );
    });
  });
});
