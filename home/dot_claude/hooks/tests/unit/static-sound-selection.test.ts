#!/usr/bin/env node --test

import { strictEqual } from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { createUnifiedVoiceConfig } from "../../../lib/unified-audio-config.ts";
import {
  resolveNotificationSoundType,
  resolveStaticSoundFile,
} from "../../../lib/unified-audio-engine.ts";
import type { UnifiedVoiceConfig } from "../../../lib/unified-audio-types.ts";

describe("static sound selection", () => {
  describe("resolveNotificationSoundType", () => {
    it("uses the permission sound for permission_prompt", () => {
      strictEqual(
        resolveNotificationSoundType("permission_prompt"),
        "PermissionRequest",
      );
    });

    it("uses the question sound for idle_prompt", () => {
      strictEqual(
        resolveNotificationSoundType("idle_prompt"),
        "AskUserQuestion",
      );
    });

    it("uses the question sound for elicitation_dialog", () => {
      strictEqual(
        resolveNotificationSoundType("elicitation_dialog"),
        "AskUserQuestion",
      );
    });

    it("uses the default sound for auth_success", () => {
      strictEqual(resolveNotificationSoundType("auth_success"), "Notification");
    });

    it("uses the default sound when the type is missing", () => {
      strictEqual(resolveNotificationSoundType(undefined), "Notification");
    });
  });

  describe("resolveStaticSoundFile", () => {
    let testDir = "";
    let soundsDir = "";
    let config: UnifiedVoiceConfig;

    function placeSound(fileName: string): string {
      const soundFile = join(soundsDir, fileName);
      writeFileSync(soundFile, "");
      return soundFile;
    }

    beforeEach(() => {
      testDir = mkdtempSync(join(tmpdir(), "test-static-sound-"));
      soundsDir = join(testDir, "sounds");
      mkdirSync(soundsDir, { recursive: true });
      const base = createUnifiedVoiceConfig();
      config = { ...base, paths: { ...base.paths, soundsDir } };
    });

    afterEach(() => {
      rmSync(testDir, { recursive: true, force: true });
    });

    it("returns the sound named after the event type when it exists", () => {
      placeSound("ClaudeNotification.wav");
      const expected = placeSound("ClaudePermissionRequest.wav");

      strictEqual(
        resolveStaticSoundFile("PermissionRequest", config),
        expected,
      );
    });

    it("falls back to ClaudeNotification.wav when the specific sound is missing", () => {
      const expected = placeSound("ClaudeNotification.wav");

      strictEqual(
        resolveStaticSoundFile("PermissionRequest", config),
        expected,
      );
      strictEqual(resolveStaticSoundFile("Stop", config), expected);
    });

    it("returns null when neither sound exists", () => {
      strictEqual(resolveStaticSoundFile("PermissionRequest", config), null);
      strictEqual(resolveStaticSoundFile("Notification", config), null);
    });
  });
});
