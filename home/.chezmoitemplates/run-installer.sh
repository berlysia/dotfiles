# Shared by the run_onchange_install-packages-1 scripts (linux, darwin). Each one includes it with a
# chezmoi template action naming this file: template "run-installer.sh" .
# written inside the usual double-brace delimiters. Those delimiters must not appear anywhere in this
# file (see record-provisioning-failure.sh for what happens when they do).
#
# run_installer URL [INSTALLER_ARG...]
#   Downloads the installer script at URL to a temp file and runs it with sh. Returns curl's exit
#   status when the download fails, and the installer's own status otherwise.
#
# The download goes to a file instead of a pipe so that an HTTP error page or a response cut off
# midway is never executed: sh would run whatever part of a piped script had arrived. The function
# reports failure through its return status alone, because the darwin caller sets neither errexit nor
# pipefail.
# No timeout or retry here, unlike run_installer in agent-vm/bootstrap.sh: this runs in a terminal
# someone is watching, and a fresh macOS has no `timeout` command.
run_installer() {
    local url="$1" script status=0
    shift
    # An explicit template: a bare `mktemp` is not accepted by every BSD mktemp.
    script="$(mktemp "${TMPDIR:-/tmp}/run-installer.XXXXXX")" || return 1
    if curl -fsSL --proto '=https' --tlsv1.2 -o "$script" "$url"; then
        sh "$script" "$@" || status=$?
        [ "$status" -eq 0 ] || echo "installer from $url failed (exit $status)" >&2
    else
        status=$?
        echo "could not download $url (curl exit $status)" >&2
    fi
    rm -f "$script"
    return "$status"
}
