#!/bin/bash
# run_onchange_setup-sync.sh - 同期スクリプトの初期セットアップ

set -euo pipefail

echo "=== Chezmoi Sync Setup ==="

# 必要ディレクトリの作成
echo "Creating directories..."
mkdir -p "${HOME}/.cache/chezmoi/backups"
mkdir -p "${HOME}/.config/chezmoi"

# 設定ファイル確認
CONFIG_FILE="${HOME}/.local/share/chezmoi/scripts/sync-config.json"
if [ -f "${CONFIG_FILE}" ]; then
    echo "✓ Configuration file exists: ${CONFIG_FILE}"
else
    echo "✗ Configuration file missing: ${CONFIG_FILE}"
    exit 1
fi

# スクリプト実行権限確認
SYNC_SCRIPT="${HOME}/.local/share/chezmoi/scripts/sync-from-home.sh"
STATUS_SCRIPT="${HOME}/.local/share/chezmoi/scripts/sync-status.sh"
WRAPPER_SCRIPT="${HOME}/.local/bin/chezmoi-sync"

for script in "${SYNC_SCRIPT}" "${STATUS_SCRIPT}" "${WRAPPER_SCRIPT}"; do
    if [ -x "${script}" ]; then
        echo "✓ Executable: ${script}"
    else
        echo "✗ Not executable: ${script}"
        chmod +x "${script}" 2>/dev/null || echo "  Warning: Failed to make executable"
    fi
done

# chezmoi設定確認
CHEZMOI_CONFIG="${HOME}/.config/chezmoi/chezmoi.toml"
if [ -f "${CHEZMOI_CONFIG}" ]; then
    echo "✓ Chezmoi config exists: ${CHEZMOI_CONFIG}"
else
    echo "✗ Chezmoi config missing: ${CHEZMOI_CONFIG}"
fi

# 初期ログファイル作成
LOG_FILE="${HOME}/.cache/chezmoi/sync-from-home.log"
touch "${LOG_FILE}"
echo "✓ Log file: ${LOG_FILE}"

# 完了メッセージ
echo
echo "=== Setup Complete ==="
echo "使用法:"
echo "  chezmoi-sync                    # 自動取り込み"
echo "  chezmoi-sync sync interactive   # インタラクティブ取り込み"
echo "  chezmoi-sync status             # 状況確認"
echo "  chezmoi-sync help               # ヘルプ表示"
echo