# Claude Code Sound Files

This directory contains sound files for Claude Code notifications.

## Current Sound Files

- `ClaudeNotification.wav` - Default notification sound (fallback)
- `ClaudeStop.wav` - Stop sound

## Expected Sound Files

The notification script dynamically selects sounds based on message content:

### Required Files
- `ClaudeNotification.wav` - Default notification sound (used as fallback)
- `ClaudeStop.wav` - Stop sound

### Optional Files (enhance user experience)
- `ClaudePermission.wav` - Permission request notifications
  - Triggered by messages containing "needs your permission" or "permission to use"
- `ClaudeWaiting.wav` - Input waiting notifications  
  - Triggered by messages containing "waiting for your input" or "has been idle"

## Fallback Behavior

If specific sound files don't exist, the script falls back to `ClaudeNotification.wav`.
All permission and waiting notifications currently use the default notification sound.

## Platform Support

- **macOS**: Uses `afplay` command
- **Linux**: Uses `paplay` command (install with `sudo apt-get install pulseaudio-utils`)
- **WSL**: Uses PowerShell Media.SoundPlayer