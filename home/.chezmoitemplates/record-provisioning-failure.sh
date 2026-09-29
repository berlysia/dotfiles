# Shared by the run_after_ 10- installers. Each one includes it with a chezmoi
# template action naming this file: template "record-provisioning-failure.sh" .
# written inside the usual double-brace delimiters. Those delimiters must not
# appear anywhere in this file: chezmoi renders it as a template and does not
# treat "#" as a comment, so an example written with live delimiters makes the
# partial include itself until rendering fails with "exceeded maximum template
# depth".
#
# record_provisioning_failure MARKER_FILE REASON RECOVER
#   Writes three fixed key=value fields to MARKER_FILE and returns 0, or
#   returns 1 when the marker could not be written.
#
# The temp file comes from mktemp: a new file under an unpredictable name,
# created exclusively at mode 600, so nothing planted in advance (a symlink to
# a FIFO or device, or a leftover from a killed run) can be written through or
# collide with it. It is then renamed into place, which replaces any older
# marker together with its mode (redirecting into an existing file would keep
# that mode). No command output is copied in: the marker outlives the run that
# produced it, and run_after_zz-verify-provisioning echoes it verbatim.
# A run killed between mktemp and mv leaves a *.tmp.XXXXXX file behind; the
# verifier stats only the exact marker paths, so such a leftover never reads
# as either a failure or a success.
record_provisioning_failure() {
    local marker_file="$1" reason="$2" recover="$3"
    local marker_tmp
    # A directory (or a symlink to one) at the marker path would make `mv -f`
    # move the temp file inside it and report success while the verifier sees
    # no marker, so treat it as a failure to record.
    [ -d "$marker_file" ] && return 1
    marker_tmp="$(mktemp "${marker_file}.tmp.XXXXXX" 2>/dev/null)" || return 1
    if printf '%s\n' \
        "at=$(date -u '+%Y-%m-%dT%H:%M:%SZ')" \
        "reason=${reason}" \
        "recover=${recover}" > "$marker_tmp" &&
        chmod 600 "$marker_tmp" &&
        mv -f "$marker_tmp" "$marker_file"; then
        return 0
    fi
    rm -f "$marker_tmp"
    return 1
}
