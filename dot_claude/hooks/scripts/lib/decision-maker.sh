#!/bin/bash

# Decision making functions for permission handling

# Output JSON decision
output_decision() {
    local decision="$1"
    local reason="$2"
    
    case "$decision" in
        "block"|"deny")
            echo "{
    \"hookSpecificOutput\": {
        \"hookEventName\": \"PreToolUse\",
        \"permissionDecision\": \"deny\",
        \"permissionDecisionReason\": \"$reason\"
    }
}"
            ;;
        "approve"|"allow")
            echo "{
    \"hookSpecificOutput\": {
        \"hookEventName\": \"PreToolUse\",
        \"permissionDecision\": \"allow\",
        \"permissionDecisionReason\": \"$reason\"
    }
}"
            ;;
        "ask")
            echo "{
    \"hookSpecificOutput\": {
        \"hookEventName\": \"PreToolUse\",
        \"permissionDecision\": \"ask\",
        \"permissionDecisionReason\": \"$reason\"
    }
}"
            ;;
        *)
            # No match means we don't have a decision
            echo '{}'
            ;;
    esac
}

# Analyze individual command results for Bash tool
analyze_bash_command_results() {
    local -n results_ref="$1"
    local -n deny_matches_ref="$2"
    local -n decision_ref="$3"
    local -n reason_ref="$4"
    
    # If any command is denied, block the entire operation
    if [ ${#deny_matches_ref[@]} -gt 0 ]; then
        decision_ref="block"
        reason_ref="One or more commands blocked: ${deny_matches_ref[*]}"
        return
    fi
    
    # Check if ALL commands are explicitly allowed
    local all_allowed=true
    for result in "${results_ref[@]}"; do
        if [[ "$result" != ALLOW:* ]]; then
            all_allowed=false
            break
        fi
    done
    
    if [ "$all_allowed" = true ] && [ ${#results_ref[@]} -gt 0 ]; then
        decision_ref="approve"
        reason_ref="All individual commands explicitly allowed"
    else
        decision_ref="no_match"
        reason_ref="Not all commands explicitly allowed"
    fi
}

# Analyze pattern matches for non-Bash tools
analyze_pattern_matches() {
    local -n allow_matches_ref="$1"
    local -n deny_matches_ref="$2"
    local -n decision_ref="$3"
    local -n reason_ref="$4"
    
    if [ ${#deny_matches_ref[@]} -gt 0 ]; then
        decision_ref="block"
        reason_ref="Matched deny patterns: ${deny_matches_ref[*]}"
    elif [ ${#allow_matches_ref[@]} -gt 0 ]; then
        decision_ref="approve"
        reason_ref="Matched allow patterns: ${allow_matches_ref[*]}"
    else
        decision_ref="no_match"
        reason_ref="No patterns matched"
    fi
}