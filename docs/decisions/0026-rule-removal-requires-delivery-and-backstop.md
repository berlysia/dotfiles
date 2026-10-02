# ADR-0026: 規則を削る根拠は、届く通知と止める機構の両方とする

## Status

accepted (2026-10-03)

ADR-0025 の K5（ENFORCED の定義）を改訂する。

## Context

ADR-0025 の後、規則そのものを棚卸しした。調べたのは `rules/workflow.md` の 40 件と、参照 skill（`document-workflow-reference`）の 17 件である。

調べた方法は 2 つある。

- hook・CLI の出力が、規則と同じ指示をモデルに届けるか。コードを読んで確かめた。
- transcript で、その規則が使われたか。

測れた窓は 2026-09-24 から 10-03 の約 10 日しかない。対話セッションは 91 本で、Document Workflow を使ったのは 44 本だった。実際に使っているプロジェクトは 2 つである。

コードを読んで分かった事実は次のとおりである。

- PreToolUse で exit 0 のときの stderr は、モデルに届かない。off-plan の警告がこれに当たる。
- SessionStart の `systemMessage` は UI に出るだけである。
- Executive Summary の書式の通知は、pass の後に Write / Edit したときにだけ出る。stamp を Bash で実行して終える流れでは出ない。
- トリアージの指示は、reviewer の推奨と一緒に 1 回出るだけである。

ADR-0025 の ENFORCED は「hook・CLI が同じ文面を出すか、機械的に強制する」だけで成り立つ。そのため、届かない通知や、見逃しても止まらない通知を根拠に、規則の文を削れてしまう。

## Decision

- **D1（ENFORCED の要件）**: 削除の根拠にするには、次の (a) と (b) の両方が要る。この定義で ADR-0025 K5 の ENFORCED を置き換える。
  - (a) 規則が当てはまる時点か、その直前に、hook・CLI の出力が同じ指示をモデルに届ける。届く出口は、PostToolUse の `additionalContext`、Stop の block 理由、CLI の出力、deny の理由である。
  - (b) (a) の通知を見逃しても、deny、CLI の非 0 終了、gate の拒否のどれかが違反を止める。人が気づくことは (b) に含めない。
  - 次のものは根拠にしない。PreToolUse で exit 0 のときの stderr、SessionStart の `systemMessage`、何も言わずに通す処理。
- **D2（使用実績）**: 使用実績は、単独では削除の根拠にしない。使うのは、候補の優先順位の目安と、hook が発火していることの確認だけである。理由は窓の短さと、設計上まれな規則（誤って入った場合の脱出、S3 デプロイ移行）があることである。
- **D3（参照 skill の扱い）**: 参照 skill の本体には、ENFORCED を削除の根拠として当てない。本体は機構を説明する文書だからである。削れるのは DUP / NOISE / MOVE のときだけとする。

今回の適用結果は、外したのが 4 件、直したのが 2 件、残したのが 5 件である。

- 外した:
  - W16 の文「起動証跡（`reviewer-runs.log`）が無いと stamp は通らない。」。stamp の台帳エラーが同じ内容を出す。
  - W17 の括弧書き「（`round` / `stamp` もこの集合）」。`round` の出力の `re-run:` 行が同じ集合を示す。
  - W33 の説明部分。「承認前の使い捨て作業は session の scratchpad か `mktemp -d` の出力先に、リテラルの絶対パスで書く（`.tmp/` も guard の対象。他 repo・`$HOME`・dotfiles には書かない）。」に縮めた。deny の理由が同じ案内を出す。
  - W39 の文「ユーザーの期待を勝手に下げたり steering を無効化しない。」。DUP として外した。`~/.claude/CLAUDE.md` の Prohibitions に同じ内容がある。
- 直した:
  - W25 の理由を、インタプリタの heredoc に合わせて訂正した。
  - W06 の参照先の節名を「脱出手順」から「誤って入った場合の脱出」に改めた。あわせて `.skills/test-design/SKILL.md` にあった、存在しない workflow.md の節への参照 2 か所も直した。
- 残した（理由）:
  - トリアージ前に提示しない: D1 (b) を満たさない。提示は取り消せず、通知は reviewer の推奨と一緒に 1 回出るだけである。
  - Executive Summary の書式: D1 (a) を満たさない。通知は pass の後の Write / Edit でだけ、hash ごとに 1 回出る。stamp を Bash で実行するときは出ない。
  - 承認前の編集の許可: モデルに届く出口がなく、重複する先もない。
  - off-plan: PreToolUse で exit 0 のときの stderr はモデルに届かない。
  - 起動軸: ADR-0011 の決定 1 が workflow.md に置くと定め、決定 6 がこれに依拠している。

### 却下した代替案

- **規則をすべて hook の出力に移す（白紙設計案）**: 作業の前に判断が要る規則があり、届かない出口もある。
- **書式と off-plan を参照 skill へ移す**: どちらも、モデルに届く出口がなくなる。
- **ADR-0025 の K5 を書き換える**: 経緯の記録が、当時の根拠と食い違う。ADR-0025 には改訂した旨だけを足す。
- **workflow-cli の節を `references/` に分ける**: skill を読んだのは 44 本中 4 本で、分けても常時の負担は減らない。

## Consequences

1. **外した文は、ほかの場所の文面に依存する**: 依存先とテストの有無は次のとおりである。
   - `round` の出力の `re-run:` 行: 守るテストがある（`workflow-cli.test.ts`）。stamp の要求は、その部分集合（常駐 reviewer の分）である。
   - guard の deny の hint: 記録だけ。`document-workflow-guard.test.ts` が確かめるのは、理由に "hint:" が含まれることだけで、文面は確かめない。`DOCUMENT_WORKFLOW_WARN_ONLY=1` のときは deny されず、D1 (b) が成り立たない。settings にこの設定は無い（grep で確認した）。
   - stamp の台帳エラー（"missing reviewer run(s) in the ledger"）: 記録だけ。round を実行していないときは、session 全体の台帳で判定される緩さがある。
   - `~/.claude/CLAUDE.md` の Prohibitions: 記録だけ。
2. **見送った課題**:
   - 届かない出口を `additionalContext` に直す。直せば off-plan が D1 を満たす。
   - トリアージ前の提示を機構に置き換える。triage marker が無いときに Stop hook で止める。
   - Executive Summary の書式を機構に置き換える。pass の stamp の出力に書式を含める。
   - 後ろの 2 つは、置き換えれば規則の文を削れる。いずれも hook の変更を伴うので、今回は見送った。
3. **`workflow.md` の削減量**: 11,429 bytes から 11,119 bytes になり、310 bytes 減った。予算の定数は 12KB（12,288 bytes）のままである。テストのコメント「about 11KB」は測った値と合うので、テストファイルは変えなかった。spec は「測った値に合わせて直す」と書いていたが、直す必要がなかった。
4. **使用実績の窓は約 10 日である**: 窓が延びたら、D2 の判断を見直す材料にする。

## References

- 改訂の対象: `docs/decisions/0025-deployed-docs-self-contained.md`
- 置き場の根拠: `docs/decisions/0011-autonomous-lane-charter.md`
- 実装:
  - `home/dot_claude/rules/workflow.md`
  - `.skills/test-design/SKILL.md`
- 根拠のコード:
  - `home/dot_claude/hooks/cli/workflow.ts`
  - `home/dot_claude/hooks/implementations/document-workflow-guard.ts`
  - `home/dot_claude/hooks/implementations/plan-review-automation.ts`
  - `home/dot_claude/hooks/lib/workflow-review-core.ts`
- テスト:
  - `home/dot_claude/hooks/tests/unit/workflow-md-budget.test.ts`
