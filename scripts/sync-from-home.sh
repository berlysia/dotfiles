#!/bin/bash
# sync-from-home.sh - 実ファイルの変更をchezmoiに取り込む

set -euo pipefail

# 設定
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG_FILE="${SCRIPT_DIR}/sync-config.json"
LOG_FILE="${HOME}/.cache/chezmoi/sync-from-home.log"
BACKUP_DIR="${HOME}/.cache/chezmoi/backups"

# ログ関数
log() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" | tee -a "${LOG_FILE}"
}

# 通知関数
notify() {
    local message="$1"
    local type="${2:-info}"
    
    case "${type}" in
        error)
            if [ "${NOTIFY_ON_ERROR}" = "true" ]; then
                "${NOTIFY_COMMAND}" "Chezmoi Sync Error" "${message}" 2>/dev/null || true
            fi
            ;;
        success)
            if [ "${NOTIFY_ON_IMPORT}" = "true" ]; then
                "${NOTIFY_COMMAND}" "Chezmoi Sync Success" "${message}" 2>/dev/null || true
            fi
            ;;
    esac
}

# バックアップクリーンアップ
cleanup_backups() {
    if [ ! -d "${BACKUP_DIR}" ]; then
        return 0
    fi
    
    # 古いバックアップを削除（保持期間）
    find "${BACKUP_DIR}" -type f -mtime +${RETENTION_DAYS} -delete 2>/dev/null || true
    
    # 最大バックアップ数制限
    local backup_count
    backup_count=$(find "${BACKUP_DIR}" -type f | wc -l)
    
    if [ ${backup_count} -gt ${MAX_BACKUPS} ]; then
        local excess=$((backup_count - MAX_BACKUPS))
        find "${BACKUP_DIR}" -type f -printf "%T@ %p\n" | sort -n | head -${excess} | cut -d' ' -f2- | xargs -r rm -f
        log "古いバックアップを${excess}件削除しました"
    fi
}

# 初期化
init() {
    mkdir -p "$(dirname "${LOG_FILE}")" "${BACKUP_DIR}"
    touch "${LOG_FILE}"
}

# 変更検出
detect_changes() {
    log "変更検出を開始"
    
    # chezmoi diffで差分確認
    local changes
    changes=$(chezmoi diff --format=json 2>/dev/null || echo "[]")
    
    if [ "${changes}" = "[]" ]; then
        log "変更なし"
        return 1
    fi
    
    log "変更を検出: ${changes}"
    return 0
}

# 監視対象ファイル設定読み込み
load_config() {
    if [ ! -f "${CONFIG_FILE}" ]; then
        log "設定ファイルが見つかりません: ${CONFIG_FILE}"
        return 1
    fi
    
    # jqでJSON設定を読み込み
    if ! command -v jq >/dev/null 2>&1; then
        log "Error: jqコマンドが見つかりません"
        return 1
    fi
    
    # 監視パターンを配列として読み込み
    WATCH_PATTERNS=$(jq -r '.sync.watch[]?' "${CONFIG_FILE}" 2>/dev/null || echo "")
    IGNORE_PATTERNS=$(jq -r '.sync.ignore[]?' "${CONFIG_FILE}" 2>/dev/null || echo "")
    
    # 設定値を読み込み
    AUTO_IMPORT=$(jq -r '.sync.auto_import // true' "${CONFIG_FILE}" 2>/dev/null || echo "true")
    RETENTION_DAYS=$(jq -r '.backup.retention_days // 30' "${CONFIG_FILE}" 2>/dev/null || echo "30")
    MAX_BACKUPS=$(jq -r '.backup.max_backups // 50' "${CONFIG_FILE}" 2>/dev/null || echo "50")
    LOG_LEVEL=$(jq -r '.logging.level // "info"' "${CONFIG_FILE}" 2>/dev/null || echo "info")
    NOTIFY_ON_IMPORT=$(jq -r '.notification.on_import // true' "${CONFIG_FILE}" 2>/dev/null || echo "true")
    NOTIFY_ON_ERROR=$(jq -r '.notification.on_error // true' "${CONFIG_FILE}" 2>/dev/null || echo "true")
    NOTIFY_COMMAND=$(jq -r '.notification.notify_command // "notify-send"' "${CONFIG_FILE}" 2>/dev/null || echo "notify-send")
}

# ファイル単位での取り込み
import_file() {
    local file="$1"
    local source_path
    
    # chezmoiソースパスを取得
    source_path=$(chezmoi source-path "${file}" 2>/dev/null || echo "")
    
    if [ -z "${source_path}" ]; then
        log "ファイルが管理対象外: ${file}"
        return 1
    fi
    
    # バックアップ作成
    if [ -f "${source_path}" ]; then
        local backup_file="${BACKUP_DIR}/$(basename "${source_path}").$(date +%Y%m%d_%H%M%S)"
        cp "${source_path}" "${backup_file}"
        log "バックアップ作成: ${backup_file}"
    fi
    
    # re-addで取り込み
    if chezmoi re-add "${file}"; then
        log "取り込み成功: ${file}"
        notify "取り込み成功: ${file}" "success"
        return 0
    else
        log "取り込み失敗: ${file}"
        notify "取り込み失敗: ${file}" "error"
        return 1
    fi
}

# インタラクティブモード
interactive_mode() {
    log "インタラクティブモードを開始"
    
    local changed_files
    changed_files=$(chezmoi managed | while read -r file; do
        if ! chezmoi verify "${file}" 2>/dev/null; then
            echo "${file}"
        fi
    done)
    
    if [ -z "${changed_files}" ]; then
        log "変更されたファイルはありません"
        return 0
    fi
    
    echo "変更されたファイル:"
    echo "${changed_files}"
    echo
    
    while read -r file; do
        echo "ファイル: ${file}"
        echo "差分:"
        chezmoi diff "${file}" || true
        echo
        
        read -p "このファイルを取り込みますか？ (y/n/q): " -n 1 -r
        echo
        
        case "${REPLY}" in
            y|Y)
                import_file "${file}"
                ;;
            q|Q)
                log "処理を中断しました"
                return 0
                ;;
            *)
                log "スキップ: ${file}"
                ;;
        esac
    done <<< "${changed_files}"
}

# 自動モード
auto_mode() {
    log "自動モードを開始"
    
    local changed_files
    changed_files=$(chezmoi managed | while read -r file; do
        if ! chezmoi verify "${file}" 2>/dev/null; then
            echo "${file}"
        fi
    done)

    log "変更されたファイル数: $(echo "${changed_files}" | wc -l)"
    
    if [ -z "${changed_files}" ]; then
        log "変更されたファイルはありません"
        return 0
    fi
    
    while read -r file; do
        # 監視対象かチェック
        if should_watch_file "${file}"; then
            import_file "${file}"
        else
            log "監視対象外: ${file}"
        fi
    done <<< "${changed_files}"
}

# ファイル監視判定
should_watch_file() {
    local file="$1"
    
    # 無視パターンチェック
    for pattern in ${IGNORE_PATTERNS}; do
        if [[ "${file}" =~ ${pattern} ]]; then
            return 1
        fi
    done
    
    # 監視パターンチェック
    if [ -n "${WATCH_PATTERNS}" ]; then
        for pattern in ${WATCH_PATTERNS}; do
            if [[ "${file}" =~ ${pattern} ]]; then
                return 0
            fi
        done
        return 1
    fi
    
    return 0
}

# メイン処理
main() {
    init
    load_config
    cleanup_backups
    
    case "${1:-auto}" in
        interactive|i)
            interactive_mode
            ;;
        auto|a)
            auto_mode
            ;;
        detect|d)
            detect_changes
            ;;
        *)
            echo "使用法: $0 [auto|interactive|detect]"
            echo "  auto: 自動取り込み（デフォルト）"
            echo "  interactive: インタラクティブ取り込み"
            echo "  detect: 変更検出のみ"
            exit 1
            ;;
    esac
}

# スクリプト実行チェック
if [ "${BASH_SOURCE[0]}" = "${0}" ]; then
    main "$@"
fi