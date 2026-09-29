# LLM gateway セッションで Claude Code を使う

社内などの LLM gateway (Anthropic 互換の `ANTHROPIC_BASE_URL` とキーで使えるプロキシ) 経由で Claude Code を起動するための仕組みと、その設計理由をまとめる。gateway の URL・MCP サーバー名・`op://` 参照は公開リポジトリに置かないため、この文書では `<gateway-host>` や `example.invalid` のプレースホルダで書く。

## 仕組み

`home/dot_shell_common/functions.sh` の `claude()` 関数が `claude` コマンドを包む。次の 2 つの環境変数が **両方** あるときだけ gateway セッションとみなす。

- `LLM_GATEWAY_API_KEY`: gateway のキー。`~/.env.1password.local` に置き、`ope` が 1Password から注入する
- `ANTHROPIC_BASE_URL`: gateway の URL

gateway セッションでは、次の 2 つを行ってから本物の `claude` を起動する。

1. キーを `ANTHROPIC_AUTH_TOKEN` として `claude` プロセスにだけ渡す (Claude Code はこの名前でキーを読む)
2. `~/.config/claude-local/gateway-mcp.json` があれば `--mcp-config=<そのパス>` を先頭に付け、gateway 経由の MCP サーバーを追加する

どちらかの環境変数が欠ければ、何もせず `command claude` に素通しする。

### 起動方法ごとの挙動

| 起動方法                                  | 挙動                                                                                      |
| ----------------------------------------- | ----------------------------------------------------------------------------------------- |
| `claude` (2 変数とも無いシェル)           | 素通し。通常の Claude.ai ログインで起動する                                               |
| `ope -gi claude`                          | `ope` が 2 変数を注入し、対話シェル経由で `claude()` が呼ばれる。gateway セッションになる |
| zsh で `ope -gl` した後の `claude`        | 読み込まれた 2 変数を `claude()` が拾い、gateway セッションになる                         |
| gateway セッション内から入れ子の `claude` | 2 変数を継承するので、親と同じく gateway + MCP になる                                     |
| 非対話の `ope -g claude`                  | 関数を通らない。下の「既知の制限」を参照                                                  |

## セットアップ

別マシンで再現するには、ローカルファイルを 2 つ置く。どちらも社内固有の値を含むので、リポジトリには入れない。

1. `~/.env.1password.local` に 2 行を追加する。値は `op://` 参照で書き、平文のキーは置かない

   ```sh
   export LLM_GATEWAY_API_KEY=op://<vault>/<item>/<field>
   export ANTHROPIC_BASE_URL=https://<gateway-host>
   ```

2. `~/.config/claude-local/gateway-mcp.json` に gateway 経由の MCP 定義を置く。パーミッションは 600 にする

   ```json
   {
     "mcpServers": {
       "example_server": {
         "type": "http",
         "url": "https://gateway.example.invalid/example/mcp",
         "headers": {
           "Authorization": "Bearer ${LLM_GATEWAY_API_KEY}"
         }
       }
     }
   }
   ```

   ヘッダーはキーを直接書かず、`${LLM_GATEWAY_API_KEY}` を参照する。この変数は `claude()` が子プロセスに渡す 2 つの名前 (`LLM_GATEWAY_API_KEY` と `ANTHROPIC_AUTH_TOKEN`) のうち、env ファイルで持つ本来の名前の方で、JSON とシェル設定でキーの名前が食い違わない。

JSON を置くかどうかが、そのマシンで gateway の MCP を使うかどうかの意思表示になる。JSON が無ければ MCP の追加だけがスキップされ、キーの受け渡しは行われる。

その後 `ope -gi claude` で起動する。

### 旧形式からの移行

`~/.env.1password.local` で `ANTHROPIC_AUTH_TOKEN=op://...` を直接 export していた場合は、その行を `LLM_GATEWAY_API_KEY=` の行に **置き換える**。両方は残さない。両方あると、`claude()` が `LLM_GATEWAY_API_KEY` の値で `ANTHROPIC_AUTH_TOKEN` を上書きするため、古い行は意味を持たないまま紛らわしく残る。

旧形式のままでも gateway への接続自体は動くが、ラッパーが gateway セッションと認識しないので MCP は付かない。互換のための shim は用意していない。

## 設計理由

### `--mcp-config=` の `=` 形式と先頭配置

`--mcp-config` は可変長オプションで、`--mcp-config FILE mcp list` のように空白区切りで書くと、後続の `mcp` や `list` まで設定ファイルのパスとして飲み込まれる。`=` 形式なら後続の引数を飲み込まない。

また、サブコマンド (`mcp list` など) はルートオプションを後置で受け付けない (`claude mcp list --mcp-config FILE` は unknown option になる)。したがって、`=` 形式で **引数の先頭** に付けるのが、サブコマンド一覧を持たずにすべての呼び出しで通る唯一の形になる。この挙動は Claude Code 2.1.284 で確認した。将来ルートオプションの先頭配置が受け付けられなくなった場合は、`claude mcp list` などがエラーになって表面化し、黙って壊れることはない。

### キーはプレフィックス代入で渡す

`ANTHROPIC_AUTH_TOKEN="$LLM_GATEWAY_API_KEY" command claude "$@"` の形は、その 1 コマンドの環境にだけ値を置く。呼び出し元のシェルには `ANTHROPIC_AUTH_TOKEN` が残らない (zsh / bash / sh で確認済み)。キーは本来の役割の名前 (`LLM_GATEWAY_API_KEY`) で持ち、Claude Code 向けの名前は起動時に作る値として扱う。

`claude()` は POSIX sh 記法で書かれている。`local` が使えないため一時変数を作ると呼び出し元にリークしうるので、変数を作らずパスを 2 回書いている。

### `ANTHROPIC_BASE_URL` も条件に含める理由

キーだけがあって BASE_URL が無いシェルで `ANTHROPIC_AUTH_TOKEN` を渡すと、gateway のキーが既定の Anthropic API に Bearer として送られてしまう。BASE_URL も揃っているときだけ渡すことで、これを避ける。この条件は statusline が gateway セッションを判定する条件 (BASE_URL と認証トークンの組) とも整合する。

### 関数として実装した理由

`ope -gi claude` という既存の起動習慣を保ち、zsh で `ope -gl` した後の起動や、gateway セッション内から入れ子で起動する `claude` にも同じ経路で効かせるため、専用コマンドではなくシェル関数にしている。`functions.sh` を読むのは `init.sh` で、それを読むのは zsh の全シェルと bash の login シェルなので、その範囲で関数が定義される。

## 既知の制限とトラブルシュート

| 症状 / 状況                                                                                  | 原因                                                                                                                         | 対処                                                                                                             |
| -------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| 非対話の `ope -g claude -p ...` が認証エラーになる。statusline も gateway 用の表示にならない | `ope -g` の非対話経路は `op run -- "$@"` でバイナリを直接実行し、`claude()` を通らないため `ANTHROPIC_AUTH_TOKEN` が渡らない | `ope -gi claude ...` を使う (`"$SHELL" -i -c` 経由で関数が効く)                                                  |
| bash の非 login 対話シェルで gateway セッションにならない                                    | `dot_bashrc` は `functions.sh` を読まないため、`claude()` が未定義                                                           | zsh から起動する。bash 対応は既存の読み込み構造の変更になるので行っていない                                      |
| bash で `ope -gl` した後も env が残らない                                                    | `ope -gl` の読み込みがパイプ内の `while` で行われ、bash では親シェルに変数が残らない (zsh は残る)                            | zsh を使うか、`ope -gi` を使う                                                                                   |
| `/mcp` に gateway の MCP が出ない                                                            | JSON が無い、または `LLM_GATEWAY_API_KEY` が空で認証ヘッダーが空展開されている。JSON が無い場合のスキップは黙って行われる    | `~/.config/claude-local/gateway-mcp.json` の存在とパス、`LLM_GATEWAY_API_KEY` が設定されていることを確認する     |
| gateway のキーが別のホストに送られる                                                         | ゲートは `ANTHROPIC_BASE_URL` の **宛先** までは確かめない                                                                   | gateway のキーを持つシェルで BASE_URL を別ホストに変えて起動するときは、先に `LLM_GATEWAY_API_KEY` を unset する |

最後の行の具体例として、`claude-zai` のセッション内から起動された zsh は、gateway のキーと ZAI 側の BASE_URL を両方継承しうる。そこで `claude` を呼ぶと gateway のキーが ZAI 側に渡る。宛先の照合には社内 URL が要り公開リポジトリには置けないので、ゲートには入れていない。なお `claude-zai` 自体は bash の非対話スクリプトで、`functions.sh` を読まないため `claude()` を通らない。

### 専用コマンドへの移行

非対話の `ope -g claude` や bash 環境で gateway セッションを使う必要が生じたら、関数ではなく専用コマンド (例: `claude-gateway`) に移行する。このコマンドが `op run` による env 注入から `claude` の起動までをまとめて行う形にすれば、起動経路に依らずトークンが渡り、上の制限のうち関数が読まれるかどうかに起因するものは構造的になくなる。

## statusline

gateway セッションでは `${ANTHROPIC_BASE_URL:+${ANTHROPIC_AUTH_TOKEN:+...}}` の条件で gateway 用の設定 `settings.gateway.json` が選ばれる。この設定は、Claude.ai ログインでしか意味を持たない利用量ウィジェット (リセットタイマー、セッション・週次の使用量) を隠す。

予算ウィジェット `home/dot_config/ccstatusline/executable_litellm-budget.sh` は、gateway が LiteLLM の場合にだけ効く。`$ANTHROPIC_BASE_URL/user/info` を叩いて LiteLLM の応答形からキーの残り予算を読むため、LiteLLM 以外の gateway では何も表示されない。
