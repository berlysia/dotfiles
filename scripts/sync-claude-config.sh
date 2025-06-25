#!/bin/sh

# sync-claude-config.sh
# Sync ~/.claude/CLAUDE.md to dot_claude/CLAUDE.md in chezmoi dotfiles
# with conflict detection and resolution

set -e

# Define paths
SOURCE_FILE="$HOME/.claude/CLAUDE.md"
TARGET_FILE="$(chezmoi source-path)/dot_claude/CLAUDE.md"

# Check if source file exists
if [ ! -f "$SOURCE_FILE" ]; then
    echo "Error: Source file $SOURCE_FILE does not exist"
    exit 1
fi

# Check if target directory exists
TARGET_DIR="$(dirname "$TARGET_FILE")"
if [ ! -d "$TARGET_DIR" ]; then
    echo "Error: Target directory $TARGET_DIR does not exist"
    exit 1
fi

# Function to check if files are identical
files_identical() {
    if [ ! -f "$TARGET_FILE" ]; then
        return 1  # Target doesn't exist, not identical
    fi
    cmp -s "$SOURCE_FILE" "$TARGET_FILE"
}

# Function to check if target has uncommitted changes
has_uncommitted_changes() {
    cd "$(chezmoi source-path)"
    git status --porcelain "dot_claude/CLAUDE.md" | grep -q "."
}

# Function to show diff
show_diff() {
    echo "=== Differences between files ==="
    if command -v colordiff >/dev/null 2>&1; then
        colordiff -u "$TARGET_FILE" "$SOURCE_FILE" || true
    else
        diff -u "$TARGET_FILE" "$SOURCE_FILE" || true
    fi
    echo "================================="
}

# Function to handle conflict resolution
resolve_conflict() {
    echo "Conflict detected! Both files have been modified."
    echo "Source: $SOURCE_FILE"
    echo "Target: $TARGET_FILE"
    echo ""
    show_diff
    echo ""
    echo "Choose an option:"
    echo "1) Overwrite target with source (lose target changes)"
    echo "2) Keep target (ignore source changes)"
    echo "3) Open merge tool (requires manual resolution)"
    echo "4) Abort operation"
    
    while true; do
        printf "Enter choice [1-4]: "
        read -r choice
        case $choice in
            1)
                echo "Overwriting target with source..."
                cp "$SOURCE_FILE" "$TARGET_FILE"
                return 0
                ;;
            2)
                echo "Keeping target file unchanged."
                return 1
                ;;
            3)
                if command -v code >/dev/null 2>&1; then
                    echo "Opening VS Code for manual merge..."
                    code --diff "$TARGET_FILE" "$SOURCE_FILE"
                    echo "Please resolve conflicts manually and save the target file."
                    echo "Press Enter when you've finished editing..."
                    read -r
                    return 0
                elif command -v vimdiff >/dev/null 2>&1; then
                    echo "Opening vimdiff for manual merge..."
                    vimdiff "$TARGET_FILE" "$SOURCE_FILE"
                    return 0
                else
                    echo "No merge tool available. Please edit manually:"
                    echo "Target: $TARGET_FILE"
                    echo "Source: $SOURCE_FILE"
                    echo "Press Enter when you've finished editing..."
                    read -r
                    return 0
                fi
                ;;
            4)
                echo "Operation aborted."
                exit 1
                ;;
            *)
                echo "Invalid choice. Please enter 1-4."
                ;;
        esac
    done
}

# Main logic
echo "Checking differences between $SOURCE_FILE and $TARGET_FILE..."

# Check if files are identical
if files_identical; then
    echo "Files are identical. No sync needed."
    exit 0
fi

# Check if target file doesn't exist
if [ ! -f "$TARGET_FILE" ]; then
    echo "Target file doesn't exist. Creating new file..."
    cp "$SOURCE_FILE" "$TARGET_FILE"
    echo "Successfully created $TARGET_FILE"
    echo "You can now commit the changes with: chezmoi cd && git add . && git commit -m 'Add Claude configuration'"
    exit 0
fi

# Check if target has uncommitted changes
if has_uncommitted_changes; then
    echo "Target file has uncommitted changes."
    if ! resolve_conflict; then
        exit 0  # User chose to keep target
    fi
else
    # Target is clean, check if we can do a simple update
    echo "Target file is clean. Showing differences:"
    show_diff
    echo ""
    printf "Update target file with source changes? [y/N]: "
    read -r answer
    case $answer in
        [Yy]*)
            cp "$SOURCE_FILE" "$TARGET_FILE"
            echo "Successfully updated $TARGET_FILE"
            ;;
        *)
            echo "Update cancelled."
            exit 0
            ;;
    esac
fi

echo "Sync completed successfully."
echo "You can now commit the changes with: chezmoi cd && git add . && git commit -m 'Update Claude configuration'"
