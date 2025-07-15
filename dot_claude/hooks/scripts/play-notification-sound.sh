#!/bin/bash

# Claude Notification Sound Player
# Auto-detects platform and plays notification sounds

# Parse JSON input and extract message
parse_notification_message() {
    local json_input=""
    
    # Read JSON from stdin if available
    if [[ ! -t 0 ]]; then
        # Read from stdin
        json_input=$(cat)
        if [[ -n "$json_input" ]] && command -v jq &> /dev/null; then
            # Extract message from JSON
            echo "$json_input" | jq -r '.message // ""' 2>/dev/null || echo ""
        else
            echo ""
        fi
    else
        echo ""
    fi
}

# Determine sound type based on message content
determine_sound_type() {
    local message="$1"
    local event_type="$2"
    
    # If no message, use default event type
    if [[ -z "$message" ]]; then
        echo "$event_type"
        return
    fi
    
    # Pattern matching based on documented Claude Code notification messages
    case "$message" in
        *"needs your permission"*|*"permission to use"*)
            echo "Permission"
            ;;
        *"waiting for your input"*|*"has been idle"*)
            echo "Waiting"
            ;;
        *)
            # Default to event type for any other messages
            echo "$event_type"
            ;;
    esac
}

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
            # Fallback to generic notification if specific sound doesn't exist
            if [[ ! -f "$sound_file" ]]; then
                sound_file="$HOME/.claude/hooks/sounds/ClaudeNotification.wav"
            fi
            sound_cmd="afplay"
            ;;
        "wsl")
            sound_file="C:\\Users\\$USER\\.claude\\sounds\\Claude${sound_type}.wav"
            # Fallback to generic notification if specific sound doesn't exist (check via powershell)
            if ! powershell.exe -c "Test-Path '$sound_file'" 2>/dev/null | grep -q True; then
                sound_file="C:\\Users\\$USER\\.claude\\sounds\\ClaudeNotification.wav"
            fi
            sound_cmd="powershell.exe -c \"(New-Object Media.SoundPlayer \\\"$sound_file\\\").PlaySync()\""
            ;;
        "linux")
            sound_file="$HOME/.claude/hooks/sounds/Claude${sound_type}.wav"
            # Fallback to generic notification if specific sound doesn't exist
            if [[ ! -f "$sound_file" ]]; then
                sound_file="$HOME/.claude/hooks/sounds/ClaudeNotification.wav"
            fi
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
        # Try to parse message from JSON input to determine appropriate sound
        notification_message=$(parse_notification_message)
        sound_type=$(determine_sound_type "$notification_message" "Notification")
        play_sound "$sound_type"
        ;;
    "Stop")
        play_sound "Stop"
        ;;
    *)
        echo "Usage: $0 {Notification|Stop}"
        exit 1
        ;;
esac