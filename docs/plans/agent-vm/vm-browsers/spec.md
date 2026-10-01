# Spec: agent-vm でブラウザを操作する MCP を使えるようにする（Issue #195）

> 注記（記録時）: ADR の節名と日付は、実装時に「K23〜K28、2026-10-01」に確定した。plan-2 は apt の update を `install_browser_deps` の中で行う（spec K5 の記述を上書き）。本文は承認時の hash を保つため書き換えていない。

調査: `research.md`（同ディレクトリ）。F1〜F9 は実機（OrbStack 2.2.3、Ubuntu resolute arm64、launcher と同じ分離フラグの probe machine）での実測。F5 では、本 spec の構成どおりに 2 つの MCP が VM 内で動くことを確認している。

## Goal

agent-vm の VM の中で、Claude Code から playwright MCP と chrome-devtools MCP を使えるようにする。Web フロントエンドの動作確認を、VM を離れずに行えるようにする。

制約は次の 2 つ。

- ADR-0018 の隔離（VM から host への経路を持たない、machine 間で書き込みを共有しない）を弱めない。
- VM ごとの容量増を、dpkg の Installed-Size の合計で 40MB 以下にする（F7 の実測は 35.1MB）。

## Experience Delta

- 変更前
  - VM の Claude には playwright も chrome-devtools も無い。
  - dev server の画面確認をするには、VM の外（host の claude）に移る必要がある。
- 変更後
  - VM の Claude が、VM 内の dev server を headless ブラウザで操作し、スクリーンショット、DOM のスナップショット、パフォーマンストレースを取れる（F5）。日本語のページも描ける（F5 の fontconfig）。
  - 人は mac のブラウザで `localhost:<port>` を開き、同じ dev server を見られる（F1）。
    - 別の VM が同じポートを先に使っていると、`localhost` はそちらに届く（F8）。その場合はポートを変える。
    - この振る舞いは、今回 `docs/agent-vm.md` に初めて書く。

## Architecture

```
host (mac)                                              isolated machine (VM)
──────────────────────────────────────                  ─────────────────────────────────────────────
agent-vm fetch-browsers  ◀── run_after_ (darwin, 毎 apply, 冪等)
  package.json の @playwright/mcp 版 → playwright exact 版 → linux-arm64 headless shell
  → browser-store/<id>/ (0700, 1 部だけ, bin/headless_shell は固定の相対 symlink)
                                   │ cp -c（APFS clonefile。実データは共有）
launcher: ensure_browsers ─────────▼ （ロック内。host 側の記録で id の変化を判定）
            browsers/<machine>/gen-*/  + current → gen-*  ──mount──▶ /opt/agent-vm/browsers/current/bin/headless_shell
                                                                                   ▲
bootstrap.sh（VM 内、既存の K19 フィルタの後）──────────────────────────────────────────┘
  - apt: 依存ライブラリ（mesa を除く）+ フォント 2 種
  - libgbm.so.1 だけを apt-get download + dpkg-deb -x で VM 専用ディレクトリに置く
  - vm-claude-browser.jq: ~/.claude.json の 2 エントリに固定パスの引数と LD_LIBRARY_PATH を与える

人: mac のブラウザ → localhost:<port> → (OrbStack の転送) → VM 内の dev server   … F1、既存の経路
```

VM から host へ向かう通信経路は増えない。host の新しい要素は次の 2 つ。どちらも host 側で完結し、VM はその結果をマウント越しに読むだけ。

- ブラウザを取得するサブコマンド
- clonefile で複製するステップ

VM の設定が参照するのは固定パス（`/opt/agent-vm/browsers/current/...`）だけ。ブラウザの版が上がっても、VM の再 bootstrap は要らない。

## Alternative Approaches (Greenfield View)

### 差分最小案 (Incremental)

- bootstrap が VM ごとに `playwright install --with-deps chromium` を実行し、`VM_MCP_KEEP` に 2 つの MCP を足す。
- 変更は `bootstrap.sh` 1 ファイルで済む。
- ただし VM ごとに約 660MB（ブラウザ）と約 103MB（依存）を持つ（F2、F3 の実測）。ユーザー判断により容量の理由で却下した。

### 白紙設計案 (Greenfield)

- 「agent は隔離された場所でブラウザを操作し、人は自分の端末から結果を見る」を、ゼロから組むと次の形になる。
  - ブラウザの実行はサンドボックス側に置く。
  - ブラウザの配布物は、サンドボックスの外にある 1 つの不変ストアから配る。
  - 閲覧は、host からサンドボックスへの一方向の転送で行う。
- 起源: 隔離環境でブラウザを使う例（Playwright の公式 Docker イメージ、devcontainer）は、どれも「実行は隔離側、閲覧はポート転送」の形を取っている。サンドボックス側からホストのブラウザを操作する形（CDP の公開）は、ブラウザの全データを境界の外に出す（chrome-devtools-mcp の README、Chrome 136 で remote debugging を制限した理由）。
- 容量の面では、不変ストアをサンドボックス間で共有するのが白紙での自然な選択になる。ただし OrbStack には読み取り専用マウントが無い（`orb create --help`）。そのため共有ストアをそのまま渡すと、1 つの VM がストアを書き換え、他の VM がそれを実行する経路になる（ADR-0018 が共有 staging を却下した理由と同じ）。

### 採用案と理由

白紙設計案を採用し、「共有ストア」を「ストアから machine ごとに clonefile で作る複製」に置き換える。

根拠は次のとおり。

- 容量
  - F3 の実測で、clonefile の複製にかかったのは約 200KB。
  - VM ごとの増分は apt の依存だけで、mesa を除けば 35.1MB（F7）。差分最小案（約 660MB と 216MB）より 1 桁以上小さい。
- 隔離
  - 複製は machine ごとに分かれ、書き込みはその machine に閉じる。
  - ADR-0018「却下した代替案: 共有 staging」と同じ理由で、共有ストアを直接マウントする案は取らない。
- 人の閲覧
  - 経路を新設しない。F1 で、`--isolate-network` の下でも host から VM への `localhost` 転送が使えることを確認済み。
- 却下した代替案
  - **host のブラウザを CDP で操作する**: V5 で閉じている VM から host への経路を新設することになる。さらに、その先がブラウザの全データ（cookie や `file://` の読み取り）に届く。
  - **依存を mesa ごと apt で入れる**: 216MB（F7）で、ユーザーが 660MB を退けた理由（容量）に抵触する。headless shell が要るのは `libgbm.so.1` だけなので、それだけを取り出す。
  - **取得物のハッシュを repo に固定する**: 検討したが採らない。host はすでに `bunx @playwright/mcp@<ver>` などで、npm の固定版を内容ハッシュなしに実行している（`home/.chezmoiscripts/run_onchange_update-claude-json.sh.tmpl:56-71`）。ブラウザの取得元のうち、playwright のパッケージは npm で、既存と同じ根になる。一方、ブラウザ本体は `cdn.playwright.dev` から来るので、別の根になる。ハッシュを repo に固定すると、Renovate が版を上げるたびに mac で手作業が要り、エルゴノミクス（支配軸）を下げる。
    - 代わりに TOFU を採る。取得した直後に `store_hash`（K3 で定義）を `.meta` に記録し、複製の前に照合する（K2、K3）。取得した後のストアの改変は、これで検出できる。
    - さらに、取得したブラウザが実行されるのは host ではなく isolated machine の中なので、被害範囲は host で npm を実行する場合より小さい。
    - K2 の ELF aarch64 判定と版の exact 検査は、取り違え（別のアーキテクチャ、範囲指定の版）を防ぐためのもの。CDN の侵害は防がない。これは既存の信頼の根と同水準のリスクとして受け入れる。

## Key Decisions

- **K1: ブラウザは VM の中で headless で動かす。host のブラウザは操作させない。**
  - 人の閲覧は、既存の host→VM の `localhost` 転送で行う。VM から host への経路は作らない。
  - 参照: `docs/agent-vm.md:141`（V5: VM から host への接続は拒否される）
  - 参照: `research.md` F1（host の `localhost:5174` から、VM 内で `127.0.0.1` に bind したサーバーに 200 が返る）
  - 参照: `home/dot_local/bin/executable_agent-vm:155-160`（`--isolated --isolate-network` の固定）

- **K2: ブラウザ本体は host の不変ストアに 1 部だけ置く。取得は launcher のサブコマンド `agent-vm fetch-browsers` が行い、darwin 専用の `run_after_` script が毎 apply で呼ぶ。**
  - 置き場所
    - 取得のロジックは launcher に置く。状態ディレクトリ（`$AGENT_VM_STATE_DIR`）のレイアウトを知るのは launcher だけにするため。
    - chezmoi script は、working tree を渡して呼ぶだけの薄いラッパにする。
    - `run_onchange_` ではなく `run_after_` にする。失敗した取得が同じキーのまま再試行されない問題を避けるため。
  - ストアのキー
    - ストアのキー（id）は、`package.json` の `@playwright/mcp` の版だけで決める。形式は `mcp-<版>`（例: `mcp-0.0.75`）。
    - 冪等の判定はネットワークなしでできる。`browser-store/mcp-<版>` があれば、何もせずに終わる。`npm view` と取得が走るのは、版が変わったときだけ。
    - `agent-vm fetch-browsers --force` は、ストアがあっても取り直す。ストアが壊れたときや改変されたとき（K3 の TOFU の不一致）の回復手順は、こちらを案内する。
    - ストアの中の `.meta` に、`mcp_version`、`playwright_version`、`revision`、取得時の `sha256`（`store_hash` の値。`v2:` の接頭辞を含む。K3 で定義）を書く。
    - launcher（K3）も同じ関数で要求 id を決める。ストアに要求 id が無い場合（旧版しか無い場合を含む）は、K3 の「ストアが無い」と同じ経路で扱う。
  - ストアのロック
    - `browser-store.lock` を、acquire_lock と同じ `flock(2)` の流儀で使う。fd は 8。
    - fetch-browsers は、公開と旧版の削除をこのロックの中で行う。
    - K3 の `ensure_browsers` は、id の決定と複製をこのロックの中で行う。
    - ロックの順序は、machine のロック（fd 9）→ ストアのロック（fd 8）に固定する。逆順は取らない。fetch-browsers は machine のロックを取らないので、循環しない。
  - 手順（ロックの外で取得し、ロックの中で公開する）
    1. working tree の `package.json` から `@playwright/mcp` の版を読む。
    2. `npm view @playwright/mcp@<ver> dependencies --json` の `playwright` の値が exact の版（範囲指定の記号 `^ ~ > < * x |` や空白を含まない）であることを確かめる。範囲指定なら、原因（「@playwright/mcp が playwright の版を範囲指定にした」）を添えて失敗する。
    3. `build/` の下で、`bunx playwright@<exact> install --only-shell chromium` を実行する（F4 で、この bunx の形で取得できたことを確認済み）。
       - cwd は build dir にする。
       - `env -i` で環境を最小にし、明示した許可リストの変数だけを渡す。
         - 許可するのは `PATH`、`HOME`、`USER`、`TMPDIR`、`MISE_*`、`XDG_*`、プロキシと CA（`HTTP(S)_PROXY`、`NO_PROXY`、`SSL_CERT_FILE`、`NODE_EXTRA_CA_CERTS`）。
         - `PLAYWRIGHT_*` は引き継がず（`PLAYWRIGHT_DOWNLOAD_HOST` などの上書きを防ぐ）、次の 2 つだけを設定する。
         - `PLAYWRIGHT_HOST_PLATFORM_OVERRIDE=ubuntu24.04-arm64`
         - `PLAYWRIGHT_BROWSERS_PATH=<build dir>`
    4. 取り出した `chrome-linux/headless_shell` が ELF aarch64（`file` の判定）であることを確かめる。
    5. 固定の相対 symlink `bin/headless_shell` → `../chromium_headless_shell-<rev>/chrome-linux/headless_shell` を作る。
    6. `.meta` を書く。
    7. ストアのロックを取り、`browser-store/mcp-<版>` に `rename(2)` で公開する。
       - `--force` のときに同じ id がすでにある場合は、まず既存のストアを `build/` の下へ `rename(2)` で退避する。その後に新しいものを公開し、退避したものを消す。`build/` は host 専用。
    8. ほかの `browser-store/mcp-*` を消す。ストアは最新の 1 つだけ持つ。複製済みの machine 側は clonefile なので、元を消してもデータは残る。
  - `browser-store/` は 0700 にする。どの machine にもマウントしない。host はストアの中身を、`file` の判定と `store_hash` 以外の方法で読んだり実行したりしない。
  - 版と revision の対応
    - @playwright/mcp は playwright を exact で固定している（0.0.75 → `1.61.0-alpha-1778188671000`、F4）。
    - そのため、MCP の版から取得すべき revision が一意に決まる（0.0.75 → 1224。最新版の 1243 とは違う）。
  - chezmoi script との契約
    - script は、working tree を引数にして `agent-vm fetch-browsers --from-apply <working tree>` を呼ぶ。
    - fetch-browsers は `check_health`（OrbStack の確認）を通らない。取得に orb は要らない。
    - PATH の前提: script は mise の shims（`$HOME/.local/share/mise/shims`）を PATH に足してから呼ぶ。`bunx`、`npm` は mise が入れる。`file` は macOS の標準。
    - 終了コード: 0 は成功または取得不要、1 は失敗。script は 1 のとき警告を出して 0 で終わる。apply 全体は止めない。
  - 失敗の記録
    - 失敗したら `browser-store/.last-failure` に、id と理由を 1 行で書く。
    - 同じ id の失敗が続くときは、apply の警告を「前回と同じ理由で失敗中: <理由>。回復: agent-vm fetch-browsers」の 1 行に縮める。R3（override の廃止）のような恒常的な失敗でも、警告が apply の出力を埋めない。
    - 成功したら `.last-failure` を消す。
  - 参照: `package.json:35`（`"@playwright/mcp": "0.0.75"`）
  - 参照: `home/.chezmoiscripts/run_onchange_update-claude-json.sh.tmpl:56-71`（版は package.json から読む既存の流儀）
  - 参照: `home/.chezmoiignore:34-37`（agent-vm の host 側ファイルは darwin 専用、K11）
  - 参照: `research.md` F3、F4

- **K3: machine ごとの複製は launcher が APFS clonefile で作り、専用のマウントで固定パスに見せる。**
  - `ensure_browsers` の置き場所
    - `prepare_machine` のロック区間の中、`ensure_machine` の直後、`maybe_bootstrap` の直前に置く。
      - 中身は後から入れてよい。F10 で、マウントの中の変化は再マウントなしで VM から見えることを確認している。
      - bootstrap より前に置くので、初回の bootstrap の時点で `current` はすでにある。
    - ディレクトリの作成は `ensure_machine` が受け持つ。`orb list` が成功し、machine が無いと確かめられたときだけ、`orb create` の前に次の順で行う。`orb list` 自体が失敗したときは、印を書かずに既存どおり失敗させる。
      1. `mkdir -p browsers/<m> browser-records`
         - 失敗すると `set -e` で起動全体が止まる。これは既存の staging や outbox の `mkdir -p` と同じ扱いで、「ブラウザだけ省略」の方針の対象外とする。
      2. 中身の無い印 `browser-records/<m>.mount` を `: >` で作る（何度実行しても同じ結果になる）。
      3. 残っている `browser-records/<m>.id` を消す。新しい machine では、必ず作り直しに入るようにするため。launcher の外で `orb delete` した machine を作り直す場合に、旧 machine の記録が残っていても、これで収束する。
      4. `orb create`（マウント付き）
      - 印を `orb create` の前に書くのは、マウント付きで作る意図を記録するため。`orb create` が、machine を作った後に非 0 を返したり中断されたりしても、印は残る。`ensure_machine` は既存の machine では早期に return するので（`executable_agent-vm:152`）、後から書く方式ではこの場合に印が永久に欠ける。`orb create` が machine を作らずに失敗した場合は、次の起動で作り直すときに同じ印を使う。
    - `ensure_browsers` は、`.mount` が無ければ何もしない。K3 より前に作られた machine が、これに当たる。こうした machine は、bootstrap 側の `test -d` で除外され、K6 の警告が出る。
    - `ensure_browsers` は失敗しない関数にする。
      - どの経路でも、警告してブラウザだけ省略し、0 を返す。
      - `prepare_machine` は `set -e` を前提にしている。`|| true` で呼ぶと関数の中の `set -e` が無効になるので、そうはしない。各ステップの戻り値を明示的に調べて分岐する。
      - fd 8 を閉じる処理も、同じ出口にまとめる。
    - 子プロセスには、既存の流儀どおり `9>&-` を付ける。
  - 判定は host 側の記録で行う
    - 記録は、`machines/` の外にある、キーごとに分けた 2 つのファイル。部分更新やマージをしないので、全置換で書いても他のキーを消さない。
      - `browser-records/<m>.mount`: 中身の無い印。`ensure_machine` だけが書く。
      - `browser-records/<m>.id`: 公開済みの id を 1 行で持つ。`ensure_browsers` だけが、一時ファイル `browser-records/<m>.id.tmp.XXXXXX`（`mktemp`）と `rename` で全置換する。
      - どちらも machine のロックの中でだけ読み書きする。読み取りは、パスを受け取る小さな関数で行う。`read_meta_field` は `meta_path` に固定されているので使わない。
      - `machines/` の中に置かない理由: `*.lock` 以外をすべてメタとして列挙する既存の処理（`known_repo_containing_cwd`、`machine_rows`、`cmd_rm`。`executable_agent-vm:603-606`、`:724-727`、`:764-765`）が、machine として拾ってしまう。`list` に幽霊の行が出て、`gc` が `orb delete` の対象にする。
      - メタと同じファイルにしない理由: `write_machine_meta` は、起動のたびにロックの外でメタファイルを全置換する（`executable_agent-vm:53-57`、`:560`）。同じファイルに書くと、記録が毎回消えてしまう。
    - `ensure_browsers` の判定。上から順に評価し、最初に当たった行の動作をとる。

      | 順 | 条件 | 動作 |
      | --- | --- | --- |
      | 1 | `.mount` が無い | 何もしない |
      | 2 | `.id` が要求 id と一致し、`browsers/<m>/current` がある（lstat） | 何もしない（ストアが無くなっていても、複製はそのまま使える） |
      | 3 | ストアに要求 id が無い | 省略し、警告する |
      | 4 | 上のどれにも当たらない（`.id` の不一致、`.id` が無い、`current` が無い） | 作り直す（手順 1〜4） |
      - 別ファイルは、ロックの中でだけ読み書きする。
    - マウントの中身（VM が書き換えられる）は、判定に使わない。
      - 例外は 1 つ。host は `browsers/<m>/current` を lstat し、名前が無ければ、記録の id が同じでも作り直す。
      - 読むのは存在の有無だけで、中身もリンク先も解釈しない。
      - これで、VM が `current` を消した場合や、`forget_machine` と起動が並行した場合も、次の起動で収束する。
  - 記録の id と要求 id（K2）が違うとき（または記録が無いとき）の手順。ストアのロックの中で行う。
    1. `browser-store/<id>` の `store_hash`（下で定義）が `.meta` の `sha256` と一致することを確かめる（TOFU）。一致しなければ、警告を出してブラウザだけ省略する。記録も書かない。これは作り直すとき（判定の 4）にだけ走る。そのうえで `build/` に `cp -c -R` で複製する。
       - clonefile できなければ、警告を出してブラウザだけ省略し、起動は続ける。通常のコピーには落とさない（machine ごとに約 337MB になるため）。記録も書かない。
    2. `browsers/<m>/` の中に、`gen-<id>-<乱数>` として公開する。
       - 名前は `mktemp -u` で、まだ存在しない名前だけを取る。
       - 公開には、既存の `build_staging` と同じ `perl -e 'rename(...)'`（`rename(2)` をそのまま呼ぶ）を使う。
       - `mv` は使わない。macOS の `mv` は、移動先がディレクトリ（symlink 越しも含む）だと、置き換えずにその中へ入れてしまう。
       - VM がその名前を先に作っていた場合の挙動は、中身による。空ディレクトリなら rename はそれを置き換え（無害）、空でないものなら失敗する。失敗したときは、警告してブラウザだけ省略する。
       - 手順 1 の複製先は、`build_staging` と同じく `$AGENT_VM_STATE_DIR/build/` の下に `mktemp -d` で毎回新しく作る。ここは host 専用で、VM からは見えない。複製は、その中の未作成のパスに対して行う。そのため、前回の残りの中に入れ子になることはない。
    3. 一時名（`mktemp -u`）で symlink `current.<乱数>` → `gen-...` を作り、同じ perl の `rename` で `current` を置き換える。
       - symlink の作成にも、perl の `symlink()` を使う。`ln -s` は、同じ名前のディレクトリ（symlink 越しを含む）が先にあると、その中にリンクを作ってしまう。perl の `symlink()` は、既に名前があれば EEXIST で失敗する。
       - `mktemp -u` は名前を予約しない。そのため、作成と rename の失敗は、上と同じく警告してブラウザだけ省略する。
       - `rename(2)` は、`current` が symlink（どこを指していても）ならエントリごと置き換え、たどらない。
       - `current` がディレクトリに変えられていると、rename は失敗する（ディレクトリを symlink で置き換えることはできない）。その場合は、何も書かずに警告し、回復手順（`agent-vm rm`）を添える。
    4. `browser-records/<m>.id` に id を書く（一時ファイルと `rename` による全置換）。
  - 古い世代（`gen-*`）は、起動中には消さない。
    - VM が動いているあいだに、VM が書き込めるツリーを host が深くたどって消すと、途中で中間のディレクトリを symlink にすり替えられたとき、削除がマウントの外に及びうる。
    - 古い世代は clonefile の複製なので、ディスクはほとんど使わない。VM がその中を書き換えた分だけ増える。
    - 世代が増えるのは `@playwright/mcp` の版が上がったときだけ。
    - 古い世代は、`forget_machine` で `browsers/<m>` ごと消す。このとき machine はすでに `orb delete` 済みで、書き込める VM は存在しない。
  - ロック区間の中で起動する子プロセス（`cp`、`mktemp`、`perl`）には、`9>&-` と同じ流儀で `8>&-` も付ける。
  - ストアのロック（fd 8）の解放
    - `ensure_browsers` は、どの経路で抜けても `exec 8>&-` でロックを閉じる。対象は、成功、待ちの上限、TOFU の不一致、clonefile の失敗、rename の失敗のすべて。
    - 後続の `maybe_bootstrap`（`orb`）に、fd 8 を継承させない。
  - TOFU のハッシュの定義
    - 既存の `dir_hash` は変えない。`build_staging` が `v1:` の staging の hash に使っていて、変えると全 machine が一度に再 bootstrap になるため。
    - 別の関数 `store_hash` を足し、`v2:` を接頭辞にする。`.meta` の `sha256` にも、この接頭辞ごと記録する。
    - パスをソートし、symlink はたどらずに `readlink` の結果を行として含める。
    - 実行ビットを含む mode を含める。
    - `.meta` は除外する。
    - これで、`bin/headless_shell` の差し替えも検出できる。
    - ストアは 0700 で VM からは見えないので、TOFU が検出するのは同じ host ユーザーによる改変とディスクの破損だけで、VM に対する防御ではない。
    - 不一致のあいだは記録が更新されず、起動のたびに再ハッシュと警告になる。これはストアの破損という異常時の挙動で、回復手順（`agent-vm fetch-browsers --force` でストアを取り直す）を添える。
  - ストアのロックは machine をまたいで共有される。ただし、待つのは id が変わったとき（ハッシュの照合と複製）と fetch-browsers の公開のときだけで、どちらも短い。
    - 待ちの上限は `acquire_lock` と同じ流儀で 60 秒とし、超えたら警告してブラウザだけ省略する。
    - fetch-browsers が公開しようとした id がすでに公開済みだった場合（apply と手動の実行が並行したとき）は、成功として扱う。ただし `--force` のときはこの扱いを使わず、K2 の手順 7 のとおり置き換える。
  - TOFU の照合は、作り直すとき（判定の 4）にしか走らない。複製が揃っているあいだはストアを再検査しない。machine 側の複製は、改変されてもその VM の中に閉じるので、これを意図どおりとする。host の権限で `.meta` ごと書き換えられる場合は防げない（host の侵害は、この脅威モデルの外）。
  - 途中で失敗しても、次の起動で収束する。
    - 記録は最後（手順 4）に書く。そのため、1〜3 のどこで失敗しても、次の起動では記録が古いまま残っていて、手順をやり直す。
    - やり直すと `gen-*` が 1 つ増える。これも clonefile なので、ディスクはほとんど増えない。`forget_machine` で片づく。
    - 失敗が続く machine では、`gen-*` が起動のたびに増え続ける。ディスクへの影響が小さいので、上限は設けない。
    - メタの無い孤児（`orb create` の失敗や、`forget_machine` の削除失敗で残る `browsers/<m>` と `browser-records/<m>.*`）は、`gc` の対象にならない。これも clonefile で小さいので受け入れる。同じ名前の machine を作り直したときは、`ensure_machine` が作成時に `.id` を消すので、作り直しの判定（判定の 4）に入って収束する。
  - 作り直すのは、判定の 4 に当たるとき（id が変わったとき、`.id` が無いとき、`current` が無いとき）。
    - VM は passwordless sudo を持つ（ADR-0018 R6）。VM が自分の複製を書き換えられることは、VM 内の任意のファイルを書き換えられることと同じ範囲に収まる。
      - `browsers/<m>` は、ADR-0018 R6 が挙げる「VM が書ける host パス」（repo・staging・outbox）に加わる 4 つ目になる。
      - host はこの中身を実行も解釈もしない。判定は host 側の記録で行い、書き込みは `rename(2)` によるエントリの置き換えだけにする。深くたどる削除は、machine が消えた後にしか行わない。
      - K7 で ADR R6 にこの点を追記する。
    - 守るべきなのは、machine 間の分離とストアの不変性だけ。
    - 起動ごとに作り直すと、`gen-*` が起動のたびに増える。
    - id が変わって `current` を新世代に切り替えても、旧世代は消さないので、稼働中のセッションが実行しているブラウザはそのまま動き続ける。新しく起動するブラウザは、`current` 経由で新世代を使う。切り替えは、各セッションで次にブラウザを起動したときに起きる。
  - ディレクトリの作成と前提
    - `browser-records/` と `browsers/<m>/` は、`ensure_machine` が作る（上記）。`.mount` があれば両方あるので、`ensure_browsers` では作らない。
    - launcher の外で `orb delete` した machine を作り直した場合も、`ensure_machine` が `.id` を消すので、作り直しに入って収束する。
    - `build/`、`browsers/`、`browser-store/` は、すべて `$AGENT_VM_STATE_DIR` の下の同じボリュームに置く。そのため `rename(2)` が成り立つ。`build_staging` と同じく、EXDEV で失敗した場合は警告してブラウザだけ省略する。
    - machine のロックは machine ごとなので、別の repo の VM とは互いに待たない。別の repo の VM は、それぞれ自分の `browsers/<m>` だけを扱う。machine をまたいで待つのは、上のストアのロックだけ。
  - マウントの追加
    - ディレクトリと印は、上記のとおり `ensure_machine` が `orb create` の前に作る。
    - `--mount "$AGENT_VM_STATE_DIR/browsers/$1:/opt/agent-vm/browsers"` を追加する。
  - 後始末（`forget_machine`。`agent-vm rm` と `gc` が使う）
    - メタと `browser-records/<m>.*`（`.mount`、`.id`、中断で残った `.id.tmp.*`）を先に消す。
    - `forget_machine` は、既存の `rm` や `gc` と同じくロックを取らない。消す対象の machine はすでに `orb delete` 済みなので、ストアのロックと順序が衝突することはない。
    - その後、`browsers/<m>` を消す。失敗は警告だけにし、`set -e` で中断させない。
    - `gc` と `rm` はどちらも、`set -e` の下で `orb delete -f` を先に実行し、その後に `forget_machine` を呼ぶ（`executable_agent-vm:746-757`、`:759-780`）。`orb delete` が失敗すれば、`forget_machine` までは進まない。そのため、この時点で `browsers/<m>` に書き込める VM は存在しない。
  - 作り直しが必要なのに、ストアに要求 id が無いとき（判定の 3）
    - 複製を省略し、起動は続ける。K10 の fail closed は OrbStack 自体が使えないときの規則で、ブラウザが無いことは agent の起動を止める理由にならない。
    - その状態が続くあいだ、起動のたびに回復手順（`agent-vm fetch-browsers`）を 1 行出す。複製が揃っている machine（判定の 2）では出さない。
      - この状態が生じるのは、取得の失敗か、apply の前の起動だけ。正常な運用では続かないので、警告が慣れを生むことはない。
      - `.last-failure` があれば、その理由も添える。
  - 参照: `home/dot_local/bin/executable_agent-vm:126-146`（build/ での構築、`rename(2)` による公開、symlink をたどらない削除）
  - 参照: `home/dot_local/bin/executable_agent-vm:149-160`（ensure_machine とマウント）
  - 参照: `home/dot_local/bin/executable_agent-vm:554-571`（prepare_machine のロック区間）
  - 参照: `home/dot_local/bin/executable_agent-vm:700-704`（forget_machine）
  - 参照: `home/dot_local/bin/executable_agent-vm:53-57`（write_machine_meta による全置換）
  - 参照: `research.md` F3（clonefile の増分は約 200KB）、F10（symlink の差し替えは VM から見える）

- **K4: VM 側の差分は `bootstrap.sh` と、同じディレクトリの VM 専用フィルタに閉じる（ADR-0018 K17〜K22 の原則を維持する）。**
  - 前提: 別のセッションで進んでいる ADR-0019 の変更（未コミット、作業ツリーで確認）の上に乗せる。
    - その変更で、Codex のフィルタは `vm-codex-config.awk` から `vm-codex-config.tmpl`（chezmoi の `execute-template` と `fromToml`、許可リストは環境変数 `VM_MCP_KEEP`）に置き換わり、dasel への依存も外れる。
    - plan は、その変更がコミットされた後の master から始める。
  - 許可リストの定数を 2 つに分ける。
    - `VM_CLAUDE_MCP_KEEP="readability context7 excalidraw playwright chrome-devtools"` は、`vm-claude-json.jq` と Claude の自己検査が使う。
    - `VM_CODEX_MCP_KEEP="readability context7 excalidraw"` は、Codex のフィルタ（`VM_MCP_KEEP` という環境変数名で渡す）と Codex の自己検査が使う。
    - こうすることで、Codex の `@latest` の playwright は、今までどおり取り除かれる。
  - 新しい jq フィルタ `agent-vm/vm-claude-browser.jq` を足す。
    - host と共有するテンプレートには手を入れない。
    - 対象は `~/.claude.json` の 2 エントリ。`args` を追記ではなく丸ごと組み直す。何度 bootstrap しても同じ結果にするため（冪等）。
    - パッケージの指定（`@playwright/mcp@<ver>`、`chrome-devtools-mcp@<ver>`）は、既存の `args[0]` から引き継ぐ。
  - 2 エントリに設定する値
    - playwright
      - `args` は `[<args[0]>, "--headless", "--isolated", "--executable-path", "/opt/agent-vm/browsers/current/bin/headless_shell"]`。
      - F5 で、`--browser` だけでは動かず、`--executable-path` が要ることを確認した。
    - chrome-devtools
      - `args` は `[<args[0]>, "--headless", "--isolated", "--executablePath", "/opt/agent-vm/browsers/current/bin/headless_shell"]`。
    - 両方とも、`env.LD_LIBRARY_PATH` に K5 の libgbm のディレクトリの絶対パス（`$HOME/.local/lib/agent-vm-browser`）を設定する。jq には `--arg` で渡し、文字列の連結はしない。
    - パスは固定なので、bootstrap がマウントを glob することも、`<id>` を焼き込むことも無い。
  - マウントが無い machine（K3 より前に作られた machine）では、ブラウザの設定を当てない。
    - bootstrap は、`/opt/agent-vm/browsers` がディレクトリとして存在しない（`test -d` が偽）なら、Claude の許可リストから `playwright` と `chrome-devtools` を外す。これで、従来どおり除外された状態になる。
      - 古い machine には `/opt/agent-vm/src` と `outbox` はあるが、`browsers` は無い。`mountpoint` は virtiofs のマウントを判定できるか実測していないので使わない。
      - 許可リストの定数（readonly）は書き換えない。jq と自己検査には、定数から実行時に導いた別の変数を渡す。
    - あわせて K6 の警告を出す。存在しないパスを指す MCP を登録しないため。
  - 冪等性の判定基準: 同じ `~/.claude.json` に `vm-claude-browser.jq` を 2 回適用した結果が、1 回適用した結果とバイト単位で一致すること。plan でテストにする。
  - 自己検査（`verify_vm_config`）に次を足す。どちらも、フィルタより緩い条件で見る既存の流儀に従う。
    - 2 エントリが残っている場合は、`args` に `--headless` と実行パスがあること
    - 2 エントリが残っている場合は、`env.LD_LIBRARY_PATH` があること
    - Codex の設定に `mcp_servers.playwright` と `mcp_servers.chrome-devtools` が無いこと（`VM_CODEX_MCP_KEEP` で検査）
  - 契約版（`BOOTSTRAP_CONTRACT` / `SUPPORTED_CONTRACT`）は 1 のまま据え置く。組み合わせごとの挙動は次のとおり。

    | launcher | machine / bootstrap | 挙動 |
    | --- | --- | --- |
    | 新 | 新しい machine、新 bootstrap | ブラウザを提供する |
    | 新 | 古い machine（マウント無し）、新 bootstrap | ブラウザの 2 エントリを外し、K6 の警告（`agent-vm rm`）を出す |
    | 旧（apply していない） | 新 bootstrap | マウントも複製も無い。上の行と同じ扱い |
    | 新 | 旧 bootstrap（staging が古い） | 起こらない。launcher は起動のたびに working tree から staging を作り直す（`build_staging`） |

  - bootstrap の引数の形は変わらない。そのため、どの組み合わせでも契約の不一致（exit 3）にはならない。
  - 参照: `agent-vm/bootstrap.sh:15`（VM_MCP_KEEP）
  - 参照: `agent-vm/bootstrap.sh:89-116`（filter_vm_configs / verify_vm_config）
  - 参照: `agent-vm/vm-claude-json.jq:1-5`
  - 参照: `docs/decisions/0018-agent-vm-orbstack.md:38`（VM 分岐を共有テンプレートに入れない原則）
  - 参照: `research.md` F5

- **K5: VM ごとの apt は、mesa を除いたブラウザの依存ライブラリとフォント 2 種に絞る。`libgbm.so.1` だけは apt から取り出して置く。**
  - `VM_APT_PKGS` とは別の定数 `VM_BROWSER_APT_PKGS` を置く。
    - 既存の「host のリストの部分集合」検査（`tests/agent-vm/run-bootstrap.sh`）は host の一覧との関係を見るもので、この定数には当てはまらない。
    - 代わりに、期待値との完全一致テストを足す。
  - 中身
    - 決め方: `playwright@<最新> install-deps --dry-run chromium-headless-shell` が Ubuntu 26.04 向けに列挙するパッケージ（F6、F7）から、次の正規表現に当たるものを除く。そこに 2 種のフォントを足す。plan の最初のタスクで、この手順で一覧を書き出して定数にする。
      - 除外の正規表現: `font|^xfonts|^xvfb$|^xserver|^x11-xkb-utils$|^xkb-data$|^libfontenc|^libgbm|^libgl|^libegl|^mesa|^libllvm|^libglvnd|^libglx|^libdrm-(amdgpu|nouveau|radeon|intel)|^libvulkan|^libwayland|^libz3|^libsensors|^libelf|^libedit|^libxshmfence|^libxxf86vm|^libx11-xcb|^libxcb-(dri|glx|present|sync|xfixes|randr|shm)`
    - F7 では、この手順で 48 パッケージ、35.1MB になった。
    - フォントは `fonts-liberation` と日本語用の `fonts-ipafont-gothic` だけ。
    - Ubuntu 側の依存が変わって 40MB を超えた場合は、完全一致テストの差分で気づける。そのときは、この spec の容量の制約を見直す。
  - `libgbm.so.1` の置き方
    - bootstrap の実行ユーザー（非 root）が、一時ディレクトリで `apt-get download libgbm1` と `dpkg-deb -x` を行う。約 240K で、apt の署名検証を経た取得になる。
    - `~/.local/lib/agent-vm-browser/` には `libgbm.so.1*` だけを置く。展開した木全体は指さない。
    - 取得した deb の版を `~/.local/lib/agent-vm-browser/.version` に記録する。`apt-cache policy libgbm1` の候補版と同じなら取り直さない（冪等）。違えば取り直す。
      - 候補版の比較が走るのは bootstrap のとき（staging が変わったとき）だけで、apt lists の更新は `install_vm_tools` の `apt-get update` に依存する。
      - dpkg の管理外なので、unattended-upgrades の対象にもならない。セキュリティ更新が届くのは、次の bootstrap のときに限られる。これは、headless のブラウザだけが読み込むライブラリとして受け入れる。
    - `libgbm1` の Depends（`libdrm2`、`libexpat1`、`libwayland-server0` など）が、基本の依存の一覧で満たされているかを、plan の最初のタスクで確かめる。足りなければ一覧に足す。F7 では、別の経路で入っていた可能性を排除できていない。
    - ldd の検査は、headless shell だけでなく、置いた `libgbm.so.1` にも当てる。
    - `libgbm1` を apt で入れると、`mesa-libgallium` と `libllvm21` を引き込み、それだけで 178MB になる（F7）。
    - headless shell が要るのは `libgbm.so.1` の読み込みだけで、GPU は使わない（F7 で 2 つの MCP の全操作が成功した）。
  - `install-deps` は使わない。理由は 2 つ。
    - root で npm のコードを実行する経路を作らないため。
    - 固定版の playwright は Ubuntu 26.04 に対応していないため（F6）。
  - 依存の検査（`ldd <headless shell> | grep 'not found'`）
    - `LD_LIBRARY_PATH` を付けて、非 root（bootstrap の実行ユーザー）で行う。
    - 欠けていれば K6 の警告を出す。
  - 容量の目標: dpkg の Installed-Size の合計で 40MB 以下。F7 の実測は 35.1MB。
  - 参照: `agent-vm/bootstrap.sh:10`、`:53-63`（install_vm_tools の、無いものだけ入れる流儀）
  - 参照: `research.md` F6、F7

- **K6: 古い machine とブラウザの欠落は、害が出る場面で自ら告げる。**
  - 警告が出る場面の一覧（どれも、失敗させずに警告だけを出す。ブラウザ以外の作業を止めないため）

    | 場面 | 条件 | 回復手順 |
    | --- | --- | --- |
    | chezmoi apply（K2） | 取得の失敗 | `agent-vm fetch-browsers`（同じ理由が続くときは 1 行に縮める） |
    | 毎回の起動（K3） | ストアに要求 id が無い | `agent-vm fetch-browsers` |
    | 毎回の起動（K3） | TOFU の不一致 | `agent-vm fetch-browsers --force`（ストアを取り直す） |
    | 毎回の起動（K3） | clonefile の失敗、EXDEV | `$AGENT_VM_STATE_DIR` が APFS の単一ボリュームにあるかを確かめる |
    | bootstrap（K4） | マウントが無い | `agent-vm rm`（下記） |
    | bootstrap（K5） | `current/bin/headless_shell` が無い、ldd に欠けがある | `agent-vm fetch-browsers` の後に、もう一度起動する |
    | bootstrap | `~/.claude.json` の `args[0]` の `@playwright/mcp` の版が、`current/.meta` の `mcp_version` と違う（`.meta` は VM から書き換えられるので、これは助言としての警告に留め、何かの判定には使わない） | `chezmoi apply` と `agent-vm fetch-browsers` |

  - `agent-vm rm` を案内するときに添える内容
    - 失うもの: VM 内のログイン状態（Claude と Codex）と、VM 内に入れた道具。
    - 残るもの: repo、セッションログ（outbox 経由で取り込み済み）、host の env ファイル。
  - bootstrap は staging が変わったときにしか走らない。そのため、bootstrap の警告が毎回の起動で出続けることはない。
  - K21 と同じく、既存 machine への移行処理は作らない。
    - `orb` には、作成後にマウントを足す手段が無い（`orb create --help` にだけ `--mount` がある）。
  - 参照: `docs/decisions/0018-agent-vm-orbstack.md:44`（K21）
  - 参照: `agent-vm/bootstrap.sh:98-99`（回復手順を添える既存の流儀）
  - 参照: `home/dot_local/bin/executable_agent-vm:163-170`（maybe_bootstrap は applied-hash が同じなら走らない）

- **K7: ADR-0018 と `docs/agent-vm.md` を改訂する。**
  - ADR-0018 の「K17〜K22 の帰結」のうち、「playwright、chrome-devtools は提供しない」の文を削る。
    - 代わりに、新しい節「VM のブラウザ（K23〜、2026-09-30 追記）」に、本 spec の K1〜K6 の骨子を書く。
    - drawio と音声通知を提供しないことは維持する。
    - VM の MCP の引数（headless と実行パス）は、共有テンプレートへの VM 分岐ではなく、bootstrap の jq の後処理で設定していることを明記する。
    - ADR-0018 の R6（VM 内の root が書ける host パス）に、`browsers/<m>` を加える。host はその中身を実行も解釈もしないことを書く。
    - Consequences に、F9（isolated machine 同士が IP で届く）を既知の性質として記録する。
  - `docs/agent-vm.md` に次を書く。
    - mac のブラウザで `localhost:<port>` を開く見方と、同じポートの衝突（F8）
    - `localhost` の注意（本 spec の R6）
    - `agent-vm fetch-browsers`
    - 古い machine の回復手順
    - chrome-devtools-mcp を headless shell と組み合わせるのは公式には非サポートで、動作は 0.25.0 で確認した。版を上げたときの確認項目にする。
    - V8 の結果（F1）
  - 参照: `docs/decisions/0018-agent-vm-orbstack.md:36-45`、`:68`
  - 参照: `docs/agent-vm.md:122`（V8 を未確認としている箇所。F1 の結果で更新する）

## Risks

- **R1: OrbStack のマウントが symlink の扱いを変える可能性**
  - F10 で、現行版（2.2.3）では相対 symlink が VM から解決されることを確認した。host 側で `rename(2)` して `current` を差し替えると、VM からも切り替わって見える。
  - 将来の版で挙動が変わった場合は、K6 の「`current/bin/headless_shell` が無い」警告で検出される。
- **R2: 同じポートの衝突**（F8）
  - host の `localhost:<port>` は、先に bind した machine に届く。
  - `docs/agent-vm.md` に書き、ポートを変えるよう案内する。
  - `<machine>.orb.local` は、loopback に bind した dev server には使えない（F1、F8）。
- **R3: `PLAYWRIGHT_HOST_PLATFORM_OVERRIDE` は Playwright の内部向けの環境変数で、将来なくなりうる。**
  - K2 の ELF aarch64 判定で検出し、公開しない。
  - その場合の代替として、公開されている zip の URL（F4 の取得ログに出る `cdn.playwright.dev`）から直接取得する方法がある。plan では実装しない。
- **R4: Ubuntu resolute（26.04）に、ubuntu24.04 用のバイナリを載せている。**
  - F2、F3、F5 で起動と MCP の全操作を確認した。
  - 将来の非互換は、K5 の ldd 検査が K6 の警告として拾う。
- **R5: `--isolate-network` を付けても、machine 間で IP による到達がある（F9）**
  - これは本 issue とは独立した既存の性質で、docs の記述と食い違う。
  - 本変更の影響は次の 2 点。
    - VM A のブラウザは、VM B が `0.0.0.0` に bind したサービスに届きうる。ただし VM A の agent は、ブラウザが無くても `curl` で同じことができる。
    - loopback に bind した dev server（vite の既定）には、他の machine から届かない。
  - `docs/agent-vm.md` で「dev server は loopback bind のまま `localhost` で見る」を推奨する。
  - machine 間の到達そのものは、別 issue として起票することをユーザーに提案する。
- **R6: VM のプロセスが host の `localhost` のポートを占有できる**
  - これは OrbStack の転送の既存の性質で、本変更で新しく生じたものではない。
  - 本変更では「mac のブラウザで VM の dev server を開く」ことを文書で勧めるので、利用頻度は上がる。
  - `localhost` のオリジンは、ポートをまたいで cookie を共有する。そのため `docs/agent-vm.md` に次の注意を書く。
    - VM の dev server は、`localhost` にログイン済みのセッションを持つ普段のブラウザプロファイルでは開かない。
    - host で使っているポート（OAuth のコールバックなど）と重ならないようにする。

- **R7: 本 spec は、別のセッションで進行中の ADR-0019 の変更に依存する**
  - その変更は、`agent-vm/bootstrap.sh`、`tests/agent-vm/`、ADR-0018、`docs/agent-vm.md` に触れている。どれも本 spec の plan が触るファイル。
  - plan は、その変更がコミットされた後の master から始める。始めるときに `agent-vm prewarm` が通ることを確かめる。

## Phase 1 で意図的に提供しない体験

### Codex からのブラウザ MCP

- **代替経路確認**: 同じ VM の Claude から、playwright と chrome-devtools を使える（K4）。`home/dot_codex/.config.toml:14-16`
- **非提供対象**: VM の Codex の `mcp_servers.playwright`。`VM_CODEX_MCP_KEEP` で除外したままにする（K4）。
- **提供しない理由**
  - Codex の設定の組み立て（`4bb38c1`）と、その VM のフィルタ（ADR-0019、別のセッションで進行中、未コミット）が、いままさに作り替えられている。
  - 変更が済んだ後なら、Codex のフィルタは TOML を解釈するので、K4 と同じ `args` と `env` の組み直しを小さく足せる。ただし、確定していない土台の上に重ねると、2 つの変更が衝突する。
- **将来の予定**
  - ADR-0019 の変更がコミットされたら、この spec の範囲に戻すか、別 issue にするかを決める。
  - 判断の材料は、Codex を VM の主エージェントとして使う頻度（ユーザーへの Open Question）。頻度が高ければ、plan を 1 つ足して本 spec の範囲に戻す。

### drawio MCP

- **代替経路確認**: ユーザーのブラウザで draw.io を開く道具で、VM には開く先が無い（`research.md` 外部の事実）。VM では excalidraw（リモート MCP）が残っている。`agent-vm/bootstrap.sh:15`
- **非提供対象**: drawio MCP 全体。
- **将来の予定**: 恒久的に非提供とする。図の作成は excalidraw か host の claude で行う。

### headed（画面ありの）ブラウザを人が VM 内で見ること

- **代替経路確認**: 人は mac のブラウザで同じ dev server を見る（F1）。agent の操作結果はスクリーンショットで受け取る。
- **非提供対象**: agent が操作しているブラウザそのものを、人が画面で見ること。
- **将来の予定**: 要望が出た時点で別 issue とする。

## ISO 25010 次元選択

- **機能適合性**: 実 VM（agent-vm で作った machine）の Claude から、次が成功すること。
  - playwright: `browser_navigate` と `browser_take_screenshot`
  - chrome-devtools: `navigate_page`、`take_screenshot`、`performance_start_trace`
- **互換性（共存性）**: host の設定が変わらないこと。
  - 対象は `~/.claude.json`、Codex の設定、`.chezmoiignore` の host 描画。
  - K20 の既存テストを維持する。
  - VM の Codex の設定に playwright が残らないこと（K4 の定数分離）。
- **セキュリティ**
  - VM から host への経路が増えないこと。
  - machine 間で書き込み可能な共有が生じないこと。
  - ストアがどの machine にもマウントされず、0700 であること。
  - launcher がマウントの中を読まず、symlink をたどらないこと。
- **信頼性**: 次の状態でも、agent の起動が失敗しないこと。警告と回復手順が出ること。
  - ストアが無い
  - 古い machine
  - clonefile の失敗
- **性能効率（資源効率）**: VM ごとの容量増が、dpkg の Installed-Size の合計で 40MB 以下であること。
- **対象外**
  - 使用性: UI の変更は無い。
  - 移植性: darwin の host と、arm64 の OrbStack だけが対象。

## Approval

- Plan Status: complete
- Review Status: pass
- Approval Status: approved

## Reviewer Outputs (Round 1)

### logic-validator
- verdict: needs-work
- 主指摘:
  - `VM_MCP_KEEP` は Codex の awk にも共有されるので、K4 だと Codex に `@latest` の playwright が残る。
  - playwright MCP のブラウザ解決は MCP 経由では未検証だった。
  - K3 の「作り直さない」の根拠として R6 を挙げたのは誤参照。
  - bootstrap 時に `<id>` を焼き込むと、ストア更新に追随しない。

### scope-justification-reviewer
- verdict: needs-work
- 主指摘:
  - K3 の「起動ごと」と「あれば何もしない」が矛盾している。
  - U3/U4 を承認前に実機で確認すべき。
  - 50MB 目標に実測がない。
  - ストアの版不一致を告げる手段がない。

### decision-quality-reviewer
- verdict: pass
- 主指摘:
  - 支配軸（隔離内のエルゴノミクス）とは整合している。
  - 体験の成否（U3/U4/R2）が plan に先送りされている。
  - Codex の除外は縮小が早い可能性がある。

### greenfield-perspective-reviewer
- verdict: needs-work
- 主指摘:
  - 採用案は白紙設計とほぼ一致している。
  - 容量目標と chrome-devtools の成立が未検証の前提に乗っている。
  - ストアの旧版の回収がない。
  - Experience Delta が U1 を未確認のまま断定している。

### architecture-boundary-analyzer
- verdict: needs-work
- 主指摘:
  - Claude と Codex の keep 定数を分けるべき。
  - `<id>` を固定パスにして、bootstrap の glob と焼き込みをなくすべき。
  - 取得ロジックは launcher のサブコマンドに置き、状態ディレクトリのレイアウトの所有者を 1 つにすべき。
  - ensure_browsers はロック内で動かし、`cp -c` の失敗を黙ってフォールバックさせないこと。

### security-vulnerability-analyzer
- verdict: needs-work
- 主指摘:
  - 取得物の supply chain（ハッシュの固定）。
  - マウント内の存在判定を VM が操作できる。
  - ストアの不変性（0700）。
  - `localhost` 転送を host への入口とする注意書き。
  - VM 間と LAN の到達性が未検証。
  - ldd を root で実行しないこと。

### data-contract-evolution-evaluator
- verdict: needs-work
- 主指摘:
  - stale な `<id>` の扱いがない。
  - 存在判定を host 側の記録で行うべき。
  - run_onchange の失敗は再試行されない。
  - `agent-vm rm` の後始末に browsers を加えるべき。
  - 契約版は据え置きで妥当（その旨を明記すること）。

<!-- auto-review: pending -->
<!-- intent-triage: pending -->

## Reviewer Outputs (Round 2)

### logic-validator
- verdict: needs-work
- 主指摘:
  - clonefile の失敗の扱いが、K3（失敗とする）と ISO の信頼性（起動を止めない）で食い違っている。
  - Codex を除外する理由が古い（作り直しは 4bb38c1 でコミット済み）。
  - ADR R6 と spec R6 の番号が衝突している。
  - 古い machine では、jq が存在しないパスを書く。

### scope-justification-reviewer
- verdict: needs-work
- 主指摘:
  - ストアの版の不一致を告げる手段が無い。
  - 冪等判定のために毎回 `npm view` が要る。
  - 失敗の警告が常態化する。
  - jq の冪等性の判定基準が無い。

### decision-quality-reviewer
- verdict: pass
- 主指摘:
  - ハッシュ固定を却下する理由に、防ぐものと防がないものを明記すること。
  - Codex を再開する条件を書くこと。
  - 警告が出る場面を一覧にすること。

### greenfield-perspective-reviewer
- verdict: pass
- 主指摘:
  - 稼働中のセッションが旧世代を使い続けることを明記すること。
  - chrome-devtools と headless shell の組み合わせは公式には非サポートであることを docs に書くこと。

### architecture-boundary-analyzer
- verdict: needs-work
- 主指摘:
  - `write_machine_meta` が `browsers_id` を毎回消してしまう。
  - ストアのキーがネットワーク依存になっている。
  - ストアのロックが無い。
  - MCP の版とストアのずれを検査していない。
  - fetch-browsers の PATH と終了コードの契約が無い。

### security-vulnerability-analyzer
- verdict: pass
- 主指摘:
  - 旧世代の `rm -rf` は、VM が書き込めるツリーを深くたどるので、`.trash` に rename してから消すべき。
  - `current` を VM がふさげる。
  - 「同じ信頼の根」という表現は正確でない（CDN は別の根）。TOFU の sha256 を勧める。
  - libgbm は `libgbm.so.1*` だけを置くこと。
  - 取得時の環境変数を最小にすること。

### data-contract-evolution-evaluator
- verdict: needs-work
- 主指摘:
  - `write_machine_meta` の全置換と `browsers_id` が衝突する。別ファイルにすべき。
  - 途中で失敗しても収束することを明記すること。
  - id の不一致と欠落を同じ経路で扱うこと。
  - `forget_machine` の削除失敗の扱い。
  - 旧と新の組み合わせの互換表。

<!-- auto-review: verdict=needs-work; hash=666eeef1c8f52079e81d4edded410b49af678f0c5dd6eb3573eee3dd9d29be37; design-hash=e672ec47c6607ca1611b75ca19e44e2e443b0d25b1501d3f3d4dc3d0ccb1b606; round=1; at=2026-09-29T18:01:09.335Z; reviewers=logic-validator+scope-justification-reviewer+decision-quality-reviewer+greenfield-perspective-reviewer+architecture-boundary-analyzer+security-vulnerability-analyzer+data-contract-evolution-evaluator -->

## Reviewer Outputs (Round 3)

### logic-validator
- verdict: pass
- 主指摘: 次の low の指摘があり、反映した。
  - マウントの判定は `mountpoint` ではなく `test -d` にする。
  - `dir_hash` は symlink と `.meta` を扱えない。
  - readonly の定数と、ロックの待ちの上限。

### scope-justification-reviewer
- verdict: pass
- 主指摘: low のみ。
  - TOFU が効かない範囲（host の侵害）を明記すること。
  - 版を上げたときの確認手順。

### decision-quality-reviewer
- verdict: pass
- 主指摘: advisory のみ。
  - `.last-failure` に初回の日時を持たせる。
  - 容量のテストが落ちたときに出すメッセージ。

### greenfield-perspective-reviewer
- verdict: pass
- 主指摘: low のみ。
  - Codex を再開する条件と、ADR-0019 がコミットされたことを plan の開始条件に含めること。
  - 容量を超えたときは、除外の正規表現も見直すこと。

### architecture-boundary-analyzer
- verdict: needs-work
- 主指摘: `machines/<m>.browsers` が、既存の `machines/*` の列挙（`list`、`gc`）で machine として拾われる。
  - `browser-records/<m>` に移して反映した。
  - fd 8 の継承の扱いも反映した。

### security-vulnerability-analyzer
- verdict: needs-work
- 主指摘: VM の稼働中に trash の中を削除すると、symlink のすり替えで削除がマウントの外に及びうる。`mv` がディレクトリの中に入れてしまう問題もある。
  - 反映した内容: 起動中の削除をやめ、`forget_machine`（`orb delete` の後）でだけ消す。公開と置き換えは perl の `rename(2)` だけで行う。
  - あわせて、環境変数の許可リストと、libgbm の依存・更新も反映した。

### data-contract-evolution-evaluator
- verdict: needs-work
- 主指摘: architecture と同じく、`.browsers` の置き場所が既存の列挙と衝突する（high）。
  - `browser-records/<m>` に移して反映した。

<!-- auto-review: verdict=needs-work; hash=0dad7664d6e251b57db057ac154d96490f3ef8ef3cc630efc5105d1e61fc1884; design-hash=965495845f38005a1492eaea5f28e89290431cb4c250cce7cdde9b357ac1d2fd; round=2; at=2026-09-29T18:07:18.657Z; reviewers=logic-validator+scope-justification-reviewer+decision-quality-reviewer+greenfield-perspective-reviewer+architecture-boundary-analyzer+security-vulnerability-analyzer+data-contract-evolution-evaluator -->

## Reviewer Outputs (Round 4)

### logic-validator
- verdict: pass
- 主指摘:
  - K3 に旧方針（起動中に旧世代を消す）の文言が残っている。
  - `browser-records/` をどこで作るかと、同じファイルシステムである前提が書かれていない。
  - 反映済み。

### architecture-boundary-analyzer
- verdict: needs-work
- 主指摘:
  - `ensure_browsers` を `ensure_machine` の前に置くと、古い machine にも複製と記録を作ってしまい、新しい machine では初回にディレクトリが無い。
  - `dir_hash` を拡張すると、staging の hash が変わる。
  - fd 8 を解放する不変条件が無い。
  - 反映済み: 順序を入れ替え、`mount=1` の記録を置き、`store_hash`（`v2:`）を足し、fd 8 は全経路で閉じる。

### security-vulnerability-analyzer
- verdict: pass
- 主指摘:
  - 一時 symlink は perl の `symlink()` で作ること。
  - `build/` は host 専用の `mktemp -d` にすること。
  - libgbm の更新は bootstrap のときに限られると明記すること。
  - `forget_machine` の前提（`orb delete` の後）を確認すること。
  - いずれも反映済み。

### data-contract-evolution-evaluator
- verdict: needs-work
- 主指摘:
  - 初回に `browsers/<m>` が無い。
  - 記録はあるのに `current` が消えた場合に、収束しない。
  - 孤児と `gen-*` の増加の扱いが書かれていない。
  - 反映済み: `current` の lstat を作り直しのきっかけにし、受け入れる範囲を明記した。

### scope-justification-reviewer
- verdict: pass (carried from Round 3)
- 主指摘: Round 3 で pass、再実行なし

### decision-quality-reviewer
- verdict: pass (carried from Round 3)
- 主指摘: Round 3 で pass、再実行なし

### greenfield-perspective-reviewer
- verdict: pass (carried from Round 3)
- 主指摘: Round 3 で pass、再実行なし

<!-- auto-review: verdict=needs-work; hash=03874daef5bc140864f51c4634ecab76f798f4f84aaf20fa4477d212b84f0a60; design-hash=350d0e6410f13b48723bea424d44ae2c0d3e4a7847b51951d452cb3c5c8dce8c; round=3; at=2026-09-29T18:12:53.940Z; reviewers=logic-validator+scope-justification-reviewer+decision-quality-reviewer+greenfield-perspective-reviewer+architecture-boundary-analyzer+security-vulnerability-analyzer+data-contract-evolution-evaluator -->
<!-- intent-triage: adopted=62; excluded=1; at=2026-09-29T18:13:17.929Z -->

## Reviewer Outputs (Round 5)

### logic-validator
- verdict: needs-work
- 主指摘:
  - K2 と K3 に `dir_hash` と `store_hash` が混在していて、TOFU の値が毎回食い違う。
  - `browser-records/<m>` の形式が 1 行のままで、全置換すると `mount=1` が消える。
- 反映済み:
  - 名前を `store_hash` に統一した。
  - 記録をキーごとの 2 つのファイル（`.mount` と `.id`）に分けた。

### architecture-boundary-analyzer
- verdict: needs-work
- 主指摘:
  - 記録の形式が食い違っている。
  - `browser-records/` の作成が、`mount=1` を書くより後になっている。
  - `set -e` の下での戻り値の扱いが決まっていない。
- 反映済み:
  - ディレクトリの作成を `ensure_machine` に寄せた。
  - `ensure_browsers` を失敗しない関数とし、各ステップの戻り値を明示的に調べるようにした。

### data-contract-evolution-evaluator
- verdict: needs-work
- 主指摘:
  - 記録の形式の食い違い。
  - `orb create` の成功後に `mount=1` を書く方式では、途中で中断すると印が永久に欠ける。
  - 判定表がほしい。
- 反映済み:
  - 印は `orb create` の前に書くようにした。
  - `ensure_browsers` の判定表を追加した。

### security-vulnerability-analyzer
- verdict: pass (carried from Round 4)
- 主指摘: Round 4 で pass、再実行なし

### scope-justification-reviewer
- verdict: pass (carried from Round 4)
- 主指摘: Round 4 で pass、再実行なし

### decision-quality-reviewer
- verdict: pass (carried from Round 4)
- 主指摘: Round 4 で pass、再実行なし

### greenfield-perspective-reviewer
- verdict: pass (carried from Round 4)
- 主指摘: Round 4 で pass、再実行なし

<!-- auto-review: verdict=needs-work; hash=b2151d218ba86e2b5fd9c66e7a798ce45a12d02b89ad06bf507f1bdfa8c0ecd7; design-hash=129a4fe8d43dab32b1085fb170fb1b87917663a69b008b6ebeb0ce2108776cc1; round=4; at=2026-09-29T18:29:21.586Z; reviewers=logic-validator+architecture-boundary-analyzer+security-vulnerability-analyzer+data-contract-evolution-evaluator -->
<!-- intent-triage: adopted=14; excluded=0; at=2026-09-29T18:29:27.956Z -->

## Reviewer Outputs (Round 6)

### logic-validator
- verdict: needs-work
- 主指摘:
  - TOFU が不一致のときの回復手順（`fetch-browsers`）が、K2 の冪等判定（ストアがあれば何もしない）と両立せず、実行できない。
  - 判定表の行が互いに排他的でない。
  - 外部で machine を作り直したときの収束の説明が正確でない。
- 反映済み:
  - `--force` を足した。
  - clonefile の失敗は、回復先を別に分けた。
  - 判定を順序付きの表にした。
  - 作成時に `.id` を消すようにした。

### architecture-boundary-analyzer
- verdict: pass
- 主指摘（low）:
  - `mkdir -p` が失敗したら起動を止める扱いを明記すること。
  - 印は冪等に作ること（`: >`）。
- 反映済み。

### data-contract-evolution-evaluator
- verdict: pass
- 主指摘（low）:
  - 判定表の評価順。
  - `.id` の一時ファイルの名前と、その後片づけ。
  - 孤児が収束することの説明。
  - `orb list` が成功したときだけ印を書くこと。
- 反映済み。

### security-vulnerability-analyzer
- verdict: pass (carried from Round 5)
- 主指摘: Round 5 で pass、再実行なし

### scope-justification-reviewer
- verdict: pass (carried from Round 5)
- 主指摘: Round 5 で pass、再実行なし

### decision-quality-reviewer
- verdict: pass (carried from Round 5)
- 主指摘: Round 5 で pass、再実行なし

### greenfield-perspective-reviewer
- verdict: pass (carried from Round 5)
- 主指摘: Round 5 で pass、再実行なし

<!-- auto-review: verdict=needs-work; hash=b66e343ecb1839003ea6b0413de4acb95ae7c7d80d9f0aa81ece4b9bb6885f2c; design-hash=046364cafec522e389633fdf0ac8f6d4a49d32246540981d37402c9bb2a833ab; round=5; at=2026-09-29T18:41:12.679Z; reviewers=logic-validator+architecture-boundary-analyzer+data-contract-evolution-evaluator -->
<!-- intent-triage: adopted=11; excluded=0; at=2026-09-29T18:41:12.697Z -->

## Reviewer Outputs (Round 7)

### logic-validator
- verdict: pass
- 主指摘:
  - 公開の手順が `--force` のときに定義されておらず、「公開済みなら成功」と衝突する（medium。plan で解消できる水準）。
  - 収束の根拠と、作り直しの条件の書き方（low）。
  - いずれも反映済み。
    - `--force` のときは、既存のストアを `build/` へ退避してから置き換える。
    - 「公開済みなら成功」は、`--force` には適用しない。

### architecture-boundary-analyzer
- verdict: pass (carried from Round 6)
- 主指摘: Round 6 で pass、再実行なし

### data-contract-evolution-evaluator
- verdict: pass (carried from Round 6)
- 主指摘: Round 6 で pass、再実行なし

### security-vulnerability-analyzer
- verdict: pass (carried from Round 6)
- 主指摘: Round 6 で pass、再実行なし

### scope-justification-reviewer
- verdict: pass (carried from Round 6)
- 主指摘: Round 6 で pass、再実行なし

### decision-quality-reviewer
- verdict: pass (carried from Round 6)
- 主指摘: Round 6 で pass、再実行なし

### greenfield-perspective-reviewer
- verdict: pass (carried from Round 6)
- 主指摘: Round 6 で pass、再実行なし

<!-- auto-review: verdict=needs-work; hash=7cb2725563556e8b7dba892cddc1c28dfb3824b3bb436ec84d7c03f1224a0d69; design-hash=c2b887192a3f892158194e4e241eca14e757156a0f96db3fb3237ebd65d86e44; round=6; at=2026-09-29T18:48:16.314Z; reviewers=logic-validator+architecture-boundary-analyzer+data-contract-evolution-evaluator -->
<!-- intent-triage: adopted=11; excluded=0; at=2026-09-29T18:48:16.334Z -->

<!-- auto-review: verdict=pass; hash=369753b259efd4af68a6cd5c35a37403650a06f3b5b674095f0604ad41711fa3; design-hash=478d4e17d4622aff0c0af254756d18d4c5265ef75d36a53f8fa50538537d101f; round=7; at=2026-10-01T13:39:06.638Z; reviewers=logic-validator -->
<!-- intent-triage: adopted=4; excluded=0; at=2026-10-01T13:39:06.656Z -->
