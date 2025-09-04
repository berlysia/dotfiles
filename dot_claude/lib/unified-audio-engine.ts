/**
 * Unified Audio Engine
 * 統一音声通知エンジン - VoiceVox互換エンジンと静的音声ファイルの統合管理
 */

import { $ } from 'dax-sh';
import { existsSync, mkdirSync, writeFileSync, unlinkSync, rmSync, readdirSync, statSync } from 'fs';
import { dirname, join } from 'path';
import { getGitContext, createContextMessage } from '../hooks/lib/git-context.ts';
import { checkClaudeCompanionStatus, type ClaudeCompanionStatus } from './claude-companion-detector.ts';
import type { 
  UnifiedVoiceConfig, 
  VoiceSession, 
  AudioQuery, 
  NotificationResult,
  Platform,
  SoundType,
  EventType
} from './unified-audio-types.ts';
import { createUnifiedVoiceConfig, createVoiceSession } from './unified-audio-config.ts';

// =========================================================================
// Low-level Platform Audio Functions
// =========================================================================

export async function commandExists(command: string): Promise<boolean> {
  try {
    await $`which ${command}`.quiet();
    return true;
  } catch {
    return false;
  }
}

async function playWSLSound(soundFile: string): Promise<boolean> {
  try {
    const winPath = await $`wslpath -w ${soundFile}`.text();
    const script = `
      try {
        [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
        
        # Copy WAV to Windows temp
        $winTempPath = 'C:\\\\temp\\\\claude_temp.wav'
        New-Item -Path 'C:\\\\temp' -ItemType Directory -Force | Out-Null
        Copy-Item '${winPath.trim()}' $winTempPath -Force
        
        # Play from Windows filesystem (synchronous for reliable playback)
        $player = New-Object System.Media.SoundPlayer
        $player.SoundLocation = $winTempPath
        $player.Load()
        $player.PlaySync()
        Write-Host 'SoundPlayer: Audio played successfully'
        
        # Clean up Windows temp file
        Remove-Item $winTempPath -Force -ErrorAction SilentlyContinue
      } catch {
        Write-Host "Error playing audio: $($_.Exception.Message)"
      }
    `;
    
    const result = await $`powershell.exe -c ${script}`.text();
    return result.includes('Audio played successfully');
  } catch {
    return false;
  }
}

export async function playSound(soundFile: string, platform: Platform): Promise<boolean> {
  if (!existsSync(soundFile)) return false;
  
  try {
    switch (platform) {
      case 'darwin':
        await $`afplay ${soundFile}`.quiet();
        return true;
        
      case 'linux':
        if (await commandExists('paplay')) {
          await $`paplay ${soundFile}`.quiet();
        } else if (await commandExists('aplay')) {
          await $`aplay -q ${soundFile}`.quiet();
        } else {
          return false;
        }
        return true;
        
      case 'wsl':
        return await playWSLSound(soundFile);
        
      default:
        return false;
    }
  } catch {
    return false;
  }
}

// =========================================================================
// Directory and File Management
// =========================================================================

export function ensureDirectories(config: UnifiedVoiceConfig, session: VoiceSession): void {
  try {
    const logDir = dirname(config.paths.logFile);
    if (!existsSync(logDir)) {
      mkdirSync(logDir, { recursive: true });
    }
    
    if (!existsSync(config.paths.tempDir)) {
      mkdirSync(config.paths.tempDir, { recursive: true });
    }
    
    if (!existsSync(session.sessionDir)) {
      mkdirSync(session.sessionDir, { recursive: true });
    }
  } catch {
    // Directory creation errors are not fatal
  }
}

export function logMessage(message: string, config: UnifiedVoiceConfig): void {
  try {
    const logDir = dirname(config.paths.logFile);
    if (!existsSync(logDir)) {
      mkdirSync(logDir, { recursive: true });
    }
    
    const timestamp = new Date().toISOString();
    const logEntry = `[${timestamp}] ${message}\n`;
    writeFileSync(config.paths.logFile, logEntry, { flag: 'a' });
  } catch {
    // Logging errors are not fatal
  }
}

export async function cleanupOldFiles(config: UnifiedVoiceConfig): Promise<void> {
  try {
    if (!existsSync(config.paths.tempDir)) return;
    
    // 24時間以上古いWAVファイルを削除
    await $`find ${config.paths.tempDir} -type f -name "*.wav" -mmin +1440 -delete`.quiet();
  } catch {
    // Cleanup failures are not fatal
  }
}

export function cleanupSession(session: VoiceSession, config: UnifiedVoiceConfig): void {
  if (session.currentWavFile && existsSync(session.currentWavFile)) {
    try {
      unlinkSync(session.currentWavFile);
      logMessage(`Cleaned up: ${session.currentWavFile}`, config);
    } catch {
      // Cleanup errors are not fatal
    }
  }

  try {
    if (existsSync(session.sessionDir)) {
      const files = readdirSync(session.sessionDir);
      if (files.length === 0) {
        rmSync(session.sessionDir, { recursive: true });
      }
    }
  } catch {
    // Cleanup errors are not fatal
  }
}

// =========================================================================
// VoiceVox Engine Integration
// =========================================================================

export async function checkVoiceVoxEngine(config: UnifiedVoiceConfig): Promise<boolean> {
  try {
    const response = await fetch(`${config.voicevox.endpoint}/version`, {
      method: 'GET',
      signal: AbortSignal.timeout(config.voicevox.timeout)
    });
    return response.ok;
  } catch {
    logMessage(`ERROR: VoiceVox-compatible engine not available at ${config.voicevox.endpoint}`, config);
    return false;
  }
}

export async function generateAudioQuery(text: string, config: UnifiedVoiceConfig): Promise<AudioQuery | null> {
  try {
    const encodedText = encodeURIComponent(text);
    
    const response = await fetch(
      `${config.voicevox.endpoint}/audio_query?text=${encodedText}&speaker=${config.voicevox.speakerId}`, 
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        }
      }
    );

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    return await response.json() as AudioQuery;
  } catch {
    logMessage('ERROR: Failed to generate audio query', config);
    return null;
  }
}

export async function synthesizeSpeech(
  query: AudioQuery, 
  outputFile: string, 
  config: UnifiedVoiceConfig
): Promise<boolean> {
  try {
    const response = await fetch(`${config.voicevox.endpoint}/synthesis?speaker=${config.voicevox.speakerId}`, {
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
      logMessage('ERROR: Failed to synthesize speech', config);
      return false;
    }

    return true;
  } catch {
    logMessage('ERROR: Failed to synthesize speech', config);
    return false;
  }
}

// =========================================================================
// Static Sound File Management
// =========================================================================

export function getStaticSoundPath(type: SoundType, config: UnifiedVoiceConfig): string {
  const fileName = `Claude${type.charAt(0).toUpperCase() + type.slice(1)}.wav`;
  return join(config.paths.soundsDir, fileName);
}

export async function playStaticWav(wavFile: string, config: UnifiedVoiceConfig): Promise<boolean> {
  if (!existsSync(wavFile)) {
    logMessage(`WARNING: Static WAV file not found: ${wavFile}`, config);
    return false;
  }

  try {
    const success = await playSound(wavFile, config.system.platform);
    if (success) {
      logMessage(`Playing static WAV: ${wavFile}`, config);
    } else {
      logMessage(`Failed to play static WAV: ${wavFile}`, config);
    }
    return success;
  } catch (error) {
    logMessage(`Error playing static WAV: ${error}`, config);
    return false;
  }
}

// =========================================================================
// Claude Companion Integration
// =========================================================================

/**
 * claude-companionが起動している場合の処理をスキップ
 */
export async function checkAndDelegateToClaude(
  config: UnifiedVoiceConfig
): Promise<NotificationResult | null> {
  const companionStatus = await checkClaudeCompanionStatus();
  
  if (companionStatus.isRunning) {
    const message = `claude-companion is running (PID: ${companionStatus.pid}, Port: ${companionStatus.port}), delegating notification`;
    logMessage(`SUCCESS: ${message}`, config);
    
    return {
      success: true,
      method: 'delegated',
      message: 'Notification delegated to claude-companion'
    };
  }
  
  if (companionStatus.error) {
    logMessage(`claude-companion check: ${companionStatus.error}`, config);
  }
  
  return null; // claude-companionが起動していない場合はnullを返す
}

// =========================================================================
// High-level Notification Functions
// =========================================================================

export async function executeFallbackNotification(
  eventType: EventType, 
  reason: string, 
  config: UnifiedVoiceConfig
): Promise<NotificationResult> {
  logMessage(`${reason}, falling back to static WAV files`, config);

  // Play prefix if available
  if (existsSync(config.paths.prefixFile)) {
    await playStaticWav(config.paths.prefixFile, config);
    logMessage(`Playing fallback prefix: ${config.paths.prefixFile}`, config);
  }

  // Play main event sound
  const soundType = eventType.toLowerCase() as SoundType;
  const fallbackFile = getStaticSoundPath(soundType, config);
  
  if (existsSync(fallbackFile)) {
    logMessage(`Using fallback static WAV: ${fallbackFile}`, config);
    const success = await playStaticWav(fallbackFile, config);
    return { success, method: 'static' };
  } else {
    logMessage(`WARNING: No fallback WAV found: ${fallbackFile}`, config);
    return { success: false, method: 'none', error: 'No fallback sound available' };
  }
}

export async function speakNotification(
  text: string, 
  eventType: EventType, 
  config: UnifiedVoiceConfig, 
  session: VoiceSession
): Promise<NotificationResult> {
  
  // Check if claude-companion is running and delegate if so
  const delegationResult = await checkAndDelegateToClaude(config);
  if (delegationResult) {
    return delegationResult;
  }
  
  // Ensure directories exist
  ensureDirectories(config, session);
  
  // Check VoiceVox engine availability
  if (!await checkVoiceVoxEngine(config)) {
    return await executeFallbackNotification(eventType, 'Voice synthesis engine unavailable', config);
  }

  // Generate unique audio file name
  const timestamp = Date.now() * 1000 + Math.floor(Math.random() * 1000);
  const audioFile = join(session.sessionDir, `notification_${eventType}_${timestamp}.wav`);
  session.currentWavFile = audioFile;

  const unifiedText = `${config.system.computerName}の${text}`;
  logMessage(`Unified message: ${unifiedText}`, config);

  // Generate audio query
  const query = await generateAudioQuery(unifiedText, config);
  if (!query) {
    return await executeFallbackNotification(eventType, 'Audio query generation failed', config);
  }

  // Synthesize speech
  if (!await synthesizeSpeech(query, audioFile, config)) {
    return await executeFallbackNotification(eventType, 'Speech synthesis failed', config);
  }

  // Play and cleanup
  try {
    const success = await playSound(audioFile, config.system.platform);
    if (success) {
      logMessage(`Successfully played VoiceVox audio: ${audioFile}`, config);
    } else {
      logMessage(`Failed to play VoiceVox audio: ${audioFile}`, config);
      return await executeFallbackNotification(eventType, 'Audio playback failed', config);
    }
    
    // Cleanup audio file
    if (existsSync(audioFile)) {
      unlinkSync(audioFile);
      logMessage(`Removed audio file: ${audioFile}`, config);
    }
    
    session.currentWavFile = null;
    logMessage(`SUCCESS: Played VoiceVox notification for ${eventType}: ${text}`, config);
    
    return { success: true, method: 'voicevox' };
    
  } catch (error) {
    logMessage(`Failed to play VoiceVox audio: ${error}`, config);
    return await executeFallbackNotification(eventType, 'Audio playback error', config);
  }
}

// =========================================================================
// Context-Aware Notification Functions
// =========================================================================

export async function handleNotification(config: UnifiedVoiceConfig, session: VoiceSession): Promise<NotificationResult> {
  await cleanupOldFiles(config);
  
  const context = await getGitContext();
  const message = createContextMessage(context, 'confirm');
  return await speakNotification(message, 'Notification', config, session);
}

export async function handleStop(config: UnifiedVoiceConfig, session: VoiceSession): Promise<NotificationResult> {
  const context = await getGitContext();
  const message = createContextMessage(context, 'complete');
  const result = await speakNotification(message, 'Stop', config, session);

  // Cleanup session directory
  if (config.behavior.cleanupOnExit && existsSync(session.sessionDir)) {
    try {
      rmSync(session.sessionDir, { recursive: true });
      logMessage(`Cleaned up session directory: ${session.sessionDir}`, config);
    } catch {
      // Cleanup errors are not fatal
    }
  }

  return result;
}

export async function handleError(config: UnifiedVoiceConfig, session: VoiceSession): Promise<NotificationResult> {
  const context = await getGitContext();
  const message = createContextMessage(context, 'error');
  return await speakNotification(message, 'Error', config, session);
}

// =========================================================================
// System Notifications
// =========================================================================

export async function sendSystemNotification(message: string, config: UnifiedVoiceConfig): Promise<void> {
  if (!config.behavior.systemNotifications) return;
  
  try {
    await $`notify-send "Claude Code" ${message}`.quiet();
    logMessage(`System notification sent: ${message}`, config);
  } catch {
    logMessage(`Failed to send system notification: ${message}`, config);
  }
}

// =========================================================================
// Public API
// =========================================================================

export async function createAudioEngine(): Promise<{
  config: UnifiedVoiceConfig;
  session: VoiceSession;
}> {
  const config = createUnifiedVoiceConfig();
  const session = createVoiceSession(config);
  
  ensureDirectories(config, session);
  
  return { config, session };
}