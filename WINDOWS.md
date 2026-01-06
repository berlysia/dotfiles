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
  - wsl2-ssh-agent: 使わない
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
```

### 併用が必要な場合

```yaml
開発: 1Password（別の鍵）
自動化: OpenSSH ssh-agent（別の鍵）
```

**鍵を分離すること。同じ鍵を両方で使わない。**

## トラブルシュート

| 症状 | 原因 | 対処 |
|------|------|------|
| `ssh-add -l` が実行ごとに変わる | Agent 複数起動 | パターン A/B に統一 |
| `git pull` が 30-60秒停止 | Agent 競合 | 上記を確認 |
| 鍵が消えたり現れたりする | 1Password の統合モード | OpenSSH ssh-agent を停止 |

```powershell
# どのプロセスが ssh-agent を使っているか確認 (Sysinternals Handle が必要)
# https://learn.microsoft.com/ja-jp/sysinternals/downloads/handle
handle.exe -a openssh-ssh-agent
```

## なぜ併用がダメなのか

1Password が OpenSSH ssh-agent と統合する場合、必要時のみ鍵を追加/削除する。
wsl2-ssh-agent 経由で WSL から接続すると、この動作が外部から見え、状態が不安定になる。
