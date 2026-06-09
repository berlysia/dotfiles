# ADR-0010: Per-Project CONTEXT.md Mechanism

## Status

accepted (2026-06-10)

## Context

aihero.dev /grill-with-docs (2026-06-09 会話) を起点に、dotfiles プロジェクトが初期化する任意の環境で、各プロジェクトのドメイン語彙を AI が事前読込できる per-project CONTEXT.md 機構が必要と判断された。要件:

- dotfiles の責務は「環境を提供する」層であり、各プロジェクトのファイル構造に侵入してはならない
- 各プロジェクト側に commit 対象ファイルや CI ルールを要求してはならない
- CONTEXT.md 不在のプロジェクトでも従来通り動作 (degraded mode 必須)
- 軽量 MVP 重視、重い投資 (skill / hook / 検出機構 / 規約 SSoT 化) は subsequent ADR に defer

## Analysis

検討した代替案:

- **A. プロジェクトルート直下 `.context.md`**: 視認性最大、AI path 解決最短だが、各プロジェクト側の `.gitignore` 編集要求が「侵入しない」本義に反するため reject
- **B. 完全外部化 `~/.claude/projects/<repo-hash>/CONTEXT.md`**: 責務境界純度は最高だが、`<repo-hash>` 解決コスト + `ls` で発見できない視認性劣化のため reject (劣化は subsequent ADR で再評価可)
- **C. ハイブリッド `.tmp/docs/CONTEXT.md` + `@path` 薄い index**【採用】

採用根拠:

- 既存 `.tmp/` gitignore 規約に乗る (新規 gitignore ルール不要)
- 既存 `@path` 自動ロード規約と見た目同型 (新規 syntax 不要)
- `pwd` 配下で `tree .tmp/` 一発で発見可能 (人間 UX 確保)
- B 案の劣化点 (`<hash>` 解決コスト、`ls` で発見不能) を回避

## Decision

### K1: ルート位置を `.tmp/docs/CONTEXT.md` に固定

各プロジェクトの `.tmp/` 配下に置き、既存 gitignore 規約に乗る。

### K2: 参照解決は lazy + `@path` 規約

CONTEXT.md 内の参照は「`@path` + 1 行要約」のみ。AI は必要時に該当ファイルを明示的に Read する。

- 同型性の限界: CLAUDE.md の `@path` は Claude Code が読み込み時に自動展開する system 機構。CONTEXT.md 内の `@path` には同じ system 機構は適用されない (CONTEXT.md は AI が CLAUDE.md の指示により Read する一般ファイル)
- 差異は CLAUDE.md (`home/dot_claude/CLAUDE.md` の `## Per-Project Context` セクション) で「CONTEXT.md 内の `@path` 表記は AI 必要時の Read 対象」と明記して埋める

### K3: degraded mode

CONTEXT.md 不在時は grill 相当の事前確認機能はオフ、Document Workflow と他の hook は通常通り動作。

- K6 との関係: 本 MVP では grill skill が deferred のため、「事前確認機能はオフ」の実態は「grill 機能そのものが未実装」と同値。grill skill が実装された段階で初めて挙動差が観測可能になる

### K4: `.tmp/docs/` は GC 対象外

`.tmp/sessions/` のみ 7日 GC。GC スクリプト (`home/.chezmoiscripts/run_after_gc.sh.tmpl:28-35`) は `.tmp/sessions/` の path-prefix を `find -mindepth 1 -maxdepth 1 -type d -mtime +7` で対象とする SAFE pattern (a) であることを spec 段階で確認済 — `.tmp/docs/` は構造的に GC 対象外。

`workflow.md` の Session Artifact Retention 節に「`.tmp/docs/` は永続扱い」を明文化済。

### K5: 初期化は手動コピー、自動生成しない

`home/dot_claude/templates/context.md.tmpl` を提供し、開発者が必要なプロジェクトで手動コピーする。自動生成は「不要なプロジェクトにも増殖する」逆効果を招くため避ける。

template 内部規約: commit 禁止ヘッダ / 機密 path 非参照 / 要約 1 行最小 / 3 区分 (Authoritative references / Personal observations / Open questions)

### K6: grill skill / context-audit hook は本 ADR スコープ外

本 ADR の MVP は「位置の固定 + 参照規約 + degraded mode + template 提供 + 規約明文化」のみ。実装位置は `home/dot_claude/skills/` / `home/dot_claude/hooks/implementations/` に予約。

## Consequences

### Positive

- プロジェクトのファイル構造に侵入ゼロで導入可能 (新規 gitignore / CI ルール / コミット対象ファイルを各プロジェクトに要求しない)
- 既存 `@path` 規約・`.tmp/` gitignore に乗るため新規 syntax を増やさない
- degraded mode により CONTEXT.md 不在プロジェクトでも従来通り動作
- 仕様 SSoT (`~/.claude/rules/context-md.md`) 1 ファイルの編集で仕様変更が完結

### Negative / 残るリスク (MVP 範囲で許容)

- **R1 参照腐敗**: `@path` が指す project-side ファイルの move/delete 検出機構なし。silent corruption ではなく Read エラーで顕在化するため許容範囲。subsequent ADR で `context-audit` を扱う候補
- **R2 事前読込忘れ**: 決定論的保証なし、CLAUDE.md 指示文の効力に依存。読み忘れ頻発時は session-start hook 導入 (subsequent ADR)
- **R5/R6 機密 path / 誤 commit**: template ヘッダの注意書きで二次防御 (`.gitignore` 一次防御の補完)。allowlist/denylist の rule SSoT 化は subsequent ADR

### Defer to subsequent ADR

- **/grill skill** の実装 (Socratic 質問による未定義語の検出と CONTEXT.md 追記)
- **context-audit** による参照腐敗検出 hook
- **session-start hook** での CONTEXT.md 自動 Read 保証 (R2 強化)
- **allowlist/denylist の rule SSoT 化** (R6 強化)
- **`templates/` 配下の `.tmpl` 規約棚卸し** (`spec.md`, `plan-execution.md` 等の既存 pass-through ファイルとの命名規約整合、architecture-strategist 由来)

## References

- `home/dot_claude/rules/context-md.md` — 本機構の仕様 SSoT
- `home/dot_claude/CLAUDE.md` — Per-Project Context セクションでの AI 指示
- `home/dot_claude/templates/context.md.tmpl` — 初期化 template
- `home/dot_claude/rules/workflow.md` Session Artifact Retention 節 — `.tmp/docs/` 永続規約
- `home/.chezmoiscripts/run_after_gc.sh.tmpl:28-35` — GC SAFE pattern 根拠
- 元の議論: aihero.dev /grill-with-docs (2026-06-09 会話)
