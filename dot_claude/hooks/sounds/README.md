# Claude Code Sound Files

This directory contains sound files for Claude Code notifications.

## File Naming Convention

Sound files follow the pattern:
```
Claude${EventType}.wav
```

- **Prefix**: `Claude`
- **Body**: EventType name (PascalCase)
- **Extension**: `.wav`

## Sound Files

### Event Sounds

| EventType | File Name | Description |
|-----------|-----------|-------------|
| `Notification` | `ClaudeNotification.wav` | Default notification (fallback) |
| `Stop` | `ClaudeStop.wav` | Task completion |
| `Error` | `ClaudeError.wav` | Error notification |
| `PermissionRequest` | `ClaudePermissionRequest.wav` | Permission request |
| `AskUserQuestion` | `ClaudeAskUserQuestion.wav` | User input required |

### Special Files

| File Name | Description |
|-----------|-------------|
| `Prefix.wav` | Played before event sound in fallback mode |

#### Prefix.wav Usage

`Prefix.wav` is played before the main event sound, useful for:

- **Device identification**: "MacBook Pro" or "Dev Server" voice announcement
- **Context setting**: Distinguish notifications from multiple machines
- **Attention grabber**: Short chime before the actual notification

Example: Create with text-to-speech
```bash
# macOS
say -o Prefix.aiff "MacBook Pro"
ffmpeg -i Prefix.aiff Prefix.wav

# Linux (with espeak)
espeak -w Prefix.wav "Dev Server"
```

## Fallback Behavior

If a specific sound file doesn't exist, the script falls back to `ClaudeNotification.wav`.

## Platform Support

- **macOS**: Uses `afplay` command
- **Linux**: Uses `paplay` command (install with `sudo apt-get install pulseaudio-utils`)
- **WSL**: Uses PowerShell Media.SoundPlayer
