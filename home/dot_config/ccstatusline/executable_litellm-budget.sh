#!/bin/bash
# Prints the remaining LiteLLM key budget. Outside LLM gateway sessions (Claude.ai login)
# the variables are unset and it prints nothing, which makes ccstatusline drop the widget.
# Always exit 0: a non-zero exit renders as an error widget instead of hiding it.
[ -n "$ANTHROPIC_BASE_URL" ] && [ -n "$ANTHROPIC_AUTH_TOKEN" ] || exit 0
curl -sf --max-time 2 "$ANTHROPIC_BASE_URL/user/info" \
	-H "Authorization: Bearer $ANTHROPIC_AUTH_TOKEN" |
	jq -r '"🔋 $" + ((.keys[0].max_budget - .keys[0].spend) | tostring | .[:7])' 2>/dev/null
exit 0
