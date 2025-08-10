#!/bin/bash

# Claude Notification Sound Player
# Auto-detects platform and plays notification sounds

# Log directory
LOG_DIR="$HOME/.claude/hooks/logs"
LOG_FILE="$LOG_DIR/notifications.jsonl"

# Ensure log directory exists
ensure_log_dir() {
    [[ ! -d "$LOG_DIR" ]] && mkdir -p "$LOG_DIR"
}

# Log notification message with metadata
log_notification() {
    local event_type="$1"
    local message="$2"
    local sound_type="$3"
    local timestamp=$(date -Iseconds)
    
    ensure_log_dir
    
    # Create JSON log entry
    local log_entry=$(jq -n \
        --arg timestamp "$timestamp" \
        --arg event_type "$event_type" \
        --arg message "$message" \
        --arg sound_type "$sound_type" \
        '{
            timestamp: $timestamp,
            event_type: $event_type,
            message: $message,
            sound_type: $sound_type
        }')
    
    # Append to log file
    echo "$log_entry" >> "$LOG_FILE"
    
    # Rotate log if it gets too large (>1000 lines)
    rotate_log_if_needed
}

# Rotate log file if it exceeds threshold
rotate_log_if_needed() {
    local max_lines=1000
    
    if [[ -f "$LOG_FILE" ]] && [[ $(wc -l < "$LOG_FILE") -gt $max_lines ]]; then
        local backup_file="${LOG_FILE}.$(date +%Y%m%d_%H%M%S)"
        mv "$LOG_FILE" "$backup_file"
        
        # Keep only last 5 backup files
        find "$LOG_DIR" -name "notifications.jsonl.*" -type f | sort -r | tail -n +6 | xargs rm -f
    fi
}

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
    
    # Pattern matching based on actual notification messages from logs
    case "$message" in
        *"needs your permission to use"*)
            # Permission requests for tools: Bash, Read, Write, Update, etc.
            echo "Permission"
            ;;
        *"is waiting for your input"*)
            # Claude is waiting for user response
            echo "Waiting"
            ;;
        *"has been idle"*)
            # Idle timeout notification (not seen in logs yet but documented)
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
    
    # Set sound file paths and command based on platform
    case "$platform" in
        "darwin")
            prefix_file="$HOME/.claude/hooks/sounds/Prefix.wav"
            sound_file="$HOME/.claude/hooks/sounds/Claude${sound_type}.wav"
            # Fallback to generic notification if specific sound doesn't exist
            if [[ ! -f "$sound_file" ]]; then
                sound_file="$HOME/.claude/hooks/sounds/ClaudeNotification.wav"
            fi
            sound_cmd="afplay"
            ;;
        "wsl")
            prefix_file="C:\\Users\\$USER\\.claude\\sounds\\Prefix.wav"
            sound_file="C:\\Users\\$USER\\.claude\\sounds\\Claude${sound_type}.wav"
            # Fallback to generic notification if specific sound doesn't exist (check via powershell)
            if ! powershell.exe -c "Test-Path '$sound_file'" 2>/dev/null | grep -q True; then
                sound_file="C:\\Users\\$USER\\.claude\\sounds\\ClaudeNotification.wav"
            fi
            sound_cmd="powershell.exe -c \"(New-Object Media.SoundPlayer \\\"#FILE#\\\").PlaySync()\""
            ;;
        "linux")
            prefix_file="$HOME/.claude/hooks/sounds/Prefix.wav"
            sound_file="$HOME/.claude/hooks/sounds/Claude${sound_type}.wav"
            # Fallback to generic notification if specific sound doesn't exist
            if [[ ! -f "$sound_file" ]]; then
                sound_file="$HOME/.claude/hooks/sounds/ClaudeNotification.wav"
            fi
            sound_cmd="paplay --wait"
            ;;
    esac
    
    # Check if sound command is available
    if [[ "$platform" == "wsl" ]]; then
        # WSL uses PowerShell which is always available
        
        # Play prefix sound first if it exists
        if powershell.exe -c "Test-Path '$prefix_file'" 2>/dev/null | grep -q True; then
            local prefix_cmd="${sound_cmd//#FILE#/$prefix_file}"
            eval "$prefix_cmd" 2>/dev/null || echo "Prefix sound file not found: $prefix_file"
        fi
        
        # Then play main sound
        local main_cmd="${sound_cmd//#FILE#/$sound_file}"
        eval "$main_cmd" || echo "Sound file not found: $sound_file"
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
        
        # Play prefix sound first if it exists and wait for completion
        if [[ -f "$prefix_file" ]]; then
            $sound_cmd "$prefix_file" 2>/dev/null || echo "Prefix sound file not found: $prefix_file"
        fi
        
        # Then play main sound
        $sound_cmd "$sound_file" || echo "Sound file not found: $sound_file"
    fi
}

# Show notification statistics
show_stats() {
    ensure_log_dir
    
    if [[ ! -f "$LOG_FILE" ]]; then
        echo "No notification logs found."
        return
    fi
    
    echo "=== Claude Notification Statistics ==="
    echo "Total notifications: $(wc -l < "$LOG_FILE")"
    echo
    
    echo "By event type:"
    jq -r '.event_type' "$LOG_FILE" | sort | uniq -c | sort -nr
    echo
    
    echo "By sound type:"
    jq -r '.sound_type' "$LOG_FILE" | sort | uniq -c | sort -nr
    echo
    
    echo "Recent messages (last 10):"
    tail -10 "$LOG_FILE" | jq -r '"[\(.timestamp)] \(.event_type): \(.message)"'
}

# Main execution
case "$1" in
    "Notification")
        # Try to parse message from JSON input to determine appropriate sound
        notification_message=$(parse_notification_message)
        sound_type=$(determine_sound_type "$notification_message" "Notification")
        
        # Log the notification
        log_notification "Notification" "$notification_message" "$sound_type"
        
        # Play the sound in background to avoid blocking
        play_sound "$sound_type" &
        ;;
    "Stop")
        # Log the stop event
        log_notification "Stop" "" "Stop"
        
        # Play the sound in background to avoid blocking
        play_sound "Stop" &
        ;;
    "stats")
        show_stats
        ;;
    *)
        echo "Usage: $0 {Notification|Stop|stats}"
        exit 1
        ;;
esac