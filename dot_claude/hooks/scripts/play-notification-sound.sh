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
    
    # Check if sound command is available
    if [[ "$platform" == "wsl" ]]; then
        # WSL uses PowerShell which is always available
        eval "$sound_cmd" || echo "Sound file not found: $sound_file"
    else
        # Check if sound command exists for macOS and Linux
        if ! command -v "$sound_cmd" &> /dev/null; then
            echo "Error: $sound_cmd is not installed. Please install it to play notification sounds."
            case "$platform" in
                "darwin")
                    echo "afplay should be pre-installed on macOS"
                    ;;
                "linux")
                    echo "Install with: sudo apt-get install pulseaudio-utils"
                    ;;
            esac
            return 1
        fi
        
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