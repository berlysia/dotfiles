#!/bin/bash

# Logging functions for hook scripts

# Log pattern analysis results
log_pattern_analysis() {
    local log_file="$1"
    local tool_name="$2"
    local tool_input="$3"
    local decision="$4"
    local decision_reason="$5"
    local -n individual_results_ref="$6"
    local -n deny_matches_ref="$7"
    local -n allow_matches_ref="$8"
    
    {
        echo "[$(date '+%Y-%m-%d %H:%M:%S')] PATTERN ANALYSIS"
        echo "Tool: $tool_name"
        
        if [ "$tool_name" = "Bash" ]; then
            local bash_command
            bash_command=$(echo "$tool_input" | jq -r '.command // empty')
            echo "Command: $bash_command"
            
            # Show individual command analysis
            echo "Individual command analysis:"
            if [ ${#individual_results_ref[@]} -gt 0 ]; then
                for result in "${individual_results_ref[@]}"; do
                    echo "  $result"
                done
            else
                echo "  No commands extracted"
            fi
        else
            echo "Input: $tool_input"
        fi
        
        echo "Decision: $decision"
        echo "Reason: $decision_reason"
        
        if [ ${#deny_matches_ref[@]} -gt 0 ]; then
            echo "Deny matches:"
            for match in "${deny_matches_ref[@]}"; do
                echo "  - $match"
            done
        fi
        
        if [ ${#allow_matches_ref[@]} -gt 0 ]; then
            echo "Allow matches:"
            for match in "${allow_matches_ref[@]}"; do
                echo "  - $match"
            done
        fi
        
        echo "---"
    } >> "$log_file"
}