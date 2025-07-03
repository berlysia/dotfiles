#!/bin/bash
# post-sync.sh - 同期後の処理

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SYNC_SCRIPT="${SCRIPT_DIR}/../scripts/sync-from-home.sh"

# 環境変数チェック
if [ -n "${CHEZMOI_COMMAND:-}" ]; then
    echo "Hook triggered by: ${CHEZMOI_COMMAND}"
fi

# 同期処理実行
if [ -x "${SYNC_SCRIPT}" ]; then
    case "${CHEZMOI_COMMAND:-}" in
        apply)
            # apply前は自動取り込み（preフック）
            "${SYNC_SCRIPT}" auto
            ;;
        update)
            # update後は自動取り込み
            "${SYNC_SCRIPT}" auto
            ;;
        *)
            # その他は変更検出のみ
            "${SYNC_SCRIPT}" detect
            ;;
    esac
else
    echo "Warning: Sync script not found or not executable: ${SYNC_SCRIPT}"
fi