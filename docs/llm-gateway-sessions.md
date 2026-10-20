# LLM gateway セッションで Claude Code を使う

別マシンで LLM gateway 経由の Claude Code を使うには、「セットアップ」の 4 手順を行う。
LLM gateway は、Anthropic 互換の `ANTHROPIC_BASE_URL` とキーで使えるプロキシ (社内のものなど) である。
この文書では、`LLM_GATEWAY_API_KEY` と `ANTHROPIC_BASE_URL` の両方がある状態で起動した Claude Code を gateway セッションと呼ぶ (判定は「仕組み」を参照)。
gateway の URL、MCP サーバー名、`op://` 参照は公開リポジトリに置かないため、この文書では `<gateway-host>` や `example.invalid` のプレースホルダで書く。

## セットアップ

手順 1〜2 で置くローカルファイルは、どちらも社内固有の値を含むので、リポジトリには入れない。

1. `~/.env.1password.local` に 2 行を追加する。
   値は `op://` 参照で書き、平文のキーは置かない。

   ```sh
   export LLM_GATEWAY_API_KEY=op://<vault>/<item>/<field>
   export ANTHROPIC_BASE_URL=https://<gateway-host>
   ```

2. `~/.config/claude-local/gateway-mcp.json` に gateway 経由の MCP 定義を置く。

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

3. `~/.config/claude-local/gateway-mcp.json` のパーミッションを 600 にする。
4. `ope -gi claude` で起動する。

手順 2 のヘッダーには、キーを直接書かず `${LLM_GATEWAY_API_KEY}` を参照する。
この変数は、`claude()` が子プロセスに渡す 2 つの名前 (`LLM_GATEWAY_API_KEY` と `ANTHROPIC_AUTH_TOKEN`) のうち、env ファイルで持つ本来の名前である。
こう書くと、JSON とシェル設定でキーの名前が食い違わない。

JSON を置くかどうかが、そのマシンで gateway の MCP を使うかどうかの意思表示になる。
JSON が無ければ MCP の追加だけがスキップされ、キーの受け渡しは行われる。

gateway セッションだけで使う plugin は、`~/.config/claude-local/plugins/<名前>/` に plugin のディレクトリごと置く。
直下の各ディレクトリ (ディレクトリへの symlink を含む) が、名前順に `--plugin-dir` で読み込まれる。
このディレクトリは利用者本人が管理するもので、置いた plugin は検証なしでそのまま読み込まれる。

`~/.env.1password.local`、`gateway-mcp.json`、`plugins/` はこのリポジトリが管理しないファイルである。
社内固有の値を持つので、別の chezmoi source (private リポジトリ、config と state を分けたもの) が持つことがある。
その場合も、このリポジトリから見た置き場所と読み込み方は変わらない。

### 旧形式からの移行

`~/.env.1password.local` で `ANTHROPIC_AUTH_TOKEN=op://...` を直接 export していた場合は、その行を `LLM_GATEWAY_API_KEY=` の行に **置き換える**。
両方は残さない。
両方あると、`claude()` が `LLM_GATEWAY_API_KEY` の値で `ANTHROPIC_AUTH_TOKEN` を上書きするため、古い行は意味を持たないまま紛らわしく残る。

旧形式のままでも gateway への接続自体は動くが、ラッパーが gateway セッションと認識しないので MCP は付かない。
互換のための shim は用意していない。

## 仕組み

`home/dot_shell_common/functions.sh` の `claude()` 関数が `claude` コマンドを包む。
次の 2 つの環境変数が **両方** あるときだけ gateway セッションとみなす。

- **`LLM_GATEWAY_API_KEY`**：gateway のキー。`~/.env.1password.local` に置き、`ope` が 1Password から注入する
- **`ANTHROPIC_BASE_URL`**：gateway の URL

gateway セッションでは、次の 2 つを行ってから本物の `claude` を起動する。

1. キーを `ANTHROPIC_AUTH_TOKEN` として `claude` プロセスにだけ渡す (Claude Code はこの名前でキーを読む)
2. `~/.config/claude-local/gateway-mcp.json` があれば `--mcp-config=<そのパス>` を先頭に付け、gateway 経由の MCP サーバーを追加する
3. `~/.config/claude-local/plugins/` の直下にディレクトリがあれば、名前順に `--plugin-dir=<そのパス>` をさらに先頭に付ける

どちらかの環境変数が欠ければ、何もせず `command claude` に素通しする。

### 起動方法ごとの挙動

| 起動方法                                  | 挙動                                                                                      |
| ----------------------------------------- | ----------------------------------------------------------------------------------------- |
| `claude` (2 変数とも無いシェル)           | 素通し。通常の Claude.ai ログインで起動する                                               |
| `ope -gi claude`                          | `ope` が 2 変数を注入し、対話シェル経由で `claude()` が呼ばれる。gateway セッションになる |
| zsh で `ope -gl` した後の `claude`        | 読み込まれた 2 変数を `claude()` が拾い、gateway セッションになる                         |
| gateway セッション内から入れ子の `claude` | 2 変数を継承するので、親と同じく gateway + MCP になる                                     |
| 非対話の `ope -g claude`                  | 関数を通らない。下の「既知の制限とトラブルシュート」を参照                                |

## 設計理由

### `--mcp-config=` の `=` 形式と先頭配置

`--mcp-config` は可変長オプションで、`--mcp-config FILE mcp list` のように空白区切りで書くと、後続の `mcp` や `list` まで設定ファイルのパスとして飲み込まれる。
`=` 形式なら後続の引数を飲み込まない。

また、サブコマンド (`mcp list` など) はルートオプションを後置で受け付けない (`claude mcp list --mcp-config FILE` は unknown option になる)。
したがって、`=` 形式で **引数の先頭** に付けるのが、サブコマンド一覧を持たずにすべての呼び出しで通る唯一の形になる。
この挙動は Claude Code 2.1.284 で確認した。
将来ルートオプションの先頭配置が受け付けられなくなった場合は、`claude mcp list` などがエラーになって表面化する。
エラーを出さずに壊れることはない。

### プレフィックス代入によるキーの受け渡し

`ANTHROPIC_AUTH_TOKEN="$LLM_GATEWAY_API_KEY" command claude "$@"` の形は、その 1 コマンドの環境にだけ値を置く。
呼び出し元のシェルには `ANTHROPIC_AUTH_TOKEN` が残らない (zsh / bash / sh で確認済み)。
キーは本来の役割の名前 (`LLM_GATEWAY_API_KEY`) で持ち、Claude Code 向けの名前は起動時に作る値として扱う。

`claude()` は POSIX sh 記法で書かれている。
`local` が使えないため一時変数を作ると呼び出し元にリークしうるので、変数を作らずパスを 2 回書いている。

### `ANTHROPIC_BASE_URL` も条件に含める理由

キーだけがあって BASE_URL が無いシェルで `ANTHROPIC_AUTH_TOKEN` を渡すと、gateway のキーが既定の Anthropic API に Bearer として送られる。
BASE_URL も揃っているときだけ渡すことで、これを避ける。

### 関数として実装した理由

`ope -gi claude` という既存の起動習慣を保ち、zsh で `ope -gl` した後の起動や、gateway セッション内から入れ子で起動する `claude` にも同じ経路で適用するため、専用コマンドではなくシェル関数にしている。
`functions.sh` を読むのは `init.sh` で、それを読むのは zsh の全シェルと bash の login シェルなので、その範囲で関数が定義される。

## 既知の制限とトラブルシュート

### gateway セッションにならない起動経路

非対話の `ope -g claude -p ...` が認証エラーになる。
原因は、`ope -g` の非対話経路が `op run -- "$@"` でバイナリを直接実行し、`claude()` を通らないため `ANTHROPIC_AUTH_TOKEN` が渡らないことである。
対処は `ope -gi claude ...` を使うことである (`"$SHELL" -i -c` 経由で関数が使われる)。

bash の非 login 対話シェルでは、gateway セッションにならない。
原因は、`dot_bashrc` が `functions.sh` を読まないため、`claude()` が未定義なことである。
対処は zsh から起動することである。
bash 対応は既存の読み込み構造の変更になるので行っていない。

bash で `ope -gl` した後も env が残らない。
原因は、`ope -gl` の読み込みがパイプ内の `while` で行われ、bash では親シェルに変数が残らないことである (zsh は残る)。
対処は zsh を使うか、`ope -gi` を使うことである。

### `/mcp` に gateway の MCP が出ない

原因は、JSON が無いか、`LLM_GATEWAY_API_KEY` が空で認証ヘッダーが空展開されているかのどちらかである。
JSON が無い場合のスキップは、何も表示されずに行われる。
対処は、`~/.config/claude-local/gateway-mcp.json` の存在とパス、`LLM_GATEWAY_API_KEY` が設定されていることを確認することである。

`/mcp` に出るが状態が `needs-auth` のときは、その MCP サーバーが gateway のキーとは別に、利用者ごとの OAuth（外部サービスへの同意）を求めている。
`/mcp` でそのサーバーを選び、Authenticate からブラウザで同意する。
このとき gateway のキーは `Authorization` 以外のヘッダー（gateway が決めたもの）で送り、`Authorization` は Claude Code が OAuth で得たトークンを入れる欄として空けておく。
`Authorization` を設定でキーに埋めると、gateway は通るが外部サービスのトークンが無く、接続できても `tools/list` が空になる。
サーバーが OAuth を使うかは、認証なしで呼んだ 401 の `WWW-Authenticate` が指す `/.well-known/oauth-protected-resource/…` で分かる。

### gateway のキーが別のホストに送られる

原因は、`claude()` の判定 (ゲート。2 変数が両方あるかの条件) が `ANTHROPIC_BASE_URL` の **宛先** までは確かめないことである。
対処は、gateway のキーを持つシェルで BASE_URL を別ホストに変えて起動する前に、`LLM_GATEWAY_API_KEY` を unset することである。

具体例として、`claude-zai` のセッション内から起動された zsh は、gateway のキーと ZAI 側の BASE_URL を両方継承しうる。
そこで `claude` を呼ぶと gateway のキーが ZAI 側に渡る。
宛先の照合には社内 URL が要り公開リポジトリには置けないので、ゲートには入れていない。
なお `claude-zai` 自体は bash の非対話スクリプトで、`functions.sh` を読まないため `claude()` を通らない。

### 専用コマンドへの移行

非対話の `ope -g claude` や bash 環境で gateway セッションを使う必要が生じたら、関数ではなく専用コマンド (例: `claude-gateway`) に移行する。
このコマンドが `op run` による env 注入から `claude` の起動までをまとめて行う形にすれば、起動経路に依らずトークンが渡り、上の制限のうち関数が読まれるかどうかに起因するものは構造的になくなる。

## statusline

個人側の statusline は 1 つで、gateway のときも切り替えない。
gateway の残予算など gateway 用の表示は、機械ごとの層 (ADR-0038 の 2 つ目の source) が、その層の起動ラッパーから `--settings` で statusline のコマンドを差し替えて出す。

その層は `~/.config/ccstatusline/settings.json` の形 (ccstatusline の `version: 4` と `lines`) と、ccstatusline の場所 (`~/.claude/node_modules/ccstatusline/dist/ccstatusline.js`) に依存する。
これらを変えるときは、その層を先に更新してから個人側を更新する。
