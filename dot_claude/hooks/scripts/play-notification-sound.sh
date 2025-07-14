#!/bin/bash

# Claude Notification Sound Player
# Auto-detects platform and plays notification sounds

play_sound() {
    local sound_type="$1"
    local platform=""
    
    # Detect platform
    if [[ "$OSTYPE" == "darwin"* ]]; then
        platform="darwin"
    elif [[ -n "$WSL_DISTRO_NAME" ]] || [[ "$OSTYPE" == "msys" ]]; then
        platform="wsl"
    else
        platform="linux"
    fi
    
    # Set sound file path and command based on platform
    case "$platform" in
        "darwin")
            sound_file="$HOME/.claude/hooks/sounds/Claude${sound_type}.wav"
            sound_cmd="afplay"
            ;;
        "wsl")
            sound_file="C:\\Users\\$USER\\.claude\\sounds\\Claude${sound_type}.wav"
            sound_cmd="powershell.exe -c \"(New-Object Media.SoundPlayer \\\"$sound_file\\\").PlaySync()\""
            ;;
        "linux")
            sound_file="$HOME/.claude/hooks/sounds/Claude${sound_type}.wav"
            sound_cmd="paplay"
            ;;
    esac
    
    # Play sound
    if [[ "$platform" == "wsl" ]]; then
        eval "$sound_cmd" || echo "Sound file not found: $sound_file"
    else
        $sound_cmd "$sound_file" || echo "Sound file not found: $sound_file"
    fi
}

# Main execution
case "$1" in
    "Notification")
        play_sound "Notification"
        ;;
    "Stop")
        play_sound "Stop"
        ;;
    *)
        echo "Usage: $0 {Notification|Stop}"
        exit 1
        ;;
esac