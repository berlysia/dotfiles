#!/usr/bin/env bash
# shellcheck shell=bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
ACTRUN_VERSION="${ACTRUN_VERSION:-v0.29.0}"
ACTRUN_STATE_ROOT="${ACTRUN_STATE_ROOT:-${TMPDIR:-/tmp}/actrun}"
RUN_ROOT="${ACTRUN_RUN_ROOT:-${ACTRUN_STATE_ROOT}/runs}"
WORKSPACE_ROOT="${ACTRUN_WORKSPACE_ROOT:-${ACTRUN_STATE_ROOT}/workspace}"
ARTIFACT_ROOT="${ACTRUN_ARTIFACT_ROOT:-${ACTRUN_STATE_ROOT}/artifacts}"
CACHE_ROOT="${ACTRUN_CACHE_ROOT:-${ACTRUN_STATE_ROOT}/cache}"
GITHUB_ACTION_CACHE_ROOT="${ACTRUN_GITHUB_ACTION_CACHE_ROOT:-${ACTRUN_STATE_ROOT}/github-action-cache}"
REGISTRY_ROOT="${ACTRUN_REGISTRY_ROOT:-${ACTRUN_STATE_ROOT}/registry}"
USE_AFFECTED=true
ACTRUN_BIN="${ACTRUN_BIN:-actrun}"

usage() {
    cat <<'EOF'
Usage:
  ./scripts/ci-local.sh <target> [--dry-run]
  ./scripts/ci-local.sh list

Targets:
  typescript | ts   Run .github/workflows/ci-typescript.yml
  codex            Run .github/workflows/validate-codex-config.yml
  shell            Run .github/workflows/ci-shellcheck.yml
  all              Run all supported local workflows
  lint             Run actrun workflow lint

Options:
  --dry-run        Show planned execution without running jobs
  --no-affected    Ignore affected-file filtering from actrun.toml

Environment:
  ACTRUN_BIN       actrun executable path (default: actrun from PATH)
  ACTRUN_VERSION   Required minimum release tag for manual installation guidance
  ACTRUN_STATE_ROOT  Root directory for actrun binaries and execution state
EOF
}

ensure_actrun() {
    if command -v "${ACTRUN_BIN}" >/dev/null 2>&1; then
        return 0
    fi

    cat >&2 <<EOF
actrun is required but was not found: ${ACTRUN_BIN}
Install tools from this project's mise config first:
  mise install

Then re-run with a mise-activated shell, or set ACTRUN_BIN to the actrun binary.
Expected actrun version: ${ACTRUN_VERSION} or newer
EOF
    exit 1
}

workflow_path() {
    case "$1" in
        typescript | ts)
            printf '%s\n' ".github/workflows/ci-typescript.yml"
            ;;
        codex)
            printf '%s\n' ".github/workflows/validate-codex-config.yml"
            ;;
        shell)
            printf '%s\n' ".github/workflows/ci-shellcheck.yml"
            ;;
        *)
            return 1
            ;;
    esac
}

run_workflow() {
    local workflow="$1"
    shift

    local args=(
        workflow
        run
        "${workflow}"
        --run-root
        "${RUN_ROOT}"
        --workspace
        "${WORKSPACE_ROOT}"
        --artifact-root
        "${ARTIFACT_ROOT}"
        --cache-root
        "${CACHE_ROOT}"
        --github-action-cache-root
        "${GITHUB_ACTION_CACHE_ROOT}"
        --registry-root
        "${REGISTRY_ROOT}"
    )
    if [[ "${USE_AFFECTED}" == true ]]; then
        args+=(--affected)
    fi
    args+=("$@")

    echo "==> ${workflow}"
    ensure_actrun
    (cd "${REPO_ROOT}" && "${ACTRUN_BIN}" "${args[@]}")
}

run_lint() {
    local args=(
        workflow
        lint
        --run-root
        "${RUN_ROOT}"
        --artifact-root
        "${ARTIFACT_ROOT}"
        --cache-root
        "${CACHE_ROOT}"
        --github-action-cache-root
        "${GITHUB_ACTION_CACHE_ROOT}"
        --registry-root
        "${REGISTRY_ROOT}"
    )
    args+=("$@")

    ensure_actrun
    (cd "${REPO_ROOT}" && "${ACTRUN_BIN}" "${args[@]}")
}

main() {
    if [[ $# -eq 0 ]]; then
        usage >&2
        exit 1
    fi

    local target="$1"
    shift

    local extra_args=()
    while [[ $# -gt 0 ]]; do
        case "$1" in
            --dry-run)
                extra_args+=("$1")
                ;;
            --no-affected)
                USE_AFFECTED=false
                ;;
            -h | --help)
                usage
                exit 0
                ;;
            *)
                extra_args+=("$1")
                ;;
        esac
        shift
    done

    mkdir -p \
        "${RUN_ROOT}" \
        "${WORKSPACE_ROOT}" \
        "${ARTIFACT_ROOT}" \
        "${CACHE_ROOT}" \
        "${GITHUB_ACTION_CACHE_ROOT}" \
        "${REGISTRY_ROOT}"

    case "${target}" in
        list)
            printf '%s\n' "typescript" "codex" "shell" "all" "lint"
            ;;
        lint)
            run_lint "${extra_args[@]}"
            ;;
        all)
            local typescript_workflow
            local codex_workflow
            local shell_workflow
            typescript_workflow="$(workflow_path typescript)"
            codex_workflow="$(workflow_path codex)"
            shell_workflow="$(workflow_path shell)"

            run_workflow "${typescript_workflow}" "${extra_args[@]}"
            run_workflow "${codex_workflow}" "${extra_args[@]}"
            run_workflow "${shell_workflow}" "${extra_args[@]}"
            ;;
        typescript | ts | codex | shell)
            local workflow
            workflow="$(workflow_path "${target}")"
            run_workflow "${workflow}" "${extra_args[@]}"
            ;;
        *)
            usage >&2
            exit 1
            ;;
    esac
}

main "$@"
