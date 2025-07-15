#!/bin/bash

# Claude Native Notification Sender
# Sends native OS notifications with platform detection

send_notification() {
    local title="$1"
    local message="$2"
    local platform=""
    
    # Detect platform
    if [[ "$OSTYPE" == "darwin"* ]]; then
        platform="darwin"
    elif [[ -n "$WSL_DISTRO_NAME" ]] || [[ "$OSTYPE" == "msys" ]]; then
        platform="wsl"
    else
        platform="linux"
    fi
    
    # Send notification based on platform
    case "$platform" in
        "darwin")
            # macOS: Use terminal-notifier for native notifications
            if command -v terminal-notifier &> /dev/null; then
                terminal-notifier -title "$title" -message "$message"
            else
                echo "terminal-notifier not found. Install with: brew install terminal-notifier"
                echo "Notification: $title - $message"
            fi
            ;;
        "wsl")
            # WSL: Use PowerShell to send Windows notifications
            powershell.exe -c "
                Add-Type -AssemblyName System.Windows.Forms
                \$notification = New-Object System.Windows.Forms.NotifyIcon
                \$notification.Icon = [System.Drawing.SystemIcons]::Information
                \$notification.BalloonTipIcon = [System.Windows.Forms.ToolTipIcon]::Info
                \$notification.BalloonTipTitle = '$title'
                \$notification.BalloonTipText = '$message'
                \$notification.Visible = \$true
                \$notification.ShowBalloonTip(5000)
                Start-Sleep -Seconds 5
                \$notification.Dispose()
            "
            ;;
        "linux")
            # Linux: Use notify-send (libnotify)
            if command -v notify-send &> /dev/null; then
                notify-send "$title" "$message"
            else
                echo "notify-send not found. Install libnotify-bin package."
                echo "Notification: $title - $message"
            fi
            ;;
    esac
}

# Get repository and context information
get_repo_info() {
    local repo_name=""
    local repo_path=""
    local git_branch=""
    local timestamp=""
    
    # Get current working directory
    repo_path=$(pwd)
    timestamp=$(date '+%H:%M:%S')
    
    # Try to get git repository name and branch
    if command -v git &> /dev/null && git rev-parse --is-inside-work-tree &> /dev/null; then
        # Get repository name from git remote or directory name
        repo_name=$(git remote get-url origin 2>/dev/null | sed 's#.*/\([^/]*\)\.git$#\1#' || basename "$repo_path")
        git_branch=$(git branch --show-current 2>/dev/null || git rev-parse --short HEAD 2>/dev/null)
    else
        # Fallback to directory name
        repo_name=$(basename "$repo_path")
    fi
    
    # Format output
    local info="$repo_name"
    if [[ -n "$git_branch" ]]; then
        info="$info@$git_branch"
    fi
    info="$info ($timestamp)"
    
    echo "$info"
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

# Main execution
case "$1" in
    "Notification")
        repo_info=$(get_repo_info)
        # Try to parse message from JSON input
        notification_message=$(parse_notification_message)
        if [[ -n "$notification_message" ]]; then
            send_notification "Claude Code - Notification" "$notification_message
📁 $repo_info"
        else
            send_notification "Claude Code - Notification" "💬 操作の確認が必要です
📁 $repo_info"
        fi
        ;;
    "Stop")
        repo_info=$(get_repo_info)
        send_notification "Claude Code - Stop" "✅ 処理が完了しました
📁 $repo_info"
        ;;
    "Error")
        repo_info=$(get_repo_info)
        send_notification "Claude Code - Error" "❌ エラーが発生しました
📁 $repo_info"
        ;;
    *)
        echo "Usage: $0 {Notification|Stop|Error} [custom_message]"
        echo "  or: $0 custom_title custom_message"
        exit 1
        ;;
esac

# Custom notification support
if [[ $# -eq 2 && "$1" != "Notification" && "$1" != "Stop" && "$1" != "Error" ]]; then
    send_notification "$1" "$2"
fi