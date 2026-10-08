# WSL の Chrome が古いままになっていた

未着手。提案・未決。

`visual-eli` の three.js をハッシュで検証する作業（2026-10-08）の途中で、利用者の指摘（「138 は chrome が古すぎないか？」）から見つかった。古い版そのものは、利用者が同じ日に更新して解消した。残っているのは、また古くなることを防ぐかどうかである。

## 起きていたこと

- WSL の `google-chrome-stable` は 138.0.7204.49 だった（`/opt/google/chrome/chrome` の日付は 2025-06-24）。apt の候補は 155.0.8059.39 で、配布元の一覧（`/etc/apt/sources.list.d/google-chrome.list`）は入っていた。更新が 1 年以上実行されていなかった。
- Playwright の MCP（`@playwright/mcp@0.0.82`）は、このシステムの Chrome を使う。ページの UA は `Chrome/138.0.0.0` だった。エージェントのブラウザ操作は、その間ずっと古い版で動いていた。
- 利用者が `google-chrome-stable` を 155.0.8059.39 に更新した（2026-10-08。`dpkg -s google-chrome-stable` で確かめた）。

## 分かっていること

- 更新のコマンドは `sudo apt update && sudo apt install --only-upgrade google-chrome-stable` で、管理者権限が要る。エージェントからは実行していない。
- Playwright が別に持つ検証用の Chrome は 153.0.8010.12 である（`~/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome`）。MCP はこちらを使っていない。`playwright-core` の `chromium.launch({ executablePath })` にパスを渡せば動かせて、`file://` も開ける。
- `home/.chezmoidata/packages.yaml` の 43〜44 行に `google-chrome` の記載がある。どの OS 向けかは確かめていない。
- 古い版で動いていることを知らせる仕組みは無かった。気づいたのは、確認の結果に書いた版番号を利用者が見たときである。

## 決まっていないこと

- Linux の Chrome の更新を、`chezmoi apply` の手順に組み込むか。組み込む場合、管理者権限の扱いをどうするか。
- 古い版のまま動いていることを、apply の検証（`run_after_zz-verify-provisioning`）で知らせるか。知らせるなら、何をもって古いとするか（apt の候補との差、版の日付からの経過）。
- Playwright の MCP に、システムの Chrome ではなく検証用の Chrome を使わせるか（MCP の起動の引数で選べるかは確かめていない）。
