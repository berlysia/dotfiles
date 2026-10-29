# ask-grokbot

`ask-grokbot` は、手元のコーディングエージェントから Grok Bot へ依頼を渡すコマンドです。
依頼は routine の webhook へ JSON で送り、成功すると返信ファイルの絶対パスを標準出力に出します。

`chezmoi apply` が、このコマンドを `~/.local/bin/ask-grokbot` に置きます。
`~/.local/bin` は、このリポジトリのシェル設定ですでに PATH に入っています。
送信には `curl` と、JSON を組む `jq` が要ります。

## 認証を置く

webhook の URL は `ASK_GROKBOT_WEBHOOK_URL`、`Authorization` ヘッダの値は `ASK_GROKBOT_AUTH` です。
設定画面に出る Authorization の値を、そのまま入れます。
コマンドは、その値の前に `Bearer` を付けません。
どちらかが未設定か空なら、`~/.config/ask-grokbot/env` を読みます。
このファイルはリポジトリの外にあり、コミットしません。
環境変数が既にある項目は、ファイルの値で上書きしません。

1. `mkdir -p ~/.config/ask-grokbot` を実行します。
2. `chmod 700 ~/.config/ask-grokbot` を実行します。
3. `~/.config/ask-grokbot/env` に次の形で 2 行を書き、`chmod 600` します。

```
ASK_GROKBOT_WEBHOOK_URL=https://example.invalid/webhook
ASK_GROKBOT_AUTH=Bearer ...
```

行の形は `KEY=value` です。
`#` で始まる行は読み飛ばします。
値の `$` やコマンド置換は展開しません。
行頭の `export ` と、値を囲む一組の引用符は外します。
引用符が無い値は、前後の空白を外します。

## 呼び出す

```bash
ask-grokbot "依頼の本文"
ask-grokbot -t reviewer "依頼の本文"
printf '%s\n' "依頼の本文" | ask-grokbot
ask-grokbot --wait 120 "依頼の本文"
ask-grokbot --dry-run "依頼の本文"
```

引数が無いときは、標準入力を依頼として読みます。
標準入力が端末で、引数も無いときは、待たずに終了コード 1 で終わります。
`-t` を付けると、JSON の `to` にその名前が入ります。
`-t` が無いときは、`to` を送りません。

`--wait` の秒数を省くと 120 秒待ち、返信ファイルが現れて中身が空でないとき、パスの次の行からその中身を出します。
時間内に現れなければ、終了コード 1 です。
`--dry-run` は JSON を標準出力に出し、送信しません。
認証が無くても実行できます。

## 送る JSON

- `machine` は `ASK_GROKBOT_MACHINE`。無ければ `hostname` の出力
- `agent` は `ASK_GROKBOT_AGENT`。無ければ `claude-code`
- `cwd` は実行時の `$PWD`
- `session` は `CLAUDE_CODE_SESSION_ID`。無ければ `CLAUDE_SESSION_ID`。どちらも無ければ空文字
- `request` は依頼の本文
- `reply_to` は `~/.ask-grokbot/inbox/<時刻>-<pid>.md` の絶対パス
- `to` は `-t` を付けたときだけ入る項目

WSL では `hostname` が Windows のマシン名と違うので、`ASK_GROKBOT_MACHINE` に Windows 側の名前を入れます。
送信の前に `~/.ask-grokbot/inbox/` を作り、モードを 700 にします。
返信ファイルそのものは作らず、受けた側が `reply_to` のパスへ書きます。

## 失敗したとき

URL か Authorization が無いときは、足りない変数名と `~/.config/ask-grokbot/env` を示し、終了コード 1 で終わります。
URL が `http://` か `https://` で始まらないときも、送らずに終わります。
HTTP の失敗は `curl -fsS` の終了コードのままです。
そのとき、返信パスは成功として出しません。
