#!/bin/sh
# dotfiles_doctor_legacy.sh - Legacy wrapper for backward compatibility
# Redirects all calls to the new test_suite.sh

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# Show migration notice
if [ "$1" != "--quiet" ] && [ "$1" != "-q" ]; then
    echo "📢 Notice: dotfiles_doctor.sh has been upgraded to test_suite.sh" >&2
    echo "   All functionality has been preserved and enhanced." >&2
    echo "" >&2
fi

# Check if new test suite exists
if [ -f "$SCRIPT_DIR/test_suite.sh" ]; then
    # Pass all arguments to new test suite
    exec "$SCRIPT_DIR/test_suite.sh" "$@"
else
    echo "❌ Error: test_suite.sh not found at $SCRIPT_DIR" >&2
    echo "   Please ensure the migration is complete." >&2
    exit 1
fi