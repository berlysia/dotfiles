# VM post-processing of ~/.codex/config.toml (spec K19): drop [mcp_servers.<name>] tables, and their sub-tables,
# unless <name> is in keep_list (space-separated, passed by bootstrap.sh). Handles quoted names, surrounding
# whitespace and [[...]] headers; dotted keys and inline tables are not produced by the template and are caught
# by bootstrap's self-check instead. Any line starting with `[` counts as a header, so a multi-line array whose
# continuation line starts with `[` would end a dropped table early; the template writes single-line arrays.
# Plain POSIX awk: Ubuntu's default awk is mawk (`]` first in a bracket expression is a literal).
BEGIN { n = split(keep_list, names, " "); for (i = 1; i <= n; i++) keep[names[i]] = 1 }
/^[ \t]*\[/ {
  drop = 0
  header = $0
  sub(/^[ \t]*\[+[ \t]*/, "", header)
  if (index(header, "mcp_servers.") == 1) {
    name = substr(header, 13)
    sub(/^"/, "", name)
    sub(/[]". \t].*$/, "", name)
    drop = !(name in keep)
  }
}
!drop
