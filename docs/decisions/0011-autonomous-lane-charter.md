# ADR-0011: 起動軸（pull/push）の明文化と自律レーン憲章

## Status

accepted (2026-06-10)

## Context

Task Intake Routing 表（`home/dot_claude/rules/workflow.md`）は ceremony 軸（手続きの重さ）1 軸のみで構成され、起動者は常に人間 pull を暗黙の前提としていた。一方、自律 CI レーン（`.github/workflows/auto-fix-dependencies.yml` = 依存 bot PR の CI 失敗を無人修正する workflow）は既に稼働しているが routing 表の外に孤立しており、「どこまで自律してよいか」の判断基準が成文化されていなかった。新しい自律タスクを追加したくなるたびに安全境界のゼロ判断が発生する。

発端はオーダー「大方針は DW で直接指揮、どうでもいいものはガンガン自律的に、とかできないもんかな」= 起動軸（initiation: 人 pull / system push）の分離要求。セッション内でユーザーが「自律レーンの住所 = CI/cron（出力=PR、無人実行・有人 review 強制）」「まず DW で設計」を確定した。

**番号注記**: 本 ADR の設計層 spec 起草時点の次番号は 0010 だったが、並行セッションが `0010-context-md-mechanism.md` を取得したため 0011 で起票した。「`docs/decisions/` の次番号で起票する」という決定本義は不変。

## Analysis

検討案:

- **差分最小案（reject）**: `auto-fix-dependencies.yml` を放置し、新しい自律タスクが欲しくなった都度 workflow を 1 本書く。routing 表は触らない。→ 危険象限（push × 設計判断）を構造的に排除できず、自律タスクが増えるほど「これは自律してよいか」の暗黙判断のばらつきが累積するため reject。
- **白紙設計案の軸定義 + 既存実装の継承（採用、ハイブリッド）**: 「誰が仕事を選ぶか（pull/push）」と「どれだけ手続きを踏むか（ceremony）」は論理的に独立した次元（起動の主体 vs 実行の重さ）であり、この直交性が 2 軸分離の origin。ゼロから設計する者はオーダーを満たすために 2 軸を分離し、危険な象限（push × 設計判断）を名指しで空にする構造へ自然に到達する。実行機構は白紙から作らず、既存 workflow の防御層（provenance / hygiene / supply-chain / concurrency）を charter の reference 実例として継承する。ただし継承する防御層が prompt injection を防がない点を charter に正確に記録した上で継承する。

誤分類リスクの非対称性が設計の急所: false-autonomous（設計判断を trivial 扱いして無人実行）は高コストで、CI レーンには `document-workflow-guard` のバックストップが無い（guard はローカル fs 基準で CI を管轄しない）。false-gated（trivial を DW 扱い）はただの摩擦で安い。

## Decision

1. **起動軸を routing 表に明文化する（K1）**: `home/dot_claude/rules/workflow.md` の Task Intake Routing に「起動軸（initiation: pull / push）」小節と二軸図を**純粋追加**する。既存 ceremony 行は不変。guard コードは変更しない（CI は元々管轄外、ローカル pull 側の挙動は不変）。
2. **自律実行はタスク型ホワイトリスト方式（K2）**: charter C1。誤分類リスクの非対称性に基づき、事前宣言したタスク型のみを実行対象とする。これは「型ホワイトリストのみが論理的に安全」という必然ではなく、現時点で最も安全と判断した**設計選択**である。汎用 triviality 判定器は禁止。既存実例 = `auto-fix-dependencies.yml` の bot author allowlist。
3. **charter を独立 rule ファイルとして作成し registry 登録する（K3）**: `home/dot_claude/rules/autonomous-lane.md` を新規作成し、`home/dot_claude/CLAUDE.md` の「Rules (auto-loaded by path match)」一覧にエントリを追加する。登録しないと auto-load されず silent gap になる。
4. **C2/C3 の honor-system 限界を明記し、mechanical gate 化を Phase 2 hardening とする（K4）**: C2「無人 merge 禁止」/ C3「設計面非接触」は現状 CI プロンプト内の指示であって機構的強制ではない（`permissions:` と `--allowed-tools` の範囲で `gh pr merge` は技術的に実行可能）。Phase 2 hardening = branch protection による merge 阻止（自律 identity が自身の PR を approve できない構成 = self-approve 抜け穴の封鎖）/ `git diff --name-only` を設計面パス + 状態ファイルパス blocklist と突合する CI step。
5. **Phase 1 メンバーは既存 1 型に限定し、Phase 2 移行トリガーを明記する（K5）**: Phase 1 charter メンバー = 依存 bot PR の CI 修正型のみ。移行トリガー = format 自動修正 / knip dead-code 削除等の新規自律型候補が実際に発生した時点。
6. **右上象限（push × 設計判断）は永久空白とする**: 設計判断（ADR / API / データモデル / routing 表自身の変更）を push に乗せることを禁止する。これが cognitive surrender 耐性の構造的根拠。

## Consequences

**正**:

- 自律レーンに型を足す/足さないの判断が charter 不変条件（C1/C2/C3 + named invariant）で機械的に下せる。
- `auto-fix-dependencies.yml` が charter 配下の明示メンバーになり、routing 表外の孤立が解消する。
- 後続フェーズ（型拡張・能動 discovery 心臓）の安全評価枠組みが先行整備される（charter なしでは C1 適合評価・injection 面評価を開始できない）。

**負・限界**:

- Phase 1 は新規の自律挙動を一切増やさない（accepted trade-off。「実際に手が空く」体験は Phase 2 以降）。
- C2/C3 は honor-system prompt control に依存する（Phase 1 accepted limitation、Phase 2 で mechanical gate 化）。
- charter と既存実装の drift リスク。緩和 = charter の参照を line 番号でなく stable identifier（`pr-info` step / `allowed_bots` キー / `persist-credentials: false` / `concurrency` キー）で行う。

**Named invariant（将来の型拡張の義務として記録）**: author allowlist は「誰が PR を開いたか」しか証明せず、agent が処理するコンテンツの安全性は保証しない（allowlist ≠ injection 防御）。Renovate/Dependabot PR の content も上流供給チェーン経由で部分的に攻撃者影響下にあり、型の狭さは injection 面を縮小するが content-safe を意味しない。新しい型が untrusted content を agent に読ませるなら、injection・exfiltration・supply-chain を CI-side の非 prompt gate で別途閉じること。

関連: charter 本体 = `home/dot_claude/rules/autonomous-lane.md`（配置先 `~/.claude/rules/autonomous-lane.md`）。先例 = ADR-0006（二層モード）/ ADR-0009（mechanical-lane、routing 軸追加の類似事例）。
