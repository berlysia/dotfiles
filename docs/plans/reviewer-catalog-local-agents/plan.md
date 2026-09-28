# Plan: 追加レビュアーのカタログをローカル agent に揃え、plugin 宣言を直す

## Goal

`REVIEWER_CATALOG` の推奨がすべて起動可能な agent を指し、起動が台帳に記録されるようにする。あわせて `claude_plugins.yaml` の宣言を実在の marketplace / plugin に合わせ、compound-engineering が実際にインストールされるようにする。

## Alternative Approaches (Greenfield View)

### 差分最小案 (Incremental)

plugin 宣言だけを直して compound-engineering を入れ、カタログは据え置く。→ 不採用。現行の plugin は該当 agent を subagent として提供しない（research O1）ので、推奨は起動不能のまま残る。

### 白紙設計案 (Greenfield)

カタログを「この repo の `home/dot_claude/agents/` に定義された agent だけ」から組む。起源: 推奨は Agent tool で起動でき、台帳（`REVIEWER_SLUGS`）に載り、モデル指定（`model: sonnet`）をこの repo で管理できる必要がある。外部 plugin の agent はこの 3 条件を repo 側で保証できない。これをテスト（カタログの各 slug に `home/dot_claude/agents/<slug>.md` が存在する）で固定すれば、外部の構成変更で再び壊れることがない。

### 採用案と理由

白紙案を採る。根拠: 外部 plugin の構成変更（agents/ の廃止）で既に一度壊れており、壊れたことが 1 か月以上気づかれなかった（台帳に記録されないため）。ローカル agent は 3 件の対応先がある（research O2）。対応先の無い performance / simplicity はカタログから外す。外す理由は「ローカルに対応する agent が無い」ことで、観点そのものが不要と判断したわけではない（起動記録ゼロは起動不能だった結果なので、観点の要否の根拠にはならない）。観点を戻すなら agent 定義を作るのが先で、それは別オーダーとする。

不変条件（起動可能・台帳に載る）は、台帳が読む 3 つのロースター（`SPEC_REVIEWERS` / `PLAN_REVIEWERS` / `REVIEWER_CATALOG`、`reviewer-run-recorder.ts:46-50` の union）全体に張る。今回壊れたのはカタログだけだが、常駐側も同じ経路で壊れうる。

## Key Decisions

- **K1: カタログの slug をローカル agent に置き換える** — architecture-strategist → `architecture-boundary-analyzer`、security-sentinel → `security-vulnerability-analyzer`、data-integrity-guardian → `data-contract-evolution-evaluator`。label・priority は据え置く。キーワードは data-contract のエントリだけ、DB 内部の語（`index` / `query` / `sql`）を外す。`data-contract-evolution-evaluator` は API / schema の互換性と移行を見る agent で、クエリやインデックスの設計は守備範囲外のため。`schema` / `migration` / `table` / `column` など schema 変更に当たる語は残す
  - 参照: `home/dot_claude/hooks/lib/workflow-review-core.ts:137-285`
- **K2: performance-oracle と code-simplicity-reviewer をカタログから外す** — ローカルに対応する agent が無い（観点の要否ではなく、起動できる定義が無いことが理由）。ADR-0015 K9 で追加した code-simplicity-reviewer の取り消しになるので、ADR-0015 に理由と「観点を戻すなら agent 定義を先に作る」を追記する
  - 参照: `home/dot_claude/hooks/lib/workflow-review-core.ts`（performance-oracle / code-simplicity-reviewer の 2 エントリ）
- **K3: 台帳が読む全ロースターの slug がローカル agent 定義を持つことをテストで固定する** — `SPEC_REVIEWERS` / `PLAN_REVIEWERS` の `slug` と `REVIEWER_CATALOG` の `subagentType` の全件が `:` を含まず、`home/dot_claude/agents/<slug>.md` が存在すること。既存の「K9a code-simplicity-reviewer」テストブロックをこれに置き換える
- **K5: plugin prefix の正規化は残し、理由を書き直す** — `reviewer-run-recorder` と `stamp` は記録された `subagent_type` の最後の `:` 区切りを bare slug として照合する。カタログから plugin agent が消えると、この正規化が意味を持つのは「plugin 名前空間付きで同名の agent が起動された」場合だけになり、それを該当 reviewer の実行として数える。除去すると stamp の台帳照合と既存テスト（`workflow-cli.test.ts:120`）の書き換えに広がるため、本オーダーでは残し、受容した挙動としてコメントとテストに明記する
  - 参照: `home/dot_claude/hooks/tests/unit/workflow-review-core.test.ts:409-426`
- **K4: plugin 宣言を実名に合わせる** — marketplace `name: every-marketplace` → `compound-engineering-plugin`、plugin `compound-engineering@every-marketplace` → `compound-engineering@compound-engineering-plugin`。`clarify@kuu-marketplace` を削除
  - 参照: `home/.chezmoidata/claude_plugins.yaml:7-8, 14-15`

## Files

```
# 編集
home/dot_claude/hooks/lib/workflow-review-core.ts
home/dot_claude/hooks/implementations/reviewer-run-recorder.ts
home/.chezmoidata/claude_plugins.yaml
home/dot_claude/rules/external-review.md
CONTEXT.md
.skills/decision-quality-review/SKILL.md
.skills/document-workflow-reference/SKILL.md
docs/decisions/0015-document-workflow-operator-ergonomics.md

# テスト
home/dot_claude/hooks/tests/unit/workflow-review-core.test.ts
home/dot_claude/hooks/tests/unit/plan-review-automation.test.ts
home/dot_claude/hooks/tests/unit/reviewer-run-recorder.test.ts
```

テスト実行（repo root）: `T=node --import ./home/dot_claude/hooks/tests/preload-test-env.mjs --test`。全体 `bun run test`、型 `bun run typecheck`、lint `bun run lint`。

## Tasks

### T1: カタログがローカル agent だけを指すことをテストで固定する（K3、Red）

**Files:**

- テスト: `home/dot_claude/hooks/tests/unit/workflow-review-core.test.ts:409-426`（K9a ブロックを置換）
- 参照: `home/dot_claude/agents/*.md`（ローカル agent 定義）

- [ ] **Step 1**: K9a の describe ブロックを次に置き換える（`existsSync` / `join` / `dirname` / `fileURLToPath` は無ければ import に足す）

```ts
describe("workflow-review-core: every reviewer roster points at local agents", () => {
  const agentsDir = join(
    dirname(fileURLToPath(import.meta.url)),
    "../../../agents",
  );
  const slugs = [
    ...SPEC_REVIEWERS.map((r) => r.slug as string),
    ...PLAN_REVIEWERS.map((r) => r.slug as string),
    ...REVIEWER_CATALOG.map((r) => r.subagentType),
  ];
  it("every slug is bare and has a definition under home/dot_claude/agents", () => {
    for (const slug of slugs) {
      ok(!slug.includes(":"), `${slug} must not be a plugin agent`);
      ok(
        existsSync(join(agentsDir, `${slug}.md`)),
        `missing agents/${slug}.md`,
      );
    }
  });
});
```

- [ ] **Step 2**: `$T home/dot_claude/hooks/tests/unit/workflow-review-core.test.ts` → 期待: 新テストが `compound-engineering:review:architecture-strategist must not be a plugin agent` で FAIL

### T2: カタログを置き換え、既存テストの期待値を新 slug に揃える（K1・K2、Green）

**Files:**

- 編集: `home/dot_claude/hooks/lib/workflow-review-core.ts:137-285`
- テスト: `workflow-review-core.test.ts:123-129, 295-302, 440, 451`、`plan-review-automation.test.ts:192-313`、`reviewer-run-recorder.test.ts:25, 52, 59`

- [ ] **Step 1**: カタログの 3 エントリの `subagentType` を `architecture-boundary-analyzer` / `security-vulnerability-analyzer` / `data-contract-evolution-evaluator` に置換。performance-oracle と code-simplicity-reviewer のエントリを削除
- [ ] **Step 2**: テストの期待値を置換: `compound-engineering:review:architecture-strategist` → `architecture-boundary-analyzer`、`compound-engineering:review:security-sentinel` → `security-vulnerability-analyzer`、bare の `security-sentinel` → `security-vulnerability-analyzer`、bare の `architecture-strategist` → `architecture-boundary-analyzer`（テスト名の文字列も同じ置換）。`reviewer-run-recorder.test.ts:52, 59` の plugin prefix 付き入力は Step 4 のとおり `some-plugin:review:security-vulnerability-analyzer` にする（`REVIEWER_SLUGS` は bare slug で判定するため prefix 正規化のテストとして残る）
- [ ] **Step 3**: `$T home/dot_claude/hooks/tests/unit/workflow-review-core.test.ts home/dot_claude/hooks/tests/unit/plan-review-automation.test.ts home/dot_claude/hooks/tests/unit/reviewer-run-recorder.test.ts home/dot_claude/hooks/tests/unit/workflow-cli.test.ts` → 期待: 全 PASS（T1 の新テスト含む）
- [ ] **Step 4**: コメントを現状に合わせる（K5）
  - `reviewer-run-recorder.ts:37-44` の `REVIEWER_SLUGS` の docblock を次の趣旨に書き換える: 3 ロースターはすべて bare slug（ローカル agent）を持つ。記録された `subagent_type` は最後の `:` 区切りで bare slug に直してから照合するので、plugin 名前空間付きで同名の agent が起動された場合も該当 reviewer として数える（受容した挙動）。`compound-engineering:review:` の文字列は含めない
  - `reviewer-run-recorder.test.ts:52, 59` の prefix 付き入力は `some-plugin:review:security-vulnerability-analyzer` にし、テスト名を「counts a plugin-namespaced run of a reviewer slug (accepted behaviour)」にする
  - `workflow-review-core.ts:111` の `PLAN_REVIEWERS` docblock の例 `(test-quality, code-simplicity, etc.)` を `(test-quality, security, etc.)` にする
- [ ] **Step 5: コミット** — `fix(hooks): point the reviewer catalog at local agents`

### T3: plugin 宣言を実名に合わせる（K4）

**Files:**

- 編集: `home/.chezmoidata/claude_plugins.yaml`

- [ ] **Step 1**: marketplace `name: every-marketplace` → `name: compound-engineering-plugin`、plugins の `compound-engineering@every-marketplace` → `compound-engineering@compound-engineering-plugin`、`- clarify@kuu-marketplace` 行を削除
- [ ] **Step 2**: `chezmoi execute-template < home/.chezmoiscripts/run_onchange_install-claude-plugins-8.sh.tmpl | grep -E "compound|clarify"` → 期待: `select(.name == "compound-engineering-plugin")` と `compound-engineering@compound-engineering-plugin` が出て、clarify は出ない
- [ ] **Step 3: コミット** — `fix(plugins): declare compound-engineering under its real marketplace name`

### T4: 文書を揃える（K1・K2）

**Files:**

- 編集: `home/dot_claude/rules/external-review.md:77`、`.skills/decision-quality-review/SKILL.md:90`、`.skills/document-workflow-reference/SKILL.md:144`、`docs/decisions/0015-document-workflow-operator-ergonomics.md`（2026-09-28 Amendment の「別件として残したもの」）

- [ ] **Step 1**: external-review.md の追加レビュアー一覧を `architecture-boundary-analyzer, security-vulnerability-analyzer, data-contract-evolution-evaluator, resilience-analyzer, test-quality-evaluator, deployment-readiness-evaluator` にする
- [ ] **Step 1b**: `CONTEXT.md:48` の content-selected の列挙を `architecture-boundary-analyzer / security-vulnerability-analyzer / data-contract-evolution-evaluator / test-quality-evaluator / 等から最大 3 名` にする
- [ ] **Step 2**: decision-quality-review SKILL.md:90 の `architecture-strategist` → `architecture-boundary-analyzer`、document-workflow-reference SKILL.md:144 の例 `security-sentinel` → `security-vulnerability-analyzer`
- [ ] **Step 3**: ADR-0015 の 2026-09-28 Amendment の「別件として残したもの」を「同日に解消: カタログをローカル agent に置き換え（performance / code-simplicity はローカルに agent 定義が無いため外した。観点が不要と判断したのではなく、戻すなら agent 定義を先に作る。K9 の code-simplicity-reviewer 追加はこれで取り消し）。compound-engineering の現行版は該当 agent を subagent として提供しない。3 つのロースターの各 slug がローカル定義を持つことをテストで固定。台帳は記録された subagent_type の plugin 名前空間を外して照合するので、同名の plugin agent の実行も当該 reviewer として数える（受容した挙動。照合を完全一致にするのは stamp にも及ぶため別オーダー）」に書き換える
- [ ] **Step 4**: `$T home/dot_claude/hooks/tests/unit/workflow-md-budget.test.ts home/dot_claude/hooks/tests/unit/plan-review-automation.test.ts` → 期待: 全 PASS（external-review.md の SSoT 区間は触らない）
- [ ] **Step 5: コミット** — `docs(workflow): name the local agents in the reviewer catalog docs`

### T5: 全体検証

- [ ] **Step 1**: `bun run test` → 期待: 失敗 0
- [ ] **Step 2**: `bun run typecheck` → 期待: エラー 0。`bun run lint` → 期待: 終了コード 0
- [ ] **Step 3**: `git grep -nE "compound-engineering:review:" -- home .skills ':!**/tests/**'` → 期待: 0 件（テストの prefix 正規化入力のみ残る）
- [ ] **Step 4**: `chezmoi apply`（引数なし）はユーザーに依頼し、その後 `claude plugin list` に `compound-engineering@compound-engineering-plugin` が出ることを確認する

## テスト計画 (ISO 25010)

### 機能適合性（正確性）

- **入力**: `REVIEWER_CATALOG` の全エントリ → **期待**: 各 `subagentType` に `:` が無く、`home/dot_claude/agents/<slug>.md` が存在する
- **入力**: 本文に `security` を含む plan（Files はコード）→ **期待**: 推奨に `security-vulnerability-analyzer` が入り、`compound-engineering` は含まれない
- **入力**: recorder に `subagent_type: some-plugin:review:security-vulnerability-analyzer` → **期待**: bare slug で `REVIEWER_SLUGS` に一致し台帳に記録される（K5 で受容した prefix 正規化の維持）
- **入力**: install script のテンプレート展開 → **期待**: marketplace 判定が `compound-engineering-plugin`、install 対象が `compound-engineering@compound-engineering-plugin`、clarify 無し

### 保守性（修正性）

- **入力**: 将来カタログに plugin agent や未定義 slug を足す → **期待**: T1 のテストが FAIL して気づける

対象外: 性能効率性（定数の置換のみ）、セキュリティ（承認・guard の条件は不変）。

受容したリスク（K5）: 台帳は plugin 名前空間を外して照合するため、reviewer と同名の plugin agent が起動されると当該 reviewer の実行として数えられ、stamp の起動証跡を満たしうる。現状その名前の plugin agent は無く、偽装にはモデルが意図して別 agent を起動する必要がある。照合の完全一致化は stamp と `workflow-cli.test.ts:120` に及ぶので別オーダーとする。

## Approval

- Plan Status: complete
- Review Status: pass
- Approval Status: approved

## Reviewer Outputs (Round 1)

### logic-validator

- verdict: needs-work
- 主指摘: O1・T1 のパス・T3 は実測で正しい。recorder:41-43 のコメントに `compound-engineering:review:` が残り T5 Step3 の grep が通らない自己矛盾。data-contract の DB 内部キーワード（query / index）が agent の守備範囲とずれる。CONTEXT.md:48 と PLAN_REVIEWERS docblock の陳腐化が Files 外

### scope-justification-reviewer

- verdict: pass
- 主指摘: K1〜K4・T1〜T5 すべてオーダーと根拠に紐づく。K3 の恒久テストは再発実績に基づき含めるべき

### decision-quality-reviewer

- verdict: pass
- 主指摘: 支配軸（保守性への格上げ）は再発実績で裏付けられ整合。K2 の根拠が観測 1 本に依存する点のみ留意

### greenfield-perspective-reviewer

- verdict: needs-work
- 主指摘: 不変条件はカタログだけでなく台帳が読む 3 ロースター全体に張るべき。K2 の「起動記録ゼロ」は起動不能の帰結で観点の要否の根拠にならない。prefix 正規化とそのコメントが plugin 前提のまま残る

<!-- auto-review: pending -->
<!-- intent-triage: pending -->

## Reviewer Outputs (Round 2)

### logic-validator

- verdict: pass
- 主指摘: Round 1 の (a)〜(c) は解消。T5 Step3 の grep は計画後に非テスト 0 件、K3 の 10 slug はすべて agent 定義が実在。軽微: recorder テスト入力の記述が中間値のまま（反映済み）

### scope-justification-reviewer

- verdict: pass
- 主指摘: 追加分はすべて Round 1 指摘への応答で、オーダーの射程内。スコープドリフトなし

### decision-quality-reviewer

- verdict: pass
- 主指摘: 支配軸（保守性）と整合。軽微: K5 の同名 plugin agent を数えうるリスクを明示すると良い（受容リスクとして反映済み）

### greenfield-perspective-reviewer

- verdict: pass
- 主指摘: 3 ロースター網羅と K2 の根拠は解消。K5 は波及範囲を実測で確認した上の既知のギャップとして許容。ADR にも 1 文残すと追える（T4 Step3 に反映済み）

<!-- auto-review: verdict=needs-work; hash=b4c4200a55733ccfb14b47b88f874f305819522c22e87b892461a24177361269; design-hash=315be08323f9a669604b381ea650dda756b11d1d4ee4351a19b7636af992417c; round=1; at=2026-09-28T04:24:46.596Z; reviewers=logic-validator+scope-justification-reviewer+decision-quality-reviewer+greenfield-perspective-reviewer -->
<!-- intent-triage: adopted=7; excluded=0; at=2026-09-28T04:24:46.614Z -->

<!-- auto-review: verdict=pass; hash=d2429965a5c3f62ac4a9d3cdbc55ac76a25addb328546ac485304f16cb4f1303; design-hash=4d6b832697e1c63706e8a239b31a07f0ae6b03009145a8053c7a40e28d8bd650; round=2; at=2026-09-28T04:29:59.211Z; reviewers=logic-validator+scope-justification-reviewer+decision-quality-reviewer+greenfield-perspective-reviewer -->
<!-- intent-triage: adopted=4; excluded=0; at=2026-09-28T04:29:59.228Z -->
