#!/bin/bash

# Pattern matching functions for hook scripts

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
    
    # Handle patterns starting with /
    if [[ "$pattern" == /* ]]; then
        pattern="${pattern#/}"
        # Anchored to root - match from beginning
        if [[ "$file_path" == "$pattern" ]] || [[ "$file_path" == "$pattern"/* ]]; then
            return 0
        fi
    else
        # Not anchored - can match anywhere in path
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
    
    # Handle ** patterns (match any number of directories)
    if [[ "$pattern" == */**/* ]]; then
        local prefix="${pattern%%/**/*}"
        local suffix="${pattern##*/**/}"
        if [[ "$file_path" == "$prefix"/*/"$suffix" ]] || [[ "$file_path" == "$prefix"*/"$suffix" ]]; then
            return 0
        fi
    fi
    
    # Standard glob matching
    if [[ "$file_path" == $pattern ]]; then
        return 0
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
            # Extract individual commands and check each one
            local commands
            IFS=$';&|' read -ra commands <<< "$actual_command"
            
            for cmd in "${commands[@]}"; do
                # Trim whitespace and remove leading & characters
                cmd=$(echo "$cmd" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' -e 's/^&*//')
                if [[ "$cmd" == "$cmd_prefix"* ]]; then
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
            if [[ "$path_pattern" == "**" || "$path_pattern" == "*" ]]; then
                return 0
            elif [[ "$path_pattern" == \!* ]]; then
                # Negation pattern - should not match
                local neg_pattern
                neg_pattern=$(echo "$path_pattern" | sed 's/^!//')
                if _match_gitignore_pattern "$file_path" "$neg_pattern"; then
                    return 1
                fi
                return 0
            elif _match_gitignore_pattern "$file_path" "$path_pattern"; then
                return 0
            fi
        elif [[ "$pattern" == "$tool_name" ]]; then
            return 0
        fi
    fi
    
    return 1
}