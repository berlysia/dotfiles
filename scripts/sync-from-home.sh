#!/bin/bash
# sync-from-home.sh - 実ファイルの変更をchezmoiに取り込む

set -euo pipefail

# 設定
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG_FILE="${SCRIPT_DIR}/sync-config.json"
LOG_FILE="${HOME}/.cache/chezmoi/sync-from-home.log"
BACKUP_DIR="${HOME}/.cache/chezmoi/backups"
LOCK_FILE="${HOME}/.cache/chezmoi/sync-from-home.lock"
LOCK_TIMEOUT=30

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

# ロック取得
acquire_lock() {
    local timeout=${LOCK_TIMEOUT}
    local count=0
    
    while [ ${count} -lt ${timeout} ]; do
        if (set -C; echo $$ > "${LOCK_FILE}") 2>/dev/null; then
            log "ロックを取得しました: ${LOCK_FILE}"
            return 0
        fi
        
        # 既存のロックファイルをチェック
        if [ -f "${LOCK_FILE}" ]; then
            local lock_pid
            lock_pid=$(cat "${LOCK_FILE}" 2>/dev/null || echo "")
            
            # プロセスが存在するかチェック
            if [ -n "${lock_pid}" ] && ! kill -0 "${lock_pid}" 2>/dev/null; then
                log "無効なロックファイルを削除: ${LOCK_FILE}"
                rm -f "${LOCK_FILE}"
                continue
            fi
        fi
        
        sleep 1
        ((count++))
    done
    
    log "Error: ロックの取得がタイムアウトしました"
    return 1
}

# ロック解放
release_lock() {
    if [ -f "${LOCK_FILE}" ]; then
        rm -f "${LOCK_FILE}"
        log "ロックを解放しました: ${LOCK_FILE}"
    fi
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
    if chezmoi re-add "${file}" 2>/dev/null; then
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
    changed_files=$(chezmoi status | grep -v '^$' | cut -c 4-)
    
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
        chezmoi diff "${file}" 2>/dev/null || true
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
    changed_files=$(chezmoi status | grep -v '^$' | cut -c 4-)

    while read -r file; do
        # 監視対象かチェック
        should_watch_file "${file}"
        local watch_result=$?
        
        case ${watch_result} in
            0)
                # 監視対象
                import_file "${file}"
                ;;
            1)
                # 監視パターンに一致しない
                log "監視対象外（パターン不一致）: ${file}"
                ;;
            2)
                # 無視パターンに一致
                log "監視対象外（無視リスト）: ${file}"
                ;;
        esac
    done <<< "${changed_files}"
}

# ファイル監視判定
should_watch_file() {
    local file="$1"
    
    # 無視パターンチェック
    for pattern in ${IGNORE_PATTERNS}; do
        if [[ "${file}" =~ ${pattern} ]]; then
            return 2
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
    # hookから呼び出されている場合はロックを取得しない
    local skip_lock=false
    if [ -n "${CHEZMOI_COMMAND:-}" ]; then
        skip_lock=true
        log "Hook経由での実行を検出: ${CHEZMOI_COMMAND}"
    fi
    
    # ロック取得
    if [ "${skip_lock}" = "false" ]; then
        if ! acquire_lock; then
            log "Error: 他のプロセスが実行中です"
            exit 1
        fi
        
        # 終了時にロックを解放
        trap release_lock EXIT
    fi
    
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