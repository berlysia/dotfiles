# Claude Code Sound Files

This directory contains encrypted sound files for Claude Code notifications.

## Encrypted Files

- `ClaudeNotification.wav.age` - Encrypted notification sound
- `ClaudeStop.wav.age` - Encrypted stop sound

## Setup

### First Time Setup
1. Place your sound files here:
   - `ClaudeNotification.wav`
   - `ClaudeStop.wav`

2. Ensure Age key is in 1Password as `chezmoi-age-key`

3. Add files with encryption:
   ```bash
   chezmoi add --encrypt ~/.claude/hooks/sounds/ClaudeNotification.wav
   chezmoi add --encrypt ~/.claude/hooks/sounds/ClaudeStop.wav
   ```

### New Environment
Sound files will be automatically decrypted when you run:
```bash
chezmoi apply
```

## Note
- Raw `.wav` files are gitignored
- Only `.age` encrypted files are tracked in Git
- Decryption requires Age key from 1Password