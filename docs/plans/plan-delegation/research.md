# 調査: 人間の承認を待たずに先へ進める場面

Document Workflow で、人間の承認を待たずに先へ進める方法を 3 つの場面について調べた。
対象は、依頼者が選んだ次の 3 場面である。

- spec 承認後の plan-N の個別承認
- 承認済み文書を改訂した後の再承認
- 離席中の待ち時間

初回の承認（plan.md、spec.md）を省くことは対象外とした。

分かったことは次の 3 点である。

- 3 場面とも、承認者を人間に保ったまま設計できる。
- 再承認の省略は、承認の記録だけでなくレビューの印も緩めないと gate が開かない。
- 離席中の先行は、`rules/autonomous-lane.md` の条項の改訂を前提にする。

以下、パスは `home/dot_claude/` からの相対で書く。

## 前提: gate と承認の記録

gate は次の条件をすべて満たした文書を承認済みとみなす（`hooks/lib/workflow-gate.ts:263` の `isDocumentApproved`）。

- 文書内の 3 つの status 行が `complete` / `pass` / `approved` である。
- 最新の auto-review marker が `verdict=pass` で、その `hash=` が現在の文書 hash と一致する。
- `approvals.log` の同じ文書の最終行の hash が、現在の文書 hash と一致する。

gate は承認を記録した経路を読まない。
`approvals.log` の `via`（`utterance` / `ask`）は `workflow-cli status` の表示にだけ使う。

「承認は人間のみ」の根拠は ADR-0023 にある。
承認行は model が書ける 1 行で、人間の承認と model の書き込みを区別できなかったことが発端である。
同 ADR は「承認行を model が書いて hash だけ記録する案」を、人間が見ていない状態で model が承認を成立させられるとして却下した。

model が自分のツール呼び出しで満たせる状態は、承認の代わりにできない。
review verdict、triage の件数、Reviewer Outputs は model が書く。
`reviewer-runs.log` は reviewer を起動した事実だけを記録し、結果は記録しない。
承認の代わりになりうる根拠は、人間が事前に下した決定と、hook が文書から計算できる事実の 2 種類である。
この段落は調査者の解釈である。

## 承認記録の集計

`.tmp/sessions/*/approvals.log` を 2026-10-06 に集計した。
GC が 7 日超のセッションを消すため、対象は直近 7 日分である。
1 ファイルに JSON として読めない行があり、そのファイルの 2 行目以降は数えていない。

| 項目                                | 件数 |
| ----------------------------------- | ---- |
| 承認の記録があるセッション          | 17   |
| うち単層（plan.md のみ）            | 11   |
| うち二層（spec + plan-N）           | 6    |
| 承認された plan-N 文書              | 9    |
| plan-N の承認行                     | 10   |
| 同じ文書の承認が 2 行あるセッション | 1    |

同じ文書の承認が 2 行あったのは 1 セッションで、spec.md と plan-1.md が各 2 行だった。
承認を待った時間を測る記録は無い。
`approvals.log` の `at` は承認の時刻で、質問を出した時刻は残らない。

## 場面 1: 承認済み文書を改訂した後の再承認

### 現状の動き

承認済み文書の文言だけを直すと、次の順で gate が閉じる。

1. 編集で文書 hash が動く。hash の正規化が除くのは marker、Reviewer Outputs、Approval の値、チェックボックスだけである（`hooks/lib/document-hash.ts:63`）。
2. marker の hash と `approvals.log` の hash が、どちらも現在の hash と一致しなくなる。
3. `workflow-cli stamp` を実行すると marker の hash は一致する。新しい round は要らないが、Reviewer Outputs の節と reviewer の起動記録が要る。
4. `approvals.log` の hash は古いままなので、人間の再承認が要る。

レビュー層の `canCarryForwardVerdict` は、再レビューの推奨を止めるだけである。
marker と `approvals.log` は書き換えない（`hooks/implementations/plan-review-automation.ts:117`）。
比較の基準は直近の needs-work marker なので、needs-work の履歴が無い文書では成立しない。

二層では連鎖が起きる。
`parent-spec-hash` は spec.md の全体 hash である（`hooks/cli/workflow.ts:855`）。
spec.md の文言を直すと、全 plan-N の `parent-spec-hash` が不一致になる。

### 省略に必要な変更

承認の記録だけを緩めても gate は開かない。
marker の hash 一致も同じ基準に変える必要がある。

設計部分の hash（design-hash）を基準にする場合、対象の節が狭い。
対象は `## Files` / `## Key Decisions` / `## Scope` / `## Tasks` の 4 節である（`hooks/lib/document-hash.ts:74`）。
spec.md のテンプレートでこれに当たるのは `## Key Decisions` だけである。
Goal、Architecture、Alternative Approaches、Risks は対象に入らない。

`approvals.log` は design-hash を持たない。
承認時点の design-hash と比べるには、記録に項目を足す必要がある。

### 解釈

現在の design-hash をそのまま承認の基準にすると、spec.md の Architecture を書き換えても承認が残る。
承認の基準にする節の範囲は、レビューの基準とは別に決める必要がある。

連鎖だけを対象にする狭い形も考えられる。
人間が改訂後の spec.md を再承認したとき、本文が変わっていない plan-N は再承認を求めない、という形である。
plan-N の本文 hash は `parent-spec-hash` を含まないので、この場合に再承認が現状でも不要である可能性がある。
これは確認していない。

## 場面 2: spec 承認後の plan-N

### 現状の動き

spec を承認した後に plan-N を書き、plan-N を 1 つずつ承認する。
spec テンプレートは「承認後に plan-1.md … を切り出す」としており、spec の承認時点で plan-N は無いのが通常である。

spec.md には、plan-N の範囲を縛る機械可読な情報が無い。
spec テンプレートには `## Files`、`## Scope`、plan の一覧のいずれも無い。
guard が読む `## Files` は plan 側だけである（`hooks/lib/workflow-files.ts` の `parseFilesPaths`）。

承認の質問は 1 問で、選択肢は文書 3 件までと「承認しない」である（`hooks/lib/workflow-approval.ts:191` の `buildApprovalQuestions`）。
記録側は、質問を現状から作り直して応答と完全に一致したときだけ記録する。
選択肢を足すには、質問の生成、選択肢の検査、記録の分岐を変える必要がある。

委任を記録できる既存の状態は無い。
`approvals.log` の読み手は、`v:1` の形でない行を読み飛ばす。
`workflow-state.json` には書き手が無く、`approved` 項目はどこからも読まれていない。

### 既存の決定

ADR-0006 は、spec の承認後に plan-N が spec.md の hash を継承し、再承認を不要とする案を検討した。
同 ADR はこの案を採用しなかった。
理由は次のとおりである（`docs/decisions/0006-document-workflow-two-layer.md:109`）。

> plan の独立性が失われ、1 plan の再計画が他 plan に波及する。worktree 並列実装の前提が壊れる。

`approvals.log` の読み手は、行に未知の項目があっても読み飛ばさない（`hooks/lib/workflow-approval.ts:143`）。
既存の `v:1` の行に項目を足しても、古い読み手はその行を承認の記録として読める。

### 解釈

ADR-0006 が退けた理由は、plan-N が自分の hash を持たなくなることによる波及である。
事前委任で plan-N の marker の hash と `parent-spec-hash` を残せば、この理由は当たらない。
省くのは plan-N の承認の記録だけである。
加えて、事前委任は人間が spec ごとに選んだときだけ適用する。

委任した場合、人間が見ないまま実装に進むのは plan-N の Files と Tasks である。
plan-N が満たす条件（Plan complete、Review pass、hash 一致、`parent-spec-hash` 一致）は、どれも model が満たせる。
委任とは、人間が spec の承認時にこの点を受け入れることである。

## 場面 3: 離席中の先行

### 現状の動き

承認前の worktree への書き込みは deny される。
gate の対象外になるのは、workflow dir の `.md` と、プロジェクト外のパスだけである。
判定は `hooks/lib/workflow-gate.ts:475` の `classifyExemption` が行う。
規約上の worktree の場所 `<repo>/.git/worktree/<branch>` はプロジェクト内なので、対象になる。
guard は subagent からの書き込みにも同じ判定をする。

事後検知の tripwire は、worktree 内の変更を見ない可能性がある。
tripwire は Bash を実行した dir で `git status` を取る（`hooks/implementations/workflow-bash-sync.ts:260`）。
親 repo の `git status` に worktree の変更は出ない、というのは推測で、確認していない。
tripwire は subagent の Bash では動かない。

離席の検知は 1 か所にある。
承認の質問への応答に `afkTimeoutMs` があると、記録側は離席とみなして記録しない（`hooks/lib/workflow-approval-record.ts:208`）。
この項目が実機で付くかは実測されていない（`docs/plans/approval-ask/research.md:55`）。

承認前の実装を別の場所で先行させる検討は、`docs/plans` と `docs/decisions` に見つからなかった。

### 既存の決定

`rules/autonomous-lane.md:5` は次のように定める。

> ローカル対話 session 内の自律実行は恒久的に非提供（`document-workflow-guard` の盲点増幅を避ける）。

「盲点増幅」が何を指すかの説明は、リポジトリ内に見つからなかった。
ADR-0011 の理由づけは CI レーンについてのもので、ローカルで非提供とする理由そのものは書かれていない。

### 解釈

先行を成立させるには、承認前でも書ける場所を gate へ足す必要がある。
これは上の条項の改訂を前提にする。

隔離の強さは Write / Edit と Bash で違う。
Write / Edit は書き込み先のパスで判定できる。
Bash は書き込み先を解析できた場合しか判定できない。

場面 2 の事前委任を入れると、plan-N の承認待ちは離席中でも発生しなくなる。
残る待ちは spec.md と plan.md の初回承認で、集計では 17 セッションに 1 回ずつある。

## 確認していないこと

- spec.md を改訂して再承認したとき、本文の変わらない plan-N に再承認が要るか。
- 親 repo を cwd にした tripwire が worktree 内の変更を見るか。
- `git -C <worktree>` 形式の Bash を guard が書き込みと判定するか。
- 離席時の `afkTimeoutMs` が実機で付くか。
- 2 行の承認があった 1 セッションで、再承認の原因が文言の修正だったか。
- 7 日より前の承認の件数。

## 出典

- gate と hash: `hooks/lib/workflow-gate.ts`、`hooks/lib/document-hash.ts`
- 承認の記録: `hooks/lib/workflow-approval.ts`、`hooks/lib/workflow-approval-record.ts`
- CLI: `hooks/cli/workflow.ts`
- テンプレート: `templates/spec.md`、`templates/plan-execution.md`
- 決定: `docs/decisions/` の ADR-0006、ADR-0011、ADR-0015、ADR-0023
- 規約: `rules/autonomous-lane.md`
- 集計: リポジトリの `.tmp/sessions/*/approvals.log`
