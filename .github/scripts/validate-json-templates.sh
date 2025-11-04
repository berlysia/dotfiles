#!/bin/bash

set -euo pipefail

echo "🔍 Validating JSON templates..."

DATA_FILE="${1:-.github/ci-chezmoi-data.json}"

if [[ ! -f "$DATA_FILE" ]]; then
  echo "❌ Data file not found: $DATA_FILE"
  exit 1
fi

# Function to check template
check_template() {
    local template="$1"
    local name
    name="$(basename "$template")"

    echo -n "Checking $name... "

    # Try to render and validate
    # Use -S/--source to specify the repository root as chezmoi source directory
    if chezmoi execute-template --init --source . --config-format json --config "$DATA_FILE" < "$template" 2>/dev/null | jq empty 2>/dev/null; then
        echo "✅"
        return 0
    else
        echo "❌"
        echo "Error details:"
        chezmoi execute-template --init --source . --config-format json --config "$DATA_FILE" < "$template" 2>&1 | head -20
        return 1
    fi
}

# Check all JSON templates (excluding node_modules)
ERRORS=0
while IFS= read -r -d '' template; do
    if ! check_template "$template"; then
        ((ERRORS++))
    fi
done < <(find . -name "*.json.tmpl" -type f -not -path "*/node_modules/*" -print0)

if [ $ERRORS -gt 0 ]; then
    echo "❌ Found $ERRORS invalid template(s)"
    exit 1
else
    echo "✅ All JSON templates are valid"
fi
