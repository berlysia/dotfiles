/**
 * Sound Types - Unified Type Definitions for Audio Notifications
 *
 * Provides centralized type definitions for the notification sound system,
 * ensuring consistency across all audio-related components.
 */

// Platform types
export type Platform = "darwin" | "linux" | "wsl";

// Base sound types for static WAV files
export type BaseSoundType = "notification" | "stop" | "permission" | "waiting";

// Extended event types for dynamic synthesis
export type EventType = "Notification" | "Stop" | "Error";

// Unified sound type that covers both static and dynamic scenarios
export type UnifiedSoundType = BaseSoundType | "error";

// Audio player interfaces
export interface AudioPlayerCapabilities {
  supportsStaticWav: boolean;
  supportsDynamicSynthesis: boolean;
  supportsConcurrentPlayback: boolean;
}

export interface AudioPlaybackOptions {
  volume?: number;
  async?: boolean;
  fallbackEnabled?: boolean;
}

export interface StaticSoundOptions extends AudioPlaybackOptions {
  soundType: BaseSoundType;
  prefixSound?: boolean;
}

export interface DynamicSpeechOptions extends AudioPlaybackOptions {
  message: string;
  eventType: EventType;
  speakerId?: string;
  computerName?: string;
}

// Notification log entry interface
export interface NotificationLogEntry {
  timestamp: string;
  event_type: string;
  message: string;
  sound_type: string;
  platform?: Platform;
  success?: boolean;
  duration_ms?: number;
}

// Audio configuration interfaces
export interface PlatformAudioConfig {
  platform: Platform;
  primaryCommand: string;
  fallbackCommand?: string;
  fileExtensions: string[];
  supportsAsync: boolean;
}

export interface AudioSystemConfig {
  soundsDirectory: string;
  tempDirectory: string;
  maxLogEntries: number;
  cleanupIntervalHours: number;
  platforms: Record<Platform, PlatformAudioConfig>;
}

// Voice synthesis interfaces (VoiceVox-compatible engines)
export interface VoiceSynthesisConfig {
  endpoint: string;
  speakerId: string;
  timeout: number;
  retryCount: number;
}

export interface AudioQuery {
  accent_phrases: any[];
  speedScale: number;
  pitchScale: number;
  intonationScale: number;
  volumeScale: number;
  prePhonemeLength: number;
  postPhonemeLength: number;
  outputSamplingRate: number;
  outputStereo: boolean;
  kana: string;
}

// Service interfaces for dependency injection
export interface IAudioPlayer {
  /**
   * Play static WAV file based on sound type
   */
  playStaticSound(options: StaticSoundOptions): Promise<boolean>;

  /**
   * Play synthesized speech
   */
  playSynthesizedSpeech(options: DynamicSpeechOptions): Promise<boolean>;

  /**
   * Get platform capabilities
   */
  getCapabilities(): AudioPlayerCapabilities;

  /**
   * Test audio system availability
   */
  testAudioSystem(): Promise<boolean>;
}

export interface IVoiceSynthesizer {
  /**
   * Check if synthesis service is available
   */
  isAvailable(): Promise<boolean>;

  /**
   * Synthesize speech to temporary file
   */
  synthesize(text: string, speakerId?: string): Promise<string | null>;

  /**
   * Get available speakers
   */
  getSpeakers(): Promise<Array<{ id: string; name: string }> | null>;
}

export interface IGitContextProvider {
  /**
   * Get repository context information
   */
  getContext(): Promise<import("./git-context.ts").GitContextInfo>;

  /**
   * Create localized message with context
   */
  createMessage(action: "confirm" | "complete" | "error"): Promise<string>;
}

export interface INotificationLogger {
  /**
   * Log notification event
   */
  log(entry: NotificationLogEntry): void;

  /**
   * Get notification statistics
   */
  getStats(): Promise<{
    total: number;
    byType: Record<string, number>;
    recent: NotificationLogEntry[];
  }>;

  /**
   * Clean up old log entries
   */
  cleanup(): Promise<void>;
}

// Factory interfaces
export interface AudioNotifierFactory {
  /**
   * Create audio notifier with specified capabilities
   */
  create(type: "static" | "dynamic" | "hybrid"): IAudioPlayer;
}

// Error types
export class AudioSystemError extends Error {
  public readonly platform: Platform;
  public readonly cause: Error | undefined;

  constructor(message: string, platform: Platform, cause?: Error) {
    super(`[${platform}] ${message}`);
    this.name = "AudioSystemError";
    this.platform = platform;
    this.cause = cause;
  }
}

export class VoiceSynthesisError extends Error {
  public readonly endpoint: string | undefined;
  public readonly cause: Error | undefined;

  constructor(message: string, endpoint?: string, cause?: Error) {
    super(`Voice synthesis failed: ${message}`);
    this.name = "VoiceSynthesisError";
    this.endpoint = endpoint;
    this.cause = cause;
  }
}

// Type guards
export function isBaseSoundType(value: string): value is BaseSoundType {
  return ["notification", "stop", "permission", "waiting"].includes(value);
}

export function isEventType(value: string): value is EventType {
  return ["Notification", "Stop", "Error"].includes(value);
}

export function isPlatform(value: string): value is Platform {
  return ["darwin", "linux", "wsl"].includes(value);
}

// Type conversion utilities
export function eventTypeToSoundType(eventType: EventType): UnifiedSoundType {
  const mapping: Record<EventType, UnifiedSoundType> = {
    Notification: "notification",
    Stop: "stop",
    Error: "error",
  };
  return mapping[eventType];
}

export function soundTypeToEventType(
  soundType: UnifiedSoundType,
): EventType | null {
  const mapping: Record<UnifiedSoundType, EventType | null> = {
    notification: "Notification",
    stop: "Stop",
    error: "Error",
    permission: null,
    waiting: null,
  };
  return mapping[soundType];
}

// Default configurations
export const DEFAULT_AUDIO_CONFIG: AudioSystemConfig = {
  soundsDirectory: "~/.claude/hooks/sounds",
  tempDirectory: "/tmp/claude-audio",
  maxLogEntries: 1000,
  cleanupIntervalHours: 24,
  platforms: {
    darwin: {
      platform: "darwin",
      primaryCommand: "afplay",
      fileExtensions: [".wav", ".mp3", ".aiff"],
      supportsAsync: true,
    },
    linux: {
      platform: "linux",
      primaryCommand: "paplay",
      fallbackCommand: "aplay -q",
      fileExtensions: [".wav"],
      supportsAsync: true,
    },
    wsl: {
      platform: "wsl",
      primaryCommand: "powershell.exe",
      fileExtensions: [".wav"],
      supportsAsync: false,
    },
  },
};

export const DEFAULT_VOICE_SYNTHESIS_CONFIG: VoiceSynthesisConfig = {
  endpoint: "http://localhost:10101",
  speakerId: "888753760", // Anneli ノーマル
  timeout: 5000,
  retryCount: 2,
};
