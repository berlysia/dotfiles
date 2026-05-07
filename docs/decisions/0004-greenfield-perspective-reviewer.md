# ADR-0004: Greenfield perspective reviewer for incremental bias mitigation

## Status

accepted

## Context

Claude が Document Workflow で plan.md を立てると、既存コード構造を不変前提として「ここに何を足すか」を書く incremental bias に陥る傾向が観察された。差分が小さいほど実装ステップが少なく、レビュー指摘も減るため、作業者にとっての局所最適に陥る。

ADR-0001 / ADR-0003 で導入した plan-review-automation の常時必須レビュアーは 3 名（logic-validator / scope-justification-reviewer / decision-quality-reviewer）。コンテンツベースで選定される追加レビュアー 8 種を含めても、観点の偏りを観察すると以下の構造になっていた:

- **logic-validator**: 中立（事実ベース）
- **scope-justification-reviewer**: 各変更にエビデンスがあるか（過剰の抑制）
- **decision-quality-reviewer**: dominant-axis の整合（軸ズレ抑制）
- **追加レビュアー群**（architecture / security / performance 等）: 各専門領域でリスクを指摘（過剰の抑制）

7 名すべてが「過剰さ・軸ズレ・無根拠を警戒する」方向で、**「現計画が小さすぎないか」を能動的に問う者がいない**。`scope-justification-reviewer` の "Near-term Necessity Advocacy" 節は近いが、評価対象は計画に含まれている変更であって、計画から漏れている改善は守備範囲外。

`intent-alignment-triage` は事後に「オーダーを歪めて縮小する指摘」を弾く damage control であり、計画段階で野心の高さを保証するメカニズムではない。

## Analysis

- バイアスの mechanism 仮説:
  - **アンカリング**: 既存コード Read 直後の plan は既存構造を不変前提にする
  - **コスト過大評価**: 大きな変更は「リスク」として計上されやすいが、変えないことのコストは見えにくい (status quo bias)
  - **完了の早さがインセンティブ化**: 差分が小さいほど作業ステップが少なく承認も早い
  - **レビュアー側の非対称性**: 「変更に根拠はあるか」を問う者はいるが、「現状維持の根拠はあるか」は誰も問わない
- 対策候補は 4 種類検討:
  - 上流対策（plan.md フォーマットに「白紙設計案」セクション必須化）
  - 下流ガード（積極寄りの常時レビュアー追加）
  - 専用スキル（手動起動 `/greenfield-rethink`）
  - これらの組み合わせ
- 単独採用ではいずれも failure mode を持つ:
  - 上流のみ: Claude が「形式的に書いて済ます」失敗
  - 下流のみ: plan 全体の書き直しコストが大きく、承認サイクルが伸びる
  - 手動起動のみ: Claude の呼び忘れリスク、強制力不在

## Decision

**上流対策と下流ガードの二重化**を採用:

1. **上流**: plan.md に `## Alternative Approaches (Greenfield View)` セクションを必須化。`workflow.md` に三条件チェックリスト (a)(b)(c) を明記して形式的記述を抑制
2. **下流**: 常時必須レビュアーの 4 番目として `greenfield-perspective-reviewer` を追加。守備範囲は「plan に書かれていない改善の発掘」とし、既存の `scope-justification-reviewer`（plan に書かれている変更の根拠）と補完関係を作る
3. **適用範囲**: 全 Document Workflow に必須。バグ修正等で本来差分最小が妥当なケースも「白紙案 = 現計画」を経由させて思考を強制

`greenfield-perspective-reviewer` の設計:

- md 単独完結型（`logic-validator` / `scope-justification-reviewer` を踏襲）
- frontmatter `tools: Read, Glob, Grep` の最小権限、`model: sonnet`
- 思考プロセス: plan.md の Goal と外部制約のみ抽出 → Proposed Approach を carve out → 独立に白紙案を再構築 → 比較 → ambition gap / anchor fixation / symptomatic patch / formalism failure を検出
- prompt injection 対策: plan 本文を `<plan>...</plan>` で明示区切り、plan 内の指示構造を「指示」として誤解釈させない

## Rejected alternatives

- **手動起動スキル `/greenfield-rethink`**: Claude の呼び忘れがバイアスの逃げ道になる
- **設計判断を伴う変更のみに限定**: 「設計判断を伴うか」の自己判定そのものがバイアスの逃げ道になる
- **`scope-justification-reviewer` の責務拡張**: 控えめ寄りと積極寄りは方向性が逆で同居困難。別エージェントの方が責務分離が明確
- **常時必須レビュアー数の上限ポリシー明文化**（performance-oracle が指摘）: 今回のスコープを越えた将来制約の議論。観測データなしに上限を決めるのは時期尚早

## Consequences

- 並列サブエージェントのトークンコストが約 33% 増（3→4 名）。手戻り削減効果による相殺は未測定で、初期数週間は純増として扱う。並列実行のため wallclock latency への影響はほぼなし
- `scope-justification-reviewer`（控えめ寄りに見える）と `greenfield-perspective-reviewer`（積極寄り）の指摘が衝突するパターンが新発生する。`intent-alignment-triage` の三分類（aligned / neutral / divergent）で arbitrate する
- 常時必須リストが `workflow.md`, `external-review.md`, `plan-review-automation.ts` の 3 箇所に分散している事実が顕在化。次回追加時に drift する懸念があり、Single Source of Truth 化は別 ADR で扱う候補 → **ADR-0005 で解消**（hook 内 `ALWAYS_ON_REVIEWERS` 定数を SSoT、doc は手書き + マーカー、テストで drift 検知）
- 進行中 plan の hash 不一致: 本変更前から進行中の Document Workflow plan を編集すると、新フォーマット非準拠の状態で 4 名推奨が出る。hook 側にガード機構はないため、当該セッションでは追加レビュアーの指摘を「フォーマット不一致による誤検知」として扱う運用判断

## Open observation items

「差分最小バイアスの抑制」目的が達成されたかは、機能存在確認だけでは判定できない。デプロイ後の最初の N 個（N ≥ 5）の Document Workflow plan を対象に観察する:

- plan.md `Alternative Approaches (Greenfield View)` セクションが「白紙案 = 差分最小案」と機械的に記述されているか、両案が異なる内容で比較されているか
- `greenfield-perspective-reviewer` の output 傾向: 全肯定が連続するなら検出力不足、全否定が連続するならノイズ過多。**1〜3 割が指摘・残りは肯定**を想定レンジとする
- 採用率: greenfield reviewer の指摘が `intent-alignment-triage` で aligned に分類される割合。極端に低ければ役割不適合、極端に高ければ `scope-justification-reviewer` との重複兆候
- 想定範囲外なら behavior tuning（指示文修正）または運用見直し

## References

- Implementation commit: `44eb918` (`feat(workflow): add greenfield-perspective-reviewer to counter incremental bias`)
- Related ADRs: ADR-0001 (Document Workflow), ADR-0003 (Document Workflow Guard enforce)
- Affected files:
  - `home/dot_claude/agents/greenfield-perspective-reviewer.md`
  - `home/dot_claude/hooks/implementations/plan-review-automation.ts`
  - `home/dot_claude/hooks/tests/unit/plan-review-automation.test.ts`
  - `home/dot_claude/rules/workflow.md`
  - `home/dot_claude/rules/external-review.md`
