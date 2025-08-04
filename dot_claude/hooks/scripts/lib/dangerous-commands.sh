#!/bin/bash

# Dangerous command detection functions

# Check for dangerous git push commands
check_dangerous_git_push() {
    local cmd="$1"
    if [[ "$cmd" =~ ^git[[:space:]]+push && ( "$cmd" =~ [[:space:]]-f([[:space:]]|$) || "$cmd" =~ [[:space:]]--force([[:space:]]|$) || "$cmd" =~ [[:space:]]--force-with-lease([[:space:]]|$) ) ]]; then
        echo "Force push blocked: $cmd"
        return 0
    fi
    return 1
}

# Check for git commit verification bypass
check_git_commit_bypass() {
    local cmd="$1"
    if [[ "$cmd" =~ ^git[[:space:]]+commit ]]; then
        # Check for --no-verify or -n flag
        if [[ "$cmd" =~ [[:space:]]--no-verify([[:space:]]|$) ]] || \
           [[ "$cmd" =~ [[:space:]]-[a-zA-Z]*n[a-zA-Z]*([[:space:]]|$) ]] || \
           [[ "$cmd" =~ [[:space:]]-c[[:space:]]+commit\.gpgsign=false([[:space:]]|$) ]] || \
           [[ "$cmd" =~ [[:space:]]--config[[:space:]]+commit\.gpgsign=false([[:space:]]|$) ]]; then
            return 0
        fi
    fi
    return 1
}

# Check for git config write operations
check_git_config_write() {
    local cmd="$1"
    if [[ "$cmd" =~ ^git[[:space:]]+config ]]; then
        # Allow read-only operations
        if [[ "$cmd" =~ [[:space:]](--get|--get-all|--list|--get-regexp)([[:space:]]|$) ]]; then
            return 1  # Not dangerous
        else
            return 0  # Potentially dangerous write operation
        fi
    fi
    return 1
}

# Check for environment variable overrides for git
check_git_env_override() {
    local cmd="$1"
    if [[ "$cmd" =~ ^(GIT_|EMAIL=|USER=|AUTHOR=|COMMITTER=) ]] && [[ "$cmd" =~ git[[:space:]] ]]; then
        return 0
    fi
    return 1
}

# Check for dangerous rm commands
check_dangerous_rm() {
    local cmd="$1"
    if [[ "$cmd" =~ ^rm[[:space:]] && ( "$cmd" =~ [[:space:]]-[rfRi]*f[rfRi]*([[:space:]]|$) || "$cmd" =~ [[:space:]]--force([[:space:]]|$) ) ]]; then
        echo "Force rm blocked: $cmd"
        return 0
    fi
    return 1
}

# Check for operations on .git directory
check_git_directory_operation() {
    local cmd="$1"
    if [[ "$cmd" =~ ^(rm|mv|rmdir)[[:space:]] ]]; then
        # Check if command targets .git directory
        if [[ "$cmd" =~ (^|[[:space:]]|[\"\']|/)\.git(/|[[:space:]]|[\"\']|$|\*) ]] || \
           [[ "$cmd" =~ (^|[[:space:]]|[\"\']|/)\.git/(objects|refs|hooks|info|logs|HEAD|config|index)(/|[[:space:]]|[\"\']|$|\*) ]]; then
            echo "Git directory protected: $cmd"
            return 0
        fi
    fi
    return 1
}

# Main function to check all dangerous commands
check_dangerous_command() {
    local cmd="$1"
    local -n reason_ref="$2"
    
    if check_dangerous_git_push "$cmd"; then
        reason_ref="Force push detected"
        return 0
    fi
    
    if check_git_commit_bypass "$cmd"; then
        reason_ref="Git commit with verification bypass detected. Manual review required."
        return 0
    fi
    
    if check_git_config_write "$cmd"; then
        reason_ref="Git config write operation detected. Manual review required."
        return 0
    fi
    
    if check_git_env_override "$cmd"; then
        reason_ref="Git command with environment variable override detected. Manual review required."
        return 0
    fi
    
    if check_dangerous_rm "$cmd"; then
        reason_ref="Force rm detected"
        return 0
    fi
    
    if check_git_directory_operation "$cmd"; then
        reason_ref=".git directory protection"
        return 0
    fi
    
    return 1
}