#!/bin/bash

# Claude Hybrid Voice Notification
# Combines static WAV files (Prefix.wav) with AivisSpeech dynamic synthesis
# Provides immediate audio feedback with detailed voice notifications

# Configuration
AIVISSPEECH_HOST="${AIVISSPEECH_HOST:-http://localhost:10101}"
DEFAULT_SPEAKER_ID="${AIVISSPEECH_SPEAKER_ID:-888753760}"  # Anneli ノーマル
TEMP_DIR="/tmp/claude-aivisspeech"
LOG_FILE="${HOME}/.claude/log/aivisspeech.log"

# Computer name configuration (user-friendly with customization support)
COMPUTER_NAME="${CLAUDE_COMPUTER_NAME:-$(hostname | sed 's/\..*$//')}"

# Static sound files (existing WAV files for fallback)
SOUND_DIR="$HOME/.claude/hooks/sounds"
PREFIX_FILE="$SOUND_DIR/Prefix.wav"

# Session management
SESSION_ID="${CLAUDE_SESSION_ID:-$(date +%Y%m%d_%H%M%S)_$$}"
SESSION_DIR="${TEMP_DIR}/sessions/${SESSION_ID}"
CURRENT_WAV_FILE=""

# Ensure directories exist
mkdir -p "$SESSION_DIR"
mkdir -p "$(dirname "$LOG_FILE")"

# Cleanup function for trap
cleanup_on_exit() {
    if [ -n "$CURRENT_WAV_FILE" ] && [ -f "$CURRENT_WAV_FILE" ]; then
        rm -f "$CURRENT_WAV_FILE"
        log_message "Cleaned up: $CURRENT_WAV_FILE"
    fi
    # Clean up session directory if empty
    rmdir "$SESSION_DIR" 2>/dev/null || true
}

# Set up trap for cleanup on exit
trap cleanup_on_exit EXIT INT TERM

# Clean up old files on startup (files older than 24 hours)
cleanup_old_files() {
    find "$TEMP_DIR" -type f -name "*.wav" -mmin +1440 -delete 2>/dev/null || true
    find "$TEMP_DIR/sessions" -type d -empty -delete 2>/dev/null || true
    log_message "Cleaned up old WAV files (>24 hours)"
}

# Function to log messages
log_message() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" >> "$LOG_FILE"
}

# Function to check if AivisSpeech is available
check_aivisspeech() {
    if ! curl -s --fail --connect-timeout 2 "${AIVISSPEECH_HOST}/version" > /dev/null 2>&1; then
        log_message "ERROR: AivisSpeech Engine not available at ${AIVISSPEECH_HOST}"
        return 1
    fi
    return 0
}

# Function to generate audio query
generate_audio_query() {
    local text="$1"
    local speaker_id="${2:-$DEFAULT_SPEAKER_ID}"
    
    local response=$(curl -s -X POST \
        "${AIVISSPEECH_HOST}/audio_query?text=$(jq -rn --arg text "$text" '$text|@uri')&speaker=${speaker_id}" \
        -H "Content-Type: application/json" 2>/dev/null)
    
    if [ $? -ne 0 ] || [ -z "$response" ]; then
        log_message "ERROR: Failed to generate audio query"
        return 1
    fi
    
    echo "$response"
}

# Function to synthesize speech
synthesize_speech() {
    local query="$1"
    local speaker_id="${2:-$DEFAULT_SPEAKER_ID}"
    local output_file="$3"
    
    curl -s -X POST \
        "${AIVISSPEECH_HOST}/synthesis?speaker=${speaker_id}" \
        -H "Content-Type: application/json" \
        -H "Accept: audio/wav" \
        -d "$query" \
        -o "$output_file" 2>/dev/null
    
    if [ $? -ne 0 ] || [ ! -f "$output_file" ] || [ ! -s "$output_file" ]; then
        log_message "ERROR: Failed to synthesize speech"
        return 1
    fi
    
    return 0
}

# Function to play static WAV file (Prefix.wav)
play_static_wav() {
    local wav_file="$1"
    local platform=""
    
    # Check if file exists
    if [[ ! -f "$wav_file" ]]; then
        log_message "WARNING: Static WAV file not found: $wav_file"
        return 1
    fi
    
    # Detect platform
    if [[ "$OSTYPE" == "darwin"* ]]; then
        platform="darwin"
    elif [[ -n "$WSL_DISTRO_NAME" ]] || [[ "$OSTYPE" == "msys" ]]; then
        platform="wsl"
    else
        platform="linux"
    fi
    
    # Play audio based on platform
    case "$platform" in
        "darwin")
            if command -v afplay &> /dev/null; then
                afplay "$wav_file" &
                log_message "Playing static WAV (macOS): $wav_file"
            else
                log_message "WARNING: afplay not found on macOS"
                return 1
            fi
            ;;
        "wsl")
            # Convert to Windows path for PowerShell
            local win_path=$(wslpath -w "$wav_file" 2>/dev/null || echo "$wav_file")
            log_message "Playing static WAV (WSL): $win_path"
            # Copy to Windows filesystem and play (WSL path access issue)
            powershell.exe -c "
                try {
                    # Copy WAV to Windows temp
                    \$winTempPath = 'C:\temp\claude_prefix_temp.wav'
                    New-Item -Path 'C:\temp' -ItemType Directory -Force | Out-Null
                    Copy-Item '$win_path' \$winTempPath -Force
                    
                    # Play from Windows filesystem (synchronous for reliable playback)
                    \$player = New-Object System.Media.SoundPlayer
                    \$player.SoundLocation = \$winTempPath
                    \$player.Load()
                    \$player.PlaySync()
                    Write-Host 'SoundPlayer: Static WAV completed'
                    
                    # Clean up Windows temp file
                    Remove-Item \$winTempPath -Force -ErrorAction SilentlyContinue
                } catch {
                    Write-Host 'Error playing static WAV:' \$_.Exception.Message
                }
            " 2>&1 | while read line; do
                log_message "Static: $line"
            done
            ;;
        "linux")
            if command -v paplay &> /dev/null; then
                paplay "$wav_file" &
                log_message "Playing static WAV (Linux): $wav_file"
            elif command -v aplay &> /dev/null; then
                aplay -q "$wav_file" &
                log_message "Playing static WAV (Linux): $wav_file"
            else
                log_message "WARNING: No audio player found (paplay/aplay)"
                return 1
            fi
            ;;
    esac
    
    return 0
}

# Function to play audio file with immediate cleanup
play_audio_and_cleanup() {
    local audio_file="$1"
    local platform=""
    local player_pid=""
    
    # Detect platform
    if [[ "$OSTYPE" == "darwin"* ]]; then
        platform="darwin"
    elif [[ -n "$WSL_DISTRO_NAME" ]] || [[ "$OSTYPE" == "msys" ]]; then
        platform="wsl"
    else
        platform="linux"
    fi
    
    # Play audio based on platform
    case "$platform" in
        "darwin")
            if command -v afplay &> /dev/null; then
                afplay "$audio_file"
                rm -f "$audio_file"
            else
                log_message "WARNING: afplay not found on macOS"
            fi
            ;;
        "wsl")
            # Convert to Windows path for PowerShell
            local win_path=$(wslpath -w "$audio_file" 2>/dev/null || echo "$audio_file")
            log_message "Playing audio file: $win_path"
            
            # Copy to Windows filesystem and play (WSL path access issue)
            powershell.exe -c "
                try {
                    # Copy WAV to Windows temp
                    \$winTempPath = 'C:\temp\claude_dynamic_temp.wav'
                    New-Item -Path 'C:\temp' -ItemType Directory -Force | Out-Null
                    Copy-Item '$win_path' \$winTempPath -Force
                    
                    # Play from Windows filesystem
                    \$player = New-Object System.Media.SoundPlayer
                    \$player.SoundLocation = \$winTempPath
                    \$player.Load()
                    \$player.PlaySync()
                    Write-Host 'SoundPlayer: Audio played successfully'
                    
                    # Clean up Windows temp file
                    Remove-Item \$winTempPath -Force -ErrorAction SilentlyContinue
                } catch {
                    Write-Host 'Error playing audio:' \$_.Exception.Message
                }
            " 2>&1 | while read line; do
                log_message "Audio: $line"
            done
            
            rm -f "$audio_file"
            log_message "Removed audio file: $audio_file"
            ;;
        "linux")
            if command -v paplay &> /dev/null; then
                paplay "$audio_file"
                rm -f "$audio_file"
            elif command -v aplay &> /dev/null; then
                aplay -q "$audio_file"
                rm -f "$audio_file"
            else
                log_message "WARNING: No audio player found (paplay/aplay)"
                rm -f "$audio_file"
            fi
            ;;
    esac
    
    # Clear current file reference after cleanup
    CURRENT_WAV_FILE=""
}

# Function to execute complete fallback sequence
execute_fallback_notification() {
    local event_type="$1"
    local reason="${2:-Unknown reason}"
    
    log_message "$reason, falling back to static WAV files"
    
    # Step 1: Play Prefix.wav if available
    if [[ -f "$PREFIX_FILE" ]]; then
        play_static_wav "$PREFIX_FILE"
        log_message "Playing fallback prefix: $PREFIX_FILE"
    fi
    
    # Step 2: Play event-specific fallback file
    local fallback_file="$SOUND_DIR/Claude${event_type}.wav"
    if [[ -f "$fallback_file" ]]; then
        log_message "Using fallback static WAV: $fallback_file"
        play_static_wav "$fallback_file"
        return 0
    else
        log_message "WARNING: No fallback WAV found: $fallback_file"
        return 1
    fi
}

# Function to generate and play notification
speak_notification() {
    local text="$1"
    local event_type="$2"
    
    # Check if AivisSpeech is available for dynamic synthesis
    if ! check_aivisspeech; then
        execute_fallback_notification "$event_type" "AivisSpeech unavailable"
        return $?
    fi
    
    # Generate unique filename in session directory
    local timestamp=$(date +%s%N)
    local audio_file="${SESSION_DIR}/notification_${event_type}_${timestamp}.wav"
    CURRENT_WAV_FILE="$audio_file"
    
    # Generate unified message: computer name + dynamic content
    local unified_text="${COMPUTER_NAME}の${text}"
    log_message "Unified message: $unified_text"
    
    # Generate audio query for unified message
    local query=$(generate_audio_query "$unified_text")
    if [ $? -ne 0 ]; then
        execute_fallback_notification "$event_type" "Audio query generation failed"
        return $?
    fi
    
    # Synthesize unified speech
    if ! synthesize_speech "$query" "$DEFAULT_SPEAKER_ID" "$audio_file"; then
        execute_fallback_notification "$event_type" "Speech synthesis failed"
        return $?
    fi
    
    # Play unified audio
    play_audio_and_cleanup "$audio_file"
    
    log_message "SUCCESS: Played notification for $event_type: $text"
    return 0
}

# Get repository information (similar to send-notification.sh)
get_repo_info() {
    local repo_name=""
    local repo_path=""
    local git_branch=""
    
    repo_path=$(pwd)
    
    if command -v git &> /dev/null && git rev-parse --is-inside-work-tree &> /dev/null; then
        repo_name=$(git remote get-url origin 2>/dev/null | sed 's#.*/\([^/]*\)\.git$#\1#' || basename "$repo_path")
        git_branch=$(git branch --show-current 2>/dev/null || git rev-parse --short HEAD 2>/dev/null)
    else
        repo_name=$(basename "$repo_path")
    fi
    
    echo "$repo_name"
}

# Clean up old files on Notification event (first event usually)
if [ "$1" = "Notification" ]; then
    cleanup_old_files
fi

# Main execution
case "$1" in
    "Notification")
        repo_name=$(get_repo_info)
        message="$repo_name リポジトリで操作の確認が必要です"
        speak_notification "$message" "Notification"
        ;;
    "Stop")
        repo_name=$(get_repo_info)
        message="$repo_name リポジトリで処理が完了しました"
        speak_notification "$message" "Stop"
        
        # Clean up entire session directory on Stop
        if [ -d "$SESSION_DIR" ]; then
            rm -rf "$SESSION_DIR"
            log_message "Cleaned up session directory: $SESSION_DIR"
        fi
        ;;
    "Error")
        repo_name=$(get_repo_info)
        message="$repo_name リポジトリでエラーが発生しました"
        speak_notification "$message" "Error"
        ;;
    *)
        # Custom message support
        if [ $# -eq 2 ]; then
            speak_notification "$2" "$1"
        else
            echo "Usage: $0 {Notification|Stop|Error} [custom_message]"
            exit 1
        fi
        ;;
esac

# Cleanup will be handled by trap
# Always exit successfully to not break the hook chain
exit 0