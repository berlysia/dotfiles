# WSL のデスクトップ通知で日本語が文字化けする

## 今の形（2026-10-22 に観察）

- `sendSystemNotification`（`home/dot_claude/lib/unified-audio-engine.ts`）は WSL で `wsl-notify-send.exe` に文言を引数で渡す
- Windows の通知センターでは、日本語が UTF-8 のバイトを Shift_JIS として読んだ形で出る。たとえば「エラー」は「繧ｨ繝ｩ繝ｼ」、「Claudeが許可を求めています」も同じように化ける
- ASCII だけの文言（`Claude Code: probe C …`）は正しく出る
- StopFailure の通知を足す前から、permission_prompt の通知でも同じように化けていた

## やりたいこと

通知の日本語を読める形で出す。

## 決めること

- 直す場所: wsl-notify-send に渡す前に文言の符号化を変えるか、通知の手段を別のもの（PowerShell の BurntToast など）に替えるか
- 確かめ方: 通知センターで、日本語の文言が化けずに出ること
