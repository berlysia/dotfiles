#!/bin/bash

# 音声ファイルのゲイン調整スクリプト
# 使用方法: ./adjust-gain.sh [gain_value] [target_files...]
# 例: ./adjust-gain.sh -10dB ClaudeNotification.wav
# 例: ./adjust-gain.sh +5dB *.wav

set -euo pipefail

# デフォルト値
DEFAULT_GAIN="-3dB"
SOUND_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ヘルプメッセージ
show_help() {
    cat << EOF
音声ファイルのゲイン調整スクリプト

使用方法:
    $0 [GAIN] [FILES...]
    $0 --help

引数:
    GAIN        ゲイン値（デフォルト: $DEFAULT_GAIN）
    FILES       対象ファイル（省略時は*.wav）

ゲイン値の形式:
    【dB形式（単位付き）】
    -10dB       かなり小さく（約0.32倍）
    -6dB        半分の音量
    -3dB        少し小さく（約0.7倍）
    0dB         変更なし（等倍）
    +3dB        少し大きく（約1.4倍）
    +6dB        2倍の音量

    【dB形式（単位なし）】※soxのデフォルト形式
    -10         かなり小さく（-10dB相当）
    -6          半分の音量（-6dB相当）
    -3          少し小さく（-3dB相当）
    0           変更なし（0dB相当）
    +3          少し大きく（+3dB相当）
    +6          2倍の音量（+6dB相当）

    【倍率形式】※1.0を基準とした倍率
    0.1         1/10の音量（-20dB相当）
    0.5         半分の音量（-6dB相当）
    0.7         少し小さく（-3dB相当）
    1.0         変更なし（等倍）
    1.4         少し大きく（+3dB相当）
    2.0         2倍の音量（+6dB相当）

例:
    $0 -10dB ClaudeNotification.wav    # 10dB下げる（単位付き）
    $0 -10 ClaudeNotification.wav      # 10dB下げる（単位なし）
    $0 +5dB *.wav                      # 全ファイルを5dB上げる
    $0 0.5 ClaudePermission.wav        # 半分の音量にする（倍率形式）
    $0 1.5 ClaudeStop.wav              # 1.5倍の音量にする（倍率形式）
    $0 --backup-restore                # バックアップから復元

依存関係:
    - sox (Sound eXchange)
    - インストール: sudo apt-get install sox

注意:
    - 元のファイルは .bak 拡張子でバックアップされます
    - 既存のバックアップは上書きされません
EOF
}

# SoX がインストールされているかチェック
check_sox() {
    if ! command -v sox &> /dev/null; then
        echo "エラー: sox がインストールされていません"
        echo "インストール: sudo apt-get install sox"
        exit 1
    fi
}

# バックアップ作成
create_backup() {
    local file="$1"
    local backup="${file%.wav}.bak.wav"
    
    if [[ ! -f "$backup" ]]; then
        echo "バックアップ作成: $file -> $backup"
        cp "$file" "$backup"
    else
        echo "バックアップ既存: $backup"
    fi
}

# ゲイン調整
adjust_gain() {
    local gain="$1"
    local file="$2"
    
    if [[ ! -f "$file" ]]; then
        echo "エラー: ファイルが見つかりません: $file"
        return 1
    fi
    
    create_backup "$file"
    
    echo "ゲイン調整: $file (gain: $gain)"
    
    # 一時ファイルを使用してゲイン調整（元の拡張子を保持）
    local temp_file="${file%.wav}_tmp.wav"
    
    # dB単位を削除して数値のみにする
    local gain_value="$gain"
    if [[ "$gain" =~ ^([+-]?[0-9.]+)dB$ ]]; then
        gain_value="${BASH_REMATCH[1]}"
    fi
    
    if sox "$file" "$temp_file" gain "$gain_value"; then
        mv "$temp_file" "$file"
        echo "完了: $file"
    else
        echo "エラー: ゲイン調整に失敗しました: $file"
        [[ -f "$temp_file" ]] && rm -f "$temp_file"
        return 1
    fi
}

# バックアップから復元
restore_from_backup() {
    local restored=0
    
    for backup in "$SOUND_DIR"/*.bak.wav; do
        if [[ -f "$backup" ]]; then
            local original="${backup%.bak.wav}.wav"
            echo "復元: $backup -> $original"
            cp "$backup" "$original"
            ((restored++)) || true
        fi
    done
    
    if [[ $restored -eq 0 ]]; then
        echo "復元可能なバックアップファイルが見つかりません"
    else
        echo "復元完了: $restored ファイル"
    fi
}

# メイン処理
main() {
    cd "$SOUND_DIR"
    
    # ヘルプ表示
    if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
        show_help
        exit 0
    fi
    
    # バックアップ復元
    if [[ "${1:-}" == "--backup-restore" ]]; then
        restore_from_backup
        exit 0
    fi
    
    # 引数がない場合はヘルプを表示
    if [[ $# -eq 0 ]]; then
        show_help
        exit 0
    fi
    
    check_sox
    
    # 引数解析
    local gain="$1"
    shift
    local files=()
    
    if [[ $# -gt 0 ]]; then
        files=("$@")
    else
        echo "エラー: 対象ファイルを指定してください"
        echo
        show_help
        exit 1
    fi
    
    if [[ ${#files[@]} -eq 0 ]]; then
        echo "エラー: 対象ファイルが見つかりません"
        exit 1
    fi
    
    echo "ゲイン調整開始 (gain: $gain)"
    echo "対象ファイル: ${files[*]}"
    echo
    
    local success=0
    local total=${#files[@]}
    
    for file in "${files[@]}"; do
        if adjust_gain "$gain" "$file"; then
            ((success++)) || true
        fi
    done
    
    echo
    echo "処理完了: $success/$total ファイル"
    
    if [[ $success -lt $total ]]; then
        exit 1
    fi
}

main "$@"