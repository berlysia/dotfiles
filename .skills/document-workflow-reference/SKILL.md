---
name: document-workflow-reference
description: Document Workflow の機構リファレンス。operator guide (`~/.claude/rules/workflow.md`) から分離した詳細を引く。hash 3 種の意味、三状態承認、DOCUMENT_WORKFLOW_DIR 引き継ぎ、S3 移行手順、prescribed-fix carry-forward の責務分離、mechanical-lane の 4 条件、ISO 25010 特性選択ガイド、workflow-cli のサブコマンド仕様を扱う。deny の原因が分からない・hash が動いた・モード判定に迷う・mechanical-lane の可否を判断するとき、または `/document-workflow-reference` と指示されたときに読む。
---

# Document Workflow — Mechanism Reference

operator guide（`~/.claude/rules/workflow.md`）は「何をどの順でやるか」を扱う。本 skill は「なぜそうなるか・機構がどう動くか」を扱う。deny の原因調査、hash の挙動、モード判定の境界、移行手順が必要なときに読む。

## 三状態承認と hash 3 種

各成果物は 3 つの状態を満たすと実装可能になる:

- **Plan Status**: `draft` → `complete`（モデルが書く）
- **Review Status**: `pass` / `needs-work` / `blocker`（`workflow-cli stamp` が厳密形で書く。手で転記しない）
- **Approval Status**: `pending` → `approved`（**人間のみ**）

hash は 3 種あり、いずれも `workflow-cli` が計算して marker に書く（モデルは転記しない）:

- **auto-review hash**: 成果物全体の正規化 hash。marker の `hash=` と実ファイルの照合に使う。正規化は marker / intent-triage marker / Reviewer Outputs セクション / Approval Status 値 / チェックボックス状態を除外するので、これらの編集では hash は動かない。**ただし Review Status の値は正規化対象外**なので、needs-work → pass の遷移では hash が動く（`workflow-cli stamp` は Review Status を書いた後の内容で hash を計算するため整合する）。
- **design-hash**: Key Decisions / Files / Scope / Tasks セクションのみの hash。prescribed-fix carry-forward 判定に使う。
- **parent-spec-hash**: plan-N.md が指す spec.md の hash。K7 連鎖検証に使う。

## K7 連鎖検証（二層）

`document-workflow-guard` は実装系書き込み時に read-snapshot で検証する:

1. spec.md の三状態 + marker verdict=pass + hash 一致
2. 対象ファイルが属する plan-N.md（Files セクションに列挙）の三状態 + hash 一致
3. その plan-N.md の `parent-spec-hash` = 現 spec.md hash

`parent-spec-hash` フィールドが欠落した plan-N.md は不一致と同等の conservative deny。spec.md を編集して hash が動くと全 plan-N.md の parent-spec-hash が不一致になり自動でブロックされる。

## deny の診断

guard の deny は固定文ではなく診断を返す: どの条件（Plan/Review/Approval/marker verdict/hash）が不成立か、実際に見つかった status 行（ハイフン欠落や行末注記もそのまま表示）、期待する厳密形、次の 1 手。`workflow-cli status` で同じ診断を出せる。

**よくある固着**: `Review Status: pass` をハイフン無しで書くと判定 regex（`^- Review Status:\s*pass\s*$`）に一致せず deny される。診断がその行を「見つかった行」として示す。`workflow-cli stamp` を使えば厳密形で書かれる。

## Bash 経路と tripwire

- 文書を Bash（`python3 - <<'PY'` 等のインタプリタ heredoc）で書き換えても、`workflow-bash-sync`（PostToolUse Bash）が wfDir 内文書の内容 hash 差分を検知してレビュー推奨を出す。subagent 由来の Bash（`agent_id` あり）は対象外。
- 承認前のインタプリタ inline-script 書き込み（`python|node|bun|deno` の `-c`/`-e`/heredoc に書込指標があり、書込先が scratch root 外 or 証明不能）は保守的に deny される。scratch root は `/tmp` / `$CLAUDE_JOB_DIR` / `.tmp/` / `$DOCUMENT_WORKFLOW_DIR`。読み取りのみの解析スクリプトは許可される。
- gate 閉（承認前）に repo 内ファイルが書き換わると tripwire が次の Bash 後に検知し `off-plan-writes.log` に記録して告知する。`git` 不在・200ms 超過では `.tripwire-disabled` を作り一度だけ告知して skip する。

## prescribed-fix carry-forward（再レビュー省略）

needs-work 指摘の反映後、以下 3 条件の AND 成立時のみ再レビューを省略して直前 verdict を carry-forward する:

- (a) 指摘が文言精度クラス（No Placeholders 禁則違反の修正等）
- (b) reviewer が verbatim 置換を指定している
- (c) `{Key Decisions, Files/Scope, Tasks}` の design-hash が直近 `verdict=needs-work` marker の design-hash から不変

**責務分離**: (a)(b) は reviewer/人間が運用文脈で成立させる条件で hook は機械判定しない。hook が機械検証するのは (c) のみ（`canCarryForwardVerdict`）。1 条件でも欠ければ全再レビュー。design-hash フィールド欠落の marker は (c) 不成立扱い。section-scoped design-hash 機構が未デプロイの場合は no-skip stance（再レビューは走らせるが省略はしない）に縮退する。「diff を目視」での (c) 判定は禁止。

## mechanical-lane（4 条件 AND）

以下 **4 条件すべて（AND）** が成立する変更のみ mechanical-lane として plan.md-only 単層に routing する。1 条件でも非該当なら二層 row に fallback（no-fallback 例外なし）。

- (i) スコープ内の全設計判断が「ユーザーがセッション内で明示確定済の既存 ADR の特定条項の改訂」で、net-new な設計空間がゼロ
- (ii) 残差が決定論的変換（rename / move / 文字列置換）で、新規 control flow / data model / API shape を導入しない
- (iii) 既存テスト + typecheck が当該変換を被覆する
- (iv) 新規 ADR 自体を当該変更の設計記録とする

mechanical-lane を選んだら 4 条件それぞれの判定根拠を plan.md に明記する（曖昧語のみの根拠は不可）。

## ISO 25010 特性選択ガイド

| 変更の種類            | 優先的に検討する品質特性             |
| --------------------- | ------------------------------------ |
| 新機能追加            | 機能適合性、使用性、信頼性           |
| バグ修正              | 機能適合性（正確性）、信頼性         |
| パフォーマンス改善    | 性能効率性                           |
| リファクタリング      | 保守性、機能適合性（リグレッション） |
| インフラ/デプロイ変更 | 移植性、互換性、信頼性               |
| セキュリティ対応      | セキュリティ、信頼性                 |
| API/データモデル変更  | 互換性、機能適合性、セキュリティ     |

## DOCUMENT_WORKFLOW_DIR の引き継ぎ

hook は wfDir を hook 入力の `session_id` + cwd から導出するので、環境変数が無くても enforce は効く。次セッションへ引き継ぐとき:

- **`/clear` して同じプロセスで続ける**: `/clear` は新しい session id を発行し `.tmp/sessions/<新 id 先頭8桁>` になる。前セッションの成果物を新 dir へ `cp -a` でコピーする。auto-review hash は文書内容のみから算出されるのでパスが変わっても承認状態は保たれる。コピーは必ず空変数ガードとセットで同じ Bash 呼び出し内で行う:

  ```bash
  : "${DOCUMENT_WORKFLOW_DIR:?set by the SessionStart hook; unset means unresolvable}"
  cp -a .tmp/sessions/<旧 id 先頭8桁>/. "$DOCUMENT_WORKFLOW_DIR"/
  ```

  変数が空のまま `cp` が走ると `cp -a <src>/. /` になりルート直下へ展開する。

- **`claude` を起動し直す**: `DOCUMENT_WORKFLOW_DIR=.tmp/sessions/<旧 id 先頭8桁> claude "..."` と起動時 env で pin する。containment を満たさない pin は `env-rejected` として捨てられ導出値が使われる。

## S3 デプロイ移行手順（hash normalizer 変更時）

hash 正規化を変更した場合、旧 normalizer で承認済の進行中成果物は marker hash が変わり conservative deny される。新規セッションで以下を実装再開前に完了する:

1. `bun run test` で hash parity（`document-hash.test.ts` の legacy↔new 境界 + `document-workflow-guard.test.ts` の統合経路）が両方緑であることを確認する。
2. 進行中成果物の `<!-- auto-review: ... -->` の hash を新 normalizer で再算出して書き換える。
3. `plan-review.cache.json`（plan と同ディレクトリに co-locate）を削除して誤 skip を防ぐ。
4. 1→2→3 完了前に実装を再開しない。

**注**: 現行設計では正規化を変更しない方針（deny 診断は寛容マッチを表示専用に分離し、判定 regex と正規化は不変）なので、この手順は将来 normalizer を変える場合の備えである。

## workflow-cli サブコマンド

`workflow-cli` は marker / Review Status / Reviewer Outputs 骨格 / intent-triage marker を書く。モデルは hash を転記しない。

- `workflow-cli status [--wf-dir <dir>]`: gate 診断 + tripwire 状態を表示。
- `workflow-cli round <doc>`: `## Reviewer Outputs (Round N)` 骨格を marker 直前に挿入し、`.round-baseline` に round 番号と時刻を記録する。
- `workflow-cli stamp <doc> --verdict <pass|needs-work|blocker> --reviewers a+b`: Round N セクションと reviewer 実行証跡（`reviewer-runs.log`）を確認し、揃っていれば厳密形の Review Status と marker を書く。証跡が無ければ非 0。
- `workflow-cli triage <doc> --adopted N --excluded M`: intent-triage marker を書く。

いずれも Approval 行に触れる変更は拒否する（承認は人間のみ）。wfDir は `--wf-dir`（`isStrictlyUnderProjectSubdir` で検証）または `$DOCUMENT_WORKFLOW_DIR`。session 由来の dir と食い違うと警告する。

## reviewer 実行台帳（reviewer-runs.log）

`reviewer-run-recorder`（PostToolUse Agent）が reviewer subagent の起動を `<sessionId>\t<subagent_type>\t<ISO>` で記録する（200 行 FIFO）。`stamp` はこの台帳で「対象層の必須 reviewer が現 round の baseline 以降に起動されたか」を検証する。これにより round + stamp だけで reviewer 未起動のまま pass を書くことを防ぐ。台帳は session 単位で文書単位ではない（同 session で spec と plan-N を同 round で見る場合は両層の必須 reviewer が揃えば通る、過剰許容側の fail-open）。

## 起動軸（pull / push）と autonomous lane

`~/.claude/rules/autonomous-lane.md` の charter（C1 型ホワイトリスト / C2 可逆性 / C3 設計面非接触）を参照。push レーンは CI/cron 専用で出力は必ず PR。設計判断（ADR / API / データモデル / routing 表の変更）を push に乗せることは恒久的に禁止。
