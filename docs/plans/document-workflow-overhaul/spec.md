# Spec: Document Workflow を最新鋭モデルで高品質・低コストに完走させる

## Goal

Opus 5 / Fable 5.1 が Document Workflow を、必須 step を欠かさず、ゲートを閉じたまま固着も素通りもせず、計画フェーズのターン・トークンを現状の半分以下で完走できる状態にする。根拠は `research.md` §2（8 失敗パターン）と §3（機構欠陥）、raw 証拠は `evidence/` 配下（transcript 解析のみローカル限定、research.md 冒頭を参照）。

## Experience Delta

- 変更前: plan を Bash で書くとレビュー自動化が発火せず（P2）、Reviewer Outputs / intent-triage が抜け（P3）、deny は固定文で原因が分からず言い換え再送し（P4）、ハイフン 1 つで数日固着し（P5）、インタプリタ heredoc は実装を素通りし（P6）、hook は normalized hash が動く毎に 1.5KB を再注入して 1 セッション 439 回 / 約 150k tokens を消費し（P8、`e86298b2` 実測）、「走らせます」で止まる（P1）
- 変更後: 文書編集は tool 経路を問わず内容 hash で検知される。deny は「どの条件が不成立か・見つかった status 行・次の 1 手」を出す。marker / hash / Reviewer Outputs 骨格 / triage marker は `workflow` CLI が書き、モデルは hash を転記しない。レビュー推奨の全文は (文書, round) ごとに 1 回だけ出て、それ以外は短い pointer。Round 3 で pass しなければ人間へエスカレーション。ゲート閉時に repo 内ファイルが書き換われば tripwire が次の Bash 後に告げる。宣言だけで止まったターンは Stop hook が差し戻す。常時ロードの workflow.md は operator guide（≤ 12KB）になり、機構仕様は skill として必要時にロードする

## Architecture

```
                      ┌──────────── PreToolUse ────────────┐
 Write/Edit/Bash ───▶ │ document-workflow-guard            │──deny(診断付き)──▶ model
                      │  ├ gate 診断 (lib/workflow-gate.ts) │
                      │  └ interpreter 書込検知 (narrow, K3) │
                      └────────────────────────────────────┘
                      ┌──────────── PostToolUse ───────────┐
 Write/Edit ────────▶ │ plan-review-automation ─┐          │
 Bash ──────────────▶ │ workflow-bash-sync ─────┼▶ lib/workflow-review-core (canSkip / 推奨文 / placeholder) │
   (親 loop のみ)      │   └ tripwire (rolling baseline, K2) │──additionalContext──▶ model
 Agent ─────────────▶ │ reviewer-run-recorder → <wfDir>/reviewer-runs.log │
                      └────────────────────────────────────┘
                      ┌──────────── Stop ──────────────────┐
                      │ resume-incomplete-work + announce 分岐 (K7) │
                      └────────────────────────────────────┘
 model ──Bash──▶ workflow-cli {status|round|stamp|triage}
                 └ lib/workflow-gate / workflow-marker / document-hash を hook と共有
 rules/workflow.md (operator guide) ── 参照 ──▶ skill: document-workflow-reference (機構仕様)
```

marker parser と status 行の正規表現は `lib/workflow-marker.ts` に 1 本化し、guard / plan-review / gate / CLI が共有する。**hash 正規化（`lib/document-hash.ts:63-70`）は一切変更しない**（後述 K4）。CLI が書く marker / intent-triage / Reviewer Outputs / `Review Status` 値はいずれも既存正規化が除外済みなので、CLI の書込は文書 hash を変えず、レビュー推奨を再発火させない。

## Alternative Approaches (Greenfield View)

### 差分最小案 (Incremental)

4 hook の matcher に `Bash` を足し、deny 文に不成立条件を追記し、status regex のハイフンを任意にする。P2/P4/P5 は減るが、hash 転記の手作業（P5 の根）、round をまたぐ再注入（P8）、宣言停止（P1）、レビュー非収束（P7）は残る。Bash を matcher に足しても `tool_input.file_path` が無いので各 hook が個別に「何が変わったか」を推測する必要があり、3 hook に同じ検知ロジックが増殖する。

### 白紙設計案 (Greenfield)

ゼロから設計するなら、LLM に SHA を転記させる設計にはしない。状態は CLI が所有し、レビューは必須 reviewer の実行を台帳で裏付け、台帳の無い verdict は存在できない。hook は「文書の内容 hash が変わったか」と「gate 閉時に repo 内ファイルが変わったか」だけを見る。レビューは「complete になった文書 1 回 + 指摘者の再確認」を既定の予算とし、超過は人間へ戻す。指示文はモデルが行動する順に並んだ 1 画面の operator guide だけを常時ロードする。起源: 観測された失敗の大半（P2–P6, P8）が「モデルの手作業を機構が前提にしている」ことから派生しており、手作業を機構側へ移せば失敗の発生面そのものが消えるため。

### 採用案と理由

ハイブリッド。白紙案の「帳簿は CLI が書く」「reviewer 実行は台帳で裏付ける」「検知は内容 hash」「予算超過は人間へ」「operator guide と機構仕様の分離」を採る。ただし状態の置き場は文書内 marker のまま残し、reviewer の起動もモデルが行う（CLI は台帳で検証するのみ、Agent tool は CLI から呼べないため）。理由: (1) guard の判定（`document-workflow-guard.ts:305-329`, `344-418`）は文書内 marker を regex で読む前提で、別ファイル化は判定・テスト・進行中成果物の全経路の書き換えになる。(2) 人間の承認は `- Approval Status: approved` を文書で書く操作であり（ADR-0001）、可読性を保ちたい。(3) marker は追記式（`document-workflow-guard.ts:781-820` が最新を採用）なので履歴も残る。marker を CLI が書けば「転記ミス」は消えるので白紙案の利益はほぼ得られる。

## Key Decisions

- **K1: 文書変更の検知を tool 経路から内容 hash に変える** — `plan-review-automation.ts` の判定部（`SPEC_REVIEWERS` / `PLAN_REVIEWERS` / `REVIEWER_CATALOG` / `canSkip` / cache 入出力 / `buildRecommendation` / `buildSummaryReminder` / cache パス解決）と `spec-plan-placeholder-scan.ts` の走査部を `lib/workflow-review-core.ts` に移し、既存 2 hook はそれを呼ぶ薄い殻にする。cache パス解決（`resolveWorkflowPaths(dirname(planPath))`）も core に含め、両 hook が同一の per-doc cache を指すようにする（N2）。新 hook `workflow-bash-sync.ts`（PostToolUse `Bash`）は、`context.input` に `agent_id` があれば（= subagent 由来）即 return する（後述の実測理由）。そうでなければ wfDir 内の spec.md / plan.md / plan-N.md 全部について core の `canSkip` を呼び、変化した文書に同じ推奨 / placeholder 処理を行う。`canSkip` は現状「normalized hash 一致（marker hash OR cache）」で、判定の唯一の実体は core 側に置き、dispatcher は再実装しない（第二 SSoT を作らない、N3）。`plan-review.cache.json` は文書名をキーにした `{ [docName]: { planHash, recommendedAt, summaryRemindedHash, fullTextEmittedForRound } }` に変える（現状は 1 ファイル 1 hash で spec と plan-N が共有。`roundCount` は cache に持たず文書の `## Reviewer Outputs (Round N)` 見出し数から読む、N3/N7）。wfDir が unresolvable なら guard と同じ方向（何もせず、その旨 1 行）。両新 hook を `.settings.hooks.json.tmpl` に登録し `hook-target-drift.test.ts` を通す（N9）。drift テストの import 先は lib に付け替え、markdown の SSoT 区間は不変。Write/Edit 経路の出力が refactor 前後で byte 一致であることを parity テストで先に赤で固定する（R8）。実測: spawn ≈ 19ms、6 文書 hash ≈ 6.5ms（サイズ非依存）。`agent_id` gate 後の対象は親ループの Bash のみ（`e86298b2` で 3141 PostToolUse Bash のうち subagent 2536 を除外し 635、≈ 16s / セッション、Bash wall time の約 0.5%）。既存 PostToolUse Bash hook は `async:true` で `additionalContext` を運べないため fold できず（実測理由、K1 で明記）、standalone hook が正当
  - 参照: `home/dot_claude/.settings.hooks.json.tmpl:4`, `:117`, `:135-160`（async PostToolUse Bash 群）
  - 参照: `plan-review-automation.ts:296-301`（`canSkip`）, `:290-293`（cache co-location）, `lib/workflow-paths.ts:136-154`, `lib/workflow-tool-input.ts:21`
  - 参照: `plan-review-automation.test.ts:30`（roster import）, `hook-target-drift.test.ts:22-25`
- **K2: gate 閉時の repo 内書換を tripwire で事後検知する** — `workflow-bash-sync`（`agent_id` gate 後、親ループのみ）は gate 閉（workflow active かつ `isImplementationPhase` 偽）のとき `execFile("git", ["--no-optional-locks", "-C", cwd, "-c", "core.fsmonitor=", "status", "--porcelain=v1", "-z", "-uall"])` を 200ms 予算で実行し、`<wfDir>/.tripwire-baseline`（前回観測）との差分で wfDir 外の追加・変更パスを得る。baseline は `lstat` で symlink を拒否し `O_NOFOLLOW|O_CREAT|O_WRONLY` で書く（`appendOffPlanLog` も同様に硬化）。baseline 欠落時（scratch 掃除等）は「差分なし」ではなく「baseline 不明、再武装した」と告知して再作成する（N13）。差分があれば `off-plan-writes.log` に `tool=Bash-tripwire` で記録（path 重複除去、200 行で打ち切り通知）し、additionalContext で「gate 閉時に <paths（`sanitizeForDisplay`、最大 10 件 + N more）> が変更された。承認前なので戻すか人間に報告せよ」と告げる。予算超過・`git` 不在は `<wfDir>/.tripwire-disabled`（理由を記録）を作って以後 skip し、その 1 回だけ可視化。`round` 実行時に再武装し、`workflow status` が tripwire 状態を表示する（N14）。`agent_id` gate により並列 subagent の baseline 衝突は起きない（親ループの並列 Bash のみが残余、稀）。検知範囲は「cwd の repo 内の tracked + 非 ignore の untracked」。ignore 済み・repo 外・nested repo・`git` 不在は盲点として R11 に記す。guard の write-like 一覧に `ln` を追加。主根拠は `docs/plans/workflow-guard-followups.md` 課題 A/B/D（既知・未修正の迂回面）で、P6 はその実例
  - 参照: `document-workflow-guard.ts:432-469`, `:489-501`, `:657-677`（write-like 一覧、`ln` 不在を確認済み）, `lib/workflow-fs.ts:18-32`, `lib/sanitize-display.ts:1-33`
- **K3: インタプリタ inline script の書込を狭い条件で事前 deny する** — gate 閉時、`python|python3|node|bun|deno` の `-`/`-c`/`-e`/`-p`/`eval` または heredoc 入力で（`ruby|perl|php` は書込 idiom 網羅が高コストなためトリガー集合から外す、`transcript-findings.md` の実測経路は python/node/bun heredoc、N9 residual）、(a) 書込指標（`open(...,'w'|'a')`, `Path(...).open(`, `write_text|write_bytes`, `writeFileSync|writeFile(|appendFile|createWriteStream|fs.promises`, `Bun.write`, `Deno.write`, `os.remove|os.rename|os.system|subprocess|shutil.`, `child_process|execSync`）があり、かつ (b) path らしき文字列リテラルが 1 つでも scratch root（`/tmp`, `$CLAUDE_JOB_DIR`, `.tmp/`, `$DOCUMENT_WORKFLOW_DIR`）の外を指す、`..` を含む、または path リテラルが 1 つも無い、場合に deny する。**scratch root 判定は正規化後の segment 境界比較**（`p === root || p.startsWith(root + "/")`、`/tmpx` を弾く、N8）。wfDir 内パスは scratch allow から除外する（ledger を最安 unblock として書かせない、security 12）。deny 文は指標と path を名指しし「Write/Edit tool か、guard が対象を読める `cat > path <<'EOF'` を使う」と指示。(b) を満たさない解析スクリプトは allow し K2 に委ねる。「書込先が証明できない限り deny」に倒さないのは、それが P4（deny → 言い換え再送）を解析用途で再生産するためで R1 に記録する
  - 参照: `document-workflow-guard.ts:610-690`, `:100-131`（対象不明の write-like は deny する既存前例）, `lib/workflow-fs.ts:68-87`（segment 境界比較の実装例）, `lib/context-helpers.ts:53-55`
- **K4: deny 理由を診断にする（正規化・判定 regex は変えない）** — 新 `lib/workflow-gate.ts` の `diagnoseGate(wfDir, targetPath)` が単層 / 二層それぞれで条件ごとの ✓/✗、不成立時に見つかった status 行（`^\s*-?\s*(Plan|Review|Approval) Status:` に**寛容に**マッチした行のみ、最大 3 行、`sanitizeForDisplay` 経由）、期待する厳密形、次の 1 手（`workflow-cli status` / `round` / `stamp` / 「人間が Approval Status を approved にする」）を返す。**guard の判定 regex（`document-workflow-guard.ts:16-18`、ハイフン必須）と `lib/document-hash.ts:63-70` の正規化は変更しない**。寛容マッチは診断表示専用で、判定には使わない。これにより既承認文書の hash は不変で S3 型の移行が不要（logic N6 / architecture N1 の blocker はこの設計で発生しない）。CLI `stamp` は必ず厳密形（`- Review Status: pass`、ハイフン付き）を書くので既存判定を通る。guard の deny 文と CLI `status` は `diagnoseGate` を共有。marker parser は `lib/workflow-marker.ts` に 1 本化し、status 行の正規表現もそこに置く（正規化モジュールに parse 定数を置かない、N7）。guard / plan-review / gate / CLI が `workflow-marker` を使う。placeholder-scan の「本文を echo しない」規約（`spec-plan-placeholder-scan.ts:10-14` のコメントが参照する _旧 spec の_ R8。本 spec の R8 とは別物、名前の混同を避ける、security 7）の例外として status 行 3 行のみを許すことを reference skill に記録する
  - 参照: `document-workflow-guard.ts:16-18`, `:97-102`, `:160`, `:200`, `:781-820`; `plan-review-automation.ts:630-666`; `lib/document-hash.ts:63-70`（**不変**）; `spec-plan-placeholder-scan.ts:10-14`
- **K5: 帳簿を `workflow-cli` が書き、reviewer 実行を台帳で裏付ける** — `home/dot_claude/hooks/cli/workflow.ts` を作り、`~/.local/bin/workflow-cli`（`run_after_sync-*` で配置、`Bash(workflow-cli *)` を permission 許可）から呼ぶ。素の `bun ~/...ts` は既存 permission（subcommand 形式）に一致せず毎回プロンプトになるため、PATH 上の wrapper 名で許可する（N10 / security 18）。wfDir は `--wf-dir` または env を `isStrictlyUnderProjectSubdir` で検証し、加えて session 由来の派生 dir と食い違えば警告を出す（`/clear` 後の stale dir を検知、security 15）。中核は純関数 `runWorkflowCli(argv, {cwd, wfDir, sessionId, now, ledgerPath})` で `node --test` から直接呼ぶ。サブコマンド: `status`（K4 診断 + tripwire 状態）/ `round <doc>`（`## Reviewer Outputs (Round N)` 骨格を marker 直前に挿入、N = 既存 round + 1、対象層の必須 reviewer 分の `verdict:` / `主指摘:` 行、tripwire 再武装）/ `stamp <doc> --verdict <pass|needs-work|blocker> --reviewers a+b`（Round N セクションが無ければ非 0。`<wfDir>/reviewer-runs.log` に、対象層の必須 reviewer 全員について、baseline 時刻以降（Round 1 は wfDir 作成時刻、以降は直前 marker の `at`、N5 / N17）の実行記録が **plugin namespace を正規化した上で** 揃わなければ非 0（`compound-engineering:review:` prefix を剥がして bare slug と比較、N4 / N16 / security 16）。`- Review Status: <v>` を厳密形に書き換え、`hash` / `design-hash` / `parent-spec-hash` / `at` / `reviewers` を計算した marker を**追記**）/ `triage <doc> --adopted N --excluded M`。いずれも diff が `Approval Status` 行に触れる場合は中断する。台帳は新 hook `reviewer-run-recorder.ts`（PostToolUse `Agent`、`tool_input.subagent_type` を記録、実機で発火とペイロードを確認済み）が `{sessionId, subagent_type, at}` を追記する（session 単位に窓を絞る、無料の改善、greenfield）。ledger は cap（200 行）+ 非 reviewer subagent（Explore / general-purpose 等）を除外。recorder の wfDir 解決は他 hook と同じ `resolveWorkflowDir`（ADR-0013、N: greenfield/arch）。guard の Bash 分類器は `workflow-cli` 呼出を「wfDir 文書への書込」として認識（文書は gate によらず書込可なので結果は allow、分類は明示）。guard は verdict=pass の文書に intent-triage marker（`pending` 以外）が無い場合、まず診断 ✗ の warn 表示のみとし、deny 昇格は「warn 後に triage 無しで承認へ進んだ事例 2 件」を再評価トリガーとする（後付け hard gate で P5 型固着を作らない、decision-quality 1）
  - 参照: `plan-review-automation.ts:470-478`, `session.ts:203-209`, `lib/workflow-fs.ts:68-87`, `.settings.permissions.json:116-130`, `home/.chezmoiscripts/run_after_sync-skills.sh.tmpl:7,37`
- **K6: レビュー推奨の全文は (文書, round) ごとに 1 回、以後は pointer** — core の `canSkip` は現状「normalized hash 一致」で指摘反映の編集ごとに全文再注入している（`e86298b2` で 439 回、`complete` 化はセッション 5% 時点なので `Plan Status` でのゲートは無効）。per-doc cache の `fullTextEmittedForRound` と、文書から読む現 round 数を比較し、同じ間は `[plan-review-automation] <doc> changed (hash <8桁>); Round <N+1>: 前回提示の推奨のまま。reviewer 実行後 workflow-cli round/stamp` の pointer（≤ 160B、日本語 UTF-8 で実測 146B、ISO 基準を 160B に、performance 8）だけ出す。round 数が増えた最初の変更で全文を出す。全文は round ≥ 2 で「前 round で needs-work / blocker だった reviewer のみ、自身の前回指摘と前 round 以降の diff を渡して再確認」、round ≥ 3 かつ verdict ≠ pass で「予算到達。Executive Summary に未解決指摘を添えて人間に判断を求め、指示なく Round 4 を始めない」、800 行超で 1 行の縮約提案。期待効果: 35 round × 1.5KB + 404 × 146B ≈ 83KB（−87%、約 130–155k tokens）
  - 参照: `plan-review-automation.ts:262-406`, `:294-301`, `:414-511`, `lib/document-hash.ts:20-37`（Reviewer Outputs 区間走査、round 数の読取に流用）
- **K7: announce-then-stop を `resume-incomplete-work.ts` の分岐として差し戻す** — 同 hook の `MIN_MESSAGE_LENGTH` allow 経路に分岐を足す: wfDir に research.md があり、`last_assistant_message` の末尾非空行が宣言語尾（`(走らせ|実行し|反映し|直し|進め|着手し|書き|開始し|回し|起動し|更新し)ます[。.!]?$` または `^(I('ll| will)|Let me) .*\.$`）に一致し、その末尾非空行に人間待ちの語（`承認`, `approve`, `待ち`, `判断を`、および行末の `?` / `？`）が無い場合、既存の持続カウンタ（UserPromptSubmit でリセット、上限 2）の範囲で `decision: block`「宣言した動作をこのターンで実行するか、何を人間に待つかを最終行に書け」。待ち語判定は末尾非空行のみで行い、本文中の URL / コード中の `?` で誤 disable しない（security 11）。`stop_hook_active` 真なら allow（前例: `webhook-notification.ts:181-182`、`lib/` 配下）。新 hook は増やさない
  - 参照: `resume-incomplete-work.ts:58-113`, `:62-64`, `:87`
- **K8: workflow.md を operator guide と機構仕様に分離する** — `rules/workflow.md` はモデルが行動する順の ≤ 12KB guide（routing 表 / 8 step と各 step で呼ぶ CLI / ターン終端規則 / No Placeholders / SSoT marker 付き reviewer 一覧 / 人間承認 / Executive Summary 雛形 / Scope Guard / 完了規約）に書き直す。DOCUMENT_WORKFLOW_DIR 引き継ぎ・**S3 移行手順**・carry-forward 責務分離・mechanical-lane 4 条件詳細・起動軸図・ISO 25010 選択ガイド・hash 3 種の意味は新 skill `.skills/document-workflow-reference/SKILL.md` に移す（`run_after_sync-skills.sh.tmpl` が同期）。SSoT marker 区間は guide に残す。受入基準: 変更後 5 セッションで欠落集計（下記スクリプトを本 plan 内で `docs/` にチェックインし ephemeral な `$CLAUDE_JOB_DIR` 依存を解消、scope 6）を再実行し、Reviewer Outputs / intent-triage 欠落 0、plan-review 注入量が round 数 × 2KB 以下
  - 参照: `home/dot_claude/rules/workflow.md:237-278`（S3 手順と SSoT 区間）, `plan-review-automation.test.ts:630-714`, `home/.chezmoiscripts/run_after_sync-skills.sh.tmpl:7,37`
- **K9a: 信頼性に効く文書矛盾を解消する**（証拠: `prompt-surface-inventory.md §3(a)-(c)`、research §3.5）— verdict 語彙を `pass/needs-work/blocker` に統一（`workflow.md:396` の `fail/needs-revision` を除去）。`REVIEWER_CATALOG` に `code-simplicity-reviewer`（`compound-engineering:review:code-simplicity-reviewer`、agent 実在を確認済み: `~/.claude/plugins/marketplaces/every-marketplace/.../review/code-simplicity-reviewer.md`。keywords: 簡素化 / simplif / YAGNI / dead code）を追加。`block-plan-mode.ts` の 6 step 列挙を「workflow.md の共通フローに従う」1 行 + wfDir 提示に置換。hook 出力の `P9` 等の内部コードを除去。`off-plan-writes.log` は `$` を含む未展開トークンを `raw-token` と明示。`stop-reflection.ts` の `messageForUser` は Stop での到達先を実機確認してから `systemMessage` へ切替（確認前は変更しない、logic 2）
  - 参照: `prompt-surface-inventory.md §3`, `plan-review-automation.ts:115-249`, `block-plan-mode.ts:43-55`, `stop-reflection.ts:167-171`, `node_modules/cc-hooks-ts/dist/index.mjs:528-533`
- **K9b: reviewer agent の Prompt Hygiene を揃える** — 5 reviewer agent 定義に `<spec>/<plan>` 内容をデータとして扱う節を追加（現状は greenfield のみ）
  - 参照: `home/dot_claude/agents/greenfield-perspective-reviewer.md:103-109`
- **K10: self-audit と placeholder-scan の発火を文書状態でゲートする** — 両者とも `lib/workflow-review-core` 経由で「書込後の文書が `Plan Status: complete` かつ per-doc cache から hash が変わった」ときだけ発火させる（`tool_input` の diff 文字列ではなく書込後状態でキーし、Bash 経路の非対称と complete 後の追随漏れを避ける、decision-quality 2 / performance 10）。self-audit は PreToolUse だが、判定に必要な「書込後内容」は `tool_input`（Write の content / Edit の new_string 適用結果）から合成する。トークンを節約するがスポーンは残る（時間は不変、performance 10）。実測: self-audit 284 回・placeholder 173 回 / `e86298b2`
  - 参照: `spec-plan-self-audit.ts:24-88`, `spec-plan-placeholder-scan.ts:31-105`

## Risks

- **R1**: K3 が解析スクリプトを誤 deny し P4 を再生産 → scratch root 条件で allow、deny 文が代替経路を明示、narrow ゆえの取りこぼしは K2 が拾う。`hooks.jsonl` で 2 週間観測し誤 deny が 1 セッション 3 件超なら指標を狭める
- **R2**: K2 の `git status` 遅延 → 実測 1.8ms（本 repo）/ 2ms（72k ファイルの worktree、ignore 剪定）。コストは index サイズ + 非 ignore untracked dir 数に比例。200ms 予算超過で sticky 無効化
- **R3**: CLI と hook の hash 不一致 → 同一 lib 関数を import、`document-hash.test.ts` に CLI 経由 parity ケース
- **R4**: K6 の pointer 化で reviewer 実行を忘れる → `stamp` が台帳で必須 reviewer を検証。ただし K3 の scratch allow から wfDir を除外し、`stamp` 失敗文言は「reviewer を走らせよ、台帳を手で書くな」と明示（security 12）
- **R5**: K7 が正当な終端を block → 上限 2 回、block 文は「待つ相手を書けば通る」
- **R6**: K8 で常時ロードから消えた規則を読まない → guide の各 step に skill 名、hook 推奨文にも skill 名
- **R7**: 進行中セッションの marker 形式との差 → CLI は既存形式を生成、parser は共有化するが受理形式・正規化・判定 regex は不変（K4）。既承認文書の hash は動かない
- **R8**: K1 の core 抽出で Write/Edit 経路が壊れると review 自動化が全経路で止まる → refactor 前に現行出力を fixture 化し byte 一致 parity テストを先に赤で置く
- **R9**: `Approval Status: approved` の書込は prompt 統制のまま（tool 統制ではない）→ 研究で自己承認 0/20。単一ユーザー環境の受容リスク（ADR-0008 Deferred-6 と同判断）。CLI は Approval 行に触れる diff を中断する
- **R10**: Bash 由来の placeholder 違反は事後検知 → K1 の同一処理が次の Bash / Edit 後に出る
- **R11**: tripwire の盲点（ignore 済み・repo 外・nested repo・`git` 不在・並列 baseline）→ 主ゲートは guard、tripwire は補助線。`agent_id` gate で並列 subagent の baseline 衝突は消え、残余は親ループの並列 Bash（稀）。盲点は reference skill に明記
- **R12**: reviewer-runs.log は session 単位で `subagent_type` と時刻を持つが文書単位ではない → 同 session 内で spec と plan-N を同 round で見る場合は両層の必須 reviewer が揃えば通る（過剰許容側、fail-open）。Agent 呼出に対象文書が構造的に無いため prompt 解析による紐付けは脆く採らない。文書単位紐付けは再評価トリガー「台帳通過後に無関係文書へ verdict が付いた事例 1 件」で検討

## ISO 25010 次元選択

- **機能適合性（正確性）**: 文書変更が tool 経路に依らず検知される、gate 診断が実状態と一致する、CLI marker が guard を通る、`stamp` が台帳無しで拒否する
- **信頼性（回復性）**: deny から 1 手で復帰、tripwire が迂回を検知、baseline 欠落で再武装告知、Stop gate が上限 2 回で止まる
- **性能効率性（資源効率性）**: 推奨全文は (文書, round) ごと 1 回、pointer ≤ 160B、tripwire ≤ 200ms、Bash hook は `agent_id` gate で親ループのみ ≈ 16s/セッション
- **セキュリティ（完全性）**: 台帳・baseline は symlink 越しに書かない、`git` は shell 非経由 + fsmonitor 無効、echo は status 行 3 行に限定し sanitize、CLI は Approval 行を書かない
- **使用性（学習性）**: operator guide ≤ 12KB で 8 step + CLI を 1 画面
- **保守性（試験性）**: 全変更が `node --test` 被覆、drift テスト（reviewer SSoT / hook-target）緑、parity テストで refactor 固定
- **対象外**: 移植性（bun / node 前提は不変）

## Reviewer Outputs (Round 1)

### logic-validator

- verdict: needs-work
- 主指摘: CLI の Bash 呼出が guard 分類器に見えず「ungated」（→ wfDir 文書は元々書込可、分類の明示で対応）。K7 は `stop_hook_active` 単独でなく持続カウンタ前例に揃える。tripwire の gitignore 盲点と snapshot 並列衝突を Risks に。stop-reflection は Stop での実機確認前に切替えない

### scope-justification-reviewer

- verdict: needs-work
- 主指摘: K2 の主根拠は P6 でなく課題 A/B/D と明記。K1 core 抽出の parity リスク（R8）と K8 の測定可能な受入基準を追加。self-audit/placeholder のゲートを独立決定（K10）に

### decision-quality-reviewer

- verdict: needs-work
- 主指摘: intent-triage の guard 必須化は後付け制約で P5 型固着を再生産し得る → warn-only から。K2 の無言 skip は可視化。K1 新 hook の unresolvable 時挙動を明記。K9 を信頼性 / hygiene に分割

### greenfield-perspective-reviewer

- verdict: needs-work
- 主指摘: `round` + `stamp` だけでは reviewer 未起動でも pass が書けるため Agent 呼出の台帳検証を追加。「採用案と理由」の無関係な drift テスト引用を削除。承認行の tool 統制欠如を Risks に

### architecture-strategist

- verdict: needs-work
- 主指摘: `Review Status` を正規化に足すと CLI 書込が hash を動かす。cache が wfDir に 1 つで文書ごとでない。marker parser を lib に 1 本化。CLI の wfDir 解決と permission 許可。skill は `.skills/` 配下。K7 は resume-incomplete-work に統合

### security-sentinel

- verdict: needs-work
- 主指摘: 台帳ファイルの symlink 書込（`O_NOFOLLOW` + `ln` を write-like に）、`git` は `execFile` + fsmonitor 無効、echo と path の sanitize、reviewer 実行台帳、K7 の上限。「Approval 行の deny」「`~/.claude/**` の無条件 deny」は敵対モデル前提で triage 除外

### performance-oracle

- verdict: needs-work
- 主指摘: K6 は round 数でキー（実測 439 発火、complete 化は 5% 時点）。tripwire は PostToolUse 単独 + 200ms + sticky 無効化 + `--no-optional-locks`。self-audit 284 / placeholder 173 のゲート化を独立決定に

## Reviewer Outputs (Round 2)

### logic-validator

- verdict: blocker → 本改訂で解消
- 主指摘: R1 の 5 件は解消。新 blocker = `Review Status` を正規化に足すと既承認文書の hash が変わり S3 型自己ロック。→ K4 を「正規化・判定 regex 不変、診断のみ寛容マッチ、CLI は厳密形を書く」に変更し blocker を発生させない設計に。snapshot 並列衝突は R11 に追記（`agent_id` gate で消去）

### scope-justification-reviewer

- verdict: needs-work → 反映済み
- 主指摘: R1 の 6 件中 5 件解消。K9 の引用（prompt-surface-inventory §3）を明記（K9a に追記）。新規（K5 台帳 / K2 `ln` / K10）はいずれも証拠裏付けあり・非投機的

### decision-quality-reviewer

- verdict: needs-work → 反映済み
- 主指摘: R1 の 4 件解消。台帳を文書に紐付けよ → Agent 呼出に文書情報が無いため session 窓に絞る（R12）。self-audit を状態ベースに → K10 で書込後状態キーに統一

### greenfield-perspective-reviewer

- verdict: pass
- 主指摘: reviewer-honesty gap は台帳で構造的に解消。marker 追記式を独立確認。無料改善として ledger を session_id に紐付け（採用）。recorder の wfDir 解決参照を追記（採用）

### architecture-strategist

- verdict: blocker → 本改訂で解消
- 主指摘: R1 の 12 件解消。新 blocker = 同上の正規化 hash 移行（K4 で回避）。N2 cache パスを core に、N3 roundCount を文書から、N4 slug 正規化、N7 status regex は marker モジュール、N8 正規化は `gm`、N9 tmpl 登録、N10 permission 形式を反映

### security-sentinel

- verdict: needs-work → 反映済み
- 主指摘: R1 の (3)(4) は triage 除外を尊重。(8) scratch root を segment 境界比較、(7) interpreter を python/node/bun/deno に限定、ledger を K3 scratch allow から除外し `stamp` 失敗文言で誘導、baseline 欠落で再武装、slug 正規化、`.tripwire-disabled` に理由記録 + status 表示

### performance-oracle

- verdict: needs-work → 反映済み
- 主指摘: subagent Bash が親 session_id で 3141 発火 → `agent_id` gate で親のみ 635 に（≈16s）。async hook は fold 不可を K1 に明記。pointer 実測 146B → ISO 基準 160B。K10 を状態ベースに。reviewer-run-recorder 148 発火 ≈ 2.8s で許容

## Reviewer Outputs (Round 3)

blocker を出した 2 名に絞った確認（prescribed-fix carry-forward の精神、指摘者のみ再確認）。

### logic-validator

- verdict: pass
- 主指摘: K4 は正規化（`document-hash.ts:63-70`）と判定 regex（`guard:16-18`）を不変にし、寛容マッチを診断表示専用に限定。既承認文書の hash は不変で S3 移行不要。Round 2 の根本原因は回避でなく設計で除去された。新たな矛盾なし

### architecture-strategist

- verdict: pass
- 主指摘: N1 blocker 解消（正規化不変）。N2（cache パスを core）/ N3（roundCount を文書から）/ N7（status regex は marker モジュール）/ N9（新 hook を tmpl 登録）/ N10（`workflow-cli` wrapper で permission 一致、bare `bun ~/...ts` は既存エントリに不一致と確認）すべて反映。新たな矛盾なし

## Approval

- Plan Status: complete
- Review Status: pass
- Approval Status: approved

<!-- auto-review: verdict=pass; hash=ea7e535f7a83e4d2e5002cfdd698d69a3472a2f61275ae613634f156a54d68c6; design-hash=04e4f200a407d72811782e5e1279c02d3396c425c3155d8dc6dd8788afadb6ed; at=2026-09-10T04:35:00Z; reviewers=logic-validator+scope-justification-reviewer+decision-quality-reviewer+greenfield-perspective-reviewer+architecture-strategist+security-sentinel+performance-oracle -->
<!-- intent-triage: adopted=56; excluded=2; at=2026-09-10T04:35:00Z -->
