#!/bin/sh
# Common utility functions for update checkers
# Provides timestamp-based interval checking

# Get current timestamp in seconds
_update_now() {
  date +%s
}

# Read last check timestamp from cache file
# Args: $1 = cache file path
# Returns: timestamp (0 if file doesn't exist)
_update_read_timestamp() {
  local cache_file="$1"
  if [ -f "$cache_file" ]; then
    cat "$cache_file" 2>/dev/null || echo 0
  else
    echo 0
  fi
}

# Write current timestamp to cache file
# Args: $1 = cache file path, $2 = timestamp
_update_write_timestamp() {
  local cache_file="$1"
  local timestamp="$2"
  mkdir -p "$(dirname "$cache_file")"
  echo "$timestamp" > "$cache_file"
}

# Check if enough time has passed since last check
# Args: $1 = last check timestamp, $2 = interval in seconds
# Returns: 0 if check needed, 1 if still within interval
_update_interval_passed() {
  local last_check="$1"
  local interval="$2"
  local now
  now=$(_update_now)
  [ $((now - last_check)) -ge "$interval" ]
}
