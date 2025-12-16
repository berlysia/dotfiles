#!/bin/sh
# mise更新チェック - シェル起動時に新バージョンを確認
# 24時間間隔でチェックし、新バージョンがあれば通知する

MISE_CHECK_INTERVAL=86400  # 24時間（秒）
MISE_LAST_CHECK="${XDG_CACHE_HOME:-$HOME/.cache}/mise_last_check"

mise_check_updates() {
  # miseがインストールされているか確認
  if [ ! -f "$HOME/.local/bin/mise" ]; then
    return
  fi

  # タイムスタンプファイルの確認
  local now
  now=$(date +%s)
  local last_check=0
  if [ -f "$MISE_LAST_CHECK" ]; then
    last_check=$(cat "$MISE_LAST_CHECK" 2>/dev/null || echo 0)
  fi

  # 間隔チェック
  if [ $((now - last_check)) -lt $MISE_CHECK_INTERVAL ]; then
    return
  fi

  # タイムスタンプ更新（先に更新して重複実行を防ぐ）
  mkdir -p "$(dirname "$MISE_LAST_CHECK")"
  echo "$now" > "$MISE_LAST_CHECK"

  # mise --version を実行して警告をチェック
  local version_output
  version_output=$("$HOME/.local/bin/mise" --version 2>&1)

  # "available"が含まれていれば新バージョンがある
  if echo "$version_output" | grep -q "available"; then
    echo "💡 mise: New version available (run 'mise self-update' to update)"
  fi
}

mise_check_updates
