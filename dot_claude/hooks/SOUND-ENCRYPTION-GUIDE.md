# 音声ファイル暗号化ガイド

## 手順

### 1. Age鍵ペアの準備（初回のみ）

```bash
# Age鍵ペアを生成
age-keygen > /tmp/age-key.txt

# 公開鍵と秘密鍵を確認
cat /tmp/age-key.txt

# 1Passwordに保存:
# - タイトル: chezmoi-age-key
# - public key: age1xxxxx...
# - private key: AGE-SECRET-KEY-1xxxxx...

# 一時ファイル削除
rm /tmp/age-key.txt
```

### 2. 音声ファイルの準備

まず、音声ファイルを一時的に配置:
```bash
# WSLの場合（Windowsから音声ファイルをコピー）
cp /mnt/c/Users/berlysia/Documents/Voices/ClaudeNotification.wav ~/.claude/hooks/sounds/
cp /mnt/c/Users/berlysia/Documents/Voices/ClaudeStop.wav ~/.claude/hooks/sounds/

# または既存の場所から
cp ~/Documents/Voices/*.wav ~/.claude/hooks/sounds/
```

### 3. 暗号化して追加

```bash
# chezmoi管理下に暗号化して追加
chezmoi add --encrypt ~/.claude/hooks/sounds/ClaudeNotification.wav
chezmoi add --encrypt ~/.claude/hooks/sounds/ClaudeStop.wav

# 確認
ls -la ~/.local/share/chezmoi/dot_claude/hooks/sounds/
# encrypted_ClaudeNotification.wav.age
# encrypted_ClaudeStop.wav.age
```

### 4. 元ファイルの削除

```bash
# 暗号化されたことを確認したら元ファイルを削除
rm ~/.claude/hooks/sounds/*.wav
```

### 5. 動作確認

```bash
# 設定を適用
chezmoi apply

# 音声ファイルが復号化されたか確認
ls -la ~/.claude/hooks/sounds/
# ClaudeNotification.wav (復号化されたファイル)
# ClaudeStop.wav (復号化されたファイル)
# ClaudeNotification.wav.age (暗号化ファイル)
# ClaudeStop.wav.age (暗号化ファイル)
```

### 6. コミット

```bash
cd ~/.local/share/chezmoi
git add dot_claude/hooks/sounds/*.age
git commit -m "feat: add encrypted sound files for Claude Code hooks"
```

## 新環境での使用

1. ageをインストール
2. 1Password CLIでログイン
3. `chezmoi init --apply`で自動的に復号化

## トラブルシューティング

### ファイルが見つからない
```bash
find ~ -name "*.wav" -type f 2>/dev/null | grep -i claude
```

### 暗号化エラー
```bash
# Age設定確認
chezmoi data | grep -A 5 encryption

# 1Password接続確認
op read "op://Personal/chezmoi-age-key/public key"
```