#!/usr/bin/env -S bun run --silent

/**
 * Claude Hybrid Voice Notification - TypeScript Version
 * Combines static WAV files with VoiceVox-compatible engine synthesis
 * Provides immediate audio feedback with detailed voice notifications
 */

import { $ } from 'dax-sh';
import { join, dirname } from 'path';
import { existsSync, mkdirSync, writeFileSync, readFileSync, statSync, readdirSync, unlinkSync, rmSync } from 'fs';
import { homedir } from 'os';

// Import shared libraries
import { getGitContext, createContextMessage } from '../lib/git-context.ts';
import { detectPlatform, playSound, commandExists, cleanupOldFiles } from '../lib/voicevox-audio.ts';
import type { 
  Platform, 
  EventType, 
  AudioQuery,
  VoiceSynthesisConfig,
  NotificationLogEntry
} from '../lib/sound-types.ts';

// Configuration interfaces
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
      defaultSpeakerId: process.env.VOICEVOX_SPEAKER_ID || '888753760', // VoiceVox互換デフォルトスピーカー
      tempDir: '/tmp/claude-voice-synthesis',
      logFile: join(homeDir, '.claude', 'log', 'voice-synthesis.log'),
      computerName: process.env.CLAUDE_COMPUTER_NAME || 'Claude', // Simplified for now
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

  private async getHostname(): Promise<string> {
    try {
      const result = await $`hostname`.text();
      const parts = result.trim().split('.');
      return parts[0] || 'Claude';
    } catch {
      return 'Claude';
    }
  }

  private ensureDirectories(): void {
    try {
      const logDir = dirname(this.config.logFile);
      if (!existsSync(logDir)) {
        mkdirSync(logDir, { recursive: true });
      }
      
      if (!existsSync(this.config.tempDir)) {
        mkdirSync(this.config.tempDir, { recursive: true });
      }
      
      if (!existsSync(this.session.sessionDir)) {
        mkdirSync(this.session.sessionDir, { recursive: true });
      }
    } catch (error) {
      // Silently continue if directory creation fails
    }
  }

  private logMessage(message: string): void {
    try {
      this.ensureDirectories();
      const timestamp = new Date().toISOString();
      const logEntry = `[${timestamp}] ${message}\n`;
      writeFileSync(this.config.logFile, logEntry, { flag: 'a' });
    } catch {
      // Silently continue if logging fails
    }
  }

  private cleanup(): void {
    if (this.session.currentWavFile && existsSync(this.session.currentWavFile)) {
      try {
        unlinkSync(this.session.currentWavFile);
        this.logMessage(`Cleaned up: ${this.session.currentWavFile}`);
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



  private async checkSynthesisEngine(): Promise<boolean> {
    try {
      const response = await fetch(`${this.config.host}/version`, {
        method: 'GET',
        signal: AbortSignal.timeout(2000)
      });
      return response.ok;
    } catch (error) {
      this.logMessage(`ERROR: VoiceVox-compatible engine not available at ${this.config.host}`);
      return false;
    }
  }

  private async generateAudioQuery(text: string, speakerId?: string): Promise<AudioQuery | null> {
    try {
      const speaker = speakerId || this.config.defaultSpeakerId;
      const encodedText = encodeURIComponent(text);
      
      const response = await fetch(`${this.config.host}/audio_query?text=${encodedText}&speaker=${speaker}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        }
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      return await response.json() as AudioQuery;
    } catch (error) {
      this.logMessage('ERROR: Failed to generate audio query');
      return null;
    }
  }

  private async synthesizeSpeech(query: AudioQuery, speakerId: string, outputFile: string): Promise<boolean> {
    try {
      const response = await fetch(`${this.config.host}/synthesis?speaker=${speakerId}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'audio/wav'
        },
        body: JSON.stringify(query)
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const arrayBuffer = await response.arrayBuffer();
      writeFileSync(outputFile, Buffer.from(arrayBuffer));

      if (!existsSync(outputFile) || statSync(outputFile).size === 0) {
        this.logMessage('ERROR: Failed to synthesize speech');
        return false;
      }

      return true;
    } catch (error) {
      this.logMessage('ERROR: Failed to synthesize speech');
      return false;
    }
  }

  private async playStaticWav(wavFile: string): Promise<boolean> {
    if (!existsSync(wavFile)) {
      this.logMessage(`WARNING: Static WAV file not found: ${wavFile}`);
      return false;
    }

    try {
      const success = await playSound(wavFile);
      if (success) {
        this.logMessage(`Playing static WAV: ${wavFile}`);
      } else {
        this.logMessage(`Failed to play static WAV: ${wavFile}`);
      }
      return success;
    } catch (error) {
      this.logMessage(`Error playing static WAV: ${error}`);
      return false;
    }
  }


  private async playAudioAndCleanup(audioFile: string): Promise<void> {
    try {
      const success = await playSound(audioFile);
      if (success) {
        this.logMessage(`Successfully played audio: ${audioFile}`);
      } else {
        this.logMessage(`Failed to play audio: ${audioFile}`);
      }
      
      // Clean up the file
      if (existsSync(audioFile)) {
        unlinkSync(audioFile);
        this.logMessage(`Removed audio file: ${audioFile}`);
      }
    } catch (error) {
      this.logMessage(`Failed to play audio: ${error}`);
      if (existsSync(audioFile)) {
        unlinkSync(audioFile);
      }
    }

    // Clear current file reference after cleanup
    this.session.currentWavFile = null;
  }


  private async executeFallbackNotification(eventType: EventType, reason: string): Promise<void> {
    this.logMessage(`${reason}, falling back to static WAV files`);

    // Step 1: Play Prefix.wav if available
    if (existsSync(this.config.prefixFile)) {
      await this.playStaticWav(this.config.prefixFile);
      this.logMessage(`Playing fallback prefix: ${this.config.prefixFile}`);
    }

    // Step 2: Play event-specific fallback file
    const fallbackFile = join(this.config.soundDir, `Claude${eventType}.wav`);
    if (existsSync(fallbackFile)) {
      this.logMessage(`Using fallback static WAV: ${fallbackFile}`);
      await this.playStaticWav(fallbackFile);
    } else {
      this.logMessage(`WARNING: No fallback WAV found: ${fallbackFile}`);
    }
  }

  private async getRepoInfo(): Promise<{ name: string; isRepository: boolean }> {
    try {
      const context = await getGitContext();
      this.logMessage(`Git context: ${context.name}, ${context.containerType}`);
      return { 
        name: context.name, 
        isRepository: context.isRepository && context.hasRemote 
      };
    } catch (error) {
      this.logMessage(`Error in getRepoInfo: ${error}`);
      return { name: 'unknown', isRepository: false };
    }
  }

  async speakNotification(text: string, eventType: EventType): Promise<void> {
    // Check if VoiceVox-compatible engine is available for dynamic synthesis
    if (!await this.checkSynthesisEngine()) {
      await this.executeFallbackNotification(eventType, 'Voice synthesis engine unavailable');
      return;
    }

    // Ensure session directory exists
    if (!existsSync(this.session.sessionDir)) {
      try {
        mkdirSync(this.session.sessionDir, { recursive: true });
      } catch {
        this.logMessage(`ERROR: Cannot create session directory: ${this.session.sessionDir}`);
        await this.executeFallbackNotification(eventType, 'Session directory creation failed');
        return;
      }
    }

    // Generate unique filename in session directory
    const timestamp = Date.now() * 1000 + Math.floor(Math.random() * 1000);
    const audioFile = join(this.session.sessionDir, `notification_${eventType}_${timestamp}.wav`);
    this.session.currentWavFile = audioFile;

    // Generate unified message: computer name + dynamic content
    const unifiedText = `${this.config.computerName}の${text}`;
    this.logMessage(`Unified message: ${unifiedText}`);

    // Generate audio query for unified message
    const query = await this.generateAudioQuery(unifiedText);
    if (!query) {
      await this.executeFallbackNotification(eventType, 'Audio query generation failed');
      return;
    }

    // Synthesize unified speech
    if (!await this.synthesizeSpeech(query, this.config.defaultSpeakerId, audioFile)) {
      await this.executeFallbackNotification(eventType, 'Speech synthesis failed');
      return;
    }

    // Play unified audio
    await this.playAudioAndCleanup(audioFile);

    this.logMessage(`SUCCESS: Played notification for ${eventType}: ${text}`);
  }

  async handleNotification(): Promise<void> {
    // Clean up old files on Notification event (first event usually)
    await cleanupOldFiles();
    
    const context = await getGitContext();
    const message = createContextMessage(context, 'confirm');
    await this.speakNotification(message, 'Notification');
  }

  async handleStop(): Promise<void> {
    const context = await getGitContext();
    const message = createContextMessage(context, 'complete');
    await this.speakNotification(message, 'Stop');

    // Clean up entire session directory on Stop
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
}

// Main execution
async function main() {
  const args = process.argv.slice(2);
  const eventType = args[0];
  
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
      if (args.length === 2 && eventType && args[1]) {
        await notification.handleCustom(eventType, args[1]);
      } else {
        console.log('Usage: speak-notification.ts {Notification|Stop|Error} [custom_message]');
        process.exit(1);
      }
      break;
  }
}

// Execute if run directly
if (import.meta.main) {
  main().catch(error => {
    console.error('Error:', error);
    process.exit(1);
  });
}