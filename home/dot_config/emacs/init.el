;; バックアップファイル (~) まとめる
(setq backup-directory-alist '(("." . "~/.config/emacs/backups")))

;; 自動保存ファイル (#) まとめる
(setq auto-save-file-name-transforms '((".*" "~/.config/emacs/auto-save/" t)))

;; ロックファイル (.#) を作らない
(setq create-lockfiles nil)

;; --- その他便利設定 ---

;; 起動画面を表示しない
(setq inhibit-startup-message t)

;; ビープ音を消す
(setq ring-bell-function 'ignore)

;; y/n で答えられるようにする
(fset 'yes-or-no-p 'y-or-n-p)

;; 行番号表示
(global-display-line-numbers-mode t)

;; 対応する括弧をハイライト
(show-paren-mode t)

;; 選択範囲をタイプで置換
(delete-selection-mode t)

;; クリップボード連携
(setq select-enable-clipboard t)

;; スクロールを1行ずつに
(setq scroll-conservatively 1)

;; タブをスペースに
(setq-default indent-tabs-mode nil)
(setq-default tab-width 4)

;; UTF-8 をデフォルトに
(prefer-coding-system 'utf-8)

;; 最近開いたファイルを記録
(recentf-mode t)
(setq recentf-max-saved-items 50)

;; カーソル位置を記憶
(save-place-mode t)

;; 自動リバート（外部変更を自動反映）
(global-auto-revert-mode t)