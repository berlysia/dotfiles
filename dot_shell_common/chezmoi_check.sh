#!/bin/sh
# chezmoi更新チェック - シェル起動時にリモートの変更を確認
# 1時間間隔でリモートから取得し、適用待ちの変更があれば通知する

CHEZMOI_CHECK_INTERVAL=3600  # 1時間（秒）
CHEZMOI_LAST_CHECK="${XDG_CACHE_HOME:-$HOME/.cache}/chezmoi_last_check"

chezmoi_check_updates() {
  # chezmoiがインストールされているか確認
  if ! type chezmoi >/dev/null 2>&1; then
    return
  fi

  # タイムスタンプファイルの確認
  local now
  now=$(date +%s)
  local last_check=0
  if [ -f "$CHEZMOI_LAST_CHECK" ]; then
    last_check=$(cat "$CHEZMOI_LAST_CHECK" 2>/dev/null || echo 0)
  fi

  # 間隔チェック
  if [ $((now - last_check)) -lt $CHEZMOI_CHECK_INTERVAL ]; then
    return
  fi

  # タイムスタンプ更新（先に更新して重複実行を防ぐ）
  mkdir -p "$(dirname "$CHEZMOI_LAST_CHECK")"
  echo "$now" > "$CHEZMOI_LAST_CHECK"

  # 中断時にタイムスタンプを復元するtrap設定
  trap 'echo "$last_check" > "$CHEZMOI_LAST_CHECK"; trap - INT; return' INT

  # リモートから取得（認証プロンプトが出る場合があるため事前通知）
  echo "chezmoi: Checking for updates..."
  chezmoi git pull -- --quiet 2>/dev/null || true

  # trap解除
  trap - INT

  # 差分確認
  local status
  status=$(chezmoi status 2>/dev/null)
  if [ -n "$status" ]; then
    echo "💡 chezmoi: Updates available (run 'chezmoi apply' to apply)"
  fi
}

chezmoi_check_updates
