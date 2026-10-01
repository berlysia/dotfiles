<!-- spec-ref: spec.md -->

# Plan 3: 文書の改訂と、実機での受け入れ

spec の K7 と、ISO 25010 の機能適合性・資源効率の実機確認を行う。plan-1 と plan-2 の実装が master に入った後に行う。

## Files

```
# 編集
docs/decisions/0018-agent-vm-orbstack.md
docs/agent-vm.md

# 新規作成（.tmp/sessions/ の GC 前に設計記録を残す）
docs/plans/agent-vm/vm-browsers/spec.md
docs/plans/agent-vm/vm-browsers/research.md
docs/plans/agent-vm/vm-browsers/plan-1.md
docs/plans/agent-vm/vm-browsers/plan-2.md
docs/plans/agent-vm/vm-browsers/plan-3.md
```

## Tasks

### T1: 実機での受け入れ（mac、OrbStack）

**Files:**

- 変更なし（確認のみ。結果は T2 で `docs/agent-vm.md` に書く）
- 参照: `research.md` F5（MCP の probe の手順と、期待される応答）
- 参照: spec の ISO 25010 の機能適合性と資源効率

この repo（または Web FE の repo）で、新しい machine を作って確かめる。古い machine があれば `agent-vm rm` してから始める。

- [ ] **Step 1: ストアを取得する**

実行: `chezmoi apply` のあとに `ls ~/.local/share/agent-vm/browser-store/`
期待: `mcp-0.0.75`（`package.json` の版）が 1 つだけある。`stat -f %Lp ~/.local/share/agent-vm/browser-store` が `700`。

- [ ] **Step 2: machine を作って bootstrap する**

実行: `agent-vm prewarm 2>&1 | tee /tmp/agent-vm-prewarm.log`
期待:
- 終了コードが 0。
- `grep -c 'agent-vm bootstrap: warning:' /tmp/agent-vm-prewarm.log` が 0。
- `agent-vm shell` の中で、次の 3 つが成り立つ。
  - `jq -c '.mcpServers.playwright.args' ~/.claude.json` が `["@playwright/mcp@0.0.75","--headless","--isolated","--executable-path","/opt/agent-vm/browsers/current/bin/headless_shell"]`。
  - `jq -r '.mcpServers.playwright.env.LD_LIBRARY_PATH' ~/.claude.json` が `$HOME/.local/lib/agent-vm-browser` を展開した値。
  - `grep -c playwright ~/.codex/config.toml` が 0。
- `ls /opt/agent-vm` に `browsers` があり、`browser-store` は無い（ストアはマウントされていない）。
- `agent-vm shell` の中で `readlink /opt/agent-vm/browsers/current` が `gen-mcp-0.0.75.` で始まる（plan-1 の `mktemp -u "$dir/gen-$id.XXXXXXXX"`）。
- 同じく `ls -ld /opt/agent-vm/browsers/current/` が読み取り可能で、`/opt/agent-vm/browsers/current/bin/headless_shell --version` が版を出す（ストアの mode が VM のユーザーから読めること）。
- 同じく `jq -c '.mcpServers["chrome-devtools"].args' ~/.claude.json` が `["chrome-devtools-mcp@0.25.0","--headless","--isolated","--executablePath","/opt/agent-vm/browsers/current/bin/headless_shell"]`。
- 同じく `ls ~/.local/lib/agent-vm-browser` が `libgbm.so.1 libgbm.so.1.0.0` だけを出す（`-A` なら `.version` も）。

- [ ] **Step 3: 容量を測る**

実行（Step 2 の直後に、machine の中で）: まず `grep -n -A4 'fonts-ipafont-gothic' /var/log/apt/history.log` で、ブラウザの依存を入れた記録の形（`Commandline:` の後に `Requested-By:` などの行が挟まるか）を確かめる。そのうえで、その記録の `Install:` 行のパッケージの Installed-Size を合計する（research F11 の方法）。

```bash
awk '/^Commandline:.*fonts-ipafont-gothic/ {f = 1; next} f && /^Install:/ {print; exit}' /var/log/apt/history.log |
  sed 's/^Install: //' | tr ',' '\n' | grep -oE '^ ?[^ :)]+:(arm64|all)' | sed 's/:.*//; s/ //' | LC_ALL=C sort -u |
  xargs dpkg-query -W -f='${Installed-Size}\n' | awk '{s += $1} END {printf "%.1f MB (%d packages)\n", s / 1024, NR}'
```

期待: 20.0 MB 以上、40.0 MB 以下（research F11 では 48 パッケージ、35.1 MB）。下限は、記録を拾えずに 0 MB になる取り違えを防ぐため。

- [ ] **Step 4: 2 つの MCP を Claude から使う**

準備（別の端末で `agent-vm shell` を開いて行う）:

```bash
mkdir -p /tmp/site && printf '<!doctype html><meta charset="utf-8"><title>vm-a</title><h1>こんにちは playwright</h1>\n' >/tmp/site/index.html
cd /tmp/site && python3 -m http.server 5174 --bind 127.0.0.1
```

実行: `agent-vm claude` を起動し、`/mcp` で playwright と chrome-devtools が connected であることを確かめてから、Claude に次を頼む。
1. playwright で `http://127.0.0.1:5174/` を開き、スクリーンショットを撮って、画像に写った見出しの文字を読み上げる
2. chrome-devtools で同じページを開き、スクリーンショットを撮る
3. chrome-devtools で `performance_start_trace`（reload: true、autoStop: true）を実行する

期待:
- playwright の `browser_navigate` と `browser_take_screenshot` が、エラー無しで応答を返す。
- chrome-devtools の `navigate_page` と `take_screenshot` が、エラー無しで応答を返す。
- `performance_start_trace` の応答が `The performance trace has been stopped` を含む（F5 と同じ）。
- Claude が読み上げた見出しが「こんにちは playwright」と一致する（豆腐（□）になっていない）。あわせて、VM の中で `fc-match "sans-serif:lang=ja"` が IPA のフォントを返す。

- [ ] **Step 5: 人の閲覧と、ポートの衝突**

実行:
1. mac のブラウザのシークレットウィンドウ（`localhost` にログイン済みのセッションを持たない）で `http://localhost:5174/` を開く。
2. 別の repo で `agent-vm prewarm` して 2 台目を作る。その `agent-vm shell` で、タイトルを `vm-b` にした `index.html` を同じポートで配る。
3. 1 台目のサーバーを止めて起動し直す（2 台目が先に bind した状態にする）。もう一度 `http://localhost:5174/` を開く。
4. 確認が済んだら、2 台目の repo で `agent-vm rm` を実行する。

期待: 1 のときのタブのタイトルは `vm-a`（F8 の再確認。ここが合否）。2 で 2 台目が同じポートを bind した直後に開いても `vm-a` のまま（先に bind した machine に届く）。3 は F8 で確かめていない順序（1 台目を止めて再起動する）なので合否には使わず、届いた先（`vm-a`、`vm-b`、応答なし）をそのまま T2 で docs に記録する。

- [ ] **Step 6: 版の更新への追随**

準備: `npm view @playwright/mcp@0.0.74 dependencies --json` の `playwright` が exact の版であることを確かめる。範囲指定なら、exact の別の公開版を `npm view @playwright/mcp versions` から選ぶ。

実行: `package.json` の `@playwright/mcp` をその版に一時的に書き換え（コミットしない）、`chezmoi apply` を実行する。次に `agent-vm prewarm` を実行し、`ls ~/.local/share/agent-vm/browsers/<machine>/` と `readlink ~/.local/share/agent-vm/browsers/<machine>/current` を確かめる（`<machine>` は `agent-vm list` の、この repo の行の名前）。

副作用と戻し方: この apply は host の `~/.claude.json` の playwright の版も書き換え、ストアの `mcp-0.0.75` を消す。確認が済んだら、`git checkout package.json` の後にもう一度 `chezmoi apply` と `agent-vm prewarm` を実行して戻す（`mcp-0.0.75` の再取得に数分かかる。容量は host に約 340MB を 1 部だけ）。戻した後、host で `jq -r '.mcpServers.playwright.args[0]' ~/.claude.json` が `@playwright/mcp@0.0.75` に戻っていること、`ls ~/.local/share/agent-vm/browser-store/` が `mcp-0.0.75` だけであることを確かめる。

期待:
- apply で `browser-store/mcp-<新しい版>` が公開され、`mcp-0.0.75` が消える。
- `current` が `gen-mcp-<新しい版>.*` を指す。`gen-mcp-0.0.75.*` は残る（spec K3）。

- [ ] **Step 7: 古い machine での警告（spec K6）**

実行: plan-1 の実装より前に作られた本物の machine（`/opt/agent-vm/browsers` のマウントが無い）が残っている場合だけ行う。その repo の staging を変えて bootstrap を走らせるため、`chezmoi apply` の後に `agent-vm claude` を起動する。

`.mount` の印を消すだけの代用はしない。印を消してもマウントは残るので、bootstrap の `test -d` は真のままで、K6 の警告の経路を通らない。

期待:
- 起動が成功する。
- bootstrap の出力に、`agent-vm rm` と、失うもの・残るもの（`you lose`）を含む警告が出る。
- Claude の `/mcp` に playwright と chrome-devtools が出ない。

本物の古い machine が無ければ、この Step は行わない。マウントが無い場合の挙動は、plan-2 の `test_browser_mcp_dropped_on_a_machine_without_the_mount` と `test_warns_on_a_machine_without_the_mount` が確かめる。

spec の信頼性・互換性・セキュリティの残りの項目（ストアが無い、clonefile の失敗、symlink の差し替え、ストアが 0700 でマウントされない、Codex に playwright が残らない）は、plan-1 と plan-2 の単体テストで確かめる。実機では繰り返さない。

### T2: `docs/agent-vm.md` を改訂する

**Files:**

- 編集: `docs/agent-vm.md`
- 参照: `docs/agent-vm.md:121`（V8 の行）、`:155`（未確認の項目。V8 だけを外し、V9 と V12 は残す）
- 参照: spec K7 の箇条

- [ ] **Step 1: 次を書く**

- V8 の結果（F1）。mac の `localhost:<port>` は loopback bind の dev server にも届くこと、`<machine>.orb.local` は `0.0.0.0` bind のときにしか届かないこと（F1、F8）。未確認の項目から V8 を外す。
- 「VM でブラウザを使う」節を新設し、次を書く。
  - 使える MCP（playwright、chrome-devtools。drawio は VM では使わない）。VM の Codex ではブラウザの MCP を使えないこと（Codex の playwright は `@latest` の指定で、利用頻度が低いため別 issue）と、代わりに同じ VM の Claude を使うこと。
  - 人の見方: mac のブラウザで `localhost:<port>` を開く。同じポートでは先に bind した machine に届く（F8）。dev server は既定の loopback bind のまま使う。
  - `localhost` の注意: VM の dev server は、`localhost` にログイン済みのセッションを持つ普段のプロファイルで開かない。host で使うポート（OAuth のコールバックなど）と重ねない。
  - `agent-vm fetch-browsers [--force]` の役割と、警告の一覧（spec K6 の表）。
  - 古い machine で使うには `agent-vm rm` が要ることと、失うもの・残るもの。
  - chrome-devtools-mcp と headless shell の組み合わせは公式サポート外で、確認した版は 0.25.0。版を上げたら T1 の Step 4 を繰り返す。
  - ブラウザ本体は `cdn.playwright.dev` から取得し、内容ハッシュを repo に固定していない（TOFU で、取得後の改変だけを検出する）。
- T1 の実測（容量、MCP の動作、ポートの衝突）を、既存の実機検証の書き方に合わせて記録する。

- [ ] **Step 2: 確認**

実行: `textlint-global docs/agent-vm.md`（グローバルの textlint 設定）
期待: エラー 0。

- [ ] **Step 3: コミット**

```bash
git add docs/agent-vm.md
git commit -m "docs(agent-vm): document browser MCP servers in the VM"
```

### T3: ADR-0018 を改訂し、設計記録を残す

**Files:**

- 編集: `docs/decisions/0018-agent-vm-orbstack.md`
- 新規: `docs/plans/agent-vm/vm-browsers/`（spec、research、plan-1〜3 をコピー）
- 参照: `docs/decisions/0018-agent-vm-orbstack.md:36-45`（K17〜K22）、`:63`（R6）、`:68`（K17〜K22 の帰結）
- 参照: `docs/plans/agent-vm/vm-allowlist/`（前回の設計記録の置き方）

- [ ] **Step 1: ADR-0018 に次を書く**

- 新しい節「VM のブラウザ（K23〜K28、2026-10-01 追記）」に、spec の K1〜K6 の骨子を 1 項目 1〜2 文で書く（spec K7 の「K23〜、2026-09-30」を、K1〜K6 の 6 項目と実装日に合わせて確定した）。
- 「K17〜K22 の帰結」から「playwright、chrome-devtools」を削り、drawio と音声通知は提供しないことを残す。
- K19 の「残す MCP（readability、context7、excalidraw）」に、「Claude はさらに playwright と chrome-devtools を残す（K23〜）」と追記する。
- R6 に `browsers/<m>` を加え、host がその中身を実行も解釈もしないことを書く。
- Consequences に次を書く。
  - F9（isolated machine 同士が IP で届く。#200）を既知の性質として書く。
  - Codex のブラウザ MCP は提供しない（利用頻度が低いので別 issue）。
  - VM の MCP の引数は、共有テンプレートへの VM 分岐ではなく、bootstrap の jq の後処理で設定している。
- References に `docs/plans/agent-vm/vm-browsers/` を足す。

- [ ] **Step 2: 設計記録をコピーする**

根拠: 前回の設計記録の置き方（`docs/plans/agent-vm/vm-allowlist/`）と、`.tmp/sessions/` が 7 日で GC されること（workflow の Session Artifact Retention）。T1 の結果を T2 で書き終え、plan-1〜3 の Approval と marker が確定した後に行う。コピーの後は、`.tmp/sessions/` 側の文書を更新しない。

コピーした spec の K7 は、ADR の節名を「K23〜、2026-09-30」と書いている。実際の節名は「K23〜K28、2026-10-01」にした（T3 Step 1）。spec は承認時の hash を保つため書き換えず、コピーした `docs/plans/agent-vm/vm-browsers/spec.md` の冒頭に「ADR の節名と日付は、実装時に K23〜K28、2026-10-01 に確定した。plan-2 は apt の update を `install_browser_deps` の中で行う（spec K5 の記述を上書き）」と注記を 1 段落足す。

実行: `.tmp/sessions/f95a0c72/` の `spec.md`、`research.md`、`plan-1.md`、`plan-2.md`、`plan-3.md` を `docs/plans/agent-vm/vm-browsers/` にコピーする。

- [ ] **Step 3: 確認**

実行: `textlint-global docs/decisions/0018-agent-vm-orbstack.md`。次に `git add docs/decisions/0018-agent-vm-orbstack.md docs/plans/agent-vm/vm-browsers/` の後で、ADR の中のパスがすべて `git ls-files` に出ることを確かめる（新しいディレクトリは add の後でないと追跡されない）。
期待: textlint のエラーが 0。ADR が参照するパスが、すべて `git ls-files` に出る。

- [ ] **Step 4: コミット**

```bash
git add docs/decisions/0018-agent-vm-orbstack.md docs/plans/agent-vm/vm-browsers/
git commit -m "docs(agent-vm): record the VM browser decisions in ADR-0018"
```

## ISO 25010 具体テストケース

### 機能適合性

- **入力**: VM の Claude に、playwright で `http://127.0.0.1:5174/` のスクリーンショットを頼む → **期待**: `browser_take_screenshot` がエラー無しで画像を返す（T1 Step 4）。
- **入力**: chrome-devtools で `performance_start_trace`（reload、autoStop） → **期待**: `The performance trace has been stopped` を含む応答（T1 Step 4、F5 と同じ）。

### 性能効率（資源効率）

- **入力**: 新しい machine の bootstrap の後の apt の Installed-Size の合計 → **期待**: 40.0 MB 以下（T1 Step 3）。

- **入力**: VM の dev server を mac のブラウザで `http://localhost:5174/` として開く → **期待**: ページが表示される（T1 Step 5）。

### 信頼性

- **入力**: 本物の古い machine（マウント無し）がある場合に、bootstrap を走らせて `agent-vm claude` → **期待**: 起動が成功し、`agent-vm rm` を含む警告が出て、`/mcp` に 2 つの MCP が出ない（T1 Step 7。古い machine が無ければ plan-2 の単体テストで代える）。

## Approval

- Plan Status: complete
- Review Status: pass
- Approval Status: approved

## Reviewer Outputs (Round 1)

### logic-validator
- verdict: needs-work
- 主指摘:
  - 版の更新の手順で、host 側に起きることと元に戻す方法を書いていない。
  - 測れない `df` の基準を置いている。
  - 文字化けしていないかの判定方法を書いていない。
  - 2 台の machine を区別できない。
  - VM の設定を実機で確かめる手順が無い。
  - ADR の K19 の記述が古い。
  - git の追跡の確認を、add より前に行っている。
- 対応: 反映した。

### scope-justification-reviewer
- verdict: needs-work
- 主指摘:
  - 容量の測り方が手順に無い。
  - 使用性の見出しが spec と食い違っている。
  - 古い machine の警告を実機で確かめていない。
  - 版の更新の手順が曖昧。
  - 参照している行番号がずれている。
  - コピーの根拠と順序を書いていない。
- 対応: 反映した（`df` の基準は、logic の指摘に合わせて削った）。

<!-- auto-review: pending -->
<!-- intent-triage: pending -->

## Reviewer Outputs (Round 2)

### logic-validator
- verdict: needs-work
- 主指摘:
  - 世代の名前の区切りが `-` ではなく `.`。
  - 容量の測定で `Install:` 行を拾えず、0MB で誤って PASS する。
  - spec と ADR の節名が食い違う。
  - chrome-devtools の確認が無い。
- 対応:
  - 区切りを直した。
  - awk で拾い、下限の 20MB を足した。
  - コピーに注記を足した。
  - chrome-devtools の args と mode の確認を足した。

### scope-justification-reviewer
- verdict: needs-work
- 主指摘:
  - Step 7 の代わりの手順（印を消す）では、マウントが残るので K6 を検証できない。
  - `<machine>` の取り方が書かれていない。
- 対応:
  - 本物の古い machine があるときだけ Step 7 を行い、無ければ plan-2 の単体テストで代えるようにした。
  - `<machine>` は `agent-vm list` から取ると書いた。

<!-- auto-review: verdict=needs-work; hash=d6dd990f13c15dc07c97c10d102271dac1e59b0551d8c9d59b81ae94ff6dfb80; design-hash=53e0afebb7814dc61e5c76b387fd1b3a25dcee5bdc6b8baf744dc89f1b8f93d3; round=1; parent-spec-hash=369753b259efd4af68a6cd5c35a37403650a06f3b5b674095f0604ad41711fa3; at=2026-10-01T13:56:24.451Z; reviewers=logic-validator+scope-justification-reviewer -->
<!-- intent-triage: adopted=30; excluded=0; at=2026-10-01T13:56:24.505Z -->

## Reviewer Outputs (Round 3)

### logic-validator
- verdict: pass
- 主指摘: low のみ。
  - Step 5 の 3 は、F8 で確かめていない順序に頼っている（合否から外し、観測の記録にした）。
  - history.log のローテーション。
  - `<machine>` の取り方。

### scope-justification-reviewer
- verdict: pass
- 主指摘: low のみ。
  - Codex でブラウザ MCP を使わないことを `docs/agent-vm.md` にも書く（反映済み）。
  - Step 6 で戻した後に jq で確かめる（反映済み）。
  - F9 は #200 で起票済み。

<!-- auto-review: verdict=needs-work; hash=e6c8b813601d182ec0c3f5795af58a690434df371fd9782d2933114ad356b492; design-hash=a7a8545bff246db644b454ce1a2dcceea826fcbb6ec6a14a6295f760f068a27e; round=2; parent-spec-hash=369753b259efd4af68a6cd5c35a37403650a06f3b5b674095f0604ad41711fa3; at=2026-10-01T14:01:30.614Z; reviewers=logic-validator+scope-justification-reviewer -->
<!-- intent-triage: adopted=8; excluded=0; at=2026-10-01T14:01:30.668Z -->

<!-- auto-review: verdict=pass; hash=3069f67ecdcb13f36f90dc67c2319eda947b34d3ff274caa1987d303a9ffd114; design-hash=15501b77a1b2af6b17039b7803647d327cdddf8dd64fc4ccb9173116018adc06; round=3; parent-spec-hash=369753b259efd4af68a6cd5c35a37403650a06f3b5b674095f0604ad41711fa3; at=2026-10-01T14:22:56.391Z; reviewers=logic-validator+scope-justification-reviewer -->
<!-- intent-triage: adopted=5; excluded=0; at=2026-10-01T14:22:56.431Z -->
