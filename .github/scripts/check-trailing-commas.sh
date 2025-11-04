#!/bin/bash

set -euo pipefail

echo "🔍 Checking for trailing commas in templates..."

FOUND=0
while IFS= read -r -d '' template; do
    if grep -n ',\s*[}\]]' "$template" > /dev/null; then
        echo "⚠️  Found trailing comma in $template:"
        grep -n ',\s*[}\]]' "$template" | head -5
        ((FOUND++))
    fi
done < <(find . -name "*.json.tmpl" -type f -not -path "*/node_modules/*" -print0)

if [ $FOUND -gt 0 ]; then
    echo "❌ Found trailing commas in $FOUND file(s)"
    exit 1
else
    echo "✅ No trailing commas found"
fi
