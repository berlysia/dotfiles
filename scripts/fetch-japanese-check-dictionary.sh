#!/usr/bin/env bash
# shellcheck shell=bash
# Fetches the UniDic dictionary that the japanese-check analyzer reads, checks
# the zip against the pinned sha256, and lays its 10 files directly into a new
# directory. CI and local runs use this; a user's `chezmoi apply` gets the same
# files from the external entry in home/.chezmoiexternal.toml.tmpl.
#
# Usage: scripts/fetch-japanese-check-dictionary.sh <dest-dir> [zip-path]
#   dest-dir  absolute path of a directory that does not exist yet or is empty
#   zip-path  absolute path where the zip is cached. When the file exists it is
#             used instead of downloading; it is verified either way.
#
# The version and sha256 come from home/.chezmoidata/japanese_check.yaml, read
# through `chezmoi execute-template`. The two JAPANESE_CHECK_DICTIONARY_*
# variables replace them (tests only).
#
# Nothing is created in dest-dir until the sha256 matches and every path in the
# zip is a plain relative path under lindera-unidic/.

set -euo pipefail

fail() {
    echo "fetch-japanese-check-dictionary: $1" >&2
    exit 1
}

[ "$#" -ge 1 ] && [ "$#" -le 2 ] || fail "usage: $0 <dest-dir> [zip-path]"
dest="$1"
case "$dest" in
    /*) ;;
    *) fail "dest-dir must be an absolute path" ;;
esac
if [ -e "$dest" ]; then
    [ -d "$dest" ] && [ -z "$(ls -A "$dest")" ] || fail "dest-dir must be an empty directory"
fi

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [ -n "${JAPANESE_CHECK_DICTIONARY_VERSION:-}" ] && [ -n "${JAPANESE_CHECK_DICTIONARY_SHA256:-}" ]; then
    version="$JAPANESE_CHECK_DICTIONARY_VERSION"
    sha256="$JAPANESE_CHECK_DICTIONARY_SHA256"
else
    command -v chezmoi > /dev/null 2>&1 || fail "chezmoi is required to read the pinned version"
    pinned="$(chezmoi execute-template --source "$root/home" \
        '{{ .japanese_check.dictionary.version }} {{ .japanese_check.dictionary.sha256 }}')" \
        || fail "could not read home/.chezmoidata/japanese_check.yaml"
    read -r version sha256 <<< "$pinned"
fi
[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || fail "the pinned version is not x.y.z"
[[ "$sha256" =~ ^[0-9a-f]{64}$ ]] || fail "the pinned sha256 is not 64 lowercase hex digits"

work="$(mktemp -d)"
trap 'rm -rf -- "$work"' EXIT
zip="${2:-$work/lindera-unidic-$version.zip}"
case "$zip" in
    /*) ;;
    *) fail "zip-path must be an absolute path" ;;
esac

if command -v sha256sum > /dev/null 2>&1; then
    hash_of() { sha256sum "$1" | cut -d ' ' -f 1; }
elif command -v shasum > /dev/null 2>&1; then
    hash_of() { shasum -a 256 "$1" | cut -d ' ' -f 1; }
else
    fail "neither sha256sum nor shasum is available"
fi

if [ ! -f "$zip" ]; then
    mkdir -p "$(dirname "$zip")"
    curl --proto '=https' --proto-redir '=https' -fsSL -o "$zip.part" \
        "https://github.com/lindera/lindera/releases/download/v${version}/lindera-unidic-${version}.zip" \
        || fail "download failed"
    mv -f "$zip.part" "$zip"
fi
[ "$(hash_of "$zip")" = "$sha256" ] || fail "the zip's sha256 does not match the pinned value"

# Every entry must be a relative path under lindera-unidic/ with no `..` part,
# and none may be a symlink (its mode starts with `l`).
while IFS= read -r name; do
    case "$name" in
        /* | ../* | */../* | */.. | .. | *\\*) fail "the zip has an unsafe path" ;;
        lindera-unidic/*) ;;
        lindera-unidic) ;;
        *) fail "the zip has an entry outside lindera-unidic/" ;;
    esac
done < <(unzip -Z1 "$zip")
if unzip -Z "$zip" | grep -q '^l'; then
    fail "the zip has a symlink entry"
fi

unzip -q "$zip" -d "$work/extract"
[ -d "$work/extract/lindera-unidic" ] && [ -n "$(ls -A "$work/extract/lindera-unidic")" ] \
    || fail "the zip has no files under lindera-unidic/"
mkdir -p "$dest"
mv "$work/extract/lindera-unidic"/* "$dest"/
echo "fetch-japanese-check-dictionary: placed $(find "$dest" -type f | wc -l | tr -d ' ') files in the destination"
