# VM post-processing of ~/.claude.json (spec K4): point the browser MCP servers at the headless shell the launcher
# mounts at a fixed path, and give them the side-loaded libgbm. Args are rebuilt from the package pin (args[0]),
# never appended, so re-running bootstrap gives the same file; flags the host template may add later after args[0]
# are dropped on purpose. An entry without a string args[0] is left as is, and bootstrap's self-check rejects it.
# $exe and $lib come from bootstrap.sh via --arg.
def browser(flag):
  # Narrow the type first: on a string .args, .args[0]? is empty and would make the whole entry disappear.
  if ((.args // null) | if type == "array" then (.[0] | type) else "none" end) == "string"
  then .args = [.args[0], "--headless", "--isolated", flag, $exe] | .env = ((.env // {}) + {LD_LIBRARY_PATH: $lib})
  else . end;
if .mcpServers then
  .mcpServers |= (
    (if has("playwright") then .playwright |= browser("--executable-path") else . end)
    | (if has("chrome-devtools") then .["chrome-devtools"] |= browser("--executablePath") else . end))
else . end
