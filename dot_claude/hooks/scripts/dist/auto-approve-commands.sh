#!/bin/bash

# Backward compatibility wrapper for TypeScript version
# This script redirects to the TypeScript implementation

SCRIPT_DIR="$(dirname "$0")"
TS_SCRIPT="$SCRIPT_DIR/../src/auto-approve-commands.ts"

# Execute the TypeScript version
exec "$TS_SCRIPT" "$@"
