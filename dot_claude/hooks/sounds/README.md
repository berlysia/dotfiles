# Claude Code Sound Files

This directory contains sound files for Claude Code notifications.

## File Naming Convention

Sound files are named based on `EventType`:
```
Claude${EventType}.wav
```

## Expected Sound Files

### Required Files
- `ClaudeNotification.wav` - Default notification sound (used as fallback)
- `ClaudeStop.wav` - Task completion sound

### Optional Files (enhance user experience)
- `ClaudeError.wav` - Error notification
- `ClaudePermissionRequest.wav` - Permission request notifications
- `ClaudeAskUserQuestion.wav` - User input required notifications

## Fallback Behavior

If a specific sound file doesn't exist, the script falls back to `ClaudeNotification.wav`.

## Platform Support

- **macOS**: Uses `afplay` command
- **Linux**: Uses `paplay` command (install with `sudo apt-get install pulseaudio-utils`)
- **WSL**: Uses PowerShell Media.SoundPlayer