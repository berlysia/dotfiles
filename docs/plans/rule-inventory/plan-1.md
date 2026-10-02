<!-- spec-ref: spec.md -->

# Plan: Document Workflow 規則の棚卸し（Execution layer）

作業 worktree: `/home/berlysia/.local/share/chezmoi/.git/worktree/docs/rule-inventory`（branch `docs/rule-inventory`）。パスは repo 相対で書く。

## Files

```
# 編集
home/dot_claude/rules/workflow.md
.skills/test-design/SKILL.md
docs/decisions/0025-deployed-docs-self-contained.md

# 新規作成
docs/decisions/0026-rule-removal-requires-delivery-and-backstop.md
```

`home/dot_claude/hooks/tests/unit/workflow-md-budget.test.ts` は変えない（T3 で理由を示す）。

## Tasks

文書だけの変更なので、TDD の Red は使わない。既存のテストを回帰の検査として使う。

### T1: workflow.md の 6 箇所を置き換える（spec D4）

**Files:**

- 編集: `home/dot_claude/rules/workflow.md:22,35,36,51,93,118`
- 参照: spec.md の D4（各項目の (a)(b) の根拠）、`home/dot_claude/hooks/cli/workflow.ts:647-653,810-813,832`

- [ ] **Step 1: 置き換え前のサイズを記録する**

実行: `wc -c home/dot_claude/rules/workflow.md`
期待: `11429`

- [ ] **Step 2: Edit で 6 箇所を置き換える**

それぞれ、旧文字列を新文字列に置き換える。旧文字列は現在のファイルの文字列と完全に一致する。

1. L22（W06）
   - 旧: `` `/document-workflow-reference` の脱出手順どおり ``
   - 新: `` `/document-workflow-reference` の「誤って入った場合の脱出」どおり ``
2. L35（W16）
   - 旧: `（**手で転記しない**）。起動証跡（`reviewer-runs.log`）が無いと stamp は通らない。`
   - 新: `（**手で転記しない**）。`
3. L36（W17）
   - 旧: `` `logic-validator` だけ再実行（`round` / `stamp` もこの集合）。 ``
   - 新: `` `logic-validator` だけ再実行。 ``
4. L51（W25）
   - 旧: `Bash の heredoc は中身（`->`/`<hash>`/`eval`等）を guard が書き込みと誤検出しうる。Edit / Write なら`plan-review-automation` も確実に発火する。`
   - 新: `インタプリタの heredoc（`python3 - <<…`など）は guard が書き込みと判定しうる。Edit / Write なら`plan-review-automation` も発火する。`
5. L93（W33）は行全体を置き換える。
   - 旧: `- 実装系書き込み（Write/Edit/NotebookEdit/Bash）は `document-workflow-guard` が制御する。`.tmp/`もプロジェクト内なので対象になる。承認前の使い捨て作業は session の scratchpad か`mktemp -d` の出力先に、リテラルの絶対パスで書く（他 repo・`$HOME`・dotfiles には書かない）。`
   - 新: `- 承認前の使い捨て作業は session の scratchpad か `mktemp -d` の出力先に、リテラルの絶対パスで書く（`.tmp/` も guard の対象。他 repo・`$HOME`・dotfiles には書かない）。`
6. L118（W39）
   - 旧: `明示的なコミット依頼があれば継続する。ユーザーの期待を勝手に下げたり steering を無効化しない。`
   - 新: `明示的なコミット依頼があれば継続する。`

- [ ] **Step 3: サイズと予算を確かめる**

実行: `wc -c home/dot_claude/rules/workflow.md`
期待: 11,100 から 11,125 の間（spec の見積もりは 11,111、architecture reviewer の実測は 11,113 前後）、かつ 11,264 以下。

11,264 を超えた場合は、ADR-0025 K6 の式で予算が 13KB になる。その場合は T3 に進まずに止め、ユーザーに報告する。

- [ ] **Step 4: 残っている文字列を確かめる**

実行: `grep -c '脱出手順\|起動証跡\|もこの集合\|誤検出しうる\|steering を無効化' home/dot_claude/rules/workflow.md`
期待: `0`

実行: `grep -c 'CRITICAL: 承認は人間のみ\|ssot:spec-reviewers:start\|mechanical-lane 4 条件\|トリアージ前にレビュー結果をユーザーへ提示しない\|Executive Summary（レビュー依頼時 MANDATORY）\|起動軸（pull / push）\|off-plan-writes.log' home/dot_claude/rules/workflow.md`
期待: `7`（残す規則が 1 行ずつある）

### T2: test-design skill の壊れた節名参照を直す（spec D5）

**Files:**

- 編集: `.skills/test-design/SKILL.md:31,43`
- 参照: `.skills/document-workflow-reference/SKILL.md:86`（「## ISO 25010 特性選択ガイド」）

- [ ] **Step 1: Edit で 2 箇所を置き換える**

1. L31
   - 旧: `` `@~/.claude/rules/workflow.md` の「品質特性の選択ガイド」を参照し ``
   - 新: `` `/document-workflow-reference` の「ISO 25010 特性選択ガイド」を参照し ``
2. L43
   - 旧: `` `@~/.claude/rules/workflow.md` の「テスト観点の記述品質ルール」を適用する: ``
   - 新: `次の記述品質ルールを適用する:`

- [ ] **Step 2: 確かめる**

実行: `grep -c '品質特性の選択ガイド\|テスト観点の記述品質ルール' .skills/test-design/SKILL.md`
期待: `0`

### T3: テストと予算の定数を確かめる（spec D7、R2）

**Files:**

- 参照: `home/dot_claude/hooks/tests/unit/workflow-md-budget.test.ts:17-25`

- [ ] **Step 1: 予算の定数とコメントが実測と合うかを確かめる**

T1 Step 3 の実測が 11,264 以下なら、ADR-0025 K6 の式（実測 + 1KB を 1KB 単位で切り上げ）の値は 12KB で、`BUDGET_BYTES = 12 * 1024` は変わらない。

テストのコメント「(about 11KB)」は、11,1xx bytes とも合う。したがってテストのファイルは変えない。spec D7 は「コメントは実測に合わせて直す」と書いているが、実測と合っているので直す必要がない。この判断は ADR-0026 の帰結 3 に書く。

- [ ] **Step 2: 全テストと typecheck を実行する**

実行: `bun run typecheck 2>&1 | tail -3`
期待: エラーが 0 件

実行: `bun run test 2>&1 | grep -E '^ℹ (tests|pass|fail)'`
期待: `fail 0`（着手前の実測は tests 2987 / pass 2974 / fail 0）

次の 5 本は、文字列を検査するので個別にも確かめる: `workflow-md-budget`、`mechanical-lane-routing`、`document-hash`、`deployed-docs-repo-refs`、`plan-review-automation`。

実行: `node --import ./home/dot_claude/hooks/tests/preload-test-env.mjs --test home/dot_claude/hooks/tests/unit/{workflow-md-budget,mechanical-lane-routing,document-hash,deployed-docs-repo-refs,plan-review-automation}.test.ts 2>&1 | grep -E '^ℹ (pass|fail)'`
期待: `fail 0`

- [ ] **Step 3: 文面の依存を守るテストがあるかを確かめる（spec R3）**

実行: `grep -rln 'missing reviewer run\|re-run:\|SCRATCH_HINT\|never in other repositories' home/dot_claude/hooks/tests/`

結果は ADR-0026 の帰結に書く。ヒットしたテストは「守るテストがある」、ヒットしない依存先は「記録だけ」とする。今回はテストを足さない（spec D6 のとおり、記録で済ませる）。

### T4: ADR-0026 を書き、ADR-0025 を最小限に直す（spec D6）

**Files:**

- 新規作成: `docs/decisions/0026-rule-removal-requires-delivery-and-backstop.md`
- 編集: `docs/decisions/0025-deployed-docs-self-contained.md:5,25`
- 参照: `docs/decisions/0025-deployed-docs-self-contained.md`（書式と K5）、`docs/decisions/0011-autonomous-lane-charter.md:26,31`

- [ ] **Step 1: ADR-0026 を書く**

見出しは ADR-0025 と同じ形（`## Status` / `## Context` / `## Decision` / `### 却下した代替案` / `## Consequences` / `## References`）にする。決定の ID は D1-D3 とし、ADR-0025 の K 番号と区別する。各節に書く内容は次のとおり。

- タイトル: `# ADR-0026: 規則を削る根拠は、届く通知と止める機構の両方とする`
- Status: `accepted (2026-10-03)`。続けて「ADR-0025 の K5（ENFORCED の定義）を改訂する」と書く。
- Context に書くこと:
  - ADR-0025 の後、規則そのものを棚卸しした。調べたのは workflow.md の 40 件と、参照 skill の 17 件である。
  - 調べた方法は 2 つある。1 つは hook・CLI の出力が規則と同じ指示をモデルに届けるかで、コードを読んで確かめた。もう 1 つは、transcript で使われたかどうかである。
  - 測れた窓は約 10 日（2026-09-24 から 10-03）しかない。対話セッションは 91 本で、Document Workflow を使ったのは 44 本だった。実際に使っているプロジェクトは 2 つである。
  - 調べて分かった事実:
    - PreToolUse で exit 0 のときの stderr はモデルに届かない。off-plan の警告がこれに当たる。
    - SessionStart の `systemMessage` は UI に出るだけである。
    - Executive Summary の書式の通知は、pass の後に Write / Edit したときにだけ出る。
    - トリアージの指示は、reviewer の推奨と一緒に 1 回出るだけである。
    - ADR-0025 の ENFORCED は「強制がある」だけで成り立つ。そのため、こうした文も削れてしまう。
- Decision:
  - **D1（ENFORCED の要件）**: 削除の根拠にするには、次の (a) と (b) の両方が要る。この定義で ADR-0025 K5 の ENFORCED を置き換える。
    - (a) 規則が当てはまる時点か、その直前に、hook・CLI の出力が同じ指示をモデルに届ける。届く経路は、PostToolUse の `additionalContext`、Stop の block 理由、CLI の出力、deny の理由である。
    - (b) (a) の通知を見逃しても、deny、CLI の非 0 終了、gate の拒否のどれかが違反を止める。人が気づくことは (b) に含めない。
    - 次のものは根拠にしない。PreToolUse で exit 0 のときの stderr、SessionStart の `systemMessage`、黙って通す処理。
  - **D2（使用実績）**: 使用実績は、単独では削除の根拠にしない。使うのは、候補の優先順位の目安と、hook が発火していることの確認だけである。理由は窓の短さと、設計上まれな規則（脱出、S3 移行）があることである。
  - **D3（参照 skill の扱い）**: 参照 skill の本体には、ENFORCED を削除の根拠として当てない。本体は機構を説明する文書だからである。削れるのは DUP / NOISE / MOVE のときだけとする。
  - 今回の適用結果: 外したのは 4 件、直したのは 2 件、残したのは 5 件である。
    - 外した: W16 の起動証跡、W17 の括弧書き、W33 の説明部分、W39。W39 は DUP として外した。
    - 直した: W25 の理由、W06 の節名。
    - 残した: トリアージ前に提示しない、Executive Summary の書式、承認前の編集の許可、off-plan、起動軸。それぞれに、残した理由を 1 行で添える。起動軸の理由は、ADR-0011 の決定 1 と決定 6 である。
- 却下した代替案:
  - 規則をすべて hook の出力に移す（白紙設計案）。作業の前に判断が要る規則があり、届かない出口もあるからである。
  - 書式と off-plan を参照 skill へ移す。どちらも、届く経路がなくなるからである。
  - ADR-0025 の K5 を書き換える。経緯の記録が、当時の根拠と食い違うからである。
  - workflow-cli の節を references に分ける。skill を読んだのは 44 本中 4 本で、分けても常時の負担は減らないからである。
- Consequences:
  1. 外した文は、ほかの場所の文面に依存する。依存先は次の 4 つで、T3 Step 3 の結果に応じて「守るテストがある」か「記録だけ」かを書く。
     - stamp の台帳エラー。round を実行していないときは、session 全体の台帳で判定される緩さがある。
     - round の出力の `re-run:` 行。stamp の要求は、その部分集合（常駐 reviewer の分）である。
     - guard の deny と `SCRATCH_HINT`。`DOCUMENT_WORKFLOW_WARN_ONLY=1` のときは deny されず、(b) が成り立たない。settings にこの設定は無い（plan 作成時に grep で確認した）。
     - `~/.claude/CLAUDE.md` の Prohibitions。
  2. 見送った課題を記録する。
     - 届かない出口を `additionalContext` に直す課題。直せば off-plan が D1 を満たす。
     - 次の 2 つは、機構に置き換えれば削れる。トリアージ前の提示（triage marker が無いときに Stop hook で止める）と、Executive Summary の書式（pass の stamp の出力に書式を含める）。
     - いずれも hook の変更を伴うので、今回は見送った。
  3. workflow.md の削減量は、T1 Step 1 と Step 3 の `wc -c` の差を書く。予算の定数は 12KB のままである。
     - plan 作成時の机上計算では 310B 減で、11,119 bytes になる。
     - spec の見積もりは 318B だったが、ADR には実測だけを書く。
     - テストのコメント「about 11KB」は実測と合うので変えなかった。spec D7 は「実測に合わせて直す」と書いていたが、直す必要がなかった。このことも 1 行書く。
  4. 使用実績の窓は約 10 日である。窓が延びたら、D2 の判断を見直す材料にする。
- References:
  - 改訂の対象: `docs/decisions/0025-deployed-docs-self-contained.md`
  - 実装:
    - `home/dot_claude/rules/workflow.md`
    - `.skills/test-design/SKILL.md`
  - 根拠のコード:
    - `home/dot_claude/hooks/cli/workflow.ts`
    - `home/dot_claude/hooks/implementations/document-workflow-guard.ts`
    - `home/dot_claude/hooks/implementations/plan-review-automation.ts`
    - `home/dot_claude/hooks/lib/workflow-review-core.ts`

数値は実測から転記する。

- バイト数: T1 Step 1 と Step 3 の `wc -c` の値。
- 依存先ごとの「守るテストがある / 記録だけ」: T3 Step 3 の grep のヒット一覧。

件数（40 件、17 件、91 本、44 本）は research.md の値をそのまま使う。

- [ ] **Step 2: ADR-0025 を直す**

1. Status（L5）
   - 旧: `accepted (2026-10-03)`
   - 新: `accepted (2026-10-03)。K5 の ENFORCED の定義は ADR-0026 で改訂した。`
2. K3（L25）
   - 旧: `今回はラウンド予算だけを `references/round-budget.md` に分けた。Round 3 を超えて延長するときにだけ読むからである。`
   - 新: `最初はラウンド予算を `references/round-budget.md`に分けた。Round 3 を超えて延長するときにだけ読むからである。後の作業で、誤って入った場合の脱出、S3 デプロイ移行手順、workflow dir の引き継ぎも、同じ理由で`references/` に分けた。`

- [ ] **Step 3: 整形と検査**

実行: `bun run format:check`
期待: 終了コード 0。このスクリプトは `oxfmt --check --ignore-path .oxfmtignore .` と prettier の yaml 検査を行う。

0 でなければ、次の 4 ファイルだけを `bunx oxfmt --ignore-path .oxfmtignore <パス>` で整形し、もう一度検査する。

- `docs/decisions/0025-deployed-docs-self-contained.md`
- `docs/decisions/0026-rule-removal-requires-delivery-and-backstop.md`
- `home/dot_claude/rules/workflow.md`
- `.skills/test-design/SKILL.md`

この 4 ファイル以外で失敗した場合は、変えずに報告する。整形で workflow.md のサイズが変わったら、T1 Step 3 の検査をもう一度行う。

実行: `textlint-global docs/decisions/0025-deployed-docs-self-contained.md docs/decisions/0026-rule-removal-requires-delivery-and-backstop.md home/dot_claude/rules/workflow.md .skills/test-design/SKILL.md`
期待: ADR-0026 のエラーと警告が 0 件。ほかの 3 ファイルは、今回変えた行にエラーと警告が 0 件（既存の行の指摘は直さない）。

### T5: コミット

- [ ] **Step 1: 2 つのコミットに分ける**

```bash
git add home/dot_claude/rules/workflow.md .skills/test-design/SKILL.md
git commit   # docs(rules): drop rules that a delivered notice and a backstop already cover
git add docs/decisions/0025-deployed-docs-self-contained.md docs/decisions/0026-rule-removal-requires-delivery-and-backstop.md
git commit   # docs(decisions): require delivery and a backstop before removing a rule
```

メッセージの本文は Contextual Commits の action 行（intent / decision / rejected / constraint / learned）で書き、末尾に Co-Authored-By 行を付ける。

### T6: master へ取り込み、配置を確かめる（spec R1）

- [ ] **Step 1: master の上に rebase し、master へ fast-forward でマージする**

作業ブランチは `9365b7d` から切った。plan の作成時点で、master は別のセッションの 3 コミットで `f212120` まで進んでいる（`0693fe3`、`3ebc9b6`、`f212120`）。この 3 コミットが触るのは mods、settings、package.json、tsconfig で、今回の 4 ファイルとは重ならない。

main checkout（`/home/berlysia/.local/share/chezmoi`）は master を checkout している。push はしない。

実行: `git -C /home/berlysia/.local/share/chezmoi status --short`
期待: 空。空でなければ止めて報告する。

worktree で次を実行する。

実行: `git rebase master`
期待: 衝突なく成功する。衝突したら `git rebase --abort` して止め、報告する。

rebase すると master 側の変更（package.json、tsconfig）が入るので、もう一度確かめる。

実行: `bun install --frozen-lockfile && bun run typecheck && bun run test 2>&1 | grep -E '^ℹ (tests|pass|fail)'`
期待: typecheck のエラーが 0 件で、`fail 0`。

main checkout で次を実行する。

実行: `git -C /home/berlysia/.local/share/chezmoi merge --ff-only docs/rule-inventory`
期待: fast-forward で成功する。失敗したら（master がさらに進んだ場合）、rebase からやり直す。

- [ ] **Step 2: 適用前の差分を確かめる**

実行: `chezmoi diff --no-pager 2>&1 | grep -E '^diff --git' `
期待: `~/.claude/rules/workflow.md` に当たる行がある。skills は rsync なので `chezmoi diff` には出ない。

ほかのファイルが出た場合は、別のセッションの master のコミット（mods、settings）で、まだ apply されていない差分かもしれない。その場合は apply せずに止め、出たファイルの一覧をユーザーに示して判断を仰ぐ。

- [ ] **Step 3: 引数なしで apply し、配置先と diff を取る**

引数なしの `chezmoi apply` は、run script もすべて実行する。master にある別のセッションのコミットの run script（`run_after_sync-mods.sh.tmpl` による mods の配置、`run_onchange_update-settings-json.sh.tmpl` による settings.json の再生成）も走る可能性がある。

apply の前に AskUserQuestion で「apply してよいか」をユーザーに確認し、承諾を得てから実行する。

実行: `chezmoi apply`

実行: `diff -q /home/berlysia/.local/share/chezmoi/home/dot_claude/rules/workflow.md ~/.claude/rules/workflow.md; echo rc=$?`
期待: `rc=0`

実行: `diff -q /home/berlysia/.local/share/chezmoi/.skills/test-design/SKILL.md ~/.claude/skills/test-design/SKILL.md; echo rc=$?`
期待: `rc=0`

実行: `diff -q /home/berlysia/.local/share/chezmoi/.skills/test-design/SKILL.md ~/.codex/skills/test-design/SKILL.md; echo rc=$?`
期待: `rc=0`

- [ ] **Step 4: 引き継ぎ文書を更新する**

`.tmp/docs/handoff-document-workflow-trim.md` の「セッション B」に結果を追記する。書くのは次の 4 点である。

- コミットの SHA
- 実測したバイト数
- 残した規則と、その理由（ADR-0026 を参照する）
- 見送った hook の課題

## ISO 25010 具体テストケース

### 保守性（修正性）

- **入力**: T1 適用後に `wc -c home/dot_claude/rules/workflow.md` を実行する → **期待**: 11,264 以下。予算 12,288 に対する余裕が 1,024 以上ある。
- **入力**: `workflow-md-budget.test.ts` を実行する → **期待**: 5 件すべて pass。

### 機能適合性（正確性）

- **入力**: T1 Step 4 の 1 つ目の grep（外した文字列）を実行する → **期待**: `0`
- **入力**: T1 Step 4 の 2 つ目の grep（残す規則 7 つ）を実行する → **期待**: `7`
- **入力**: `grep -rn '品質特性の選択ガイド\|テスト観点の記述品質ルール\|の脱出手順' home/dot_claude .skills --include='*.md'` を実行する → **期待**: ヒット 0 件（壊れた節名参照が残っていない）
- **入力**: `deployed-docs-repo-refs.test.ts` を実行する → **期待**: pass。新しい文に ADR 番号や配置元のパスが入っていない。
- **入力**: 全テストを実行する → **期待**: `fail 0`
- **入力**: apply 後に配置先 3 ファイルと source の `diff -q` を取る → **期待**: すべて `rc=0`

### 対象外

- 性能効率性、セキュリティ、互換性: 文書だけの変更で、hook と CLI の挙動は変えない。承認の規則（CRITICAL）と書き込み禁止先は残す。T1 Step 4 で確かめる。

## Approval

- Plan Status: complete
- Review Status: pass
- Approval Status: approved

## Reviewer Outputs (Round 1)

### logic-validator

- verdict: pass
- 主指摘: 旧文字列はすべて完全一致し、置換を再現すると 11,119 bytes で範囲内だった。W06 は +27B なので、ADR に 318B と書かない（反映済み）。textlint の対象が狭かった（反映済み）。

### scope-justification-reviewer

- verdict: pass
- 主指摘: spec D4-D6 に取りこぼしはない。引数なしの apply は master の run script も実行するので、ユーザーに確認する（反映済み）。D7 とのずれを明記する（反映済み）。format:check はプロジェクトのスクリプトに合わせる（反映済み）。

<!-- auto-review: pending -->
<!-- intent-triage: pending -->

<!-- auto-review: verdict=pass; hash=bea7dab4b66b16beaebed3e016217df637ee81312576ffe059a1ec31e89f3c89; design-hash=7e2b7dde41e0f3423d6d8ae9f62dd536f1baf2a5a55492378f784227c8bd6da3; round=1; parent-spec-hash=071067977ee6d1ea1690e5af7b61277c3662a3bfbbb03247f20c0246d2de7687; at=2026-10-02T22:03:43.363Z; reviewers=logic-validator+scope-justification-reviewer -->
<!-- intent-triage: adopted=12; excluded=0; at=2026-10-02T22:03:43.380Z -->
