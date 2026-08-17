# 管理外ファイルの蓄積検出（未着手）

chezmoi が managed 外のファイルを刈らないため、所有ディレクトリにレガシー層が蓄積する問題への対処。2 ラウンドのレビュー（各 5-7 名）で設計が 2 回反転し、未解決事項が残ったため実装を見送った。

実測はすべて 2026-08-18 時点。関連コミット: `3065dce`（課題 B、`run_onchange` の Hash 修正）。

## 発端

`~/.claude/hooks/` に 2025 年 8-9 月のレガシー層が 132 件蓄積していた（`scripts/` 68、`tests/` 34、`lib/` 9 ほか）。ソース側に `scripts/` ディレクトリ自体が存在せず、ADR-0002 の TypeScript 移行前の残骸だった。参照ゼロを個別確認した上で人手で削除済み。

`chezmoi apply` を何度実行しても管理外ファイルは残るため、リネーム・削除・ディレクトリ再編のたびに層が積もる。「apply が成功した」は「デプロイ済みの状態が正しい」を意味しない。

## 確定した事実

### スコープ設定が本質的な難所

`~/.claude` 配下の管理外は約 15,800 件で、`node_modules` 6475 / `file-history` 3034 / `projects` 2031 / `session-env` 1860 / `plugins` 1816 など**大半が正当な実行時状態**。「管理外 = 陳腐化」とする検出器はノイズ 99.9% になり、`home/dot_claude/rules/code-quality.md` の `## Recoverable State Must Announce Itself`「正常時に鳴る警告は読み手に無視することを学習させる」に正面から反する。

所有ディレクトリを positive に列挙する必要がある。候補は `agents` / `commands` / `hooks` / `lib` / `rules` / `scripts` / `templates` の 7 つで、これは「`~/.claude/` 直下で managed ファイルを 1 件以上持つディレクトリから `skills` を除いたもの」と完全に一致する（`skills/` は `.skills/` からの rsync と APM install で正当に管理外）。

現況（`chezmoi unmanaged` 基準）: `agents/` 6、`scripts/` 4、`commands/` 2、`lib/` 2、`hooks/` 1（`logs` ディレクトリ）、`rules/` 0、`templates/` 0。未 deploy は全ディレクトリで 0 件。

### `chezmoi unmanaged` の意味論

- `chezmoi unmanaged [path]...` がネイティブに存在し、手組みの集合差（`chezmoi managed` × `find` の差）と全 7 ディレクトリで結果が一致する
- **管理外ディレクトリの中には降りない。** ディレクトリを 1 エントリとして返す。`--include=files` を付けるとそのディレクトリエントリが除外され、配下が丸ごと不可視になる（`hooks/logs` が `--include=files` で 0 件、無指定で 1 件）。削除した 132 件も管理外ディレクトリ配下にあり、`--include=files` では取り逃がす
- **複数パスを渡すと、1 つでも不在なら全体が無音になる。** 存在する側の結果も出力されない（rc=1）。`-k` / `--keep-going` を付けると rc=0 になるが**出力はゼロのまま**で、成功を装って何も報告しない状態になる。ディレクトリごとにループすれば正常に動く
- **`.chezmoiignore` に該当するパスは構造的に報告されない。** 所有ディレクトリ配下で `chezmoi ignored` に入るパスは 47 件あり、これらは managed ディレクトリの中にあっても ignored 判定で走査から外れる。現時点で実在するものは 0 件だが、ignore パターン追加前に deploy されたファイルは永久に不可視
- 入れ子実行（`run_after_` の内側から呼ぶ）は安全。rc=0、デッドロックなし。一方 `chezmoi apply` の入れ子は `timeout obtaining persistent state lock` で確実にデッドロックする

### `.chezmoiremove` の意味論

- ソースディレクトリに置く宣言的な削除リスト。テンプレート可能、glob 可、ディレクトリを再帰削除する
- 1 行書くと `chezmoi status` が ` D <path>` を、`chezmoi diff` が `deleted file mode` を表示し、`apply` するまで実ファイルは消えない
- **ディレクトリを書いた場合、`chezmoi diff` は配下の中身を一切表示しない**（`deleted file mode 40755` の 1 エントリのみ）。ファイルなら中身まで出る。C はディレクトリ粒度で報告するため、「報告 → `.chezmoiremove` → diff で確認 → apply」という経路は中身を見ずに再帰削除する導線になる
- **managed なパスと衝突すると `inconsistent state` で apply 全体が停止し、無関係な他の target も一切適用されない。** しかも対象がまだ dest に無い初回だけ rc=0 で通り、次回から壊れる遅延故障。git にコミットされて全マシンに効く
- literal な `../` で destDir の外に出られる（絶対パスと `../*` は no-op）

### `run_after_` スクリプトの制約

- chezmoi は属性 prefix を剥がした名前で辞書順ソートする。数字は英字より前に来るため `run_after_99-...` は `run_after_gc` / `run_after_sync-skills` より**先**に走る。最後に置くなら `zz-` 等
- 非ゼロ終了すると `chezmoi apply` 全体が exit 1 になり、後続の `run_after_` も実行されない。参照実装は `run_after_ensure-hook-deps.sh.tmpl`（`set -e` を使わず `exit 0`）、反例は `run_after_gc.sh.tmpl`（`set -euo pipefail`）
- `$CHEZMOI_EXECUTABLE` / `$CHEZMOI_SOURCE_DIR` / `$CHEZMOI_DEST_DIR` / `$CHEZMOI_CONFIG_FILE` は v2.71.1 で実際に export される。本リポジトリの既存スクリプトは 1 つも使っていない
- **素の `chezmoi` を呼ぶと source は素の config から、dest は環境変数から解決され、食い違う。** 結果は「0 行」ではなく「もっともらしい間違った 201 行」になる。`--source` / `--destination` だけでは不十分で、`[data]` を含む config 自体が再解決されるため `--config "$CHEZMOI_CONFIG_FILE"` も要る
- cwd は destDir。`chezmoi unmanaged` の相対パス引数は cwd 基準で解決されるため、絶対パスを使うべき

## 未解決の設計判断

### 1. liveness シグナルが無い

最も重い。`chezmoi unmanaged` は rc=1 かつ出力 0 行を返す経路があり（不在パス、source state のテンプレート評価失敗）、「検査の失敗は握り潰して apply を落とさない」と「件数ゼロなら無音」を両立させると、**恒久的に壊れた検査ときれいなデプロイが観測上まったく同じ**になる。

C は「壊れていることに気付けない状態」を直す機構なのに、その機構自身が壊れたことに気付けない。rc を明示チェックして「検査失敗」を無音にしない設計が要る（apply を落とさずに報告することは両立する）。

### 2. sanity guard の粒度

「managed ファイル数が 0 なら異常として抑止する」というガードと、「宣言した所有ディレクトリのうち managed 0 件のものを報告する」という陳腐化検出が、同一条件に正反対の動作を要求する。前者を「全ディレクトリ合計が 0」、後者を「各ディレクトリが 0」と読み分ければ両立するが、明示が要る。

加えて、このガードは source 側の指標なので destination 側の崩壊（ディレクトリが dest から消えている）を検出できない。

### 3. allowlist 方式の両方向の陳腐化

- 削除方向: 所有ディレクトリが将来削除されると検査が差分ゼロで沈黙する
- 追加方向: `home/dot_claude/` に新ディレクトリが追加されたのに定数へ追記し忘れると、そのディレクトリは検査対象に入らず静かに蓄積する

後者の緩和として「`~/.claude/` 直下で managed を持つのに定数に無いディレクトリを検出する」を足すと、`skills`（意図的に除外したもの）が毎回鳴り、「正常時に鳴る警告」を自ら作る。既知除外集合が必要になるが、それは allowlist 陳腐化問題を一段上で再生産する。

### 4. 除外の照合方式

`hooks/logs` を prefix で除外すると `hooks/logs-old` や `hooks/logsdir` も巻き込む（`chezmoi unmanaged` はこれらを別エントリとして返す）。エントリ文字列の完全一致にすれば穴は塞がる。

### 5. ディレクトリ粒度と削除経路の衝突

ディレクトリ単位の報告は「`hooks/scripts` 配下が丸ごと管理外」と行動しやすい粒度だが、`.chezmoiremove` にディレクトリを書くと diff が中身を出さないまま再帰削除する。報告に配下ファイル数を含めるか、削除手順に「事前に `ls` せよ」を含めるか。

### 6. `.chezmoiremove` 自動投入の可否

C の設計原則（chezmoi ネイティブを使い独自の削除ロジックを書かない）を最後まで押すと、検出結果を `.chezmoiremove.tmpl` に自動投入する案に行き着く。棄却根拠は 2 つあり、いずれも記録に値する。

- `.chezmoiremove.tmpl` は同じ apply の中で `run_after_` より前にレンダリングされるため、自動投入すると人間のレビュー段階を挟まず同じ実行内で削除が走る
- `chezmoi unmanaged` の結果は完全に解決された target state に依存し、その target state は `.chezmoiremove` の内容に依存するため自己参照になる

### 7. `~/.claude/` 直下の managed 層

`.claude/CLAUDE.md` / `README-permissions.md` / `insight-distill-deny.txt` / `insight-distill-redact.txt` / `package.json` は managed だが、`.claude/` ルート自体は所有ディレクトリではないため、ここに落ちた残骸は検出対象外になる。実際にルート直下の管理外 52 件の中に `debug_session.js` / `exact_package.json` / `permissions.json.backup-2025-09-14T08-32-17` / `plugin-dependencies.json` が実在する。

## 検出できることが確認済みのケース

以下は `chezmoi unmanaged` で正しく検出される（レビューで構成して確認）。

- managed サブディレクトリ内の残骸
- 壊れた symlink
- 深いネスト（親ディレクトリの 1 エントリとして）
- ソースが削除された managed ファイル（実環境の 14 件がこれ）

## 検査対象を `~/.claude/` に限る理由

`~/.codex/` / `~/.config/` / `~/.shell_common/` も `home/dot_*/` → deploy 先という同型構造を持ち、原理的に同じ蓄積が起こり得る。調査起点が `~/.claude/hooks/` の運用問題であり他ルートでの実害は未調査のため、対象拡大は実害の観測を待つ。
