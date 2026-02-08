/**
 * Unified Audio Configuration Factory
 * 統一音声設定の生成と管理
 */

import { homedir } from "node:os";
import { join } from "node:path";
import type {
  Platform,
  UnifiedVoiceConfig,
  VoiceSession,
} from "./unified-audio-types.ts";

// プラットフォーム検出
export function detectPlatform(): Platform {
  const osType = process.env.OSTYPE || "";
  if (osType.startsWith("darwin")) return "darwin";
  if (process.env.WSL_DISTRO_NAME) return "wsl";
  return "linux";
}

// 統一設定の作成
export function createUnifiedVoiceConfig(): UnifiedVoiceConfig {
  const homeDir = homedir();
  const platform = detectPlatform();

  return {
    voicevox: {
      endpoint: process.env.VOICEVOX_ENDPOINT || "http://localhost:10101",
      speakerId: process.env.VOICEVOX_SPEAKER_ID || "888753760",
      timeout: 5000,
    },

    paths: {
      soundsDir: join(homeDir, ".claude", "hooks", "sounds"),
      tempDir: "/tmp/claude-voice-synthesis",
      logFile: join(homeDir, ".claude", "log", "voice-synthesis.log"),
      prefixFile: join(homeDir, ".claude", "hooks", "sounds", "Prefix.wav"),
    },

    system: {
      computerName: process.env.CLAUDE_COMPUTER_NAME || "Claude",
      platform,
    },

    behavior: {
      fallbackToStatic: true,
      systemNotifications: platform === "linux" || platform === "wsl",
      cleanupOnExit: true,
    },
  };
}

// セッション作成
export function createVoiceSession(config: UnifiedVoiceConfig): VoiceSession {
  const sessionId =
    process.env.CLAUDE_SESSION_ID ||
    `${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}_${process.pid}`;
  const sessionDir = join(config.paths.tempDir, "sessions", sessionId);

  return {
    sessionId,
    sessionDir,
    currentWavFile: null,
  };
}
