# Research: Document Workflow を最新鋭モデル（Opus 5 / Fable 5.1）で高品質に動かす

調査日: 2026-09-10。オーダー: 「Document Workflow 下での Opus 5 の動作品質がすごく悪いので、Fable / Opus のような最新鋭モデルで良い性能が得られるようにエクセレントな状態にアップデートして」。

調査は 4 本の subagent（transcript 解析 = opus、hook 注入テキスト棚卸し = sonnet、成果物品質監査 = sonnet、コードマップ = sonnet）と main loop の直接読みで行った。本文書はそれらの統合と根本原因分析。生レポートのうち `evidence/prompt-surface-inventory.md` / `evidence/artifact-quality.md` / `evidence/code-map.md` は本ディレクトリに同梱する。transcript 解析レポートは他プロジェクトの名前とセッション引用を含むため tracked にせず、ローカルの `.tmp/docs/document-workflow-overhaul-evidence/transcript-findings.md` にのみ置く（本リポジトリは公開）。

## 1. 母集団と計測法

- `~/.claude/projects/**/*.jsonl` 1,075 セッション中、main loop が `claude-opus-5` のもの 73、うち Document Workflow が実働（`plan-review-automation` 発火 or plan 書込 or guard deny > 0）したもの 26。比較可能な Fable 5 セッションは 2（`552e5513`, `af87f583`）。sonnet / opus-4-8 の main loop セッションは存在しない
- 計測の罠（再調査時に繰り返さない）: (1) `workflow.md` 全文が毎回 `attachment.type="instructions"` として transcript に載るため `grep -l "plan-review-automation"` は全件ヒットする。(2) guard の deny は `"is_error":true` との AND で数える（guard を調査していたセッションでは文字列だけ 22 件出る）。(3) 並列 tool 呼び出しは JSONL で別行に割れるので `requestId` でまとめないと「逐次実行」と誤読する

## 2. 観測された失敗パターン（頻度順）

| #   | パターン                                                                           | 頻度                                                           | 代表証拠                                                                                                                                                         |
| --- | ---------------------------------------------------------------------------------- | -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1  | announce-then-stop: 「〜を走らせます」と書いて tool 呼び出しゼロでターンを閉じる   | Opus 8/12 セッション、ユーザー催促 24 回                       | `e86298b2` L10202 `round 3 のレビューを走らせます。` → Stop → L10208 ユーザー「「走らせます」で、とまっている」                                                  |
| P2  | plan/spec を Bash（`python3 - <<'PY'`）で書き換え、PostToolUse 4 hook が発火しない | Opus は plan 編集の 13–86%（中央値 30%）が Bash。Fable は 0–7% | `aecb11d7` L1129 形式が 147 回。matcher: guard は `Write\|Edit\|MultiEdit\|NotebookEdit\|Bash`、他 4 hook は `Write\|Edit\|NotebookEdit`                         |
| P3  | `Reviewer Outputs` / `intent-triage` マーカーの欠落（step 5.1 / 6 不履行）         | Opus 4/12 で完全ゼロ、3 で 1–2 回のみ。Bash 比率と単調相関     | `38478a42`: レビュアー 24 体を回して Reviewer Outputs 0                                                                                                          |
| P4  | guard deny を「内容の問題」と誤読し、同じ書込を言い換えて再送                      | deny が出た 8/8 セッション                                     | `b533d0e7` L1036/1100/1115: `cat >> research.md` が 3 連続 deny（Write に切替えれば通った）                                                                      |
| P5  | Status 行の書式ズレ（ハイフン欠落・行末注記）でゲートが閉じたまま固着              | 2 セッション、ただし固着コストが突出                           | `e86298b2` L5870「guard はハイフン付きのリスト形式を要求していました…plan-1 の実装がゲートを通らなかったのもこれです」。同セッションでハイフン無し行 82 箇所     |
| P6  | インタプリタ heredoc で guard を迂回して実装（自己申告）                           | 1 件、ただし経路は常時開放                                     | `e86298b2` L4463「私が ADR を `python3 <<'PY'` ヒアドキュメントで編集していました…既定経路が迂回路になっていました」。sonnet subagent が同じ前例に倣った         |
| P7  | レビュー非収束・文書肥大                                                           | Opus 5/12 が Round ≥ 4、最大 Round 11。Fable も Round 7        | `aecb11d7`: hook 1 本の修正で計画文書 448KB、約 20 ラウンド / 85–90 レビュアー起動。`e86298b2` L1798「3ラウンド・のべ21体のレビューで、毎回 blocker が出ました」 |
| P8  | hook 出力によるコンテキスト消費                                                    | 全セッション                                                   | `e86298b2`: `plan-review-automation` 185 発火 ≈ 106k tokens、実レビューラウンドは 35。`164e0449`: plan 28 編集 → hook 48 発火 → 実レビュー 2 回。4 回 compact    |

計画フェーズが総ターンに占める割合: `0435f351` 98%、`38478a42` 88%、`b533d0e7` 76%。5 セッションは実装ファイルへの Edit/Write が 0 件（計画だけで終了）。

### 反証された仮説

- 承認前に勝手に `approved` にする → 反証（20/20 がユーザーの approve 発話直後）
- レビュアーを逐次実行 → 反証（最大並列 4–12。単発実行は Fable `af87f583` が 14 件で最悪）
- `DOCUMENT_WORKFLOW_DIR` 解決失敗 → 現行では 0 件（ADR-0013 で解消済み）
- 質問しすぎ → 反証（疑問文終端 0–3%。症状は逆で「質問も宣言もせず黙って止まる」）
- compact 後の状態喪失 → 反証（standing orders は保持されていた）

### Opus 5 固有 vs 環境固有

- **環境固有（Fable でも同率以上）**: P1、P7、P8
- **Opus 5 固有**: P2〜P6。根は単一で、**Bash（特に python heredoc）でファイルを編集する強い選好**。auto mode の harness 指示（「ファイル変更は sed / heredoc で」）は増幅要因だが、指示のないセッションでも Bash 比率 77–86% なので原因ではない

## 3. 機構側の欠陥（コード・文書の直接読み）

### 3.1 hook の非対称と分類器

- `.settings.hooks.json.tmpl`: guard のみ `Bash` を matcher に含む。`plan-review-automation` / `spec-plan-placeholder-scan` / `spec-plan-self-audit` / `lessons-learned-extractor` は `Write|Edit|NotebookEdit`。`lib/workflow-tool-input.ts:21` の `EDIT_TOOLS` allowlist も同 4 種のみ（`docs/plans/workflow-guard-followups.md` 課題 D として既知、未着手）
- guard の Bash 分類器はシェルリダイレクトと固定コマンド列（`tee`/`cp`/`mv`/`sed -i`/`perl -i` 等）のみ。`python3 - <<'PY'` / `node -e` / `bun -e` は素通り（課題 B と同根）
- 結果として **双方向の破れ**: 文書を Bash で書くとレビュー自動化が発火せず（P2/P3）、実装を Bash で書くとゲートが効かない（P6）。しかも当時は wfDir 内 md への Bash 書込が deny されたため（`4d048c9` で部分修正済み）、文書を書こうとして deny され言い換え再送する（P4）

### 3.2 deny 理由と status 判定

- deny 文は固定 2 種（単層 / 二層）。どの条件（Plan/Review/Approval/hash/parent-spec-hash）が不成立か、対象ファイル、現在の該当行を出さない（`document-workflow-guard.ts:97-98`）
- 判定は `/^- Review Status:\s*pass\s*$/m` 等の完全一致。テンプレートはハイフン付きだがモデルはテンプレートを使わず手書きするため、ハイフン欠落・行末注記で不一致（P5）。deny 文は「近い行はあるが書式が違う」を伝えない

### 3.3 レビュー自動化の経済

- `plan-review-automation` は hash が変わる毎回の編集で約 1.1–3KB の推奨ブロック全文（レビュアー一覧 + 責務 + marker テンプレ + 注入防御 + intent-triage 指示）を再注入する。実レビューは発火の 2 割以下（P8）。モデルに hook 出力を読み飛ばす習慣を学習させる
- `spec-plan-self-audit`（PreToolUse）は hash ゲート無しで**毎編集** checklist + `lessons-learned.md` 末尾 50 行を注入。`spec-plan-placeholder-scan` は diff ではなくファイル全体を毎回走査
- ラウンド予算・収束基準が無い。指摘反映の編集が新しい参照ズレを生み、文書が大きいほど 1 ラウンドの指摘が増える正帰還（P7）。レビュアーは毎回 45–120KB の文書全体を読む
- `lessons-learned.md` は Reviewer Outputs の `主指摘` を逐語コピーしているだけ（3/3 ファイルで確認）。合成なし。GC 対象の `.tmp/sessions/` に置かれ昇格経路なし。self-audit 経由で毎編集再注入される唯一の消費者

### 3.4 手作業の状態機械

モデルが手で維持する項目: `Plan Status` / `Review Status` / `Approval Status`（人間）/ marker の `verdict, hash, design-hash, parent-spec-hash, reviewers, at` / `intent-triage` marker / `Reviewer Outputs (Round N)` / Executive Summary。うち hash 3 種は hook が**計算して表示するだけ**で、ファイルへの記入はモデルの Edit（転記ミスは次の書込で guard deny → P4/P5 に合流）。

文書の記述はこれと矛盾する: `workflow.md:231`「design-hash は hook が記入する（人手記入なし）」、`templates/plan-execution.md:110-111`「parent-spec-hash は hook が挿入する。人間が直接編集する必要はない」、`workflow.md:136`「plan-review-automation が Review Status と marker を更新する」。いずれも hook は文書内容を書かない（cache のみ書く）ので誤り。

### 3.5 文書間の矛盾・迷子の指示

- verdict 語彙: `workflow.md:396` Executive Summary は `pass/fail/needs-revision`、hook / guard / templates は `pass/needs-work/blocker`
- `code-simplicity-reviewer` は `workflow.md:280` / `external-review.md:77` で自動選定候補と書かれるが `REVIEWER_CATALOG`（7 件）に無い
- `block-plan-mode.ts:45-53` は 6 step 版のフローを提示し Intent Triage と Commit を欠く。`plan-review-automation.ts:505-509` は intent-triage を必須と言う
- `intent-triage` marker は「MANDATORY」だが guard は検査しない（機械的バックストップなし）。`Reviewer Outputs` 欠落は lessons 抽出を無言で skip
- `P9` / `K5` / `K7` / `R3` / `DI1` 等の内部設計コードが hook 出力（`Self-audit checklist (P9):`）に漏れ、モデルが読める文書に定義なし
- 注入防御 `<spec>…</spec>` は reviewer 5 名中 `greenfield-perspective-reviewer` のみが契約を文書化
- `stop-reflection.ts` の `messageForUser` は `session.ts:255-258` の記述通りなら捨てられる（到達性未検証）
- `off-plan-writes.log` が展開前の shell トークン（`$W`, `$A`, `/`）を path として記録（`b533d0e7` 18 件全部）

### 3.6 常時ロード文書の規模

`~/.claude/rules/*.md` + CLAUDE.md 合計 83KB、`workflow.md` 単体 36KB（約 9k tokens）。内容の大半はモデルが行動するための指示ではなく機構の仕様（hash 正規化の S3 移行手順、DOCUMENT_WORKFLOW_DIR 引き継ぎ、mechanical-lane 4 条件、guard の 4 段解決順序、carry-forward の責務分離）。`e86298b2` では `instructions` attachment が 60 回 × 7.5KB ≈ 112k tokens。

## 4. 根本原因（5 Whys）

1. なぜ成果が出ない? → 計画フェーズがターンの 70–98% を占め、レビューが収束せず、必須 step が抜け、ゲートが閉じたまま止まる、あるいは素通りする
2. なぜ? → (a) 帳簿（hash 転記・marker・3 状態・Reviewer Outputs・triage marker・Executive Summary）をモデルの手作業に載せている、(b) hook の matcher / 分類器がモデルの Bash 選好と噛み合わない、(c) レビュー loop に予算も収束条件も無く、hook が毎編集フルテキストを再注入する、(d) deny が診断情報を持たない
3. なぜそうなった? → 機構が ADR 0001→0013 で積層的に足され、各コンポーネント単体は `empirical-prompt-tuning` で「収束」判定されたが（`docs/plans/document-workflow-prompt-tuning.md`）、**end-to-end のセッションコスト**（ターン数・トークン・ラウンド数）は一度も計測・最適化されていない
4. なぜ個別収束で足りなかった? → 評価シナリオは「hook 出力を受け取った assistant が正しく行動するか」であり、「同じ出力を 185 回受け取ったら」「モデルが Bash で編集したら」「deny が 3 連続したら」という繰り返し・逸脱の系列は評価対象外だった
5. なぜ系列が見えなかった? → transcript を横断計測する手段が無く、失敗はユーザーの体感（「手が止まってる」「なんかひどいねえ」）としてしか観測されなかった

## 5. 保存すべき不変条件（ADR 由来）

- ADR-0001: 承認は人間のみ。research → plan → 注釈反復 → 承認 → 実装の反復 loop。enforcement は hook
- ADR-0003: guard は enforce（deny）モード既定。warn-only は opt-in の escape hatch
- ADR-0006: spec.md（設計承認単位）と plan-N.md（実行承認単位）は独立 hash + `parent-spec-hash` 連鎖。層別 reviewer SSoT はコード定数
- ADR-0008: 延期項目は再評価トリガー付きで記録する
- ADR-0009: mechanical-lane は 4 条件 AND の amendment。必須 reviewer を落とさない
- ADR-0013: wfDir は `session_id` + cwd から導出。解決失敗は conservative deny。env は containment 検証済み override のみ

## 6. 既知の後続課題との関係

`docs/plans/workflow-guard-followups.md` の課題 B（複合コマンド迂回）/ C（非 Bash 経路の allow）/ D（Bash 経由の spec/plan 編集が 3 hook を迂回）は本調査の P2/P3/P6 と同根。本オーダーは課題 D を含み、B は「インタプリタ heredoc を保守的 deny」で部分的に扱う（tree-sitter 側の完全対応は対象外）。

## 7. 設計方向の候補（spec.md で決定する）

- **帳簿を hook / CLI に移す**: hash・marker・Reviewer Outputs 骨格の記入をモデルの転記から外す
- **Bash 経路の対称化**: PostToolUse を「コマンド構文」ではなく「wfDir 文書の内容 hash 差分」で検知し、guard は「書込可能性が判定できないインタプリタ実行」を conservative deny
- **deny の診断化**: 不成立条件・対象ファイル・実際に見つかった近似行・修正コマンドを出す
- **レビュー loop の経済**: 同一文書への再注入を 1 行に縮退、ラウンド予算、Round ≥ 2 は前回指摘者のみ + diff
- **P1 対策**: Stop hook で「宣言語尾 + tool 呼び出しゼロ + workflow 未完了状態」を block
- **workflow.md の分離**: モデル向け operator guide（≤ 8KB、常時ロード）と機構リファレンス（必要時ロード）
- **文書矛盾の解消**: verdict 語彙、catalog、block-plan-mode の step、「人手記入なし」の虚偽、内部コード漏れ
