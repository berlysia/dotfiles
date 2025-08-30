# Claude Code Hooks Input/Output Reference

This document provides comprehensive examples of input and output formats for Claude Code hooks based on the official documentation.

**References:** 
- [Claude Code Hooks Reference](https://docs.anthropic.com/en/docs/claude-code/hooks#hook-input)
- [Claude Code Changelog](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md)

## Hook Input Structure

All hooks receive JSON data via stdin with common fields:

```json
{
  "session_id": "string",
  "transcript_path": "string",          // Path to conversation JSON
  "hook_event_name": "string",          // Name of the hook event
  "current_working_directory": "string" // Current working directory (v1.0.54+)
  // ... event-specific fields
}
```

## Available Hook Events

1. **PreToolUse** - Before tool execution
2. **PostToolUse** - After tool completion
3. **Notification** - System notifications
4. **UserPromptSubmit** - When user submits a prompt (v1.0.54+)
5. **Stop** - When main agent finishes responding
6. **SubagentStop** - When subagent finishes responding (v1.0.41+)
7. **PreCompact** - Before context compaction (v1.0.48+)
8. **SessionStart** - When starting a new session
9. **SessionEnd** - When session terminates

## PreToolUse

Runs after Claude creates tool parameters and before processing the tool call.

### Input

```json
{
  "session_id": "abc123",
  "transcript_path": "~/.claude/projects/.../00893aaf-19fa-41d2-8238-13269b9b3ca0.jsonl",
  "hook_event_name": "PreToolUse",
  "current_working_directory": "/path/to/project",
  "tool_name": "Write",
  "tool_input": {
    "file_path": "/path/to/file.txt",
    "content": "file content"
  }
}
```

### Output Options

#### Simple: Exit Code
- **Exit code 0**: Success, stdout shown to user in transcript mode
- **Exit code 2**: Blocking error, stderr fed back to Claude (blocks tool call)
- **Other exit codes**: Non-blocking error, stderr shown to user

#### Advanced: JSON Output
```json
{
  "continue": true,                    // Whether Claude should continue (default: true)
  "stopReason": "string",             // Message shown when continue is false
  "suppressOutput": true,             // Hide stdout from transcript (default: false)
  "decision": "approve" | "block",    // Control tool execution
  "reason": "Explanation for decision"
}
```

**Decision Control:**
- `"approve"`: Bypasses permission system, reason shown to user
- `"block"`: Prevents tool execution, reason shown to Claude

## PostToolUse

Runs immediately after a tool completes successfully.

### Input

```json
{
  "session_id": "abc123",
  "transcript_path": "~/.claude/projects/.../00893aaf-19fa-41d2-8238-13269b9b3ca0.jsonl",
  "hook_event_name": "PostToolUse",
  "current_working_directory": "/path/to/project",
  "tool_name": "Write",
  "tool_input": {
    "file_path": "/path/to/file.txt",
    "content": "file content"
  },
  "tool_response": {
    "filePath": "/path/to/file.txt",
    "success": true
  }
}
```

### Output Options

#### Simple: Exit Code
- **Exit code 0**: Success
- **Exit code 2**: Shows error to Claude (tool already ran)
- **Other exit codes**: Shows stderr to user

#### Advanced: JSON Output
```json
{
  "continue": true,
  "stopReason": "string",
  "suppressOutput": true,
  "decision": "block",                 // Only "block" or undefined
  "reason": "Explanation for decision"
}
```

## Notification

Runs when Claude Code sends notifications (permission requests, idle timeout).

### Input

```json
{
  "session_id": "abc123",
  "transcript_path": "~/.claude/projects/.../00893aaf-19fa-41d2-8238-13269b9b3ca0.jsonl",
  "hook_event_name": "Notification",
  "current_working_directory": "/path/to/project",
  "message": "Task completed successfully"
}
```

### Output Options

Only exit codes are meaningful:
- **Exit code 0**: Success
- **Other exit codes**: Shows stderr to user

## Stop

Runs when the main Claude Code agent has finished responding.

### Input

```json
{
  "session_id": "abc123",
  "transcript_path": "~/.claude/projects/.../00893aaf-19fa-41d2-8238-13269b9b3ca0.jsonl",
  "hook_event_name": "Stop",
  "current_working_directory": "/path/to/project",
  "stop_hook_active": true  // True when already continuing from a stop hook
}
```

### Output Options

#### Simple: Exit Code
- **Exit code 0**: Success
- **Exit code 2**: Blocks stoppage, shows error to Claude

#### Advanced: JSON Output
```json
{
  "continue": true,
  "stopReason": "string",
  "suppressOutput": true,
  "decision": "block",                 // Prevents Claude from stopping
  "reason": "Must be provided when Claude is blocked from stopping"
}
```

## SubagentStop

Runs when a Claude Code subagent (Task tool call) has finished responding.

### Input

```json
{
  "session_id": "abc123",
  "transcript_path": "~/.claude/projects/.../00893aaf-19fa-41d2-8238-13269b9b3ca0.jsonl",
  "hook_event_name": "SubagentStop",
  "current_working_directory": "/path/to/project",
  "stop_hook_active": true
}
```

### Output Options

Same as Stop hook.

## UserPromptSubmit

Runs when the user submits a prompt (v1.0.54+).

### Input

```json
{
  "session_id": "abc123",
  "transcript_path": "~/.claude/projects/.../00893aaf-19fa-41d2-8238-13269b9b3ca0.jsonl",
  "hook_event_name": "UserPromptSubmit",
  "current_working_directory": "/path/to/project",
  "prompt": "User's submitted prompt text"
}
```

### Output Options

#### Simple: Exit Code
- **Exit code 0**: Success
- **Other exit codes**: Shows stderr to user

#### Advanced: JSON Output
```json
{
  "continue": true,
  "stopReason": "string",
  "suppressOutput": true
}
```

## SessionStart

Runs when starting a new Claude Code session.

### Input

```json
{
  "session_id": "abc123",
  "transcript_path": "~/.claude/projects/.../00893aaf-19fa-41d2-8238-13269b9b3ca0.jsonl",
  "hook_event_name": "SessionStart",
  "current_working_directory": "/path/to/project"
}
```

### Output Options

Only exit codes are meaningful:
- **Exit code 0**: Success
- **Other exit codes**: Shows stderr to user

## SessionEnd

Runs when a Claude Code session terminates.

### Input

```json
{
  "session_id": "abc123",
  "transcript_path": "~/.claude/projects/.../00893aaf-19fa-41d2-8238-13269b9b3ca0.jsonl",
  "hook_event_name": "SessionEnd",
  "current_working_directory": "/path/to/project"
}
```

### Output Options

Only exit codes are meaningful:
- **Exit code 0**: Success
- **Other exit codes**: Shows stderr to user

## PreCompact

Runs before Claude Code is about to run a compact operation (v1.0.48+).

### Input

```json
{
  "session_id": "abc123",
  "transcript_path": "~/.claude/projects/.../00893aaf-19fa-41d2-8238-13269b9b3ca0.jsonl",
  "hook_event_name": "PreCompact",
  "current_working_directory": "/path/to/project",
  "trigger": "manual" | "auto",       // manual from /compact, auto from full context
  "custom_instructions": ""           // Instructions from /compact command
}
```

### Output Options

Only exit codes are meaningful:
- **Exit code 0**: Success
- **Other exit codes**: Shows stderr to user

## Common Tool Matchers

- `Task` - Agent tasks
- `Bash` - Shell commands
- `Glob` - File pattern matching
- `Grep` - Content search
- `Read` - File reading
- `Edit`, `MultiEdit` - File editing
- `Write` - File writing
- `WebFetch`, `WebSearch` - Web operations
- `mcp__*` - MCP tools (e.g., `mcp__memory__.*`)

## Advanced Configuration Features

### Project-Relative Script Paths (v1.0.41+)

Use `$CLAUDE_PROJECT_DIR` environment variable for project-relative script paths:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "command",
            "command": "$CLAUDE_PROJECT_DIR/scripts/validate-command.sh"
          }
        ]
      }
    ]
  }
}
```

### Command Timeouts (v1.0.41+)

Configure optional timeouts for hook commands:

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": ".*",
        "hooks": [
          {
            "type": "command",
            "command": "/path/to/notify.sh",
            "timeout": 5000  // 5 seconds timeout
          }
        ]
      }
    ]
  }
}
```

### Multiple Hooks per Event

Configure multiple hooks for the same event with different matchers:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "command",
            "command": "/path/to/bash-validator.sh"
          }
        ]
      },
      {
        "matcher": "Write|Edit",
        "hooks": [
          {
            "type": "command", 
            "command": "/path/to/file-backup.sh"
          }
        ]
      }
    ]
  }
}
```

## Exit Code 2 Behavior Summary

| Hook Event        | Behavior                                    |
|-------------------|---------------------------------------------|
| PreToolUse        | Blocks tool call, shows error to Claude    |
| PostToolUse       | Shows error to Claude (tool already ran)   |
| Notification      | Shows stderr to user only                   |
| UserPromptSubmit  | Shows stderr to user only                   |
| Stop              | Blocks stoppage, shows error to Claude     |
| SubagentStop      | Blocks stoppage, shows error to Claude     |
| PreCompact        | Shows stderr to user only                   |
| SessionStart      | Shows stderr to user only                   |
| SessionEnd        | Shows stderr to user only                   |

## Example: Bash Command Validation Hook

### TypeScript Version

```typescript
#!/usr/bin/env node

import * as fs from 'fs';

interface ValidationRule {
    pattern: RegExp;
    message: string;
}

interface HookInput {
    session_id: string;
    transcript_path: string;
    hook_event_name: string;
    tool_name: string;
    tool_input: {
        command?: string;
        [key: string]: any;
    };
}

interface HookOutput {
    continue?: boolean;
    stopReason?: string;
    suppressOutput?: boolean;
    decision?: 'approve' | 'block';
    reason?: string;
}

const VALIDATION_RULES: ValidationRule[] = [
    {
        pattern: /\bgrep\b(?!.*\|)/,
        message: "Use 'rg' (ripgrep) instead of 'grep' for better performance"
    },
    {
        pattern: /\bfind\s+\S+\s+-name\b/,
        message: "Use 'rg --files | rg pattern' instead of 'find -name'"
    },
    {
        pattern: /\brm\s+-rf\s+\//,
        message: "Dangerous recursive delete detected"
    }
];

function validateCommand(command: string): string[] {
    const issues: string[] = [];
    for (const rule of VALIDATION_RULES) {
        if (rule.pattern.test(command)) {
            issues.push(rule.message);
        }
    }
    return issues;
}

function main(): void {
    try {
        const input = fs.readFileSync(0, 'utf8');
        const inputData: HookInput = JSON.parse(input);
        
        const toolName = inputData.tool_name || "";
        const toolInput = inputData.tool_input || {};
        const command = toolInput.command || "";
        
        if (toolName !== "Bash" || !command) {
            process.exit(1);
        }
        
        const issues = validateCommand(command);
        
        if (issues.length > 0) {
            // Block with JSON output
            const output: HookOutput = {
                decision: 'block',
                reason: `Command validation failed:\n${issues.map(i => `• ${i}`).join('\n')}`
            };
            
            console.log(JSON.stringify(output, null, 2));
            process.exit(0);
        }
        
        // Approve if no issues found
        const output: HookOutput = {
            decision: 'approve',
            reason: 'Command validation passed'
        };
        
        console.log(JSON.stringify(output, null, 2));
        process.exit(0);
        
    } catch (error) {
        console.error(`Error: Invalid JSON input: ${error instanceof Error ? error.message : error}`);
        process.exit(1);
    }
}

main();
```

### Shell Version (with jq)

```bash
#!/bin/bash

# Read input data
input_data=$(cat)

# Extract fields using jq
tool_name=$(echo "$input_data" | jq -r '.tool_name // ""')
command=$(echo "$input_data" | jq -r '.tool_input.command // ""')
hook_event=$(echo "$input_data" | jq -r '.hook_event_name // ""')

# Exit if not Bash tool or empty command
if [[ "$tool_name" != "Bash" || -z "$command" ]]; then
    exit 1
fi

# Validation rules
declare -a validation_rules=(
    "grep\b(?!.*\|):Use 'rg' (ripgrep) instead of 'grep' for better performance"
    "find\s+\S+\s+-name\b:Use 'rg --files | rg pattern' instead of 'find -name'"
    "rm\s+-rf\s+/:Dangerous recursive delete detected"
    "sudo\s+rm:Dangerous sudo rm command detected"
)

# Array to store validation issues
declare -a issues=()

# Check each rule
for rule in "${validation_rules[@]}"; do
    pattern="${rule%%:*}"
    message="${rule#*:}"
    
    # Check with Perl-compatible regex
    if echo "$command" | grep -Pq "$pattern"; then
        issues+=("$message")
    fi
done

# If issues found
if [[ ${#issues[@]} -gt 0 ]]; then
    # Output issues to stderr
    for issue in "${issues[@]}"; do
        echo "• $issue" >&2
    done
    
    # Block with JSON output (advanced control)
    reason=$(printf '%s\n' "${issues[@]}" | jq -R . | jq -s 'join("\n")')
    output=$(jq -n \
        --arg decision "block" \
        --argjson reason "$reason" \
        '{
            decision: $decision,
            reason: ("Command validation failed:\n" + $reason)
        }')
    
    echo "$output"
    exit 0
fi

# Approve case
output=$(jq -n \
    --arg decision "approve" \
    --arg reason "Command validation passed" \
    '{
        decision: $decision,
        reason: $reason
    }')

echo "$output"
exit 0
```

### Usage Example: Configuration File

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "command",
            "command": "/path/to/bash-validator.ts"
          }
        ]
      }
    ]
  }
}
```