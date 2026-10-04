# Spec: file-access-guard のパス判定の強化（#241 の項目 2・4）

事実の出典は同じディレクトリの `research.md`。パスは `home/dot_claude/hooks/` 起点、行番号は `d6ce00a` 時点。

2026-10-04 にユーザーが spec を 2 つに分けることを選んだ。この spec は判定側（項目 2、項目 4、`..` の件、NotebookEdit の登録）を扱う。Bash の抽出と登録（項目 3）は別の spec にし、Round 1〜4 のレビューで固まった設計と未解決の指摘は research 6 に残した。末尾の Reviewer Outputs の Round 1〜4 は、分ける前の spec に対するもの。

## Goal

file-access-guard が「許可したルートの中に見えるが、実際には外に届くパス」を通さないようにする。そのために、symlink を解決した位置も判定し、`..` を含む絶対パスを拒否し、NotebookEdit を検査の対象に加える。あわせて、file-access-guard、document-workflow-guard、pattern-matcher の 3 つで、一時ディレクトリのルートの列挙を 1 か所にする。permission-auto-approve は K5 のとおり対象外。

## Experience Delta

変更前（hook を直接呼んだ実測。research 3.2〜3.4）:

- 配布している設定に `Edit(/tmp/**)` があるので、`/tmp/<外を指す symlink>/x` への Write が通る
- `/home/user/project/../../../etc/passwd` の Read と Write が通る。`~/.claude/../…` と additionalDirectories の `..` も通る
- NotebookEdit は file-access-guard の登録に入っていないので、検査されない（research 5.1）

変更後:

- 上の操作は deny になる。`..` を含む絶対パスは、行き先にかかわらず deny（K2）。symlink を経由するパスは、行き先が許可の外なら deny（K1）。理由には、書かれた形のパス、解決後のパス、どの形のどの step で拒否したかが出る
- repo の中にとどまる `..` 入りの絶対パス（`/home/user/project/src/../README.md`）と、相対パスの途中の `..`（`a/../b`）も deny になる（今は通る。R9）。相対パスの先頭の `..`（`../README.md`）は `..` の検査では止めず、今までどおり行き先で判定する
- dotfiles の repo では、HOME 配下の Read は今も step 6b が通している（research 5.5）。`~/.ssh/id_rsa` のように `..` も symlink も使わない Read は、この repo では通るまま
- NotebookEdit にも同じ判定が当たる
- file-access-guard 以外の hook の変化: find の自動承認は、開始パスが `/tmpx/y` や `/tmp/../etc` のときに当たらなくなる（確認の質問が出る）。document-workflow-guard は、`a..b` のように名前に `..` を含むだけのリテラルを拒否しなくなる
- repo の中の相対パスと、`/tmp`・scratchpad・`mktemp -d` の出力先への読み書きは今までどおり通る
- repo の中に置いた、repo の外を指す symlink を経由する Read / Write は deny になる（今は通る。R1）
- 一時ディレクトリのルートの列挙は、file-access-guard、document-workflow-guard、pattern-matcher の 3 つについて `lib/temp-roots.ts` の 1 か所になる。permission-auto-approve は literal の `/tmp` のまま（K5）
- 独自の `$TMPDIR`（項目 5）は今までどおりルートにしない。2026-10-04 にユーザーが「提供しない」を選んだ（K6）
- Bash のコマンドに書かれたパスは、今までどおり file-access-guard に検査されない（別の spec で扱う）

## Architecture

```
lib/path-containment.ts（新設）
  isUnderRoot(p, root)             セグメント境界つきの字句の包含判定。`..` は見ない
  hasParentSegment(p)              `..` というセグメントを含むか
  resolveWithMissingTail(path)     workflow-fs.ts から移す。workflow-fs.ts は再 export する
  resolvePhysicalPath(absPath)     `..` を含まない絶対パスの、symlink を解決した位置を返す
      → { ok: true, path } | { ok: false, code }   例外は外へ出さない
lib/temp-roots.ts（新設）
  collectTempRoots(tmpdir, realpath)   file-access-guard.ts から移す。ルートの列挙だけを持ち、判定は持たない

implementations/file-access-guard.ts
  validatePath: 生のパスから「字句の形」「物理の形」を 1 回ずつ作り、両方が許可されたときだけ通す
implementations/permission-auto-approve.ts   hasParentSegment を使う
implementations/document-workflow-guard.ts   collectTempRoots("", realpathSync)、isUnderRoot、hasParentSegment を使う
lib/pattern-matcher.ts                       find の開始パスの判定に collectTempRoots("", realpathSync) と isUnderRoot を使う
.settings.hooks.json.tmpl                    file-access-guard の matcher に NotebookEdit を足す
```

依存の向きは `implementations/*` → `lib/*` の一方向。`lib/workflow-fs.ts` → `lib/path-containment.ts`。`lib/path-containment.ts` と `lib/temp-roots.ts` は node の標準モジュールと `lib/path-utils.ts` だけを import する。

### `validatePath` の流れ

1. `..` の検査（K2）。`path` が `/` で始まり、`..` のセグメントを含むなら deny（`step=parent-segment`）。相対パスは、先頭に並ぶ `..` だけを許し、`..` 以外のセグメントの後ろに `..` があれば deny（`sub/../x`、`../a/../b`）。`.` のセグメントは数えない（`./../x` は `../x` と同じ扱いで通る）
2. 字句の形を作る。絶対パスはそのまま（`//` と `/./` だけ `posix.normalize` で畳む）。相対パスは `resolve(cwd, path)`。`cwd` は `CLAUDE_TEST_CWD`、無ければ `process.cwd()` で、どちらも `resolvePhysicalPath` に通して物理的なパスにしてから使う（解決できなければ deny）。今の `resolvePath` は相対パスを `realpathSync(path)` で解くが、この経路は使わなくなる。1 を通った入力なので、字句の形に `..` は残らず、symlink の手前で `..` が畳まれることも無い。物理の形 = `resolvePhysicalPath(字句の形)`。`ok: false` なら deny（K3）
3. 物理の形が `realpath(HOME)` か `realpath(repoRoot)` の配下（`isUnderRoot` で判定）なら、その接頭部を HOME、repoRoot の書かれた形に置き換える。両方に当たるときは長い方、同じ長さなら repoRoot。置き換えの対象はこの 2 つだけ。どちらかの realpath を求められないときは、その置き換えをせずに判定する。相対パスから作った字句の形は、物理的なパスにした cwd を基点にしているので、同じ置き換えを当てる（HOME や repoRoot が symlink 経由のときに、字句の形が step 1 に当たらなくなるのを防ぐ。plan-1 のテストで固定する）
4. 今の step の並び（1 repoRoot → 1.5 一時ディレクトリ → 1.6 workflow dir → 2 システムディレクトリの拒否 → 3 `~/.claude` → 4 additionalDirectories → 5 allow パターン → 6 chezmoi → 既定の拒否）を 1 つの関数 `judge(form, { category, allowPatterns })` にまとめ、字句の形と、3 を経た物理の形のそれぞれに当てる。`category` は `"read"` か `"write"` で、今の `toolName` による分岐（step 4、step 6）をこれに置き換える。並びは変えない。既存のテストが並びに依存しているためで、ルートの表への組み直しはこの spec の範囲に入れない
5. 両方が allow のときだけ allow。字句の形と物理の形が別々のルートで許可されてもよい（例: `/tmp/link` が repo の中のファイルを指す）
6. 一時ディレクトリと workflow dir のルートは、書かれた形と realpath の形の両方を今も持っている（`collectTempRoots`、`getWorkflowDirRoots`）。step 3 の `~/.claude` と additionalDirectories は、書かれた形とその realpath の両方を物理の形に当てる。realpath は照合が必要になった時点で求め、求められないときは書かれた形だけを当てる
7. システムディレクトリの一覧（拒否）は、書かれた値とその realpath の両方を物理の形に当てる。realpath を求められないときは書かれた値だけを当てる（拒否は減らさない）。今と同じく、allow パターンでも上書きできない
8. allow パターン（step 5）は realpath しない。字句の形にも物理の形にも、書かれたままのパターンを当てる

step 1.5 / 1.6 は今は `isWithinTempRoots` が別の解決で判定しているが、変更後は 4〜6 の規則に入る普通のルートになる。`isWithinTempRoots` は名前、シグネチャ、`..` を含むパスを拒否する挙動を保ち、物理の位置を求める部分を `resolvePhysicalPath` に差し替える。

## Alternative Approaches (Greenfield View)

### 差分最小案 (Incremental)

- 項目 4: 一時ディレクトリのルート配下に見えるパスは step 1.5 の結論を最終にし、step 5 へ落とさない
- `..`: 絶対パスに `..` があれば拒否する
- 項目 2: `"/tmp"` の列挙を定数にして 3 つの hook から import する

symlink については、閉じるのは `/tmp` の配下だけで、repo の中や additionalDirectories の配下の symlink が外を指す場合は残る。`..` の拒否は、採用案もこの案のものを使う。

### 白紙設計案 (Greenfield)

パスの判定を「解決」と「方針」に分ける。解決は入口で 1 回だけ行い、方針（どのルートを許すか）は解決済みの形だけを見る。一時ディレクトリは特別扱いせず、許可するルートの 1 つにする。判定はツール名ではなく、読み取りか書き込みかのカテゴリを受け取る。

この形になる理由（起源）: 今の穴は、step ごとに正規化の度合いが違う文字列を見ていることから出ている。step 1.5 だけが物理位置を確かめ、step 5 の glob だけが `..` を畳み、残りは生の文字列を見る（research 3.1〜3.4）。解決を 1 か所に寄せれば、step を足すたびに同じ検査を書き直す必要がなくなる。カテゴリを受け取る形にしておけば、後から別のツール（Bash のオペランドなど）を同じ判定に渡せる。

### 採用案と理由

白紙設計案を採る。

- symlink の判定は白紙設計案を採る。差分最小案は step 1.5 の結論を最終にするだけなので、一時ディレクトリ以外のルート（repo、additionalDirectories）の中の symlink が外を指す場合が残る
- research 3.3 と 3.4 の実測で、step 1、step 3、step 4 が `..` 入りの絶対パスを通すことを確認した。これは K2 の `..` の検査で閉じる。相対パスの先頭の `..` だけを通すのは、基点の cwd が物理的なパスで、そこから親へ上がるだけなら symlink をまたがないため
- 一時ディレクトリを普通のルートにする根拠: Round 1 のレビューで、`isWithinTempRoots` を別経路のまま残すと解決の実装が 3 通り（`resolvePath`、`rawAbs` + `isWithinTempRoots`、`resolvePhysicalPath`）併存し、`..` の意味も 2 つになると指摘された。`isWithinTempRoots` の名前、シグネチャ、`..` を含むパスを拒否する挙動を保てば、`tests/unit/file-access-guard.test.ts` の既存テストが退行の検出に使える。`..` を含む既存テストの入力は、絶対パスか、相対パスの先頭の `..` で repo の外に出るもので、どれも期待値は deny / false のまま（research 5.4）
- `..` の扱いは、差分最小案の「絶対パスに `..` があれば拒否する」を採る（K2）。白紙設計案の「解決を入口で 1 回」は、`..` を解決する代わりに受け付けないことで満たす

## Key Decisions

- **K1: 字句の形と物理の形の両方が許可されたときだけ通す** — すべての step を 2 つの形のそれぞれに当てる。項目 4 の symlink は「字句の形は中、物理の形は外」なので、この規則で閉じる。`..` を含むパスは K2 が先に止めるので、ここに来るパスに `..` は無く、物理の形は 1 つに決まる。allow パターンは realpath しない。パターンの固定部分を realpath すると、エージェントが書ける場所（`/tmp` の下など）に置いた symlink で許可範囲を動かせるため。物理の形の接頭部を書かれた形へ戻すのは HOME と repoRoot に限る。repoRoot は git が決める値。HOME は `process.env.HOME` から取る（`lib/path-utils.ts:27`）。今の step 3 と step 6 も同じ値を信頼しており、この spec でも HOME は信頼する前提にする。HOME は既に信頼している値なので、新しく開くものは無い。`$TMPDIR` を信頼しない（K6）のは、信頼すると新しい書き込み可能なルートが増えるためで、扱いが違うのはこの差による。プロジェクトの設定の `env` で HOME を動かせる場合の扱いは #241 に残す。戻す理由: `/home` が別の場所への symlink である環境（`/home` → `/var/home`、`/home` → `/data/home`）で、物理の形が step 2 の `/var` に当たったり、`Edit(~/foo/**)` に当たらなくなったりするのを防ぐ
  - 参照: `implementations/file-access-guard.ts:462-515`（`validatePath` の step 1〜1.6）
  - 参照: `implementations/file-access-guard.ts:516-587`（step 2〜5。文字列だけの照合）
  - 参照: `lib/pattern-matcher.ts:198-229`（`matchAbsoluteGlob`。`..` は畳むが symlink は見ない）
- **K2: `..` を含む絶対パスは deny にし、相対パスは先頭の `..` だけを通す** — 2026-10-04 にユーザーが選んだ。絶対パスに `..` のセグメントがあれば、行き先にかかわらず deny（`step=parent-segment`）。相対パスは、先頭に並ぶ `..`（`../README.md`、`../../x`）だけを通し、ほかのセグメントの後ろに `..` があれば deny。deny の理由に「`..` を使わないパスで書き直す」と出す。この規則を通ったパスの字句の形には `..` が残らないので、物理の形は `resolveWithMissingTail` 1 回で決まる。先頭の `..` を通してよい理由: 基点の cwd は `process.cwd()` が返す物理的なパスで、そこから親へ上がるだけなら symlink をまたがない。却下した案は「`..` の手前を物理的に解決してから親へ上がる」（Round 1〜5 の案）。symlink の途中に `..` があるパスは、OS に任せて開く場合と、先に字句的に畳んでから開く場合とで位置が違い、ツールがどちらで開くかを確認していない（R5）。両方の位置を判定する案は Round 5 の後に書いたが、形の列挙が閉じているかをレビューで確かめる必要が残る。一律に deny にすれば、その確認が要らない。一時ディレクトリは今も `..` を含むパスを拒否している（`isWithinTempRoots`）ので、同じ扱いを全体に広げる形になる。影響: `/home/user/project/src/../README.md` のように、repo の中にとどまる `..` 入りの絶対パスも deny になる（今は通る。R9）
  - 参照: `implementations/file-access-guard.ts:324-337`（`resolvePath`。相対パスは realpath、絶対パスは無加工）
  - 参照: `implementations/file-access-guard.ts:344-351, 394-407`（`hasParentSegment` と、`isWithinTempRoots` の `..` の拒否。bun の `realpathSync` が `sym/..` を字句的に畳むという実測のコメント）
  - 参照: `lib/workflow-fs.ts:103-108`（`resolveWithMissingTail` は字句の正規化済みの入力を前提にする。K2 を通ったパスは `..` を含まないので前提を満たす）
- **K3: 物理の形を解決できないパスは deny し、理由を分ける** — dangling symlink、`ELOOP`、`EACCES`、`ENOTDIR`、NUL バイトを含むパスは「検査できなかった」であって「存在しない」ではない。`resolvePhysicalPath` は `..` の処理を含めて例外を投げず `{ ok: false, code }` を返す。存在しないパス（これから作るファイル）は、最寄りの既存の祖先を解決して残りを付け直す。`validatePath` の中で起きた例外も `{ ok: false, code }` に寄せ、外側の catch（:97-101）の欄の無い文言に落とさない。deny の理由は次の欄を持つ: `lexical=<字句の形>`、`physical=<物理の形>` または `unresolvable=<code>`、`denied-form=lexical|physical`、`step=<拒否した step。2-system、default など>`。物理の形だけが拒否されたときは、設定に足す値（物理の形のパス）を 1 行で示す。`unresolvable=` のときは、原因ごとの直し方を 1 行で示す: dangling symlink は「リンク先を作るか、リンクを消す」、`ELOOP` は「symlink の循環を解く」、`EACCES` は「途中のディレクトリの権限を確かめる」
  - 参照: `lib/workflow-fs.ts:89-133`（`resolveWithMissingTail`）
  - 参照: `implementations/file-access-guard.ts:87-101`（今の deny の文言と、例外を deny にする catch）
- **K4: 共有するのは部品とルートの列挙で、方針は各 hook に残す** — 下の表のとおり。`isUnderRoot` は字句の判定だけを行い、`..` の扱いは呼ぶ側が `hasParentSegment` で決める。`realpathInsideWorkflowDir` と `isStrictlyUnderProjectSubdir` は統合しない（`lib/workflow-fs.ts:37-44` に、統合すると穴が開くと書いてある）。`isStrictlyUnderProjectSubdir` は「基点そのものを拒否し、基点が symlink でも拒否する」判定で、`isUnderRoot`（基点そのものを受け入れる字句の判定）とは別物

  | hook                               | 共有する部品                                                                        | 残す方針                                                                                                                                                                    |
  | ---------------------------------- | ----------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | file-access-guard（A）             | `isUnderRoot`、`resolvePhysicalPath`、`collectTempRoots(os.tmpdir(), realpathSync)` | `$TMPDIR` は macOS の形だけ受け入れる                                                                                                                                       |
  | permission-auto-approve（B）       | `hasParentSegment`                                                                  | 自セッションの scratchpad の形だけを自動承認する。ルートは literal の `/tmp` のまま（K5）。`$TMPDIR` は見ない。`..` を含むパスは拒否。包含は `isStrictlyUnderProjectSubdir` |
  | document-workflow-guard（C）       | `collectTempRoots("", realpathSync)`、`isUnderRoot`、`hasParentSegment`             | リテラルを cwd で解決せず、書かれた文字列のまま比べる。`..` を含むリテラルは拒否                                                                                            |
  | pattern-matcher（find の開始パス） | `collectTempRoots("", realpathSync)`、`isUnderRoot`、`hasParentSegment`             | `..` を含む開始パスは自動承認しない                                                                                                                                         |

  `collectTempRoots("", …)` は `/tmp` とその realpath だけを返す（既存テスト `yields only /tmp for the Linux default`）。C の `..` の判定は部分文字列からセグメント単位に変わり、`a..b` という名前のリテラルを巻き込まなくなる。pattern-matcher の `/^\/tmp/` は `/tmpx/y` と `/tmp/../etc` にも一致する（research 5.4）
  - 参照: `implementations/file-access-guard.ts:353-385`（`collectTempRoots`、`isUnderRoot`）
  - 参照: `implementations/permission-auto-approve.ts:381-414`（`isSessionScratchpadSafe`）
  - 参照: `implementations/document-workflow-guard.ts:582-667`（`isUnderSegmentRoot`、scratch roots、:652 の `includes("..")`。:611-619 に、cwd で解決しない理由）
  - 参照: `lib/pattern-matcher.ts:128-140`（find の開始パス）

- **K5: B の scratchpad のルートは変えない** — `isSessionScratchpadSafe` は `segments[0] !== "tmp"` で literal の `/tmp` に固定している。`collectTempRoots` に寄せると `/tmp` の realpath の形（macOS の `/private/tmp`）も自動承認の対象になるが、自動承認が広がる向きの変更で、必要としている実測や使用例が無く、macOS の実機でも確かめていない（Round 5 の指摘）。B が共有するのは `hasParentSegment` だけにする。項目 2 の「literal `/tmp` の判定の共通化」のうち、B の分は #241 に残す
  - 参照: `implementations/permission-auto-approve.ts:381-414`
- **K6: 独自の `$TMPDIR`（項目 5）は一時ディレクトリのルートにしない** — 2026-10-04 にユーザーが選んだ。`$TMPDIR` はプロジェクトの `.claude/settings.json` の `env` で設定できるので、値をそのまま信用すると、信頼していない repo が書き込み可能なルートを決められる。必要な環境では、ユーザーの設定に `additionalDirectories` と `Edit(<そのディレクトリ>/**)` を書けば step 4 で通る（Read は `additionalDirectories` だけで通る）。この環境は `TMPDIR` が未設定で、管理下の設定にも `TMPDIR` を設定する箇所はない（`git grep TMPDIR -- home` で確認）。現状（`TMPDIR=/run/user/<uid>` がルートにならない）をテストで固定し、理由と設定の書き方を #241 に書く
  - 参照: `implementations/file-access-guard.ts:339-342`（`$TMPDIR` を信用しない理由）
  - 参照: `implementations/file-access-guard.ts:552-579`（step 4。代替の経路）
- **K7: `/var/tmp` の扱いは変えない** — `alwaysSafePaths` に `/var/tmp` があるが、先に step 2 の `/var/` の拒否に当たるので、今も `/var/tmp/x` への Write は deny（research 3.4 で実測）。この spec は判定の順序を変えないので、deny のままになる。現状をテストで固定し、到達しない行があることを #241 に書く
  - 参照: `implementations/file-access-guard.ts:516-550`
- **K8: file-access-guard の matcher に NotebookEdit を足す** — 2026-10-04 にユーザーが選んだ。今の matcher は `Read|Write|Edit` で、hook のコードにある NotebookEdit の分岐は起動されない（research 5.1）。NotebookEdit は書き込みのツールで、`extractFilePaths` は `notebook_path` を既に取り出している（:240-249）。step 4 の書き込みの分岐に NotebookEdit が無い（:565-569）点は、`judge` が `category` を受け取る形にすることで直る（NotebookEdit は `"write"`）。起動されるツールのうち、`category` への置き換えで結果が変わるのは NotebookEdit だけ。plan-1 のテストで、NotebookEdit の repo の外への書き込みが deny、repo の中への書き込みが allow になることを固定する。hook のコードにある Glob、Grep、LS、NotebookRead、Bash の分岐は消さない。Glob、Grep、LS、NotebookRead は `"read"` に写す。今の step 4 が additionalDirectories の配下で自動許可するのは Read と LS だけ（:559）なので、Glob、Grep、NotebookRead は step 4 で通る側に変わる（どれも起動されないので、実際の挙動は変わらない）。Bash にはカテゴリを与えず、今と同じく step 4 と step 6 を素通りして既定の拒否に落とす。`extractPathsFromBashCommand`（:280-322）は触らず、テストも足さない。別の spec で置き換える。Glob と Grep は matcher に足さない（ユーザーの選択。読み取りで、repo の外を探す用途を止めるため）
  - 参照: `home/dot_claude/.settings.hooks.json.tmpl:35-39`（file-access-guard の登録）
  - 参照: `implementations/file-access-guard.ts:39-53`（`fileTools`。届かないツールも並んでいる）
  - 参照: `implementations/file-access-guard.ts:216-278`（`extractFilePaths`）
  - 参照: `implementations/file-access-guard.ts:552-579, 589-623`（step 4 と step 6 の `toolName` による分岐）

## Risks

- **R1**: repo の中に、repo の外を指す symlink を置いている運用が K1 で止まる → 物理の形が additionalDirectories か allow パターンに当たれば通る。K3 の deny の理由に物理の形のパスが出るので、設定に書く値が分かる。この repo では `.tmp/docs/CONTEXT.md` → `../../CONTEXT.md` が該当するが、指す先は repo の中なので通る
- **R2**: allow パターンの対象ディレクトリが symlink のとき（例: `Edit(~/.local/**)` で `~/.local` が別の場所を指す）、物理の形がパターンに当たらず deny になる → K1 のとおりパターンは realpath しない。K3 の deny の理由に出る物理の形のパスを、ユーザーがパターンとして設定に足す。HOME そのものが symlink の場合は、流れの 3 が書かれた形へ戻すので当たる（テストで固定する）
- **R3**: additionalDirectories に書いたディレクトリそのものが、エージェントの書ける場所（`/tmp` の下など）にあって symlink に置き換えられると、その realpath が動く → 防げない。この制限を #241 に書く
- **R4**: 判定の後、実行までの間にパスの実体が変わる場合は防げない → hook の判定は呼び出しごとの 1 回で、`lib/workflow-fs.ts:65-66` と同じ前提。#241 に書く
- **R5**: Claude Code 本体が `file_path` を正規化してから hook に渡すかは確認していない。research 3.3 と 3.4 の `..` の実測は hook を直接呼んだもの → 本体が渡す前に正規化していれば、K2 の `..` の検査は当たらないだけで害は無い。本体が生の値を渡す場合は、ツールが `..` をどの順序で解決して開くかにかかわらず、K2 が先に deny にする。symlink（項目 4）は本体の正規化では畳まれないので、K1 の必要性は本体の挙動に左右されない。hook を直接呼んだ実測が本体経由の挙動を保証しないことを #241 に書く
- **R6**: 許可するルートの realpath を求める呼び出しが、NFS や FUSE の障害で返らない場合は防げない。run-guard の 20 秒のタイムアウトで呼び出しが止まる → realpath を求めるのは、照合に必要になったルートだけにする（流れの 6）。この制限を #241 に書く
- **R7**: macOS の既定のファイルシステムは大文字と小文字を区別しないが、`isUnderRoot` は区別する → 許可するルートについては、食い違うのは `/TMP/x` のように設定と違う綴りで書いた場合で、字句の形がどのルートにも当たらないので deny の側に倒れる。step 2 の拒否の一覧は逆で、`/ETC/x` が `/etc` に当たらず、additionalDirectories や allow パターンが広いと拒否が効かない。macOS では step 2 の照合を小文字にそろえて行う（`process.platform === "darwin"` のとき）
- **R8**: `lib/path-containment.ts` と `lib/temp-roots.ts` は file-access-guard、permission-auto-approve、document-workflow-guard、pattern-matcher、`lib/workflow-fs.ts` から import されるので、どちらかに構文エラーや配布の漏れがあると、複数の hook が同時に止まる。今は file-access-guard の不具合で止まるのは file-access-guard だけ → plan-1 の最初のタスク（挙動を変えない移動）で、これらを import する hook の入口をすべて bun で起動する確認を入れ、以後のタスクでも毎回走らせる。配布は `chezmoi apply` が `lib/` と `implementations/` を一括で置く。止まった場合の復旧: Read / Write / Edit / NotebookEdit が file-access-guard で止まっても、Bash は file-access-guard に登録されていないので、`git revert` と `chezmoi apply` は Bash から打てる。document-workflow-guard が止まると Bash も止まるが、これは今も同じで、run-guard の文言が出る

- **R9**: K2 で、repo の中にとどまる `..` 入りの絶対パス（`/home/user/project/src/../README.md`）と、相対パスの途中の `..`（`a/../b`）が deny になる。今は通っている → ユーザーが選んだ変更。deny の理由に、`..` を使わないパスで書き直すと出すので、エージェントは次の呼び出しで直せる。Read / Write / Edit の `file_path` は絶対パスで渡す決まりで、`..` を含める必要のある操作は無い。相対パスの先頭の `..` は通る

## Phase 1 で意図的に提供しない体験

### `..` を含む絶対パスを解決して通すこと

- **代替経路確認**: `lib/workflow-fs.ts:109-133`（`resolveWithMissingTail`。`..` を含まないパスなら 1 回で物理の位置が決まる）。`..` を使わないパスで書き直せば通る
- **非提供対象**: `/repo/src/../README.md` や `/tmp/a/../b` のように、許可するルートの中にとどまる `..` 入りの絶対パスを通すこと
- **将来の予定**: 提供しない。理由は K2

### Bash のコマンドに書かれたパスの検査（項目 3）

- **代替経路確認**: 無い。file-access-guard は Bash で起動されない（`home/dot_claude/.settings.hooks.json.tmpl:35`。research 5.1）
- **非提供対象**: Bash の抽出の作り直しと、matcher への Bash の追加
- **将来の予定**: 別の spec で扱う。ユーザーは 2026-10-04 に「Bash を登録して効かせる」を選び、その後に spec を分けることを選んだ。Bash を登録する選択は取り下げておらず、別の spec が引き継ぐ。Round 1〜4 のレビューで固まった設計と未解決の指摘は research 6 にある。システムディレクトリの読み取りを allow パターンで上書きできるようにするかどうかも、そこで決める。この spec が終わった後も、Bash のコマンドに書かれたパスは `..` や symlink を含めて検査されない

### 独自の `$TMPDIR` をルートにする（項目 5）

- **代替経路確認**: `implementations/file-access-guard.ts:552-579`（additionalDirectories と allow パターン。ユーザーの設定に書けば通る）
- **非提供対象**: `$TMPDIR` の値から一時ディレクトリのルートを自動で導くこと（macOS の形を除く）
- **将来の予定**: 提供しない。理由は K6

### permission-auto-approve の `/tmp` の判定の共通化（項目 2 のうち B の分）

- **代替経路確認**: `implementations/permission-auto-approve.ts:397-406`（`isSessionScratchpadSafe` は literal の `/tmp` で判定を続ける。Linux の scratchpad は今までどおり自動承認される）
- **非提供対象**: scratchpad のルートを `lib/temp-roots.ts` の列挙から取ること
- **将来の予定**: #241 に項目として残す。理由は K5

### Glob と Grep の `path`

- **代替経路確認**: 無い。matcher に入れないので hook が起動されない（`home/dot_claude/.settings.hooks.json.tmpl:35`）
- **非提供対象**: Glob と Grep が repo の外を読むことの検査
- **将来の予定**: 2026-10-04 にユーザーが「今回は足さない」を選んだ。#241 に項目として残す

### dotfiles の repo での、HOME 配下の機密ファイルの読み取り

- **代替経路確認**: 無い。`implementations/file-access-guard.ts:609-622`（step 6b）が HOME 配下の読み取りをすべて許可する
- **非提供対象**: `~/.ssh`、`~/.aws`、`~/.gnupg` などを step 6b の前で拒否すること
- **将来の予定**: #241 に項目として残す。今も同じ状態で、この spec で新しく開くものではない

## ISO 25010 次元選択

- **セキュリティ（機密性・完全性）**: 許可していないパスへの読み書きを止めることが目的
- **機能適合性（正確性）**: 正当なパス（相対パスの先頭の `..`、scratchpad、`mktemp -d`、macOS の `/private/tmp`、HOME が symlink の環境）を止めないこと。今の実装が deny にする入力を引き続き deny にすること
- **信頼性（障害許容性）**: パスを解決できないときに、例外で落ちずに理由つきで deny すること
- **保守性（モジュール性）**: 包含判定とルートの列挙を `lib/` に寄せ、hook ごとの方針と分けること
- **対象外**: 性能効率性（1 回の呼び出しで realpath が数回増えるだけ）、使用性（操作は変わらない。deny の文言に欄が増えるだけ）、移植性（対象 OS は今と同じ Linux と macOS）

## 実行計画の分け方

- **plan-1**: K1〜K8 の全部。`lib/path-containment.ts`、`lib/temp-roots.ts`、`file-access-guard.ts` の `validatePath`、`permission-auto-approve.ts`、`document-workflow-guard.ts` のルートの列挙と `..` の判定、`lib/pattern-matcher.ts` の find の開始パス、`.settings.hooks.json.tmpl` の matcher。最初のタスクは `resolveWithMissingTail` と `collectTempRoots` の、挙動を変えない移動と、R8 の起動の確認。最後のタスクは、#241 に書く内容（Bash の検査が別の spec になったことと research 5 の経緯、K5 で残した B の `/tmp` の判定、K6 の理由と設定の書き方、K7 の到達しない行、HOME を信頼する前提、R3、R4、R5、R6、「提供しない体験」の各項目）のコメントの下書きで、投稿はユーザーの確認の後に行う。`bash-parser.ts`、`deny-input.ts`、`executable_run-guard.sh` には触れない

## Approval

- Plan Status: complete
- Review Status: pass
- Approval Status: approved

## Reviewer Outputs (Round 1)

### logic-validator

- verdict: needs-work
- 主指摘: R2 の対処（allow パターンの固定部分を realpath した形も照合に足す）は、固定部分がエージェントの書ける場所を通ると symlink の穴を開け直す。`resolvePhysicalPath` に `resolve()` 済みの文字列を渡すと `sym/..` が先に畳まれるので、入力は生の文字列にする必要がある。

### scope-justification-reviewer

- verdict: needs-work
- 主指摘: 項目 5 を提供しない K6 は、オーダーが項目 5 を進めることなので、ユーザーへの明示の確認が要る。step 3・4・6 に K1 を広げる根拠（research 3.4）が未実測。

### decision-quality-reviewer

- verdict: pass
- 主指摘: 支配軸（誤 allow の防止）と各判断は合っている。K10 の「判定しない」範囲を「提供しない体験」に明記し、語の形で絞るとよい。

### greenfield-perspective-reviewer

- verdict: needs-work
- 主指摘: K8 の表から `chmod` / `chown` が抜けており、今の実装より防御が減る。`isWithinTempRoots` を残すと解決の経路が 2 本、`..` の意味が 2 つになる。

### architecture-boundary-analyzer

- verdict: needs-work
- 主指摘: `extractPathOperands` のシグネチャが無く、document-workflow-guard（書き込み先だけ）と file-access-guard（読み取り元とリンク元も）の要件の違いをどこで切るかが決まっていない。`resolveWithMissingTail` は `path-containment` に移し、`workflow-fs` から再 export する向きがよい。

### security-vulnerability-analyzer

- verdict: needs-work
- 主指摘: 許可ルートを呼び出しのたびに realpath する一般則は、エージェントが置いた symlink で許可範囲を動かせる（high）。step 1.5 / 1.6 の入力 `rawAbs` が字句の形とも物理の形とも別で、解決が 3 通り併存する（high）。

### resilience-analyzer

- verdict: needs-work
- 主指摘: `prepareDenyInput` が例外を投げたときの扱いと、ルートの realpath が失敗・遅延したときの扱いが決まっていない。deny の理由に、どちらの形が落ちたかと解決できなかった理由が出ない。

<!-- auto-review: pending -->
<!-- intent-triage: pending -->

## Reviewer Outputs (Round 2)

### logic-validator

- verdict: needs-work
- 主指摘: dotfiles の repo では step 6b が HOME 配下の読み取りを通すので、Bash の `cat ~/.ssh/id_rsa` は deny にならず、Experience Delta と食い違う。step 4 の書き込みの分岐に NotebookEdit が無い。`cat {/etc/passwd,x}` がブレース展開で素通しになる。

### scope-justification-reviewer

- verdict: pass
- 主指摘: Bash のシステムディレクトリの読み取りには設定での回避経路が無く、「提供しない体験」にも載っていない。デバイスファイルの一覧の出典と、判定ログに Bash のコマンドと cwd があることの確認が無い（いずれも記述の補強）。

### decision-quality-reviewer

- verdict: needs-work
- 主指摘: Bash のシステムディレクトリの読み取りを上書き不可で拒否するのは誤 deny の側に倒しすぎ。読み取りは allow パターンで上書きできるようにする。`ls ../*.ts` のように `..` が展開の記号より前にある語まで deny にしている。

### greenfield-perspective-reviewer

- verdict: pass
- 主指摘: 白紙案と採用案は同じ形。`judge` がツール名でなくカテゴリを受け取ることと、起動されないツールの分岐を残す理由を 1 行ずつ書く（軽微）。

### architecture-boundary-analyzer

- verdict: needs-work
- 主指摘: 表に `chmod` / `chown` と `-t DIR` を入れたので、document-workflow-guard の結果も 2 か所で変わり、「そのまま移す」と矛盾する。Bash の write を `Edit` で渡すと `Write(…)` の許可パターンが落ちる。lib が解釈するフラグの範囲を列挙する。

### security-vulnerability-analyzer

- verdict: needs-work
- 主指摘: glob やブレースを含む語を書かれたまま判定すると、repo の中の symlink に展開が当たって外へ届く（high）。入力リダイレクト `<` が表に無い。additionalDirectories の物理の照合が、接頭部を戻す規則と食い違う。

### resilience-analyzer

- verdict: needs-work
- 主指摘: Bash が全部止まったとき、復旧の手順（matcher から外す）が利用者に見えず、`git revert` も Bash から打てない。判定ログの再生は偏った標本なので、母集団と理由別の件数を報告に入れ、0 件を安全の根拠にしない。

<!-- auto-review: verdict=needs-work; hash=6d6bbbca43fb6cc4c72bdebf3e5178cf313eff59746193099a14a50d07099785; design-hash=4cd92242285dcb85f2b0e75a98836b55f41caa3fc67d18b4b5a5d9bdfbbfbbe8; round=1; at=2026-10-04T09:30:03.944Z; reviewers=logic-validator+scope-justification-reviewer+decision-quality-reviewer+greenfield-perspective-reviewer+architecture-boundary-analyzer+security-vulnerability-analyzer+resilience-analyzer -->

## Reviewer Outputs (Round 3)

### logic-validator

- verdict: needs-work
- 主指摘: K10 の表で `$` の行がブレースと glob の行より前にあり、`lin*/$f` や `{/etc/$f,x}` が symlink の検査とブレース展開に進まない。クォートの種類を語ごとに 1 つ持つ設計では `"$HOME"/*.md` を判定できない。`recovery=` は Bash のときだけ意味がある。

### scope-justification-reviewer

- verdict: pass
- 主指摘: glob の処理は根拠があり、項目 3 に対して重すぎない。上限（5,000、64）の数値に出典が無いので、根拠を 1 行足し、再生の報告に上限に当たった件数を入れる（記述の補強）。

### decision-quality-reviewer

- verdict: pass
- 主指摘: 支配軸とずれた判断は無い。glob の上限超過を deny にするのは fail-closed として妥当。deny の理由に、原因になった symlink を出すと復旧が楽になる（任意）。

### greenfield-perspective-reviewer

- verdict: pass
- 主指摘: 採用案は白紙設計案と同じ形のまま。run-guard のタイムアウトで Bash が止まる場合に K14 の手順が出ない（軽微）。

### architecture-boundary-analyzer

- verdict: needs-work
- 主指摘: K10 の glob の処理はファイルシステムを読むが、置き場が spec から読めない。`lib/bash-path-operands.ts` は文字列の処理だけにとどめ、ディレクトリを読む処理は別の場所に置き、document-workflow-guard がそれに依存しないと書く。

### security-vulnerability-analyzer

- verdict: needs-work
- 主指摘: K10 の行の順序でブレースと glob の規則を迂回できる（high）。複数の階層にまたがる glob で下へ降りる規則が一意に読めない。システムディレクトリの読み取りの上書きは、プロジェクトの設定から `/proc` などを開けられる。`recovery=` の手順がエージェントに「guard を外せ」と読める。

### resilience-analyzer

- verdict: needs-work
- 主指摘: Bash が全部止まる最もありそうな原因（run-guard のタイムアウトと異常終了）に `recovery=` が出ない。glob の処理の失敗の仕方（読めないディレクトリ、上限の数え方、遅いファイルシステム）が決まっていない。登録の後に誤 deny を検知する手段が無い。

<!-- auto-review: verdict=needs-work; hash=3a29edda6df40041c1a8caca342f6a4129f593bde6841dcda4a07a8b5f20bc60; design-hash=9e79a77269bb326568c6a961f5fec72f42887b8b540c1453942f784d51c984e6; round=2; at=2026-10-04T09:47:26.097Z; reviewers=logic-validator+scope-justification-reviewer+decision-quality-reviewer+greenfield-perspective-reviewer+architecture-boundary-analyzer+security-vulnerability-analyzer+resilience-analyzer -->

## Reviewer Outputs (Round 4)

### logic-validator

- verdict: needs-work
- 主指摘: K10 の `..` の規則を手順 5 の切り詰めの前後どちらで見るかが読めず、`$X/../x` の結果が決まらない。`walkGlob` の `base` が空のとき、`*.ts`（cwd）と `/*`（ルート）を区別できない。`lin*$f/passwd` のように同じセグメントに glob と `$` がある語で glob が落ちる。

### scope-justification-reviewer

- verdict: pass
- 主指摘: 追加の 5 点はどれもオーダーとユーザーの選択に由来する。run-guard のテスト（2 つ目の引数の有無、タイムアウト、異常終了）を plan-2 に入れる（軽微）。

### decision-quality-reviewer

- verdict: pass
- 主指摘: 支配軸とずれた判断は無い。`glob-limit` の deny に回避の書き方を 1 行添える。登録の 1 週間後の見直しが人の記憶頼みになっている（どちらも軽微）。

### greenfield-perspective-reviewer

- verdict: pass
- 主指摘: 採用案は白紙設計案と同じ形。glob を「判定する」か「全部 deny にする」かの比較を K10 に 1 行足す。種別の一覧を再生とログで共有する（どちらも軽微）。

### architecture-boundary-analyzer

- verdict: pass
- 主指摘: Round 3 の指摘は解消。run-guard は引数の有無にかかわらず `RUN_GUARD_RECOVERY` を設定し直す。`walkGlob` はディレクトリの読み取りと時計を引数で受ける（どちらも軽微）。

### security-vulnerability-analyzer

- verdict: needs-work
- 主指摘: ブレース展開の後の語にチルダと `$HOME` の手順を当て直さないので、`{~,x}/.ssh/id_rsa` が通る（high）。`.*` が `..` に一致するシェルがある。`**` は zsh では再帰になる。`$'…'` が「判定しない」に落ちる。ユーザーの設定の見分けを配列の添字や `process.env.HOME` に頼ってはいけない。

### resilience-analyzer

- verdict: needs-work
- 主指摘: run-guard の 2 つ目の引数について、無いときに出力が今と同じであること、案内を書式文字列に入れないこと、引数が無いときに環境変数を消すことを spec が求めていない。ログの書き込みが失敗したときに deny の判定と種別が変わらないことも求めていない。

<!-- auto-review: verdict=needs-work; hash=483d560019b6ea69641a0bc721791a125b41badbc88390b5648e3d35285f3dee; design-hash=90bc1e562976245c0628a045d1899a952a1e82c83f37fd187c14ba426bf89d5c; round=3; at=2026-10-04T09:52:36.477Z; reviewers=logic-validator+scope-justification-reviewer+decision-quality-reviewer+greenfield-perspective-reviewer+architecture-boundary-analyzer+security-vulnerability-analyzer+resilience-analyzer -->
<!-- intent-triage: adopted=20; excluded=0; at=2026-10-04T09:54:43.285Z -->

## Reviewer Outputs (Round 5)

### logic-validator

- verdict: needs-work
- 主指摘: 8 つの入力を流れに沿ってたどり、判定の規則に穴は無い。Experience Delta の `~/.claude/../…` の Read が deny になるという記述は、dotfiles の repo では step 6b で通るので成り立たない。`category` への置き換えで、起動されない Glob・Grep・NotebookRead の step 4 の結果も変わる。Bash の分岐の写し先が未定義。

### scope-justification-reviewer

- verdict: needs-work
- 主指摘: K5（`/private/tmp` の形の scratchpad も自動承認する）は必要性の根拠が無く、macOS でも未確認。自動承認が広がる変更なので、根拠を示すか落とす。K4 が起こす他の hook の挙動の変化が Experience Delta に出ていない。

### decision-quality-reviewer

- verdict: pass
- 主指摘: K1〜K8 は支配軸から外れていない。システムディレクトリの上書きは Bash の spec で再検討すると書き残す。NotebookEdit の deny と allow をテストする（どちらも軽微）。

### greenfield-perspective-reviewer

- verdict: pass
- 主指摘: 白紙設計案と同じ形に着地している。起動されない 3 つのツールが step 4 で通る側に変わる点を書く。Bash の分岐は触らず、テストも足さないと明記する（どちらも軽微）。

### security-vulnerability-analyzer

- verdict: needs-work
- 主指摘: ツールが `..` を先に畳んでから開く場合、開かれる位置は畳んだ後のパスの物理の形で、今の 2 つの形のどちらとも違いうる（medium）。HOME は `process.env.HOME` から来るので「エージェントが動かせない」という根拠と合わない。`~/.claude` 自体が symlink の配置、macOS での拒否リストの大文字小文字（どちらも low）。

### resilience-analyzer

- verdict: needs-work
- 主指摘: 共有モジュールを 4 つの hook が import するので、1 つの失敗で複数の hook が同時に止まる。import だけを確かめるテストと復旧の経路を書く。`unresolvable=` のときの直し方、どの step で落ちたか、HOME と repoRoot の realpath を求められないときの扱いが無い。

<!-- auto-review: verdict=needs-work; hash=734a6cfd77ff6b1fa33ccf8593c709cb6341ae977569a2a76110dddf1e650135; design-hash=f197a5867aa06822de6ab167f521531d1143ddd85a81875dfba3e626d0cd9f8a; round=4; at=2026-10-04T10:12:05.925Z; reviewers=logic-validator+scope-justification-reviewer+decision-quality-reviewer+greenfield-perspective-reviewer+architecture-boundary-analyzer+security-vulnerability-analyzer+resilience-analyzer -->
<!-- intent-triage: adopted=28; excluded=0; at=2026-10-04T10:12:05.942Z -->

## Reviewer Outputs (Round 6)

### logic-validator

- verdict: pass
- 主指摘: 9 つの入力を流れに沿ってたどり、すべて意図どおり。`..` を含む既存テストの期待値は変わらない。`CLAUDE_TEST_CWD` が物理的なパスであるという前提と、`./../x` の扱いを書く。相対パスの途中の `..` が deny になる点を Experience Delta にも書く（いずれも軽微）。

### scope-justification-reviewer

- verdict: needs-work
- 主指摘: K5 で permission-auto-approve を外したので、Goal の「一時ディレクトリの判定を hook の間で 1 つの実装にそろえる」と Experience Delta の「ルートの定義は 1 か所になる」が事実と合わない。そろうのは file-access-guard、document-workflow-guard、pattern-matcher の 3 つ、と書き換える。

### decision-quality-reviewer

- verdict: pass
- 主指摘: K2 は支配軸に沿っている。R9 の「`..` を含める必要のある操作は無い」は断定が強い。deny の理由に、畳んだ後のパスを参考として添える（いずれも軽微）。

### greenfield-perspective-reviewer

- verdict: pass
- 主指摘: `..` を受け付けない形は白紙設計案と整合する。「差分最小案」と K3 に前の案の言い回しが残っている（軽微）。

### security-vulnerability-analyzer

- verdict: pass
- 主指摘: K2 で Round 5 の medium は閉じた。`hasParentSegment` は `/a/..//b` や末尾の `/..` を検出する。相対パスの先頭の `..` は、ツールが hook と同じ物理的な cwd で解決するという前提に載っている。macOS の大文字小文字は step 2 以外の照合ともそろえる（いずれも low）。

### resilience-analyzer

- verdict: pass
- 主指摘: Round 5 の 4 点は解消。`parent-segment` の deny の文言を絶対パスと相対パスで出し分ける。hook の cwd とツールの cwd が一致するかを R5 の確認項目に足す（いずれも軽微）。

<!-- auto-review: verdict=needs-work; hash=bc6881a4a8e5bcd72626a391b8ad45b7ebff681470239faa9c6499c21f608036; design-hash=9da2e05f572ced19fc7ed674ff9aae391757644972ec3813a08f7ae9b46689dd; round=5; at=2026-10-04T11:01:42.358Z; reviewers=logic-validator+scope-justification-reviewer+decision-quality-reviewer+greenfield-perspective-reviewer+security-vulnerability-analyzer+resilience-analyzer -->
<!-- intent-triage: adopted=23; excluded=0; at=2026-10-04T11:01:42.374Z -->

## Reviewer Outputs (Round 7)

### logic-validator

- verdict: pass
- 主指摘: cwd を物理的なパスにしてから使う変更は K2 と既存テストに矛盾しない（存在しない cwd は最寄りの祖先から付け直されて同じ文字列になる）。HOME や repoRoot が symlink 経由のとき、相対パスから作った字句の形にも流れの 3 の置き換えを当てる（軽微。反映済み）。

### scope-justification-reviewer

- verdict: pass
- 主指摘: Round 6 の指摘は解消。Goal に `..` の拒否と NotebookEdit の登録を 1 句足す、R9 に相対パスの途中の `..` を加える（いずれも軽微。反映済み）。

### decision-quality-reviewer

- verdict: pass (carried from Round 6)
- 主指摘: Round 6 で pass、再実行なし

### greenfield-perspective-reviewer

- verdict: pass (carried from Round 6)
- 主指摘: Round 6 で pass、再実行なし

### security-vulnerability-analyzer

- verdict: pass (carried from Round 6)
- 主指摘: Round 6 で pass、再実行なし

### resilience-analyzer

- verdict: pass (carried from Round 6)
- 主指摘: Round 6 で pass、再実行なし

<!-- auto-review: verdict=needs-work; hash=89c845f09880ce410e45757872a4373e37b624d10b8445896ec5eb619dd7927a; design-hash=4d1bfe21d3460f9578553fe864471ea756cc75b9f606fc75bff216a1ca1e1334; round=6; at=2026-10-04T11:44:08.513Z; reviewers=logic-validator+scope-justification-reviewer+decision-quality-reviewer+greenfield-perspective-reviewer+security-vulnerability-analyzer+resilience-analyzer -->
<!-- intent-triage: adopted=17; excluded=0; at=2026-10-04T11:44:08.531Z -->

<!-- auto-review: verdict=pass; hash=51ab752781c3c37442efe8064f0adb4e7dc132c409d0fe68fb20186704b14171; design-hash=4d1bfe21d3460f9578553fe864471ea756cc75b9f606fc75bff216a1ca1e1334; round=7; at=2026-10-04T11:49:47.067Z; reviewers=logic-validator+scope-justification-reviewer+decision-quality-reviewer+greenfield-perspective-reviewer+security-vulnerability-analyzer+resilience-analyzer -->
<!-- intent-triage: adopted=6; excluded=0; at=2026-10-04T11:49:47.084Z -->
