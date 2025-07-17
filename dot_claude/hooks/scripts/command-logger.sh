#!/bin/bash

# Claude Code Command Logger
# Records command execution with precise timing using Pre/Post hook matching
# Compliant with Claude Code hooks specification
# Output: One line per command with execution time

# Configuration
WORKSPACE_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
LOG_DIR="${WORKSPACE_ROOT}/.claude/log"
COMMAND_LOG="${LOG_DIR}/command_execution.log"
TIMING_DIR="${LOG_DIR}/cmd_timing"

# Ensure directories exist
mkdir -p "${LOG_DIR}" "${TIMING_DIR}"

# Read hook input and extract hook type
INPUT=$(cat)

# Validate JSON input according to Claude Code hooks specification
if ! echo "$INPUT" | jq empty 2>/dev/null; then
    echo "Error: Invalid JSON input" >&2
    exit 1
fi

HOOK_TYPE="${1:-unknown}"
TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%S.%3NZ")
TIMESTAMP_NS=$(date +%s%N)

# Extract fields from hook input using official Claude Code hooks structure
TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // empty' 2>/dev/null || echo "unknown")
TOOL_COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // ""' 2>/dev/null || echo "")
TOOL_DESCRIPTION=$(echo "$INPUT" | jq -r '.tool_input.description // ""' 2>/dev/null || echo "")
SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // ""' 2>/dev/null || echo "")
TOOL_RESPONSE=$(echo "$INPUT" | jq -r '.tool_response // ""' 2>/dev/null || echo "")

# Only process Bash tool commands
if [ "$TOOL_NAME" != "Bash" ]; then
  echo "$INPUT"
  exit 0
fi

# Generate stable command ID with session isolation
TOOL_PARAMS=$(echo "$INPUT" | jq -r '.tool_input // {}' 2>/dev/null | jq -c 'to_entries | sort_by(.key) | from_entries' 2>/dev/null || echo '{}')
PARAMS_HASH=$(echo "$TOOL_PARAMS" | sha256sum | cut -d' ' -f1 | head -c 8)

# Use official session_id from Claude Code hooks if available
if [ -n "$SESSION_ID" ]; then
    CLAUDE_SESSION_ID=$(echo "$SESSION_ID" | sha256sum | cut -d' ' -f1 | head -c 8)
else
    # Fallback to process-based session ID for backwards compatibility
    CLAUDE_SESSION_ID="${CLAUDE_SESSION_ID:-$(echo "${PPID}_$$" | sha256sum | cut -d' ' -f1 | head -c 8)}"
fi
export CLAUDE_SESSION_ID

COMMAND_ID="cmd_${PARAMS_HASH}_${CLAUDE_SESSION_ID}"

# Function to generate command statistics
generate_statistics() {
  local STATS_FILE="${LOG_DIR}/command_stats.txt"
  local SCRIPT_DIR="$(dirname "$0")"
  local STATS_SCRIPT="${SCRIPT_DIR}/generate_stats.sh"
  
  if [ ! -f "$COMMAND_LOG" ]; then
    return
  fi
  
  # Use external script for statistics generation
  if [ -f "$STATS_SCRIPT" ]; then
    "$STATS_SCRIPT" "$COMMAND_LOG" > "$STATS_FILE" 2>/dev/null || true
    echo "📊 Command statistics updated: $STATS_FILE"
  else
    # Fallback simple statistics
    {
      echo "# Command Statistics (Generated: $TIMESTAMP)"
      echo "Total commands: $(wc -l < "$COMMAND_LOG")"
      echo "Session: $CLAUDE_SESSION_ID"
    } > "$STATS_FILE"
    echo "📊 Basic statistics generated: $STATS_FILE"
  fi
}

if [ "$HOOK_TYPE" = "PreToolUse" ]; then
  # Store command info for PostToolUse hook matching (using timestamp for uniqueness)
  PENDING_FILE="${TIMING_DIR}/.pending_${COMMAND_ID}_${TIMESTAMP_NS}"
  # Use JSON format for robust parsing with jq
  jq -n \
    --arg command_id "$COMMAND_ID" \
    --arg command "$TOOL_COMMAND" \
    --arg description "$TOOL_DESCRIPTION" \
    --arg timestamp_ns "$TIMESTAMP_NS" \
    '{
      command_id: $command_id,
      command: $command,
      description: $description,
      timestamp_ns: ($timestamp_ns | tonumber)
    }' > "$PENDING_FILE"
  
elif [ "$HOOK_TYPE" = "PostToolUse" ]; then
  # Find matching PreToolUse command and calculate execution time
  TIMEOUT_SECONDS=300  # 5 minutes timeout for command matching
  CUTOFF_TIME_NS=$((TIMESTAMP_NS - (TIMEOUT_SECONDS * 1000000000)))
  
  # Find the most recent pending file for this command
  PENDING_FILES=$(find "${TIMING_DIR}" -name ".pending_${COMMAND_ID}_*" -type f 2>/dev/null | sort -r)
  
  for pending_file in $PENDING_FILES; do
    if [ -f "$pending_file" ]; then
      # Parse JSON data with jq for robust handling
      START_TIME_NS=$(jq -r '.timestamp_ns // 0' "$pending_file" 2>/dev/null || echo 0)
      # Check if within timeout range
      if [ "$START_TIME_NS" -gt "$CUTOFF_TIME_NS" ]; then
        # Parse pending command data using jq
        LOGGED_COMMAND=$(jq -r '.command // ""' "$pending_file" 2>/dev/null || echo "")
        LOGGED_DESCRIPTION=$(jq -r '.description // ""' "$pending_file" 2>/dev/null || echo "")
        
        # Calculate Claude Code total time (PreToolUse to PostToolUse)
        TOTAL_DURATION_MS=$(( (TIMESTAMP_NS - START_TIME_NS) / 1000000 ))
        
        # Create log entry with timing information
        LOG_ENTRY="${TIMESTAMP}|${COMMAND_ID}|${TOTAL_DURATION_MS}ms|${LOGGED_COMMAND}|${LOGGED_DESCRIPTION}"
        
        # Append to command execution log
        echo "$LOG_ENTRY" >> "$COMMAND_LOG"
        
        # Clean up pending file
        rm -f "$pending_file"
        break
      fi
    fi
  done
  
  # Periodic cleanup of stale files (every 100th command)
  COMMAND_COUNT=$(wc -l < "$COMMAND_LOG" 2>/dev/null || echo 0)
  if [ $((COMMAND_COUNT % 100)) -eq 0 ] && [ "$COMMAND_COUNT" -gt 0 ]; then
    find "${TIMING_DIR}" -name ".pending_*" -type f -mmin +60 -delete 2>/dev/null || true
  fi

elif [ "$HOOK_TYPE" = "Stop" ]; then
  # Clean up timed-out pending files when Claude Code session stops
  echo "🛑 Stop hook executed at $TIMESTAMP"
  echo "🛑 Stop hook executed at $TIMESTAMP" >> "${LOG_DIR}/stop_hook.log"
  
  TIMEOUT_SECONDS=300  # 5 minutes timeout
  CUTOFF_TIME_NS=$((TIMESTAMP_NS - (TIMEOUT_SECONDS * 1000000000)))
  
  # Find and remove timed-out pending files
  PENDING_FILES=$(find "${TIMING_DIR}" -name ".pending_*" -type f 2>/dev/null)
  CLEANUP_COUNT=0
  TOTAL_FILES=$(echo "$PENDING_FILES" | wc -w)
  
  echo "Found $TOTAL_FILES pending files to check" >> "${LOG_DIR}/stop_hook.log"
  
  for pending_file in $PENDING_FILES; do
    if [ -f "$pending_file" ]; then
      # Parse JSON data with jq for robust handling
      START_TIME_NS=$(jq -r '.timestamp_ns // 0' "$pending_file" 2>/dev/null || echo 0)
      if [ "$START_TIME_NS" -le "$CUTOFF_TIME_NS" ]; then
        rm -f "$pending_file"
        CLEANUP_COUNT=$((CLEANUP_COUNT + 1))
      fi
    fi
  done
  
  # Log cleanup activity
  if [ "$CLEANUP_COUNT" -gt 0 ]; then
    echo "Cleaned up $CLEANUP_COUNT timed-out pending files" >> "${LOG_DIR}/cleanup.log"
    echo "Cleaned up $CLEANUP_COUNT timed-out pending files" >> "${LOG_DIR}/stop_hook.log"
  else
    echo "No files needed cleanup" >> "${LOG_DIR}/stop_hook.log"
  fi
  
  # Generate command statistics on Stop
  echo "📊 Generating command statistics..."
  generate_statistics
fi

# Pass through input unchanged (required by Claude Code hooks specification)
echo "$INPUT"