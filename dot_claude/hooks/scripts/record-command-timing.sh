#!/bin/bash

# Record command timing for Claude hooks
# This script is called both in PreToolUse and PostToolUse

# Get git repository root, fallback to current directory if not in a git repo
WORKSPACE_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
LOG_DIR="${WORKSPACE_ROOT}/.claude/log"
LOG_FILE="${LOG_DIR}/command_timing.jsonl"
TIMING_DIR="${LOG_DIR}/timing"

# Ensure log directories exist
mkdir -p "${LOG_DIR}" "${TIMING_DIR}"

# Get input from stdin
INPUT=$(cat)

# Extract tool information from the input
TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // empty' 2>/dev/null || echo "unknown")
HOOK_TYPE="${1:-unknown}"  # PreToolUse or PostToolUse
TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%S.%3NZ")
TIMESTAMP_NS=$(date +%s%N)  # Nanoseconds for precise timing

# Generate a unique ID for this tool invocation
TOOL_ID=$(echo "$INPUT" | jq -r '.id // empty' 2>/dev/null)
if [ -z "$TOOL_ID" ]; then
  # Fallback: use tool name and timestamp
  TOOL_ID="${TOOL_NAME}_${TIMESTAMP_NS}"
fi

if [ "$HOOK_TYPE" = "PreToolUse" ]; then
  # Store start time
  echo "$TIMESTAMP_NS" > "${TIMING_DIR}/${TOOL_ID}.start"
  
  # Log PreToolUse event
  LOG_ENTRY=$(jq -n \
    --arg timestamp "$TIMESTAMP" \
    --arg hook "$HOOK_TYPE" \
    --arg tool "$TOOL_NAME" \
    --arg workspace "$WORKSPACE_ROOT" \
    --arg tool_id "$TOOL_ID" \
    '{
      timestamp: $timestamp,
      hook_type: $hook,
      tool_name: $tool,
      workspace: $workspace,
      tool_id: $tool_id
    }')
    
elif [ "$HOOK_TYPE" = "PostToolUse" ]; then
  # Read start time if available
  START_FILE="${TIMING_DIR}/${TOOL_ID}.start"
  if [ -f "$START_FILE" ]; then
    START_TIME_NS=$(cat "$START_FILE")
    # Calculate duration in milliseconds
    DURATION_MS=$(( (TIMESTAMP_NS - START_TIME_NS) / 1000000 ))
    
    # Clean up timing file
    rm -f "$START_FILE"
    
    # Log PostToolUse event with duration
    LOG_ENTRY=$(jq -n \
      --arg timestamp "$TIMESTAMP" \
      --arg hook "$HOOK_TYPE" \
      --arg tool "$TOOL_NAME" \
      --arg workspace "$WORKSPACE_ROOT" \
      --arg tool_id "$TOOL_ID" \
      --arg duration_ms "$DURATION_MS" \
      '{
        timestamp: $timestamp,
        hook_type: $hook,
        tool_name: $tool,
        workspace: $workspace,
        tool_id: $tool_id,
        duration_ms: ($duration_ms | tonumber)
      }')
  else
    # No start time found
    LOG_ENTRY=$(jq -n \
      --arg timestamp "$TIMESTAMP" \
      --arg hook "$HOOK_TYPE" \
      --arg tool "$TOOL_NAME" \
      --arg workspace "$WORKSPACE_ROOT" \
      --arg tool_id "$TOOL_ID" \
      '{
        timestamp: $timestamp,
        hook_type: $hook,
        tool_name: $tool,
        workspace: $workspace,
        tool_id: $tool_id,
        duration_ms: null
      }')
  fi
else
  # Unknown hook type
  LOG_ENTRY=$(jq -n \
    --arg timestamp "$TIMESTAMP" \
    --arg hook "$HOOK_TYPE" \
    --arg tool "$TOOL_NAME" \
    --arg workspace "$WORKSPACE_ROOT" \
    '{
      timestamp: $timestamp,
      hook_type: $hook,
      tool_name: $tool,
      workspace: $workspace
    }')
fi

# Append to log file
echo "$LOG_ENTRY" >> "$LOG_FILE"

# Pass through the input unchanged
echo "$INPUT"