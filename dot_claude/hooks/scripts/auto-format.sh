#!/bin/bash

# Extract file paths from tool input
FILES=$(echo "$CLAUDE_TOOL_INPUT" | jq -r '
  if .file_path then
    .file_path
  elif .edits then
    .file_path
  elif .notebook_path then
    .notebook_path
  else
    empty
  end
' 2>/dev/null)

# Exit if no files to format
if [ -z "$FILES" ]; then
  exit 0
fi

# Check if file exists
if [ ! -f "$FILES" ]; then
  exit 0
fi

# Get file extension
EXT="${FILES##*.}"

# Skip non-source files
case "$EXT" in
  js|jsx|ts|tsx|json|jsonc|css|scss|html|md|mdx|yml|yaml|toml|rs|go|py)
    ;;
  *)
    exit 0
    ;;
esac

# Function to check if command exists
command_exists() {
  command -v "$1" >/dev/null 2>&1
}

# Try Biome first (fastest)
if [ -f "biome.json" ] || [ -f "biome.jsonc" ]; then
  if command_exists biome; then
    biome format --write "$FILES" 2>/dev/null && exit 0
  elif [ -f "node_modules/.bin/biome" ]; then
    ./node_modules/.bin/biome format --write "$FILES" 2>/dev/null && exit 0
  elif command_exists npx && [ -f "package.json" ] && grep -q '"@biomejs/biome"' package.json; then
    npx biome format --write "$FILES" 2>/dev/null && exit 0
  fi
fi

# Try Deno fmt
if [ -f "deno.json" ] || [ -f "deno.jsonc" ]; then
  if command_exists deno; then
    deno fmt "$FILES" 2>/dev/null && exit 0
  fi
fi

# Try Prettier
if [ -f ".prettierrc" ] || [ -f ".prettierrc.json" ] || [ -f ".prettierrc.js" ] || [ -f ".prettierrc.yml" ] || [ -f ".prettierrc.yaml" ] || [ -f "prettier.config.js" ]; then
  if command_exists prettier; then
    prettier --write "$FILES" 2>/dev/null && exit 0
  elif [ -f "node_modules/.bin/prettier" ]; then
    ./node_modules/.bin/prettier --write "$FILES" 2>/dev/null && exit 0
  elif command_exists npx && [ -f "package.json" ] && grep -q '"prettier"' package.json; then
    npx prettier --write "$FILES" 2>/dev/null && exit 0
  fi
fi

# Success - no formatter found is still a valid state
exit 0