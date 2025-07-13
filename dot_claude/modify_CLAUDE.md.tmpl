#!/bin/bash

# ~/.claude/CLAUDE.md のシンプルパッチベースマージスクリプト
# diffとpatchコマンドを直接使用した軽量実装

set -euo pipefail

# マージモード設定
MERGE_MODE="${MERGE_MODE:-AUTO}"

# 作業用一時ファイル
TEMP_DIR=$(mktemp -d)
EXISTING_FILE="$TEMP_DIR/existing.md"
CHEZMOI_FILE="$TEMP_DIR/chezmoi.md"

# エラー時のクリーンアップ
cleanup() {
    rm -rf "$TEMP_DIR"
}
trap cleanup EXIT

# 標準入力から既存のファイル内容を読み込み
cat > "$EXISTING_FILE"

# chezmoi管理のCLAUDE.md設定を読み込み
cat > "$CHEZMOI_FILE" << 'EOF'
{{ includeTemplate "dot_claude/.CLAUDE.md" . }}
EOF

# パッチ生成
generate_patch() {
    # unified diff形式でパッチを生成
    if diff -u "$EXISTING_FILE" "$CHEZMOI_FILE" > /dev/null 2>/dev/null; then
        echo "✅ No changes detected between files" >&2
        cat "$EXISTING_FILE"
        return 1
    else
        return 0
    fi
}

# インタラクティブ適用
apply_patch() {
    case "$MERGE_MODE" in
        "INTERACTIVE")
            echo "Choose action:" >&2
            echo "1) Apply patch (update to chezmoi version)" >&2
            echo "2) Open merge tool" >&2
            echo "3) Keep existing version" >&2
            echo "4) Manual edit" >&2
            echo "" >&2
            
            while true; do
                read -p "Enter choice [1-5]: " choice
                case $choice in
                    1)
                        echo "📥 Applying patch..." >&2
                        cp "$CHEZMOI_FILE" "$EXISTING_FILE"
                        cat "$EXISTING_FILE"
                        return 0
                        ;;
                    2)
                        open_merge_tool
                        return 0
                        ;;
                    3)
                        echo "📄 Keeping existing version" >&2
                        cat "$EXISTING_FILE"
                        return 0
                        ;;
                    4)
                        manual_edit
                        return 0
                        ;;
                    *)
                        echo "Invalid choice. Please enter 1-4." >&2
                        ;;
                esac
            done
            ;;
        "AUTO")
            echo "🤖 Auto-applying chezmoi version..." >&2
            cp "$CHEZMOI_FILE" "$EXISTING_FILE"
            cat "$EXISTING_FILE"
            ;;
        "FORCE")
            echo "💪 Force-applying chezmoi version..." >&2
            cp "$CHEZMOI_FILE" "$EXISTING_FILE"
            cat "$EXISTING_FILE"
            ;;
    esac
}

# マージツールを開く
open_merge_tool() {
    if command -v code >/dev/null 2>&1; then
        echo "🛠️  Opening VS Code merge editor..." >&2
        # 3ファイル比較: existing, chezmoi, (output will be existing)
        code --diff "$EXISTING_FILE" "$CHEZMOI_FILE" --wait
        cat "$EXISTING_FILE"
    elif command -v vimdiff >/dev/null 2>&1; then
        echo "🛠️  Opening vimdiff..." >&2
        vimdiff "$EXISTING_FILE" "$CHEZMOI_FILE"
        cat "$EXISTING_FILE"
    elif command -v meld >/dev/null 2>&1; then
        echo "🛠️  Opening Meld..." >&2
        meld "$EXISTING_FILE" "$CHEZMOI_FILE"
        cat "$EXISTING_FILE"
    else
        echo "❌ No suitable merge tool found" >&2
        echo "Available files for manual editing:" >&2
        echo "  Existing: $EXISTING_FILE" >&2
        echo "  Chezmoi:  $CHEZMOI_FILE" >&2
        read -p "Press Enter after manual editing..."
        cat "$EXISTING_FILE"
    fi
}

# 手動編集
manual_edit() {
    local editor="${EDITOR:-nano}"
    echo "✏️  Opening editor ($editor)..." >&2
    echo "Files available:" >&2
    echo "  Current: $EXISTING_FILE" >&2
    echo "  Target:  $CHEZMOI_FILE" >&2
    echo "" >&2
    
    $editor "$EXISTING_FILE"
    cat "$EXISTING_FILE"
}

# メイン処理
main() {
    if generate_patch; then
        apply_patch
    fi
}

main