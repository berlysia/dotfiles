#!/usr/bin/env -S bun run --silent

/**
 * CLI interface for Voice Notification
 * Standalone script for manual voice notification control
 * Usage: speak-notification.ts {Notification|Stop|Error} [custom_message]
 */

import { $ } from 'dax-sh';
import { join, dirname } from 'path';
import { existsSync, mkdirSync, writeFileSync, readFileSync, statSync, readdirSync, unlinkSync, rmSync } from 'fs';
import { homedir } from 'os';

import { getGitContext, createContextMessage } from '../hooks/lib/git-context.ts';
import { detectPlatform, playSound, commandExists, cleanupOldFiles } from '../hooks/lib/voicevox-audio.ts';
import type { 
  Platform, 
  EventType, 
  AudioQuery,
  VoiceSynthesisConfig,
  NotificationLogEntry
} from '../hooks/lib/sound-types.ts';
interface VoiceSynthesisEngineConfig {
  host: string;
  defaultSpeakerId: string;
  tempDir: string;
  logFile: string;
  computerName: string;
  soundDir: string;
  prefixFile: string;
}

interface SessionInfo {
  sessionId: string;
  sessionDir: string;
  currentWavFile: string | null;
}

class VoiceNotification {
  private config: VoiceSynthesisEngineConfig;
  private session: SessionInfo;

  constructor() {
    this.config = this.initializeConfig();
    this.session = this.initializeSession();
    
    // Setup cleanup on exit
    process.on('exit', () => this.cleanup());
    process.on('SIGINT', () => {
      this.cleanup();
      process.exit(0);
    });
    process.on('SIGTERM', () => {
      this.cleanup();
      process.exit(0);
    });
  }

  private initializeConfig(): VoiceSynthesisEngineConfig {
    const homeDir = homedir();
    
    return {
      host: process.env.VOICEVOX_ENDPOINT || 'http://localhost:10101',
      defaultSpeakerId: process.env.VOICEVOX_SPEAKER_ID || '888753760',
      tempDir: '/tmp/claude-voice-synthesis',
      logFile: join(homeDir, '.claude', 'log', 'voice-synthesis.log'),
      computerName: process.env.CLAUDE_COMPUTER_NAME || 'Claude',
      soundDir: join(homeDir, '.claude', 'hooks', 'sounds'),
      prefixFile: join(homeDir, '.claude', 'hooks', 'sounds', 'Prefix.wav')
    };
  }

  private initializeSession(): SessionInfo {
    const sessionId = process.env.CLAUDE_SESSION_ID || `${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}_${process.pid}`;
    const sessionDir = join(this.config.tempDir, 'sessions', sessionId);

    return {
      sessionId,
      sessionDir,
      currentWavFile: null
    };
  }

  private cleanup(): void {
    if (this.session.currentWavFile && existsSync(this.session.currentWavFile)) {
      try {
        unlinkSync(this.session.currentWavFile);
      } catch {
        // Ignore cleanup failures
      }
    }

    // Clean up empty session directory
    try {
      if (existsSync(this.session.sessionDir)) {
        const files = readdirSync(this.session.sessionDir);
        if (files.length === 0) {
          rmSync(this.session.sessionDir, { recursive: true });
        }
      }
    } catch {
      // Ignore cleanup failures
    }
  }

  private logMessage(message: string): void {
    try {
      const logDir = dirname(this.config.logFile);
      if (!existsSync(logDir)) {
        mkdirSync(logDir, { recursive: true });
      }
      
      const timestamp = new Date().toISOString();
      const logEntry = `[${timestamp}] ${message}\n`;
      writeFileSync(this.config.logFile, logEntry, { flag: 'a' });
    } catch {
      // Silently continue if logging fails
    }
  }

  async handleNotification(): Promise<void> {
    await cleanupOldFiles();
    const context = await getGitContext();
    const message = createContextMessage(context, 'confirm');
    await this.speakNotification(message, 'Notification');
  }

  async handleStop(): Promise<void> {
    const context = await getGitContext();
    const message = createContextMessage(context, 'complete');
    await this.speakNotification(message, 'Stop');

    if (existsSync(this.session.sessionDir)) {
      try {
        rmSync(this.session.sessionDir, { recursive: true });
        this.logMessage(`Cleaned up session directory: ${this.session.sessionDir}`);
      } catch {
        // Ignore cleanup failures
      }
    }
  }

  async handleError(): Promise<void> {
    const context = await getGitContext();
    const message = createContextMessage(context, 'error');
    await this.speakNotification(message, 'Error');
  }

  async handleCustom(eventType: string, message: string): Promise<void> {
    await this.speakNotification(message, eventType as EventType);
  }

  async speakNotification(text: string, eventType: EventType): Promise<void> {
    this.logMessage(`CLI: ${eventType} - ${text}`);
    console.log(`🔊 ${eventType}: ${text}`);
  }
}

async function main() {
  const args = process.argv.slice(2);
  const eventType = args[0];
  
  if (!eventType) {
    console.log('Usage: speak-notification.ts {Notification|Stop|Error} [custom_message]');
    process.exit(1);
  }

  const notification = new VoiceNotification();

  switch (eventType) {
    case 'Notification':
      await notification.handleNotification();
      break;
    case 'Stop':
      await notification.handleStop();
      break;
    case 'Error':
      await notification.handleError();
      break;
    default:
      // Custom message support
      if (args.length === 2 && args[1]) {
        await notification.handleCustom(eventType, args[1]);
      } else {
        console.log('Usage: speak-notification.ts {Notification|Stop|Error} [custom_message]');
        process.exit(1);
      }
      break;
  }
}

if (import.meta.main) {
  main().catch(error => {
    console.error('Error:', error);
    process.exit(1);
  });
}