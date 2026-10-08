# WSL の Chrome が古いままになっている

未着手。提案・未決。

`visual-eli` の three.js をハッシュで検証する作業（2026-10-08）の途中で、利用者の指摘（「138 は chrome が古すぎないか？」）から見つかった。その作業では扱わないと決めた。

## 分かっていること

- WSL の `google-chrome-stable` は 138.0.7204.49 である（`dpkg -s google-chrome-stable`、`/opt/google/chrome/chrome` の日付は 2025-06-24）。
- apt の候補は 155.0.8059.39 である（`apt-cache policy google-chrome-stable`、2026-10-08）。配布元の一覧（`/etc/apt/sources.list.d/google-chrome.list`）は入っていて、更新が実行されていないだけである。
- Playwright の MCP（`@playwright/mcp@0.0.82`）は、このシステムの Chrome を使う。ページの UA は `Chrome/138.0.0.0` だった。エージェントのブラウザ操作は、1 年以上前の版で動いている。
- Playwright が別に持つ検証用の Chrome は 153.0.8010.12 である（`~/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome`）。MCP はこちらを使っていない。
- Windows 側は Chrome 155、Edge 154 である。
- `home/.chezmoidata/packages.yaml` の 43〜44 行に `google-chrome` の記載がある。どの OS 向けかは確かめていない。

## 更新のしかた

```
sudo apt update && sudo apt install --only-upgrade google-chrome-stable
```

管理者権限が要るので、エージェントからは実行していない。

## 決まっていないこと

- Linux の Chrome の更新を、`chezmoi apply` の手順に組み込むか。組み込む場合、管理者権限の扱いをどうするか。
- Playwright の MCP に、システムの Chrome ではなく検証用の Chrome を使わせるか（MCP の起動の引数で選べるかは確かめていない）。
- 古い版のまま動いていることを、apply の検証（`run_after_zz-verify-provisioning`）で知らせるか。
