/**
 * Unified Audio System Types
 * 音声通知システムの統一型定義
 */

export type Platform = "darwin" | "linux" | "wsl";
export type EventType = "Notification" | "Stop" | "Error" | "PermissionRequest" | "AskUserQuestion" | string;

export interface UnifiedVoiceConfig {
  // VoiceVox互換エンジン設定
  voicevox: {
    endpoint: string;
    speakerId: string;
    timeout: number;
  };

  // ファイルシステム設定
  paths: {
    soundsDir: string;
    tempDir: string;
    logFile: string;
    prefixFile: string;
  };

  // システム設定
  system: {
    computerName: string;
    platform: Platform;
  };

  // 動作設定
  behavior: {
    fallbackToStatic: boolean;
    systemNotifications: boolean;
    cleanupOnExit: boolean;
  };
}

export interface VoiceSession {
  sessionId: string;
  sessionDir: string;
  currentWavFile: string | null;
}

export interface AudioQuery {
  accent_phrases: Array<{
    moras: Array<{
      text: string;
      consonant?: string;
      consonant_length?: number;
      vowel: string;
      vowel_length: number;
      pitch: number;
    }>;
    accent: number;
    pause_mora?: {
      text: string;
      consonant?: string;
      consonant_length?: number;
      vowel: string;
      vowel_length: number;
      pitch: number;
    };
  }>;
  speedScale: number;
  pitchScale: number;
  intonationScale: number;
  volumeScale: number;
  prePhonemeLength: number;
  postPhonemeLength: number;
  outputSamplingRate: number;
  outputStereo: boolean;
  kana?: string;
}

export interface NotificationResult {
  success: boolean;
  method: "voicevox" | "static" | "none" | "delegated";
  error?: string;
  message?: string;
}
