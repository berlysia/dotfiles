import { $ } from 'dax-sh';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { homedir } from 'node:os';

// 型定義
export type Platform = 'darwin' | 'linux' | 'wsl';
export type SoundType = 'notification' | 'stop' | 'permission' | 'waiting';

export interface VoiceVoxCompatibleConfig {
  endpoint?: string;  // VoiceVox互換エンジンのエンドポイント
  speakerId?: string; // 話者ID
}

export interface AudioConfig {
  soundsDir: string;
  tempDir: string;
  voicevox?: VoiceVoxCompatibleConfig;
}

// プラットフォーム検出
export function detectPlatform(): Platform {
  const osType = process.env.OSTYPE || '';
  if (osType.startsWith('darwin')) return 'darwin';
  if (process.env.WSL_DISTRO_NAME) return 'wsl';
  return 'linux';
}

// 設定取得（環境変数サポート）
export function getAudioConfig(): AudioConfig {
  const homeDir = homedir();
  const endpoint = process.env.VOICEVOX_ENDPOINT;
  
  const config: AudioConfig = {
    soundsDir: path.join(homeDir, '.claude/hooks/sounds'),
    tempDir: '/tmp/claude-voicevox'
  };
  
  if (endpoint) {
    config.voicevox = {
      endpoint,
      speakerId: process.env.VOICEVOX_SPEAKER_ID || '888753760'
    };
  }
  
  return config;
}

// コマンドの存在確認
export async function commandExists(command: string): Promise<boolean> {
  try {
    await $`which ${command}`.quiet();
    return true;
  } catch {
    return false;
  }
}

// WSL環境でのWindows側音声再生
export async function playWSLSound(soundFile: string): Promise<boolean> {
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

// 汎用的な音声ファイル再生
export async function playSound(soundFile: string): Promise<boolean> {
  const platform = detectPlatform();
  
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

// VoiceVox互換エンジンの可用性チェック
export async function isVoiceVoxAvailable(): Promise<boolean> {
  const config = getAudioConfig();
  if (!config.voicevox?.endpoint) return false;
  
  try {
    const response = await fetch(`${config.voicevox.endpoint}/version`, {
      signal: AbortSignal.timeout(2000)
    });
    return response.ok;
  } catch {
    return false;
  }
}

// VoiceVox互換音声合成
export async function synthesizeVoiceVoxSpeech(text: string, speakerId?: string): Promise<string | null> {
  const config = getAudioConfig();
  if (!config.voicevox?.endpoint) return null;
  
  const speaker = speakerId || config.voicevox.speakerId || '888753760';
  
  try {
    // 音声クエリ生成
    const queryResponse = await fetch(
      `${config.voicevox.endpoint}/audio_query?text=${encodeURIComponent(text)}&speaker=${speaker}`,
      { method: 'POST' }
    );
    
    if (!queryResponse.ok) return null;
    const query = await queryResponse.json();
    
    // 音声合成
    const synthesisResponse = await fetch(
      `${config.voicevox.endpoint}/synthesis?speaker=${speaker}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(query)
      }
    );
    
    if (!synthesisResponse.ok) return null;
    
    // 一時ファイルに保存
    await fs.mkdir(config.tempDir, { recursive: true });
    const tempFile = path.join(config.tempDir, `voice-${Date.now()}.wav`);
    
    const buffer = await synthesisResponse.arrayBuffer();
    await fs.writeFile(tempFile, Buffer.from(buffer));
    
    return tempFile;
  } catch {
    return null;
  }
}

// 静的音声ファイルのパス取得
export function getStaticSoundPath(type: SoundType): string {
  const config = getAudioConfig();
  const fileName = `Claude${type.charAt(0).toUpperCase() + type.slice(1)}.wav`;
  return path.join(config.soundsDir, fileName);
}

// ファイルの存在確認
async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

// 統合通知関数（優先度付きフォールバック機構）
export async function notify(message: string, type: SoundType = 'notification'): Promise<void> {
  let voicePlayedSuccessfully = false;
  
  // 1. VoiceVox音声合成を優先的に試みる
  if (await isVoiceVoxAvailable()) {
    const voiceFile = await synthesizeVoiceVoxSpeech(message);
    if (voiceFile) {
      try {
        if (await playSound(voiceFile)) {
          voicePlayedSuccessfully = true;
        }
      } finally {
        await fs.unlink(voiceFile).catch(() => {});
      }
    }
  }
  
  // 2. VoiceVoxが失敗した場合のみ静的WAVファイルを再生（フォールバック）
  if (!voicePlayedSuccessfully) {
    const staticSound = getStaticSoundPath(type);
    if (await fileExists(staticSound)) {
      await playSound(staticSound);
    }
  }
  
  // 3. システム通知（Linux限定、音声と並列実行）
  if (detectPlatform() === 'linux') {
    await $`notify-send "Claude Code" ${message}`.quiet().catch(() => {});
  }
}

// リポジトリ情報取得
export async function getRepoInfo(): Promise<string> {
  try {
    const isGit = await $`git rev-parse --is-inside-work-tree`.quiet().noThrow();
    if (isGit.code === 0) {
      const remoteUrl = await $`git remote get-url origin`.text().catch(() => '');
      if (remoteUrl) {
        const match = remoteUrl.match(/\/([^/]+)\.git$/);
        if (match && match[1]) return match[1];
      }
      return await $`basename $(pwd)`.text().then(s => s.trim());
    }
    return await $`basename $(pwd)`.text().then(s => s.trim());
  } catch {
    return 'unknown';
  }
}

// リポジトリコンテキスト付き通知
export async function notifyWithContext(eventType: 'Notification' | 'Stop'): Promise<void> {
  const repo = await getRepoInfo();
  const computerName = process.env.CLAUDE_COMPUTER_NAME || 'Claude';
  
  const message = eventType === 'Stop' 
    ? `${computerName}の${repo} リポジトリで処理が完了しました`
    : `${computerName}の${repo} リポジトリで操作の確認が必要です`;
  
  await notify(message, eventType.toLowerCase() as SoundType);
}

// 古いファイルのクリーンアップ
export async function cleanupOldFiles(): Promise<void> {
  const config = getAudioConfig();
  
  try {
    if (!await fileExists(config.tempDir)) {
      return;
    }
    
    // 24時間以上古いWAVファイルを削除
    await $`find ${config.tempDir} -type f -name "*.wav" -mmin +1440 -delete`.quiet();
  } catch {
    // クリーンアップの失敗は無視
  }
}