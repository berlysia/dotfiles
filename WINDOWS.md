# Windows + WSL SSH Agent セットアップ

## 絶対守るべきルール

**SSH Agent は 1 つだけ使う。併用禁止。**

## 構成パターン

### パターン A: 1Password を使う（推奨）

```yaml
用途: 開発環境
制約: GUI が必要（CI/cron 不可）

必須設定:
  - 1Password SSH Agent: 有効
  - Windows OpenSSH ssh-agent: 停止・無効化
  - wsl2-ssh-agent: 使う（必須）
```

```powershell
# Windows OpenSSH ssh-agent を無効化
Stop-Service ssh-agent
Set-Service ssh-agent -StartupType Disabled
```

### パターン B: OpenSSH ssh-agent を使う

```yaml
用途: CI/自動化/非対話環境
制約: 鍵ファイル管理が必要

必須設定:
  - 1Password SSH Agent: 完全に OFF
  - OpenSSH ssh-agent: 有効
  - wsl2-ssh-agent: 使う（必須）
```

### 併用が必要な場合

```yaml
開発: 1Password（別の鍵）
自動化: OpenSSH ssh-agent（別の鍵）
```

**鍵を分離すること。同じ鍵を両方で使わない。**

## トラブルシュート

| 症状                            | 原因                   | 対処                     |
| ------------------------------- | ---------------------- | ------------------------ |
| `ssh-add -l` が実行ごとに変わる | Agent 複数起動         | パターン A/B に統一      |
| `git pull` が 30-60秒停止       | Agent 競合             | 上記を確認               |
| 鍵が消えたり現れたりする        | 1Password の統合モード | OpenSSH ssh-agent を停止 |

```powershell
# どのプロセスが ssh-agent を使っているか確認 (Sysinternals Handle が必要)
# https://learn.microsoft.com/ja-jp/sysinternals/downloads/handle
handle.exe -a openssh-ssh-agent
```

## なぜ併用がダメなのか

1Password が OpenSSH ssh-agent と統合する場合、必要時のみ鍵を追加/削除する。
wsl2-ssh-agent 経由で WSL から接続すると、この動作が外部から見え、状態が不安定になる。

# Windows Terminal の通知（OSC 777）

WSL の許可待ちのトーストは、Claude Code 本体が OSC 777 で端末に出させる（`preferredNotifChannel` は WSL だけ `ghostty`）。OSC 777 を表示できるのは Windows Terminal Preview だけで、`allowOSC777` を有効にしたプロファイルに限る。

## 設定

Preview と設定を先に入れてから、WSL で `chezmoi apply` する。順序が逆だと、apply 後に許可待ちの通知が出ない。

1. Preview を入れる（`packages.yaml` の winget で入る）
2. Preview の `settings.json`（`%LOCALAPPDATA%\Packages\Microsoft.WindowsTerminalPreview_8wekyb3d8bbwe\LocalState\settings.json`）で、WSL のプロファイルだけに平らなキーを足す

```json
{
  "name": "Ubuntu",
  "compatibility.allowOSC777": true
}
```

PowerShell などほかのプロファイルや `defaults` には広げない。

## 出ない条件

- 前面にある今のペインでは出ない
- 前回の通知から 5 秒以内は出ない
- tmux の中では出ない
- 安定版の Windows Terminal のタブと、`allowOSC777` の無いプロファイルでは、許可待ちの通知が出ない（本体の OSC 777 は無視され、hook は `WT_SESSION` を見て自分のトーストを止める）

## 確かめ方

Preview の WSL タブ（tmux の外）で次を打ち、5 秒以内に別のウィンドウを前面にする。

```sh
sleep 5; printf '\e]777;notify;Claude Code;test\a'
```

hook 発の通知（LLM 判定、StopFailure）は、どの端末でも `wsl-notify-send` が出す。

## なりすまし

`allowOSC777` を有効にしたタブでは、端末に流れる文字列から任意のタイトルと本文のトーストを出せる。`cat` したファイル、`git log`、`curl` の出力、postinstall の出力でも起こる。トーストの内容は信じず、操作は端末で確かめる。信頼できない出力は `cat` せず、`-R`/`-r` を付けない `less` か `cat -v` で見る。
