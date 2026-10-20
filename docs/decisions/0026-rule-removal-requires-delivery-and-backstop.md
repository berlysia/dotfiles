# ADR-0026: 規則を削る根拠は、届く通知と止める機構の両方とする

## Status

accepted (2026-10-03)

ADR-0025 の K5（ENFORCED の定義）を改訂する。

Consequences 3 の「予算の定数は 12KB のまま」は、ADR-0032 が覆した（上限を 13KB に戻した）。

Decision で「残した」とした Executive Summary の書式は、ADR-0035 が中身を改訂した（workflow.md に残す理由は変わらない）。

## Context

ADR-0025 の後、規則そのものを棚卸しした。調べたのは `rules/workflow.md` の規則と、参照 skill（`document-workflow-reference`）の規則である。

調べた方法は 2 つある。

- hook・CLI の出力が、規則と同じ指示をモデルに届けるか。コードを読んで確かめた。
- transcript で、その規則が使われたか。

測れた窓は 2026-09-24 から 10-03 の約 10 日しかなく、Document Workflow を使ったセッションは対話セッションの半分弱、使っているプロジェクトは 2 つだった。

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

今回の適用では、4 件の文を DUP / ENFORCED の根拠で外し（起動証跡の stamp 要求、`round` / `stamp` の集合の括弧書き、承認前の scratch 置き場の説明、`CLAUDE.md` の Prohibitions と重複する一文）、2 件を訂正し、5 件を残した。

- 残した（理由）:
  - トリアージ前に提示しない: D1 (b) を満たさない。提示は取り消せず、通知は reviewer の推奨と一緒に 1 回出るだけである。
  - Executive Summary の書式: D1 (a) を満たさない。通知は pass の後の Write / Edit でだけ、hash ごとに 1 回出る。stamp を Bash で実行するときは出ない。
  - 承認前の編集の許可: モデルに届く出口がなく、重複する先もない。
  - off-plan: PreToolUse で exit 0 のときの stderr はモデルに届かない。
  - 起動軸: ADR-0011 の決定 1 が workflow.md に置くと定め、決定 6 がこれに依拠している。

## 却下した代替案

- **規則をすべて hook の出力に移す（白紙設計案）**: 作業の前に判断が要る規則があり、届かない出口もある。
- **書式と off-plan を参照 skill へ移す**: どちらも、モデルに届く出口がなくなる。
- **ADR-0025 の K5 を書き換える**: 経緯の記録が、当時の根拠と食い違う。ADR-0025 には改訂した旨だけを足す。
- **workflow-cli の節を `references/` に分ける**: skill を読んだセッションはごく少数で、分けても常時の負担は減らない。

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
3. **`workflow.md` の予算の定数は変えなかった**: 削減量は予算の余裕に収まる。この点は ADR-0032 が覆した（Status）。
4. **使用実績の窓は約 10 日である**: 窓が延びたら、D2 の判断を見直す材料にする。

## References

- 改訂の対象: `docs/decisions/0025-deployed-docs-self-contained.md`
- 置き場の根拠: `docs/decisions/0011-autonomous-lane-charter.md`
- 経緯（57 件の規則表、レビューの記録）: `git show 52dc6fd447:docs/plans/rule-inventory/`（research.md / spec.md / plan-1.md）
