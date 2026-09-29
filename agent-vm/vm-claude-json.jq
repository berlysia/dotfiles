# VM post-processing of ~/.claude.json (spec K19): keep only MCP servers that work with network access alone.
# An allowlist ($keep, space-separated, passed by bootstrap.sh), so MCP servers added to the host template later
# do not reach the VM. Project-scoped servers (projects[...].mcpServers) are the user's own and are left alone.
($keep | split(" ")) as $names
| if .mcpServers then .mcpServers |= with_entries(select(.key | IN($names[]))) else . end
