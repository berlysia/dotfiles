#!/usr/bin/env bun

import { defineHook } from "cc-hooks-ts";
import { execSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Notification and Stop event handlers
 * Handles Stop and Notification events with sound/visual notifications
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
      
      // Play notification sound and send notification
      handleNotifications(eventType);

      return context.success({});

    } catch (error) {
      console.error(`Notification error: ${error}`);
      return context.success({});
    }
  }
});

function logEvent(eventType: string, sessionId?: string): void {
  const logEntry = {
    timestamp: new Date().toISOString(),
    event: eventType,
    session_id: sessionId,
    user: process.env.USER || "unknown",
    cwd: process.cwd(),
  };

  const logFile = join(homedir(), ".config", "claude-companion", "logs", "hooks.jsonl");
  const logLine = JSON.stringify(logEntry) + "\n";
  
  try {
    // Ensure directory exists
    const logDir = join(homedir(), ".config", "claude-companion", "logs");
    require("node:fs").mkdirSync(logDir, { recursive: true });
    
    appendFileSync(logFile, logLine);
  } catch (error) {
    console.error(`Failed to log event: ${error}`);
  }
}

function handleNotifications(eventType: string): void {
  const soundsDir = join(homedir(), ".claude", "hooks", "sounds");
  
  try {
    // Play notification sound
    let soundFile = "";
    if (eventType === "Stop") {
      soundFile = join(soundsDir, "ClaudeStop.wav");
    } else if (eventType === "Notification") {
      soundFile = join(soundsDir, "ClaudeNotification.wav");
    }
    
    if (soundFile && require("node:fs").existsSync(soundFile)) {
      // Try to play sound (Linux-specific, could be enhanced for other platforms)
      try {
        execSync(`paplay "${soundFile}"`, { stdio: "ignore" });
      } catch {
        // Fallback to aplay
        try {
          execSync(`aplay "${soundFile}"`, { stdio: "ignore" });
        } catch {
          // Sound playback failed, continue silently
        }
      }
    }
    
    // Send desktop notification (Linux-specific)
    try {
      const message = eventType === "Stop" ? "Claude Code session ended" : "Claude Code notification";
      execSync(`notify-send "Claude Code" "${message}"`, { stdio: "ignore" });
    } catch {
      // Notification failed, continue silently
    }
    
    // Text-to-speech notification (optional, Linux-specific)
    try {
      const message = eventType === "Stop" ? "Claude session ended" : "Claude notification";
      execSync(`espeak "${message}"`, { stdio: "ignore" });
    } catch {
      // TTS failed, continue silently
    }
    
  } catch (error) {
    console.error(`Notification handling error: ${error}`);
  }
}