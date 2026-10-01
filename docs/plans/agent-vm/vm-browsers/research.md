# Research: agent-vm でブラウザを操作する MCP を使えるようにする（Issue #195）

## 問い

agent-vm の VM では playwright / chrome-devtools / drawio の MCP が除外されており、VM の中で Web フロントエンドの動作確認ができない。これを使えるようにする方法と、ADR-0018 の隔離との釣り合いを決めるための事実を集める。

## 除外した理由（リポジトリ内の記録）

- 除外の理由は隔離ではなく「VM にブラウザも GUI も無いので、ネットワークだけでは動かない」ことだった。
  - `agent-vm/vm-claude-json.jq:1` "keep only MCP servers that work with network access alone"
  - `docs/plans/agent-vm/vm-allowlist/spec.md:10`
- 当時の spec は、Web FE の画面確認がしにくくなる懸念を記録していた（`spec.md:130-134`）。将来案として次の 2 つを挙げている。
  - (a) VM 内の headless Chromium と playwright MCP
  - (b) V8 を検証して、mac のブラウザから確認する
- 残す MCP は `agent-vm/bootstrap.sh:15` の `VM_MCP_KEEP="readability context7 excalidraw"` の 1 定数で決まる。`vm-claude-json.jq`、`vm-codex-config.awk`、自己検査（`bootstrap.sh:97-113`）がこの定数を共有する。
- MCP の定義元
  - Claude: `home/.chezmoiscripts/run_onchange_update-claude-json.sh.tmpl:20-75`。playwright と chrome-devtools は `bunx <pkg>@<ver>` を引数なしで起動する。drawio は darwin かつ `mcp.shared_mode` のとき SSE を使い、それ以外は `bunx @drawio/mcp`。
  - Codex: `home/dot_codex/.config.toml:14-16`。playwright は `npx @playwright/mcp@latest`。
- 前提: VM の mise には node / bun と `npm:@playwright/cli` が入る（`home/dot_config/mise/config.toml.tmpl`）。VM の apt にはブラウザも、その依存ライブラリも入っていない。

## 実機検証（2026-09-30、OrbStack 2.2.3、Ubuntu resolute arm64）

`orb create --isolated --isolate-network ubuntu v8probe-195` で使い捨ての machine を作り、検証後に削除した。launcher と同じ分離フラグを付けている（`--forward-ssh-agent` とマウントは付けていない。今回の検証項目には関係しない）。

### F1: host から VM の待ち受けポートへの到達（V8）

VM 内で `python3 -m http.server` を 2 つ起動し、host から curl で叩いた。

| VM 内の bind   | host `localhost:<port>` | `<machine>.orb.local:<port>` | VM の IP 直接 |
| -------------- | ----------------------- | ---------------------------- | ------------- |
| `0.0.0.0:5173` | 200                     | 200                          | 200           |
| `127.0.0.1:5174` | 200                   | 接続失敗                     | （未測定）    |

`--isolate-network` を付けても、host から VM への到達は残る。VM 内で loopback にだけ bind した dev server（vite の既定）も、mac の `localhost:<port>` から開ける。V5（既存の実測）では、逆向きの VM から host への接続は拒否されている。

### F2: VM 内の headless Chromium

- `npx playwright install --with-deps chromium` が linux arm64 で成功した。Chrome Headless Shell 153.0.8010.12。`~/.cache/ms-playwright` は 662M。
- non-root（uid 501）のまま、sandbox を無効にせずに `chromium.launch({ headless: true })` が起動した。VM 内の `127.0.0.1:5174` のスクリーンショットも撮れた。`--no-sandbox` は不要。
- `--with-deps` は apt で依存ライブラリを入れる（sudo が要る）。ADR-0018 K18 の「bootstrap が非対話で入れる」枠に収まる。

### F3: ブラウザを host に 1 部だけ置き、machine ごとに clonefile で配る

ユーザー判断で、VM ごとに 660MB を持たせる案は容量の理由で退けた。代わりに次の方式を検証した。

- host（mac）の上で `PLAYWRIGHT_HOST_PLATFORM_OVERRIDE=ubuntu24.04-arm64 npx playwright install --only-shell chromium` を実行した。linux/arm64 の Chrome Headless Shell（ELF aarch64）を 266M 取得できた。ffmpeg は 3.2M。
- `cp -c -R`（APFS clonefile）で複製した。空き容量の減少は約 200KB で、データブロックは共有される。
- 複製を `orb create --isolated --isolate-network --mount <copy>:/opt/agent-vm/browsers` でマウントした。VM 内の playwright から `executablePath` で指定すると起動し、`127.0.0.1` の dev server を開けた（sandbox 有効、non-root）。
- VM ごとにかかるのは apt の依存ライブラリだけ。`playwright install-deps chromium-headless-shell` で 31 パッケージ、Installed-Size の合計は 103MB（フォント 92MB、ライブラリ 11MB）。
  - この probe では、先に apt で入れた nodejs が fontconfig などを引き込んでいる。本番の VM（node は mise）でのライブラリの増分は、11MB より大きい可能性がある。
  - VM のルートは OrbStack が machine 間で共有する btrfs の subvolume で、`df` の差分は 0 になり使えない。容量は dpkg の Installed-Size で測った。
- フォント（92MB）も同じ host 側の共有に載せれば、VM ごとの apt はライブラリだけになる（未検証。fontconfig の設定が要る）。
- orb の `--mount` に読み取り専用の指定は無い。VM は自分の複製を書き換えられるが、複製は machine ごとなので、影響はその machine に閉じる。launcher が起動のたびに複製し直せば、改ざんは次回の起動まで持ち越されない。これは K2・K3 の staging と同じ考え方。

### F4〜F9: spec レビュー後の spike（2026-09-30、probe machine 2 台、launcher と同じ分離フラグ）

- **F4: 版と revision の対応**
  - `npm view @playwright/mcp@0.0.75 dependencies` の結果は `playwright` と `playwright-core` がどちらも `1.61.0-alpha-1778188671000` で、exact 指定だった。
  - この版で host から取得すると `chromium_headless_shell-1224`（337M。ffmpeg を含む）になった。最新版の playwright で取得したもの（1243）とは revision が違う。
- **F5: MCP 経由での動作**（apt の node ではなく bun の `bunx`）
  - playwright MCP 0.0.75
    - `--headless --browser chromium` だけでは失敗した。`PLAYWRIGHT_BROWSERS_PATH` を指定しても「Browser "chrome-for-testing" is not installed」になる。
    - `--executable-path <headless_shell>` を付けると、`browser_navigate` と `browser_take_screenshot` が成功した。`--browser` の値（chromium、chrome）は結果に影響しなかった。
  - chrome-devtools-mcp 0.25.0
    - `--headless --isolated --executablePath <headless_shell>` で `navigate_page`、`take_screenshot`、`performance_start_trace`（reload、autoStop）がすべて成功した。
  - 日本語フォントは `fc-match "sans-serif:lang=ja"` が IPAPGothic を返した。
- **F6: 固定版の `install-deps` は Ubuntu 26.04 に対応していない**
  - 固定版で `install-deps` を実行すると「Cannot install dependencies for ubuntu26.04-arm64」で失敗した。
  - 最新版は 26.04 向けに 83 パッケージ（推移的な依存と xvfb を含む）を列挙した。
- **F7: 依存の容量は mesa が支配している**
  - 83 から、フォント、xfonts、xvfb、xserver 系を除いた 64 個と、`fonts-liberation`、`fonts-ipafont-gothic` を入れた。合計は 215.8MB だった。
  - 内訳のうち `libllvm21`（130MB）と `mesa-libgallium`（48MB）は、`libgbm1` から引き込まれている。
  - headless shell が必要とする（ldd で見た）のは `libgbm.so.1` だけで、GL や mesa のドライバは要求していない。
  - mesa、GL、llvm 系を除いて入れると 48 パッケージ、35.1MB（フォント関連 17.7MB、ライブラリ 17.5MB）になった。
  - 欠ける `libgbm.so.1` は、`apt-get download libgbm1` と `dpkg-deb -x` で得た（240K。apt の署名検証を経た取得）。これを `LD_LIBRARY_PATH` で渡すと、F5 の 2 つの MCP の全操作が成功した。スクリーンショットのサイズは、全依存を入れた VM と一致した。
- **F8: 同じポートを使う 2 台の VM**
  - A と B の両方で `127.0.0.1:5300` に bind した。host の `localhost:5300` は 3 回とも A に届いた（先に bind した machine に届くとみられる）。
  - loopback に bind したポートは `<machine>.orb.local` からは届かない（F1 と同じ）。
- **F9: VM から外への到達性**
  - **VM A から VM B の IP の `0.0.0.0:5301` に 200 が返った**（応答の中身は B のもの。A は 5301 で待ち受けていない）。`--isolate-network` を付けていても、machine 間の IP 到達は遮断されていない。これは OrbStack の docs の記述（他の machine を遮断する）と食い違い、本 issue とは独立した既存の性質。
  - `probe195-b.orb.local` は A からは解決できなかった。
  - A から LAN のゲートウェイ（192.168.10.1:80）への接続は失敗した。ただしルーターが 80 番で待ち受けていないだけの可能性があり、結論は出せない。
  - インターネットには到達した（200）。

- **F10: マウント越しの相対 symlink**
  - host 側で `current -> gen-1`、`gen-*/bin/x -> ../real/f` を作り、isolated machine にマウントした。VM から `cat /opt/agent-vm/browsers/current/bin/x` を実行すると、gen-1 の中身が読めた。
  - host で `current.new -> gen-2` を作り、perl の `rename` で `current` を置き換えた。VM からは、再マウントなしで gen-2 の中身が読めた。

- **F11: 依存の一覧の確定**（2026-10-01、新しい probe machine、node は入れていない）
  - `playwright@latest`（1.63.0）の `install-deps --dry-run chromium-headless-shell` に、spec K5 の除外の正規表現をあてた結果は 42 パッケージ。
    - `at-spi2-common libasound2-data libasound2t64 libatk-bridge2.0-0t64 libatk1.0-0t64 libatspi2.0-0t64 libavahi-client3 libavahi-common-data libavahi-common3 libcairo2 libcups2t64 libdatrie1 libdrm-common libdrm2 libfreetype6 libgraphite2-3 libharfbuzz0b libice6 libnspr4 libnss3 libpango-1.0-0 libpixman-1-0 libpng16-16t64 libsm6 libthai-data libthai0 libunwind8 libxaw7 libxcb-render0 libxcomposite1 libxdamage1 libxfixes3 libxi6 libxkbcommon0 libxkbfile1 libxmu6 libxpm4 libxrandr2 libxrender1 libxres1 libxt6t64 x11-common`
  - これに `fonts-liberation fonts-ipafont-gothic` を足して `--no-install-recommends` で入れた。依存を含めて 48 パッケージ、35.1MB（フォント 17.7MB、ライブラリ 17.5MB）で、F7 と一致した。
  - `libgbm1` の Depends は `mesa-libgallium libc6 libdrm2 libexpat1`。
    - `libdrm2` は一覧に含まれる。`libexpat1` と `libc6` は基本の Ubuntu にすでに入っている。
    - 取り出した `libgbm.so.1` を `ldd` にかけると、欠けは 0。
    - deb には `libgbm.so.1`、`libgbm.so.1.0.0`、`gbm/`（backend）が入っている。置くのは `libgbm.so.1*` だけでよい。
  - `libgbm1` の候補版は `26.0.8-1ubuntu0.3`。

## ユーザーの回答（2026-10-01）

- spec の Open Question「VM で Codex を主エージェントとして使う頻度」への回答は「低い」。Codex のブラウザ MCP は本 spec の範囲に戻さない。ADR-0019 の後に必要が出たら、別 issue にする。
- F9（isolated machine 同士が IP で届く）を別 issue として起票することに OK をもらった。

## 外部の事実（ドキュメント由来）

- @playwright/mcp には `--headless`、`--isolated`、`--executable-path`、`--no-sandbox` がある。`file://` とワークスペース外のファイルへのアクセスは既定で禁止されている。https://github.com/microsoft/playwright-mcp
- chrome-devtools-mcp の公式サポートは Google Chrome と Chrome for Testing のみ。Google Chrome の linux arm64 版は無い。`--executablePath` で他の Chromium も指定できるが、動作は保証されない（未検証）。`--headless` と `--isolated` がある。https://github.com/ChromeDevTools/chrome-devtools-mcp
- @drawio/mcp は、図を URL fragment に詰めて、ユーザーのブラウザで draw.io を開く道具。headless の VM では開く先が無い。https://github.com/jgraph/drawio-mcp
- host の Chrome の CDP を VM に晒した場合
  - chrome-devtools-mcp 自身が「ブラウザ内の全データを閲覧・変更できる」と警告している。
  - Chrome 136 以降、既定プロファイルでは remote debugging が無効になった。cookie の窃取が理由（https://developer.chrome.com/blog/remote-debugging-port）。
  - F1 と V5 から、VM から host への経路は無い。晒すには、SSH トンネルなど新しい経路を作る必要がある。

## 事実から導けること

- 「VM 内の headless ブラウザ」と「人は host のブラウザで dev server を見る」を組み合わせれば、隔離に新しい経路を足さずに Web FE 開発の主要な体験が成立する。
  - F1: 人は mac のブラウザで VM 内の dev server を見られる。
  - F2: agent は VM 内でブラウザを操作できる。
- host のブラウザを VM から操作する案は、V5 で閉じている VM→host の経路を開く必要がある。開いた先はブラウザの全データに届く。

## 未確認

U1、U3、U4、U6 は F4〜F8 で解消した。

- U1: （F8 で解消）先に bind した machine に届く。
- U2: `0.0.0.0` に bind したとき、OrbStack の設定次第で LAN へ公開されるか（docs には、通常の machine では公開されると書かれている。isolated machine では未確認）。
- U3: chrome-devtools-mcp が Playwright の Chromium（`--executablePath`）で動くか。
- U4: 実際の VM（mise の node、`bunx` での起動）で playwright MCP が headless で動くか。今回の検証は apt の node と playwright ライブラリを直接使った。
- U5: （F3 で解消の見込み）VM ごとの容量は、apt の依存ライブラリだけになる。
- U6: chrome-devtools-mcp が headless shell で足りるか、full の Chromium が要るか。full も host 側に 1 部置けば、VM ごとの容量は増えない。
- U7: host 側の共有ブラウザを、いつ・誰が取得・更新するか。@playwright/mcp が要求する chromium の revision と一致させる必要がある。
