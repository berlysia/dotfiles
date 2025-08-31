/**
 * Voice Notification Library
 * Functional approach to voice synthesis with VoiceVox-compatible engines
 * Provides reusable functions for both hook and CLI implementations
 */

import { $ } from 'dax-sh';
import { join, dirname } from 'path';
import { existsSync, mkdirSync, writeFileSync, statSync, readdirSync, unlinkSync, rmSync } from 'fs';
import { homedir } from 'os';
import { getGitContext, createContextMessage } from '../hooks/lib/git-context.ts';
import { playSound, cleanupOldFiles } from '../hooks/lib/voicevox-audio.ts';
import type { EventType, AudioQuery } from '../hooks/lib/sound-types.ts';

export interface VoiceConfig {
  host: string;
  defaultSpeakerId: string;
  tempDir: string;
  logFile: string;
  computerName: string;
  soundDir: string;
  prefixFile: string;
}

export interface VoiceSession {
  sessionId: string;
  sessionDir: string;
  currentWavFile: string | null;
}

export function createVoiceConfig(): VoiceConfig {
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

export function createVoiceSession(config: VoiceConfig): VoiceSession {
  const sessionId = process.env.CLAUDE_SESSION_ID || 
    `${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}_${process.pid}`;
  const sessionDir = join(config.tempDir, 'sessions', sessionId);

  return {
    sessionId,
    sessionDir,
    currentWavFile: null
  };
}

export function logMessage(message: string, config: VoiceConfig): void {
  try {
    const logDir = dirname(config.logFile);
    if (!existsSync(logDir)) {
      mkdirSync(logDir, { recursive: true });
    }
    
    const timestamp = new Date().toISOString();
    const logEntry = `[${timestamp}] ${message}\n`;
    writeFileSync(config.logFile, logEntry, { flag: 'a' });
  } catch {
  }
}

export function ensureDirectories(config: VoiceConfig, session: VoiceSession): void {
  try {
    const logDir = dirname(config.logFile);
    if (!existsSync(logDir)) {
      mkdirSync(logDir, { recursive: true });
    }
    
    if (!existsSync(config.tempDir)) {
      mkdirSync(config.tempDir, { recursive: true });
    }
    
    if (!existsSync(session.sessionDir)) {
      mkdirSync(session.sessionDir, { recursive: true });
    }
  } catch {
  }
}

export function cleanupSession(session: VoiceSession, config: VoiceConfig): void {
  if (session.currentWavFile && existsSync(session.currentWavFile)) {
    try {
      unlinkSync(session.currentWavFile);
      logMessage(`Cleaned up: ${session.currentWavFile}`, config);
    } catch {
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
  }
}

export async function checkSynthesisEngine(config: VoiceConfig): Promise<boolean> {
  try {
    const response = await fetch(`${config.host}/version`, {
      method: 'GET',
      signal: AbortSignal.timeout(2000)
    });
    return response.ok;
  } catch {
    logMessage(`ERROR: VoiceVox-compatible engine not available at ${config.host}`, config);
    return false;
  }
}

export async function generateAudioQuery(text: string, config: VoiceConfig, speakerId?: string): Promise<AudioQuery | null> {
  try {
    const speaker = speakerId || config.defaultSpeakerId;
    const encodedText = encodeURIComponent(text);
    
    const response = await fetch(`${config.host}/audio_query?text=${encodedText}&speaker=${speaker}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      }
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    return await response.json() as AudioQuery;
  } catch {
    logMessage('ERROR: Failed to generate audio query', config);
    return null;
  }
}

export async function synthesizeSpeech(query: AudioQuery, speakerId: string, outputFile: string, config: VoiceConfig): Promise<boolean> {
  try {
    const response = await fetch(`${config.host}/synthesis?speaker=${speakerId}`, {
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

export async function playStaticWav(wavFile: string, config: VoiceConfig): Promise<boolean> {
  if (!existsSync(wavFile)) {
    logMessage(`WARNING: Static WAV file not found: ${wavFile}`, config);
    return false;
  }

  try {
    const success = await playSound(wavFile);
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

export async function playAudioAndCleanup(audioFile: string, session: VoiceSession, config: VoiceConfig): Promise<void> {
  try {
    const success = await playSound(audioFile);
    if (success) {
      logMessage(`Successfully played audio: ${audioFile}`, config);
    } else {
      logMessage(`Failed to play audio: ${audioFile}`, config);
    }
    
    if (existsSync(audioFile)) {
      unlinkSync(audioFile);
      logMessage(`Removed audio file: ${audioFile}`, config);
    }
  } catch (error) {
    logMessage(`Failed to play audio: ${error}`, config);
    if (existsSync(audioFile)) {
      unlinkSync(audioFile);
    }
  }

  session.currentWavFile = null;
}

export async function executeFallbackNotification(eventType: EventType, reason: string, config: VoiceConfig): Promise<void> {
  logMessage(`${reason}, falling back to static WAV files`, config);

  if (existsSync(config.prefixFile)) {
    await playStaticWav(config.prefixFile, config);
    logMessage(`Playing fallback prefix: ${config.prefixFile}`, config);
  }

  const fallbackFile = join(config.soundDir, `Claude${eventType}.wav`);
  if (existsSync(fallbackFile)) {
    logMessage(`Using fallback static WAV: ${fallbackFile}`, config);
    await playStaticWav(fallbackFile, config);
  } else {
    logMessage(`WARNING: No fallback WAV found: ${fallbackFile}`, config);
  }
}

export async function speakNotification(text: string, eventType: EventType, config: VoiceConfig, session: VoiceSession): Promise<void> {
  if (!await checkSynthesisEngine(config)) {
    await executeFallbackNotification(eventType, 'Voice synthesis engine unavailable', config);
    return;
  }

  if (!existsSync(session.sessionDir)) {
    try {
      mkdirSync(session.sessionDir, { recursive: true });
    } catch {
      logMessage(`ERROR: Cannot create session directory: ${session.sessionDir}`, config);
      await executeFallbackNotification(eventType, 'Session directory creation failed', config);
      return;
    }
  }

  const timestamp = Date.now() * 1000 + Math.floor(Math.random() * 1000);
  const audioFile = join(session.sessionDir, `notification_${eventType}_${timestamp}.wav`);
  session.currentWavFile = audioFile;

  const unifiedText = `${config.computerName}の${text}`;
  logMessage(`Unified message: ${unifiedText}`, config);

  const query = await generateAudioQuery(unifiedText, config);
  if (!query) {
    await executeFallbackNotification(eventType, 'Audio query generation failed', config);
    return;
  }

  if (!await synthesizeSpeech(query, config.defaultSpeakerId, audioFile, config)) {
    await executeFallbackNotification(eventType, 'Speech synthesis failed', config);
    return;
  }

  await playAudioAndCleanup(audioFile, session, config);
  logMessage(`SUCCESS: Played notification for ${eventType}: ${text}`, config);
}

export async function handleNotification(config: VoiceConfig, session: VoiceSession): Promise<void> {
  await cleanupOldFiles();
  
  const context = await getGitContext();
  const message = createContextMessage(context, 'confirm');
  await speakNotification(message, 'Notification', config, session);
}

export async function handleStop(config: VoiceConfig, session: VoiceSession): Promise<void> {
  const context = await getGitContext();
  const message = createContextMessage(context, 'complete');
  await speakNotification(message, 'Stop', config, session);

  if (existsSync(session.sessionDir)) {
    try {
      rmSync(session.sessionDir, { recursive: true });
      logMessage(`Cleaned up session directory: ${session.sessionDir}`, config);
    } catch {
    }
  }
}

export async function handleError(config: VoiceConfig, session: VoiceSession): Promise<void> {
  const context = await getGitContext();
  const message = createContextMessage(context, 'error');
  await speakNotification(message, 'Error', config, session);
}

export async function handleCustom(eventType: string, message: string, config: VoiceConfig, session: VoiceSession): Promise<void> {
  await speakNotification(message, eventType as EventType, config, session);
}