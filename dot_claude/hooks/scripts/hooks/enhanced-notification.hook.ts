#!/usr/bin/env bun

import { defineHook } from "cc-hooks-ts";
import { execSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Enhanced cross-platform notification and Stop event handlers
 * Handles Stop and Notification events with cross-platform sound/visual notifications
 * Converted and enhanced from send-notification.sh and speak-notification.sh
 */
export default defineHook({
  trigger: { 
    Stop: true,
    Notification: true 
  },
  run: (context) => {
    const eventType = context.event.hook_event_name || "Unknown";
    
    try {
      // Log the event
      logEvent(eventType, context.event.session_id);
      
      // Send cross-platform notifications
      sendCrossPlatformNotification(eventType);
      
      // Play notification sound
      playNotificationSound(eventType);

      return context.success({});

    } catch (error) {
      console.error(`Notification error: ${error}`);
      return context.success({});
    }
  }
});

interface PlatformInfo {
  type: 'darwin' | 'linux' | 'wsl' | 'unknown';
  osType: string;
  isWSL: boolean;
}

function detectPlatform(): PlatformInfo {
  const osType = process.platform;
  const isWSL = Boolean(process.env.WSL_DISTRO_NAME) || process.env.TERM_PROGRAM === 'vscode';
  
  let type: PlatformInfo['type'] = 'unknown';
  
  if (osType === 'darwin') {
    type = 'darwin';
  } else if (isWSL) {
    type = 'wsl';
  } else if (osType === 'linux') {
    type = 'linux';
  }
  
  return {
    type,
    osType: process.platform,
    isWSL
  };
}

function commandExists(command: string): boolean {
  try {
    execSync(`command -v ${command}`, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function sendCrossPlatformNotification(eventType: string): void {
  const platform = detectPlatform();
  const title = "Claude Code";
  const message = eventType === "Stop" ? "Session ended" : 
                  eventType === "Notification" ? "Notification" : 
                  `Event: ${eventType}`;
  
  try {
    switch (platform.type) {
      case 'darwin':
        sendMacOSNotification(title, message);
        break;
        
      case 'wsl':
        sendWSLNotification(title, message);
        break;
        
      case 'linux':
        sendLinuxNotification(title, message);
        break;
        
      default:
        console.log(`Notification: ${title} - ${message}`);
        break;
    }
  } catch (error) {
    console.error(`Platform notification failed: ${error}`);
    console.log(`Fallback notification: ${title} - ${message}`);
  }
}

function sendMacOSNotification(title: string, message: string): void {
  if (commandExists('terminal-notifier')) {
    execSync(`terminal-notifier -title "${title}" -message "${message}"`, { stdio: 'ignore' });
  } else {
    // Fallback to osascript
    const script = `display notification "${message}" with title "${title}"`;
    execSync(`osascript -e '${script}'`, { stdio: 'ignore' });
  }
}

function sendWSLNotification(title: string, message: string): void {
  // Use PowerShell to send Windows notifications
  const powershellScript = `
    Add-Type -AssemblyName System.Windows.Forms
    $notification = New-Object System.Windows.Forms.NotifyIcon
    $notification.Icon = [System.Drawing.SystemIcons]::Information
    $notification.BalloonTipIcon = [System.Windows.Forms.ToolTipIcon]::Info
    $notification.BalloonTipTitle = '${title}'
    $notification.BalloonTipText = '${message}'
    $notification.Visible = $true
    $notification.ShowBalloonTip(5000)
    Start-Sleep -Seconds 2
    $notification.Dispose()
  `;
  
  execSync(`powershell.exe -c "${powershellScript}"`, { stdio: 'ignore' });
}

function sendLinuxNotification(title: string, message: string): void {
  if (commandExists('notify-send')) {
    execSync(`notify-send "${title}" "${message}"`, { stdio: 'ignore' });
  } else {
    console.log(`Linux notification: ${title} - ${message}`);
  }
}

function playNotificationSound(eventType: string): void {
  const soundsDir = join(homedir(), ".claude", "hooks", "sounds");
  
  let soundFile = "";
  if (eventType === "Stop") {
    soundFile = join(soundsDir, "ClaudeStop.wav");
  } else if (eventType === "Notification") {
    soundFile = join(soundsDir, "ClaudeNotification.wav");
  }
  
  if (soundFile && existsSync(soundFile)) {
    const platform = detectPlatform();
    
    try {
      switch (platform.type) {
        case 'darwin':
          // macOS: Use afplay
          execSync(`afplay "${soundFile}"`, { stdio: 'ignore' });
          break;
          
        case 'linux':
        case 'wsl':
          // Linux/WSL: Try multiple audio systems
          const audioCommands = ['paplay', 'aplay', 'play'];
          
          for (const cmd of audioCommands) {
            if (commandExists(cmd)) {
              try {
                execSync(`${cmd} "${soundFile}"`, { stdio: 'ignore', timeout: 5000 });
                break;
              } catch {
                continue;
              }
            }
          }
          break;
          
        default:
          console.log(`Playing sound: ${soundFile}`);
          break;
      }
    } catch (error) {
      console.error(`Sound playback failed: ${error}`);
    }
  }
}

function logEvent(eventType: string, sessionId?: string): void {
  const logEntry = {
    timestamp: new Date().toISOString(),
    event: eventType,
    session_id: sessionId,
    user: process.env.USER || "unknown",
    cwd: process.cwd(),
    platform: detectPlatform(),
  };

  const logFile = join(homedir(), ".config", "claude-companion", "logs", "hooks.jsonl");
  const logLine = JSON.stringify(logEntry) + "\n";
  
  try {
    // Ensure directory exists
    const logDir = join(homedir(), ".config", "claude-companion", "logs");
    mkdirSync(logDir, { recursive: true });
    
    appendFileSync(logFile, logLine);
  } catch (error) {
    console.error(`Failed to log event: ${error}`);
  }
}