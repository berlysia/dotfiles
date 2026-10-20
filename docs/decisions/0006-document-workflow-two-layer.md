# ADR-0006: Document Workflow の二層化 (spec.md + plan-N.md)

## Status

accepted

plan-N.md の Tasks を「バイトサイズ TDD scaffold」とした決定は、ADR-0032 が改訂した（Tasks は契約・不変条件・テストケースの列挙とし、コード本体を書かない）。

routing 表の判定基準は ADR-0009 が amend した（mechanical-lane の追加。supersede しない）。plan-N の承認の委任は ADR-0028 が加えた（Amendments）。

## Context

Document Workflow (ADR-0001) は plan.md 単一ファイルに、設計の判断と実行の手順を同居させる構造を採用してきた。3-5 ステップ規模の変更ではこの構造で十分機能するが、6+ ステップや複数の設計判断を含む大規模変更では以下の問題が観測されている:

- **plan.md の肥大化**: Goal / Alternative Approaches / Key Decisions / Files / Tasks / ISO 25010 テスト計画が 1 枚に同居し、レビュアーの守備範囲が曖昧になる
- **再計画コストの非局所化**: 設計判断は変わらないのに実行手順を差し替えると plan.md 全体の hash が無効化され、全レビューが再走する
- **worktree 並列実装との不整合**: 1 plan で複数モジュールの実装計画が混在すると、各モジュールを独立にレビュー・承認・実装できない
- **incremental bias の温床**: Greenfield View が実行詳細と同居するため、設計層独立の白紙視点が薄まる

obra/superpowers の brainstorming → writing-plans → executing-plans 三層スキル構造との比較から、「設計の承認単位 (spec)」と「実行の承認単位 (plan)」を別ファイルに分離することで再レビューコストの局所化と並列実装の整合性を同時に達成できることが示唆された。

## Decision

**Option A**: spec.md (設計層) と plan-N.md (実行層) を完全に分離し、独立 hash・独立承認とし、parent-spec-hash で連鎖を検証する。

差分最小案（plan.md 内にセクションマーカーを足すだけ）を白紙視点と比較した結果、別ファイル化が必須と判断した:

- 1 plan の再計画で他 plan の hash が無効化される副作用を避けるには独立 hash が必要で、独立 hash には別ファイル化が前提
- worktree 並列実装で各 plan を独立にレビュー・承認・実装するには guard が plan ごとに状態を判定する必要があり、別ファイルが前提
- spec 層レビュアー (greenfield / decision-quality 等) と plan 層レビュアー (test-quality / code-simplicity 等) の SSoT 分離が ADR-0005 規約と整合する

しきい値判定は **ステップ数 (6+) OR 複数設計判断 OR 複数サブシステム** の OR 条件を採用する。AND 条件だと「6+ ステップだが単一判断」(機械的書き換え等) が過剰 ceremony 化する。

### モード判定（人間/Claude が routing 表で判定、hook は spec.md 存在で自動分岐）

| 条件                                                                  | モード                                   |
| --------------------------------------------------------------------- | ---------------------------------------- |
| 1-2 ステップ、1-2 ファイル                                            | 直接実行                                 |
| 3-5 ステップ、明確な方針                                              | `/approach-check`                        |
| 3-5 ステップ + 単一の設計判断                                         | DW (plan.md のみ)                        |
| 3-5 ステップ + 複数判断 OR 6+ ステップ + 単一判断 OR 複数サブシステム | DW (spec + plan-N)                       |
| Scope Guard 検知                                                      | `/scope-guard` → spec + 1..N plan に分解 |

### 二層モードの成果物

- spec.md（設計層、1 つ）: Goal / Experience Delta / Alternative Approaches (Greenfield View) / Key Decisions / Architecture / Risks / ISO 25010 次元選択 / Approval
- plan-N.md（実行層、N 個）: spec-ref / Files / Tasks（バイトサイズ TDD scaffold）/ ISO 25010 具体テストケース / Approval（`parent-spec-hash` 必須）

### 承認連鎖

1. spec.md を `Plan Status: complete` → `Review Status: pass` → `Approval Status: approved` の順で進める
2. spec 承認後、plan-N.md を独立に同手順で承認する
3. `document-workflow-guard` は実装系書き込み時に、spec.md の三状態 + hash 一致、対象 plan-N.md の三状態 + hash 一致、plan-N.md の `parent-spec-hash` と現 spec.md hash の一致を、read-snapshot で検証する
4. spec の承認時に人間が選ぶと、spec の `## Scope` に収まる plan-N は個別の承認なしで gate を通る（ADR-0028）

### 決定の ID

- **K4（レビュアー集合の SSoT 分離）**: `ALWAYS_ON_REVIEWERS` を `SPEC_REVIEWERS`（logic-validator / scope-justification-reviewer / decision-quality-reviewer / greenfield-perspective-reviewer）と `PLAN_REVIEWERS`（logic-validator / scope-justification-reviewer + コンテンツベース選定）に分ける。同名 slug が両方に出るので、doc 側のマーカー区間も spec 用と plan 用に分け、各区間と各定数配列を独立に照合する。これは ADR-0005 の規約（マーカーは slug 識別子の SSoT 区間にだけ使う。責務文の prose は対象外）を踏襲する解釈である
- **K5（hash 関数の汎化）**: hash 関数を文書種別ごとの正規化ルールで切り替えられる形にする。spec.md は Tasks の checkbox を持たないため、plan.md と正規化が異なる
- **K7（parent-spec-hash 連鎖）**: plan-N.md の auto-review marker に `parent-spec-hash` を必須にし、書き込みは `plan-review-automation` hook が担う。欠落した plan-N.md は conservative deny（bypass 防止）。spec.md の改訂で plan-N.md が silent stale になる整合性ホールを塞ぐ
- **K8（Files 節の書式）**: plan-N.md の Files は 1 行 1 パスの固定書式とし、形式違反は conservative deny
- **K9（plan ファイルの glob 制限）**: guard が enumerate する plan ファイルは `plan.md` と連番の `plan-N.md` に限る。`plan-draft.md` や `.bak` などは対象外
- **K11（prompt injection 防御）**: reviewer が読む spec.md / plan-N.md 本文は `<spec>` / `<plan>` タグで区切り、ADR-0004 の区切りを拡張する
- **後方互換**: spec.md 不在時は単層モード（現行 plan.md ベース）に自動で戻る。進行中の plan.md は単層で継続し、新規セッションのみ二層モードの判定を適用する
- **No Placeholders 禁則**: spec.md / plan-N.md / 単層 plan.md 共通で、"TBD" / "後で実装" / "適切にエラー処理" のようなプレースホルダを禁止する。`workflow.md` に明記する

## 却下した代替案

- **差分最小案 (マーカー分離)**: ファイル分離なしでは hash 単位が分離できず、独立承認・並列実装が不可能。
- **Option B (plan が spec hash を継承で再承認不要)**: plan の独立性が失われ、1 plan の再計画が他 plan に波及する。worktree 並列実装の前提が壊れる。
- **Option C (統合 hash)**: spec 変更で全 plan 再レビューとなり、本 ADR の主目的「再計画コスト局所化」が失われる。
- **しきい値の AND 条件採用**: 「6+ ステップだが単一判断」(機械的書き換え等) が過剰 ceremony 化し、運用コストが許容を超える。
- **K1 自動判定 (hook がモード推奨)**: hook 側にステップ数判定ロジックを持ち込むと plan 内容のパース責務が肥大化する。判定は人間/Claude (routing 表参照) に委ね、hook は spec.md 存在のみで分岐する設計が責務として軽い。
- **責務文の SSoT 化** (ADR-0005 で確認済み): 表現粒度 (英語 instruction vs 日本語解説) が異なるため一致を強制すると両方の表現が痩せる。本 ADR でも踏襲。
- **P0 規律 (Spec Self-Review ゲート / 一問一答) を本 ADR に同梱**: ファイル構造の二層化とプロセス規律は責務軸が直交し、独立に accept/reject 可能。本 ADR ではファイル構造変更 + No Placeholders 禁則のみ採用、Spec Self-Review と一問一答は ADR-0007 へ分離。

## Consequences

- **再レビューコストの局所化**: spec を変えずに plan-N.md だけ差し替え可能。1 plan の再計画が他 plan の hash を無効化しない
- **worktree 並列実装との整合**: 各 plan-N.md を独立に承認・実装可能。1 spec → N plan の関係が成立
- **承認ゲートの二重化コスト**: spec 承認 + plan 承認で承認サイクルが伸びる。しきい値判定 (3-5 ステップ + 単一判断 → plan.md のみ) で軽量モードを残して軽減
- **hook 複雑度増**: `document-workflow-guard` に承認連鎖検証 + parent-spec-hash 検証 + Files 節パーサ + glob 厳格化が追加。テストカバレッジで吸収
- **既存進行中 workflow との互換性**: spec.md 不在時の単層 fallback で破綻なし。新規セッションのみ二層モード適用
- **テンプレート間の構造 drift**: 軽量 spec (plan.md-only モード) と完全 spec (二層モード) のセクション集合が drift する可能性。テンプレ間構造照合 CI は導入せず、この節に記録して、必要なら別 ADR で対処する
- **直積状態空間の未網羅**: spec 三状態 × plan-N 三状態の 9 セルのうち、テストは 7 ケースを網羅する。未網羅は、spec=complete + plan=Review:pending と、hash 同時更新後の片方残存。代表性で許容する
- **hook 完了後の race の accept（K12）**: read-snapshot は hook 単一実行内の TOCTOU を防ぐが、hook 完了後の編集は次回 Write 時の K7 連鎖検証で検出される設計とする

## Amendments

### Amendment (2026-10-06): plan-N の承認を委任できる

ADR-0028 で、人間が spec の承認時に選ぶと、spec の `## Scope` に収まる plan-N が個別の承認なしで gate を通るようにした。

これは却下した代替案の Option B とは違う。
plan-N は自分の marker の hash と `parent-spec-hash` を持ち続け、省くのは plan-N の承認の記録だけである。
Option B を退けた理由（plan の独立性が失われる）は当たらない。

ただし、spec を改訂すると、全 plan-N の委任が同時に無効になる。
人間が改訂後の spec を承認し直すまで、委任で通っていた plan-N は止まる。

## References

- ADR-0001: Document Workflow の起源
- ADR-0003: Guard enforce mode
- ADR-0004: Greenfield Reviewer + plan.md MANDATORY セクション
- ADR-0005: Always-on reviewers SSoT 規約
- obra/superpowers (`https://github.com/obra/superpowers`): brainstorming / writing-plans / executing-plans skills
- Followup ADR: ADR-0007 — Spec Self-Review ゲート + 一問一答ルール
- Amended by: ADR-0009 — mechanical-lane routing（routing criteria を amend、supersede しない）
