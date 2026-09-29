# VM post-processing of ~/.claude/settings.json (spec K19): drop hooks that only make sense on the host.
# Matches the audio notifier's script path exactly (followed by a space or quote, as hook-timer.sh wraps it),
# then prunes matcher groups and events left empty so the shape stays what update-settings-json writes.
def host_only: test("/\\.claude/hooks/implementations/speak-notification\\.ts[ '\"]");
if .hooks then
  .hooks |= (
    with_entries(.value |= (map(.hooks |= map(select((.command // "") | host_only | not)))
                            | map(select(.hooks | length > 0))))
    | with_entries(select(.value | length > 0)))
else . end
