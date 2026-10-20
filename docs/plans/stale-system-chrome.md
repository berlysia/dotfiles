# WSL の Chrome が古いままになりうる

未着手。提案・未決。

WSL の `google-chrome-stable` は apt で入れたもので、更新は利用者が `sudo apt update && sudo apt install --only-upgrade google-chrome-stable` を実行したときだけ進む（管理者権限が要り、エージェントからは実行していない）。古いまま動いていることを知らせる仕組みが無く、エージェントのブラウザ操作は古い版で動き続けうる。気づけるのは、確認の結果に書いた版番号を利用者が見たときだけである。

## 分かっていること

- Playwright の MCP は、システムの Chrome を使う（ページの UA の `Chrome/<主版>` で版が分かる）。
- Playwright が別に持つ検証用の Chrome が `~/.cache/ms-playwright/` にある。MCP はこちらを使っていない。`playwright-core` の `chromium.launch({ executablePath })` にパスを渡せば動かせて、`file://` も開ける。
- chezmoi が Chrome を入れるのは `home/.chezmoidata/packages.yaml` の Homebrew cask（macOS）だけで、Linux の Chrome は管理外である。

## 決まっていないこと

- Linux の Chrome の更新を、`chezmoi apply` の手順に組み込むか。組み込む場合、管理者権限の扱いをどうするか。
- 古い版のまま動いていることを、apply の検証（`run_after_zz-verify-provisioning`）で知らせるか。知らせるなら、何をもって古いとするか（apt の候補との差、版の日付からの経過）。
- Playwright の MCP に、システムの Chrome ではなく検証用の Chrome を使わせるか（MCP の起動の引数で選べるかは確かめていない）。
