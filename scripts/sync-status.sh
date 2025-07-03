#!/bin/bash
# sync-status.sh - 同期状況の確認

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG_FILE="${HOME}/.cache/chezmoi/sync-from-home.log"
BACKUP_DIR="${HOME}/.cache/chezmoi/backups"

# 色付きメッセージ
red() { echo -e "\033[31m$*\033[0m"; }
green() { echo -e "\033[32m$*\033[0m"; }
yellow() { echo -e "\033[33m$*\033[0m"; }
blue() { echo -e "\033[34m$*\033[0m"; }

# ヘッダー
header() {
    echo "$(blue "=== Chezmoi Sync Status ===")"
    echo "$(date '+%Y-%m-%d %H:%M:%S')"
    echo
}

# 変更状況確認
check_changes() {
    echo "$(blue "--- 変更状況 ---")"
    
    local changed_files=0
    local total_files=0
    
    while read -r file; do
        ((total_files++))
        if ! chezmoi verify "${file}" 2>/dev/null; then
            if [ ${changed_files} -eq 0 ]; then
                echo "$(yellow "変更されたファイル:")"
            fi
            echo "  $(red "✗") ${file}"
            ((changed_files++))
        fi
    done < <(chezmoi managed)
    
    if [ ${changed_files} -eq 0 ]; then
        echo "$(green "✓ 全ファイルが同期されています")"
    else
        echo
        echo "$(yellow "変更ファイル数: ${changed_files}/${total_files}")"
    fi
    echo
}

# 最新ログ表示
show_recent_logs() {
    echo "$(blue "--- 最新ログ (10件) ---")"
    
    if [ -f "${LOG_FILE}" ]; then
        tail -10 "${LOG_FILE}"
    else
        echo "$(yellow "ログファイルが見つかりません")"
    fi
    echo
}

# バックアップ状況
show_backup_status() {
    echo "$(blue "--- バックアップ状況 ---")"
    
    if [ -d "${BACKUP_DIR}" ]; then
        local backup_count
        backup_count=$(find "${BACKUP_DIR}" -type f | wc -l)
        
        if [ ${backup_count} -gt 0 ]; then
            echo "$(green "バックアップ数: ${backup_count}")"
            echo "$(blue "最新バックアップ:")"
            find "${BACKUP_DIR}" -type f -printf "%T@ %p\n" | sort -n | tail -5 | while read -r timestamp file; do
                local date_str
                date_str=$(date -d "@${timestamp}" '+%Y-%m-%d %H:%M:%S')
                echo "  ${date_str} $(basename "${file}")"
            done
        else
            echo "$(yellow "バックアップファイルがありません")"
        fi
    else
        echo "$(yellow "バックアップディレクトリが見つかりません")"
    fi
    echo
}

# 設定状況
show_config_status() {
    echo "$(blue "--- 設定状況 ---")"
    
    local config_file="${SCRIPT_DIR}/sync-config.json"
    if [ -f "${config_file}" ]; then
        echo "$(green "✓ 設定ファイル: ${config_file}")"
        
        if command -v jq >/dev/null 2>&1; then
            # 監視パターン表示
            local watch_patterns
            watch_patterns=$(jq -r '.sync.watch[]?' "${config_file}" 2>/dev/null | sed 's/^/  /' || echo "")
            if [ -n "${watch_patterns}" ]; then
                echo "$(blue "監視パターン:")"
                echo "${watch_patterns}"
            fi
            
            # 無視パターン表示
            local ignore_patterns
            ignore_patterns=$(jq -r '.sync.ignore[]?' "${config_file}" 2>/dev/null | sed 's/^/  /' || echo "")
            if [ -n "${ignore_patterns}" ]; then
                echo "$(blue "無視パターン:")"
                echo "${ignore_patterns}"
            fi
            
            # その他の設定値表示
            local auto_import
            auto_import=$(jq -r '.sync.auto_import // true' "${config_file}" 2>/dev/null || echo "true")
            echo "$(blue "自動取り込み: ${auto_import}")"
            
            local retention_days
            retention_days=$(jq -r '.backup.retention_days // 30' "${config_file}" 2>/dev/null || echo "30")
            echo "$(blue "バックアップ保持期間: ${retention_days}日")"
        else
            echo "$(yellow "jqコマンドが見つかりません。設定詳細を表示できません。")"
        fi
    else
        echo "$(red "✗ 設定ファイルが見つかりません")"
    fi
    echo
}

# 統計情報
show_statistics() {
    echo "$(blue "--- 統計情報 ---")"
    
    if [ -f "${LOG_FILE}" ]; then
        local today
        today=$(date '+%Y-%m-%d')
        
        local today_imports
        today_imports=$(grep "${today}" "${LOG_FILE}" | grep -c "取り込み成功" || echo "0")
        
        local today_errors
        today_errors=$(grep "${today}" "${LOG_FILE}" | grep -c "取り込み失敗" || echo "0")
        
        echo "$(green "本日の取り込み成功: ${today_imports}")"
        echo "$(red "本日の取り込み失敗: ${today_errors}")"
        
        local total_size
        total_size=$(du -sh "${HOME}/.local/share/chezmoi" 2>/dev/null | cut -f1 || echo "不明")
        echo "$(blue "chezmoi ディレクトリサイズ: ${total_size}")"
    else
        echo "$(yellow "ログファイルがありません")"
    fi
    echo
}

# コマンド実行
run_command() {
    case "${1:-status}" in
        status|s)
            header
            check_changes
            show_recent_logs
            show_backup_status
            show_config_status
            show_statistics
            ;;
        changes|c)
            header
            check_changes
            ;;
        logs|l)
            header
            show_recent_logs
            ;;
        backups|b)
            header
            show_backup_status
            ;;
        config|conf)
            header
            show_config_status
            ;;
        stats|st)
            header
            show_statistics
            ;;
        *)
            echo "使用法: $0 [status|changes|logs|backups|config|stats]"
            echo "  status: 全体状況（デフォルト）"
            echo "  changes: 変更状況のみ"
            echo "  logs: ログのみ"
            echo "  backups: バックアップ状況のみ"
            echo "  config: 設定状況のみ"
            echo "  stats: 統計情報のみ"
            exit 1
            ;;
    esac
}

# メイン処理
main() {
    run_command "$@"
}

# スクリプト実行チェック
if [ "${BASH_SOURCE[0]}" = "${0}" ]; then
    main "$@"
fi