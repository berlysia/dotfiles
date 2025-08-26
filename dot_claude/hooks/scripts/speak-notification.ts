#!/usr/bin/env bun

/**
 * Claude Hybrid Voice Notification - TypeScript Version
 * Combines static WAV files with AivisSpeech dynamic synthesis
 * Provides immediate audio feedback with detailed voice notifications
 */

import { $ } from 'dax-sh';
import { join, dirname } from 'path';
import { existsSync, mkdirSync, writeFileSync, readFileSync, statSync, readdirSync, unlinkSync, rmSync } from 'fs';
import { homedir } from 'os';

// Configuration interfaces
interface AivisSpeechConfig {
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

interface AudioQuery {
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

type Platform = 'darwin' | 'wsl' | 'linux';
type EventType = 'Notification' | 'Stop' | 'Error';

class AivisSpeechNotification {
  private config: AivisSpeechConfig;
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

  private initializeConfig(): AivisSpeechConfig {
    const homeDir = homedir();
    
    return {
      host: process.env.AIVISSPEECH_HOST || 'http://localhost:10101',
      defaultSpeakerId: process.env.AIVISSPEECH_SPEAKER_ID || '888753760', // Anneli ノーマル
      tempDir: '/tmp/claude-aivisspeech',
      logFile: join(homeDir, '.claude', 'log', 'aivisspeech.log'),
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
      return result.trim().split('.')[0];
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

  private async cleanupOldFiles(): Promise<void> {
    try {
      if (!existsSync(this.config.tempDir)) {
        return;
      }

      // Remove WAV files older than 24 hours (1440 minutes)
      await $`find ${this.config.tempDir} -type f -name "*.wav" -mmin +1440 -delete`.quiet();
      
      // Remove empty session directories
      await $`find ${this.config.tempDir}/sessions -type d -empty -delete`.quiet();
      
      this.logMessage('Cleaned up old WAV files (>24 hours)');
    } catch {
      // Ignore cleanup failures
    }
  }

  private detectPlatform(): Platform {
    const osType = process.env.OSTYPE || '';
    
    if (osType.startsWith('darwin')) {
      return 'darwin';
    }
    
    if (process.env.WSL_DISTRO_NAME || osType === 'msys') {
      return 'wsl';
    }
    
    return 'linux';
  }

  private async checkAivisSpeech(): Promise<boolean> {
    try {
      const response = await fetch(`${this.config.host}/version`, {
        method: 'GET',
        signal: AbortSignal.timeout(2000)
      });
      return response.ok;
    } catch (error) {
      this.logMessage(`ERROR: AivisSpeech Engine not available at ${this.config.host}`);
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

      return await response.json();
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

    const platform = this.detectPlatform();

    try {
      switch (platform) {
        case 'darwin':
          if (await $`which afplay`.quiet().noThrow()) {
            await $`afplay ${wavFile}`.spawn();
            this.logMessage(`Playing static WAV (macOS): ${wavFile}`);
            return true;
          }
          this.logMessage('WARNING: afplay not found on macOS');
          return false;

        case 'wsl':
          await this.playWSLStaticWav(wavFile);
          return true;

        case 'linux':
          if (await $`which paplay`.quiet().noThrow()) {
            await $`paplay ${wavFile}`.spawn();
            this.logMessage(`Playing static WAV (Linux): ${wavFile}`);
            return true;
          } else if (await $`which aplay`.quiet().noThrow()) {
            await $`aplay -q ${wavFile}`.spawn();
            this.logMessage(`Playing static WAV (Linux): ${wavFile}`);
            return true;
          }
          this.logMessage('WARNING: No audio player found (paplay/aplay)');
          return false;

        default:
          return false;
      }
    } catch (error) {
      this.logMessage(`Error playing static WAV: ${error}`);
      return false;
    }
  }

  private async playWSLStaticWav(wavFile: string): Promise<void> {
    try {
      // Convert WSL path to Windows path
      const winPath = await $`wslpath -w ${wavFile}`.text();
      this.logMessage(`Playing static WAV (WSL): ${winPath.trim()}`);

      // PowerShell script with proper UTF-8 encoding setup and escaping
      const script = `
        try {
          [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
          
          # Copy WAV to Windows temp
          \$winTempPath = 'C:\\temp\\claude_prefix_temp.wav'
          New-Item -Path 'C:\\temp' -ItemType Directory -Force | Out-Null
          Copy-Item '${winPath.trim()}' \$winTempPath -Force
          
          # Play from Windows filesystem (synchronous for reliable playback)
          \$player = New-Object System.Media.SoundPlayer
          \$player.SoundLocation = \$winTempPath
          \$player.Load()
          \$player.PlaySync()
          Write-Host 'SoundPlayer: Static WAV completed'
          
          # Clean up Windows temp file
          Remove-Item \$winTempPath -Force -ErrorAction SilentlyContinue
        } catch {
          Write-Host "Error playing static WAV: \$(\$_.Exception.Message)"
        }
      `;

      const output = await $`powershell.exe -c ${script}`.text();
      
      output.split('\n').forEach(line => {
        if (line.trim()) {
          this.logMessage(`Static: ${line.trim()}`);
        }
      });
    } catch (error) {
      this.logMessage(`Error in WSL static WAV playback: ${error}`);
    }
  }

  private async playAudioAndCleanup(audioFile: string): Promise<void> {
    const platform = this.detectPlatform();

    try {
      switch (platform) {
        case 'darwin':
          if (await $`which afplay`.quiet().noThrow()) {
            await $`afplay ${audioFile}`;
            unlinkSync(audioFile);
          } else {
            this.logMessage('WARNING: afplay not found on macOS');
          }
          break;

        case 'linux':
          if (await $`which paplay`.quiet().noThrow()) {
            await $`paplay ${audioFile}`;
            unlinkSync(audioFile);
          } else if (await $`which aplay`.quiet().noThrow()) {
            await $`aplay -q ${audioFile}`;
            unlinkSync(audioFile);
          } else {
            this.logMessage('WARNING: No audio player found (paplay/aplay)');
            unlinkSync(audioFile);
          }
          break;

        case 'wsl':
          await this.playWSLAudio(audioFile);
          unlinkSync(audioFile);
          this.logMessage(`Removed audio file: ${audioFile}`);
          break;
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

  private async playWSLAudio(audioFile: string): Promise<void> {
    try {
      // Convert to Windows path for PowerShell
      const winPath = await $`wslpath -w ${audioFile}`.text();
      this.logMessage(`Playing audio file: ${winPath.trim()}`);

      // PowerShell script with proper UTF-8 encoding setup
      const script = `
        try {
          [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
          
          # Copy WAV to Windows temp
          \$winTempPath = 'C:\\temp\\claude_dynamic_temp.wav'
          New-Item -Path 'C:\\temp' -ItemType Directory -Force | Out-Null
          Copy-Item '${winPath.trim()}' \$winTempPath -Force
          
          # Play from Windows filesystem
          \$player = New-Object System.Media.SoundPlayer
          \$player.SoundLocation = \$winTempPath
          \$player.Load()
          \$player.PlaySync()
          Write-Host 'SoundPlayer: Audio played successfully'
          
          # Clean up Windows temp file
          Remove-Item \$winTempPath -Force -ErrorAction SilentlyContinue
        } catch {
          Write-Host "Error playing audio: \$(\$_.Exception.Message)"
        }
      `;

      const output = await $`powershell.exe -c ${script}`.text();
      
      output.split('\n').forEach(line => {
        if (line.trim()) {
          this.logMessage(`Audio: ${line.trim()}`);
        }
      });
    } catch (error) {
      this.logMessage(`Error in WSL audio playback: ${error}`);
    }
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

  private async getRepoInfo(): Promise<string> {
    try {
      let repoName = '';
      
      const isGitRepo = await $`git rev-parse --is-inside-work-tree`.quiet().noThrow();
      if (isGitRepo.code === 0) {
        // Try to get repo name from remote origin
        const remoteUrl = await $`git remote get-url origin`.text().catch(() => '');
        if (remoteUrl) {
          const match = remoteUrl.match(/\/([^/]+)\.git$/);
          repoName = match ? match[1] : '';
        }
        
        // Fallback to current directory name
        if (!repoName) {
          repoName = await $`basename $(pwd)`.text();
        }
      } else {
        repoName = await $`basename $(pwd)`.text();
      }
      
      return repoName.trim();
    } catch {
      return 'unknown';
    }
  }

  async speakNotification(text: string, eventType: EventType): Promise<void> {
    // Check if AivisSpeech is available for dynamic synthesis
    if (!await this.checkAivisSpeech()) {
      await this.executeFallbackNotification(eventType, 'AivisSpeech unavailable');
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
    await this.cleanupOldFiles();
    
    const repoName = await this.getRepoInfo();
    const message = `${repoName} リポジトリで操作の確認が必要です`;
    await this.speakNotification(message, 'Notification');
  }

  async handleStop(): Promise<void> {
    const repoName = await this.getRepoInfo();
    const message = `${repoName} リポジトリで処理が完了しました`;
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
    const repoName = await this.getRepoInfo();
    const message = `${repoName} リポジトリでエラーが発生しました`;
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
  
  const notification = new AivisSpeechNotification();

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
      if (args.length === 2) {
        await notification.handleCustom(eventType, args[1]);
      } else {
        console.log('Usage: speak-notification.ts {Notification|Stop|Error} [custom_message]');
        process.exit(1);
      }
      break;
  }
}

// Execute if run directly (check if this file is the main module)
if (process.argv[1] === __filename || process.argv[1].endsWith('speak-notification.ts')) {
  main().catch(error => {
    console.error('Error:', error);
    process.exit(1);
  });
}