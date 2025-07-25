#!/bin/bash

# Pattern matching functions for hook scripts

# Extract wrapper command's child command
_extract_child_command() {
    local command="$1"
    local -n child_cmd_ref="$2"
    
    # Handle wrapper commands that execute other commands
    if [[ "$command" =~ ^timeout[[:space:]] ]]; then
        # timeout [OPTION] DURATION COMMAND [ARG]...
        # Skip 'timeout', skip duration, take the rest
        local words=($command)
        if [ ${#words[@]} -gt 2 ]; then
            # Join words from index 2 onwards
            local remaining="${words[@]:2}"
            child_cmd_ref="$remaining"
            return 0
        fi
    elif [[ "$command" =~ ^time[[:space:]] ]]; then
        # time [OPTION] COMMAND [ARG]...
        local words=($command)
        if [ ${#words[@]} -gt 1 ]; then
            local remaining="${words[@]:1}"
            child_cmd_ref="$remaining"
            return 0
        fi
    elif [[ "$command" =~ ^(npx|pnpx|bunx)[[:space:]] ]]; then
        # npx/pnpx/bunx [OPTIONS] COMMAND [ARG]...
        local words=($command)
        if [ ${#words[@]} -gt 1 ]; then
            local remaining="${words[@]:1}"
            child_cmd_ref="$remaining"
            return 0
        fi
    elif [[ "$command" =~ ^xargs[[:space:]] ]]; then
        # xargs [OPTION]... COMMAND [INITIAL-ARGS]...
        # This is tricky because xargs options vary. Simple approach: take last arguments
        local words=($command)
        if [ ${#words[@]} -gt 1 ]; then
            # Find the first word that doesn't start with -
            local i=1
            while [ $i -lt ${#words[@]} ]; do
                if [[ "${words[$i]}" != -* ]]; then
                    local remaining="${words[@]:$i}"
                    child_cmd_ref="$remaining"
                    return 0
                fi
                ((i++))
            done
        fi
    elif [[ "$command" =~ -exec[[:space:]] ]]; then
        # find ... -exec COMMAND [ARG]... \;
        # Extract everything between -exec and \; or +
        local exec_part
        exec_part=$(echo "$command" | sed -n 's/.*-exec[[:space:]]\+\(.*\)[[:space:]]\+[\\;+].*/\1/p')
        if [ -n "$exec_part" ]; then
            child_cmd_ref="$exec_part"
            return 0
        fi
    fi
    
    return 1
}

# Extract all individual commands from compound command strings
_extract_commands_from_compound() {
    local command_string="$1"
    local -n commands_array="$2"
    
    # Simple approach: split only on &&, ||, ;, and |
    local temp_command="$command_string"
    
    # Replace operators with unique delimiters  
    temp_command="${temp_command//&&/█AND█}"
    temp_command="${temp_command//||/█OR█}"
    temp_command="${temp_command//;/█SEMI█}"
    temp_command="${temp_command//|/█PIPE█}"
    
    # Split on the unique delimiters
    local IFS='█'
    local parts
    read -ra parts <<< "$temp_command"
    
    for part in "${parts[@]}"; do
        # Skip operator parts
        if [[ "$part" == "AND" || "$part" == "OR" || "$part" == "SEMI" || "$part" == "PIPE" ]]; then
            continue
        fi
        
        # Clean up whitespace
        part=$(echo "$part" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')
        
        if [ -n "$part" ]; then
            # Add the main command
            commands_array+=("$part")
            
            # Extract and add child commands from wrapper commands
            local child_command=""
            if _extract_child_command "$part" child_command; then
                if [ -n "$child_command" ]; then
                    commands_array+=("$child_command")
                fi
            fi
        fi
    done
}

# Check if individual command matches any allow pattern
_check_individual_command() {
    local cmd="$1"
    local allow_list="$2"
    
    if [ -z "$allow_list" ]; then
        return 1
    fi
    
    while IFS= read -r pattern; do
        if [ -n "$pattern" ]; then
            # Create a mock tool input for individual command check
            local mock_input="{\"command\":\"$cmd\"}"
            if check_pattern "$pattern" "Bash" "$mock_input"; then
                return 0
            fi
        fi
    done <<< "$allow_list"
    
    return 1
}

# Check individual command and return matching pattern
_check_individual_command_with_pattern() {
    local cmd="$1"
    local allow_list="$2"
    local -n matched_pattern_ref="$3"
    
    if [ -z "$allow_list" ]; then
        return 1
    fi
    
    while IFS= read -r pattern; do
        if [ -n "$pattern" ]; then
            # Create a mock tool input for individual command check
            local mock_input="{\"command\":\"$cmd\"}"
            if check_pattern "$pattern" "Bash" "$mock_input"; then
                matched_pattern_ref="$pattern"
                return 0
            fi
        fi
    done <<< "$allow_list"
    
    return 1
}

# Check if individual command matches any deny pattern
_check_individual_command_deny() {
    local cmd="$1"
    local deny_list="$2"
    
    if [ -z "$deny_list" ]; then
        return 1
    fi
    
    while IFS= read -r pattern; do
        if [ -n "$pattern" ]; then
            # Create a mock tool input for individual command check
            local mock_input="{\"command\":\"$cmd\"}"
            if check_pattern "$pattern" "Bash" "$mock_input"; then
                return 0
            fi
        fi
    done <<< "$deny_list"
    
    return 1
}

# Check individual command deny and return matching pattern
_check_individual_command_deny_with_pattern() {
    local cmd="$1"
    local deny_list="$2"
    local -n matched_pattern_ref="$3"
    
    if [ -z "$deny_list" ]; then
        return 1
    fi
    
    while IFS= read -r pattern; do
        if [ -n "$pattern" ]; then
            # Create a mock tool input for individual command check
            local mock_input="{\"command\":\"$cmd\"}"
            if check_pattern "$pattern" "Bash" "$mock_input"; then
                matched_pattern_ref="$pattern"
                return 0
            fi
        fi
    done <<< "$deny_list"
    
    return 1
}

# GitIgnore-style pattern matching
_match_gitignore_pattern() {
    local file_path="$1"
    local pattern="$2"
    
    # Handle directory patterns ending with /
    if [[ "$pattern" == */ ]]; then
        pattern="${pattern%/}"
        # For directory patterns, match if file is within that directory
        if [[ "$file_path" == "$pattern"/* || "$file_path" == "$pattern" ]]; then
            return 0
        fi
    fi
    
    # Handle ** patterns first (match any number of directories)
    if [[ "$pattern" == "**" ]]; then
        # ** matches everything
        return 0
    elif [[ "$pattern" == */** ]]; then
        # Pattern ends with /** - match everything under prefix
        local prefix="${pattern%/**}"
        if [[ "$prefix" == /* ]]; then
            # Anchored pattern - match from beginning
            if [[ "$file_path" == "$prefix"/* || "$file_path" == "$prefix" ]]; then
                return 0
            fi
        else
            # Not anchored - can match anywhere
            if [[ "$file_path" == *"$prefix"/* || "$file_path" == *"$prefix" ]]; then
                return 0
            fi
        fi
    elif [[ "$pattern" == */**/* ]]; then
        local prefix="${pattern%%/**/*}"
        local suffix="${pattern##*/**/}"
        if [[ "$file_path" == "$prefix"/*/"$suffix" ]] || [[ "$file_path" == "$prefix"*/"$suffix" ]]; then
            return 0
        fi
    fi
    
    # Handle patterns starting with /
    if [[ "$pattern" == /* ]]; then
        pattern="${pattern#/}"
        # Anchored to root - match from beginning
        if [[ "$file_path" == "$pattern" ]] || [[ "$file_path" == "$pattern"/* ]]; then
            return 0
        fi
    else
        # Not anchored - can match anywhere in path
        # For patterns like *.js, we only want to match the filename, not any directory
        if [[ "$pattern" == *.* ]]; then
            local basename="${file_path##*/}"
            if [[ "$basename" == $pattern ]]; then
                return 0
            fi
        else
            # For patterns without extension, check each directory level
            local dir_path="$file_path"
            while [[ "$dir_path" == */* ]]; do
                local basename="${dir_path##*/}"
                if [[ "$basename" == $pattern ]]; then
                    return 0
                fi
                dir_path="${dir_path%/*}"
            done
            # Check root level
            if [[ "$dir_path" == $pattern ]]; then
                return 0
            fi
        fi
    fi
    
    return 1
}

# Check if a pattern matches the tool usage
check_pattern() {
    local pattern="$1"
    local tool_name="$2" 
    local tool_input="$3"
    
    # Handle Bash tool specifically
    if [[ "$pattern" == Bash\(* ]]; then
        if [ "$tool_name" != "Bash" ]; then
            return 1
        fi
        
        # Extract the command pattern from Bash(command:*)
        local cmd_pattern
        cmd_pattern=$(echo "$pattern" | sed 's/Bash(\(.*\))/\1/')
        
        # Get the actual command
        local actual_command
        actual_command=$(echo "$tool_input" | jq -r '.command // empty')
        
        # Check if command matches the pattern
        if [[ "$cmd_pattern" == *:* ]]; then
            local cmd_prefix
            cmd_prefix=$(echo "$cmd_pattern" | cut -d':' -f1)
            
            # Handle compound commands (&&, ||, ;)
            # Split on compound operators and subcommands
            local commands=()
            _extract_commands_from_compound "$actual_command" commands
            
            for cmd in "${commands[@]}"; do
                # Trim whitespace and remove leading & characters
                cmd=$(echo "$cmd" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' -e 's/^&*//')
                
                # Check if command starts with the prefix
                if [[ "$cmd" == "$cmd_prefix"* ]]; then
                    return 0
                fi
                
                # Also check if the prefix appears as a word within the command
                # This catches cases like "timeout 15 pnpm test" matching "pnpm:*"
                if [[ "$cmd" == *" $cmd_prefix "* ]] || [[ "$cmd" == *" $cmd_prefix" ]]; then
                    return 0
                fi
            done
        elif [[ "$actual_command" == "$cmd_pattern" ]]; then
            return 0
        fi
        
        return 1
    fi
    
    # Handle other tools with file path patterns
    if [[ "$pattern" == "$tool_name"* ]]; then
        # Extract the path pattern
        local path_pattern
        if [[ "$pattern" == *\(* ]]; then
            path_pattern=$(echo "$pattern" | sed "s/${tool_name}(\(.*\))/\1/")
            
            # Get the file path from tool input
            local file_path
            file_path=$(echo "$tool_input" | jq -r '.file_path // .path // .pattern // empty')
            
            # GitIgnore-style pattern matching
            if [[ "$path_pattern" == "**" ]]; then
                return 0
            elif [[ "$path_pattern" == \!* ]]; then
                # Negation pattern - should not match
                local neg_pattern
                neg_pattern=$(echo "$path_pattern" | sed 's/^!//')
                if _match_gitignore_pattern "$file_path" "$neg_pattern"; then
                    return 1
                else
                    return 0
                fi
            elif _match_gitignore_pattern "$file_path" "$path_pattern"; then
                return 0
            fi
        elif [[ "$pattern" == "$tool_name" ]]; then
            return 0
        fi
    fi
    
    return 1
}