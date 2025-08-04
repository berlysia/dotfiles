#!/bin/bash

# Auto-approve commands based on permissions.allow/deny lists
# Refactored version with modular structure

# Source common libraries
SCRIPT_DIR="$(dirname "$0")"
source "${SCRIPT_DIR}/lib/hook-common.sh"
source "${SCRIPT_DIR}/lib/pattern-matcher.sh"
source "${SCRIPT_DIR}/lib/dangerous-commands.sh"
source "${SCRIPT_DIR}/lib/decision-maker.sh"
source "${SCRIPT_DIR}/lib/logging.sh"

# Log file for auto-approved commands
LOG_FILE="${HOME}/.claude/auto_approve_commands.log"

# Process individual Bash command
process_bash_command() {
    local cmd="$1"
    local deny_list="$2"
    local allow_list="$3"
    local -n result_ref="$4"
    local -n deny_match_ref="$5"
    local -n exit_early_ref="$6"
    
    # Check for dangerous commands first
    local danger_reason=""
    if check_dangerous_command "$cmd" danger_reason; then
        # Special handling for commands that need manual review
        if [[ "$danger_reason" == *"Manual review required"* ]]; then
            exit_early_ref="ask|$danger_reason"
            return
        else
            result_ref="DENY: '$cmd' (blocked: $danger_reason)"
            deny_match_ref="$danger_reason"
            return
        fi
    fi
    
    # Check deny patterns
    if [ -n "$deny_list" ]; then
        local matched_deny_pattern=""
        if _check_individual_command_deny_with_pattern "$cmd" "$deny_list" matched_deny_pattern; then
            result_ref="DENY: '$cmd' (matched: $matched_deny_pattern)"
            deny_match_ref="Individual command blocked: $cmd"
            return
        fi
    fi
    
    # Check allow patterns
    if [ -n "$allow_list" ]; then
        local matched_allow_pattern=""
        if _check_individual_command_with_pattern "$cmd" "$allow_list" matched_allow_pattern; then
            result_ref="ALLOW: '$cmd' (matched: $matched_allow_pattern)"
        else
            result_ref="NO_MATCH: '$cmd' (no allow pattern matched)"
        fi
    else
        result_ref="NO_MATCH: '$cmd' (no allow patterns defined)"
    fi
}

# Process Bash tool commands
process_bash_tool() {
    local tool_input="$1"
    local deny_list="$2"
    local allow_list="$3"
    local -n individual_results_ref="$4"
    local -n deny_matches_ref="$5"
    local -n early_exit_ref="$6"
    
    local bash_command
    bash_command=$(echo "$tool_input" | jq -r '.command // empty')
    
    local extracted_commands=()
    _extract_commands_from_compound "$bash_command" extracted_commands
    
    # Process each individual command
    for cmd in "${extracted_commands[@]}"; do
        cmd=$(echo "$cmd" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')
        if [ -n "$cmd" ]; then
            local cmd_result=""
            local cmd_deny_match=""
            local exit_early=""
            process_bash_command "$cmd" "$deny_list" "$allow_list" cmd_result cmd_deny_match exit_early
            
            # Check for early exit conditions
            if [ -n "$exit_early" ]; then
                early_exit_ref="$exit_early"
                return
            fi
            
            if [ -n "$cmd_result" ]; then
                individual_results_ref+=("$cmd_result")
            fi
            
            if [ -n "$cmd_deny_match" ]; then
                deny_matches_ref+=("$cmd_deny_match")
            fi
        fi
    done
}

# Process non-Bash tools
process_other_tool() {
    local tool_name="$1"
    local tool_input="$2"
    local deny_list="$3"
    local allow_list="$4"
    local -n deny_matches_ref="$5"
    local -n allow_matches_ref="$6"
    
    # Check deny patterns first
    if [ -n "$deny_list" ]; then
        while IFS= read -r pattern; do
            if [ -n "$pattern" ] && check_pattern "$pattern" "$tool_name" "$tool_input"; then
                deny_matches_ref+=("$pattern")
            fi
        done <<< "$deny_list"
    fi
    
    # Check allow patterns
    if [ -n "$allow_list" ]; then
        while IFS= read -r pattern; do
            if [ -n "$pattern" ] && check_pattern "$pattern" "$tool_name" "$tool_input"; then
                allow_matches_ref+=("$pattern")
            fi
        done <<< "$allow_list"
    fi
}

# Main execution
main() {
    # Read and validate input
    local tool_data tool_info tool_name tool_input
    tool_data=$(read_hook_input)
    tool_info=$(extract_tool_info "$tool_data")
    tool_name=$(echo "$tool_info" | cut -d'|' -f1)
    tool_input=$(echo "$tool_info" | cut -d'|' -f2-)
    
    # Exit if no tool name
    [ -z "$tool_name" ] && exit 0
    
    # Get permission lists
    local allow_list deny_list
    if [ "${CLAUDE_TEST_MODE:-}" = "1" ]; then
        # Test mode
        allow_list=$(echo "${CLAUDE_TEST_ALLOW:-[]}" | jq -r '.[]?' 2>/dev/null | grep "^${tool_name}(" || true)
        deny_list=$(echo "${CLAUDE_TEST_DENY:-[]}" | jq -r '.[]?' 2>/dev/null | grep "^${tool_name}(" || true)
    else
        # Normal mode
        local workspace_root settings_files
        workspace_root=$(get_workspace_root)
        readarray -t settings_files < <(get_settings_files "$workspace_root")
        allow_list=$(extract_permission_list "allow" "${settings_files[@]}")
        deny_list=$(extract_permission_list "deny" "${settings_files[@]}")
    fi
    
    # Exit if no lists defined
    if [ -z "$allow_list" ] && [ -z "$deny_list" ]; then
        exit 0
    fi
    
    # Process based on tool type
    local deny_matches=() allow_matches=() individual_command_results=()
    local decision="" decision_reason="" early_exit=""
    
    if [ "$tool_name" = "Bash" ]; then
        process_bash_tool "$tool_input" "$deny_list" "$allow_list" \
            individual_command_results deny_matches early_exit
        
        # Handle early exit conditions
        if [ -n "$early_exit" ]; then
            local exit_type="${early_exit%%|*}"
            local exit_reason="${early_exit#*|}"
            output_decision "$exit_type" "$exit_reason"
            exit 0
        fi
        
        analyze_bash_command_results individual_command_results deny_matches \
            decision decision_reason
    else
        process_other_tool "$tool_name" "$tool_input" "$deny_list" "$allow_list" \
            deny_matches allow_matches
        analyze_pattern_matches allow_matches deny_matches \
            decision decision_reason
    fi
    
    # Log the analysis
    log_pattern_analysis "$LOG_FILE" "$tool_name" "$tool_input" \
        "$decision" "$decision_reason" \
        individual_command_results deny_matches allow_matches
    
    # Output the decision
    output_decision "$decision" "$decision_reason"
}

# Run main
main