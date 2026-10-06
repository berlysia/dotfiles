# ADR-0030: 残件は、応答を閉じる前にファイルに保存する

## Status

accepted (2026-10-07)

## Context

出発点は `git show a250c0de38:docs/plans/followup-capture.md` である。行番号は、この作業の変更を当てた後のものである。
ADR-0029 の作業（PR #275）の終わりに、利用者が挙げた論点だった。

### 現行の入口と出口

- 残件の行き先は、ADR-0029 K1 の表の 4 行目「範囲の外として次に回した課題 → `docs/plans/` の持ち越した課題の一覧」である（`docs/decisions/0029-workflow-records-move-into-adr.md:48`）。
- 書く時点は「計画の最後のタスク」の 1 回だけである（同 `:53`、`.skills/document-workflow-reference/references/record-migration.md:24`、`home/dot_claude/templates/plan-execution.md:78-93`、`home/dot_claude/rules/workflow.md:116`）。
- ADR-0029 K1 が計画の外の手順にしなかった理由は、ADR と規則の文書が保護対象で、承認済みの計画の Files に載っていないと書けないことである（同 `:55`）。`docs/plans/` は保護対象ではない（`home/dot_claude/hooks/tests/unit/workflow-files.test.ts:282` の `["docs/plans/x.md", false]`）。
- `docs/plans/` に置くものは、ADR-0029 K3 が 2 種類に決めている。持ち越した課題の一覧（`<主題>-followups.md`）と、未着手の作業の出発点である（同 `:60-64`）。
- 出口の規則（片付いた項目は消す）は文章だけである。`docs/plans/` を読む hook・CLI・CI は無い（grep で確認。コメント 2 件のみ）。
- `workflow-guard-followups.md` の課題 D・J・K は、解消と書かれたまま残っている（`:11`、`:161`、commit `2122c96`）。
- 既存の一覧は 4 ファイルで、項目は計 25 件、書式は揃っていない。

### 2026-10-07 の事例

- 「記録を移す」タスクの commit（`43e1949`）は、4 行目を「該当なし」と書いた。
- 残件 3 つは、その後の完了報告と会話の中で出た。保存の手段は、チャットに書いた起動プロンプトだけだった。
- 利用者の説明（2026-10-07）:
  - 3 つのうち「移す手順の見直し」と「残件を保存する仕組み」は、やり残しである。
  - 作業が終わったときに、モデルが申告したはずである。
  - 「plan の重さ」は、やり残しではない。
- 残件には 3 種類ある（利用者の整理）。やり残し、開発中の発見・着想、使ってみて分かった違和感である。

### 書き込みの gate

- workflow が始まっていない状態では、`docs/plans/` への書き込みは gate されない。2026-10-07 に `workflow-cli status docs/plans/some-new-followup.md` を実行すると、「inactive … is not gated」と出力した。
- 承認前の状態では gate される。workflow dir に research.md だけがある状態で同じコマンドを実行すると、「Document workflow gate: … is blocked」と出力し、plan.md の条件 6 つが未達と表示した（2026-10-07）。承認前は `docs/plans/` に書けない。
- 承認前でも、research・spec・plan への編集は許可される。
- 承認前でも、workflow dir の中の新しいファイルには書ける。2026-10-07 に、workflow dir に research.md と plan.md の下書きがある状態で、`workflow-cli status` を workflow dir 内の `followups.md` と `followups/plan-weight.md` に実行した。どちらも「is not gated (a workflow document)」を返した。
- 承認後は、どの plan の Files にも無いファイルへの書き込みは warn と `off-plan-writes.log` になる（`rules/workflow.md` の「CRITICAL: 承認は人間のみ」）。この状態での実測はしていない。

### 発火点に使える場所

- `rules/workflow.md` は 11,937 バイトで、予算テストの上限は 12,288 バイトである。残りは 351 バイトである（`wc -c`、`home/dot_claude/hooks/tests/unit/workflow-md-budget.test.ts:23`）。
- `rules/workflow.md:118-120` の Task Completion Protocol は、停止前の確認を 1 文で書いている。
- reference にだけ置いた規約が発火しなかった前例がある。オフロード判定は `rules/model-offloading.md` にあったが、plan の承認から実装に移る時点に発火点が無く、適用されなかった。`workflow.md` の step 8 に 1 行足して直した（`home/dot_claude/rules/model-offloading.md` の「失敗事例」）。
- 発火の一文の候補は 223 バイトだった（`printf … | wc -c`）。採った文は 302 バイトで、残り 351 バイトに収まる。

### 案の出どころ

4 つの出どころから案を集めた。Codex（6 案）、白紙設計（3 案）、外部の先行例の調査（先行例 9 件と 4 案）、事実の調査である。
Codex の案 1、白紙設計の案 2、外部調査の案 A は、別々に「出た時点で、1 主題 1 ファイルに書く。hook は足さない」に着いた。
3 つとも「事例は 1 件」という同じ制約を渡されているので、軽い案に寄る前提を共有している。

### 確かめていないこと

- 文言を 1 行足すだけで、モデルが残件をファイルに書く割合がどれだけ上がるかは、測っていない。
- 2026-10-07 の transcript は読んでいない。「モデルが申告したはず」は利用者の記憶による。
- Stop hook が語句で残件を検出する精度は、測っていない。

## Decision

- **K1: 発火点は、停止前の確認（Task Completion Protocol）に置く。** 確認の列に「応答に出た残件を保存したか」を足し、同じ段落に書く先を 1 文で書く。
  - 置き場の候補は 4 つあった。
    - 共通フローの step 8（実装の着手）: 実装を始める 1 回しか通らない。残件は、その後の完了報告で出る。
    - ターン終端規則: 前半（宣言したら実行する）は一般的な文面だが、主題は「実行の宣言」と「承認の依頼」で、残件の保存とは主題が違う。後半は Document Workflow の手順に向けた文面である。
    - Session Artifact Retention: 「作業の終わり」と `docs/plans/` を既に扱うが、手順の説明であり、応答のたびに読む確認ではない。
    - Task Completion Protocol: どの作業でも、応答を閉じる前に読む確認である。残件が出るのは応答で、応答の後には必ず停止がある。
  - 候補の発火のしやすさは測っていない。Task Completion Protocol の「停止前」はタスク単位に読める。会話の途中の応答で確認が読まれるかも測っていない。Task Completion Protocol を選ぶ根拠は、残件が出る時点（応答を閉じる前）と、確認が読まれる時点が同じであることである。
  - 自分が書いた残件にも、利用者が挙げた残件にも当てる。利用者が挙げ、モデルが「承知した」とだけ答える応答も対象にするためである。
  - 承認前の書き先（workflow dir の `followups/`）も、`workflow.md` の文に書く。reference にしか無いと、承認前の応答で `docs/plans/` に書こうとして guard に止められる。
  - 参照: `home/dot_claude/rules/workflow.md:118-120`（Task Completion Protocol）
  - 参照: `home/dot_claude/rules/workflow.md:42-44`（ターン終端規則）
  - 参照: `home/dot_claude/hooks/tests/unit/workflow-md-budget.test.ts:23-30`（上限 12,288 バイト。変更前は 11,937 バイト、足した文は 302 バイト、変更後は 12,239 バイト）

- **K2: 「今やる」提案と競合させない。分け目は、今の作業の判定基準を満たすのに要るかどうかである。**
  - 要る内容は残件ではない。今の作業で扱う。計画の変更が要るなら、計画を改めて承認を得る。
  - 計画の無い作業では、元の依頼を満たすのに要るかで分ける。作業を終えた後に見つかった欠けは、残件として書く。
  - 要らない内容は、先に書いて知らせる。今やる方がよいとモデルが考えるときだけ、知らせに理由を添えて勧める。そう考えないなら、今やることを提案しない（利用者の指示、2026-10-07）。
  - 利用者が今やると言えば、書いたファイルか項目が作業の出発点になり、その作業の最後の commit で消す（K3 の出口をそのまま使う）。
  - 勧めるときも書くのを先にするのは、返事が無いまま終わるとチャットにしか残らないためである。
  - この分け目は、利用者が挙げた懸念（出た時点で書く動きと、一緒にやろうと言う動きが競合しないか、2026-10-07）への答えである。
  - 参照: `.skills/document-workflow-reference/references/record-migration.md:54-55`（一覧の項目と出発点のファイルを消す規則）

- **K3: 保存の前に利用者へ聞かない。保存してから知らせる。** 利用者の選択（2026-10-07）である。
  - 利用者が言っていない課題をモデルが挙げるときは、冒頭に「提案・未決」と書く。利用者が選んだ選択肢の説明に含まれていた条件である。
  - ファイルに書くことと commit は別である。commit は、その作業の commit に含めるか、利用者の依頼に従う。根拠は、`rules/workflow.md:120` の停止前の確認が「依頼されたコミット」だけを対象にしていることである。
  - 参照: `home/dot_claude/hooks/tests/unit/workflow-files.test.ts:282`（`docs/plans/` は保護対象ではない）

- **K4: 置き場と単位は ADR-0029 K3 のまま使う。承認前の仮置きは、最後のタスクが回収する。**
  - その項目だけで 1 つの計画になる論点は、出発点のファイルにする。終わった作業に付く小さな課題は、`<主題>-followups.md` の項目にする。同じ主題のファイルが既にあれば足す。
  - 以前の作業を使ってみて分かった違和感は、その作業の `<主題>-followups.md` に足す。どの作業か分からなければ、出発点のファイルにする。
  - 承認前は `docs/plans/` に書けない（Context の「書き込みの gate」）。その間に出た残件は、workflow dir の `followups/` に、`docs/plans/` に置くときと同じ名前と形で書く。
  - 最後のタスクが、`followups/` の中のファイルを、名前を変えずに `docs/plans/` へ移す。この 1 行を、最後のタスクの枠（テンプレートと「最後のタスクの書き方」）に足す。足さないと、枠の文面どおりに実行したとき `followups/` が見られない。
  - 回収の文は 3 か所（テンプレート、「最後のタスクの書き方」、「残件を書く時点」）に入り、どれも同じ文意である。テンプレートは最後のタスクを実行する場所、ほかの 2 つは説明の場所である。直すときは 3 か所を揃える。
  - research.md の節にしないのは、行き先が分かれるためである。research の事実は ADR の Context へ、残件は `docs/plans/` へ行く。
  - workflow dir は 7 日で消える。承認に至らずに作業をやめるときは、やめる前に `followups/` の中身を `docs/plans/` へ移す。
  - 参照: `docs/decisions/0029-workflow-records-move-into-adr.md:60-64`（K3）
  - 参照: `home/dot_claude/templates/plan-execution.md:87-89`（最後のタスクの Step 1）

- **K5: この作業に含めないものを、残件として書く。**
  - 「記録を移す」手順の見直し（表の行ごとから、原本の見出しごとの照合へ）。利用者が含めないと選んだ。
  - 既存の一覧に残っている片付いた項目（`workflow-guard-followups.md` の課題 D・J・K）の掃除。利用者が別の残件に回すと選んだ。
  - 2 つとも `docs/plans/followup-capture-followups.md` に書く。この作業自身が、足した規則の最初の適用になる。
  - 参照: `git show a250c0de38:docs/plans/followup-capture.md` の 21-29 行（片付いた項目と、移す手順の観察）

- **K6: 決定は新しい ADR（0030）に書き、ADR-0029 の K1 に 1 行の案内を足す。**
  - ADR-0029 の「最後のタスクで移す」は、原本の節を移す手順として残る。足すのは、残件の入口だけである。案内が無いと、ADR-0029 だけを読んだ人には、最後のタスクが唯一の入口に見える。
  - 配置される文書（`workflow.md`、`record-migration.md`、`SKILL.md`、テンプレート）には ADR 番号を書かない。
  - `docs/plans/` という置き場は、配置される文書に既に書かれている。ほかのプロジェクトのために、reference に読み替えの 1 文を足す（R6）。
  - 参照: `docs/decisions/0029-workflow-records-move-into-adr.md:85`（配置される文書に ADR 番号を書かない）
  - 参照: `home/dot_claude/rules/workflow.md:116`（`docs/plans/` を書いている既存の文）

## 却下した代替案

- **差分最小案: `rules/workflow.md` に「応答に残件を書くときは、その応答の中で書く」という 1 文を足し、細目は `record-migration.md` に書く。置き場は ADR-0029 K3 の 2 種類をそのまま使う。** 2026-10-07 と同じ失敗を防がない。モデルは残件を完了報告に書いたのに保存しなかった。「書くとき」という条件は、あの日も満たされていた。足りなかったのは、応答を閉じる前の確認である。文は 223 バイトで、採った案より 79 バイト少ない。仮置きの回収も無く、承認前に書いた残件が `docs/plans/` へ移らない（K4）。
- **Stop hook による検出と促し**: 全ターンで hook が動き、語句の検出は問題提起の形の残件を落とす。精度は測っていない。Stop と UserPromptSubmit の両方で動く hook は既に 3 つある（`resume-incomplete-work.ts:130`、`completion-gate.ts:152`、`complexity-delta.ts:413`）。`resume-incomplete-work` は `last_assistant_message` を読み、停止を止める。
- **`workflow-cli followup` の台帳**: 入口はモデルの呼び出しに頼るので、K1 と同じ弱点を持つ。`workflow-cli` のサブコマンドは `status | dir | round | stamp | triage | ask-approval` の 6 つである（`home/dot_claude/hooks/cli/workflow.ts:205-219`）。
- **transcript からの事後の抽出**: 残件が無い会話にも抽出の費用が掛かる。
- **GitHub issue への一本化**: ADR-0029 K3 の置き場の決定を改め、既存の一覧 4 ファイル・25 項目の移行を伴う。GitHub Issues は 28 件で、OPEN は 7 件である（`gh issue list`、2026-10-07）。#241 は持ち越した課題の性格を持つ。
- **一覧と出発点の 2 種類を 1 種類にまとめること**: ADR-0029 K3 の決定を改める。
- **セッションの外で利用者が気づいた残件の入口**: 今までどおり、利用者が issue かファイルに書く。

## Consequences

- **モデルが停止前の確認を飛ばすと、今までと同じく消える（R1）。** 機械的な検査は無い。気づく手段は 1 つある。規則は「書いた先を知らせる」と定めるので、応答に残件があるのにファイルのパスが無ければ、利用者が応答を読んで分かる。
- **雑談や仮説まで残件として書かれ、`docs/plans/` が増える（R2）。** K2 の分け目と K3 の「提案・未決」の表記で、利用者が後から捨てる判断をしやすくする。件数は測らない。利用者が `docs/plans/` を見て多いと感じたら、分け目を見直す。
- **承認後の作業中に `docs/plans/` へ書くと、`off-plan-writes.log` に warn が出る場合がある（R3）。** 書き込みは通る。この状態での実測はしていない。
- **利用者が「今やって」と答えた後、出発点のファイルか一覧の項目を消し忘れる（R4）。** 既存の規則が、どちらも消すと定めている（`record-migration.md:54-55`、テンプレートの Step 2）。検査は無い。
- **承認前に書いた残件が、workflow dir と一緒に消える（R5）。** 承認に至らずに作業をやめ、移すのを忘れた場合である。7 日の間は拾い直せる。検査は無い。
- **`docs/plans/` を持たないプロジェクトで、書く先に迷う（R6）。** `workflow.md` と skill は、ほかのプロジェクトにも配置される。`workflow.md:116` が既に `docs/plans/` と「そのプロジェクトの記録の慣習に従う」を併記しており、足した文も同じ前提に乗る。読み替えの 1 文は reference だけに足した（残り 49 バイトでは `workflow.md` に足せない）。
- **`workflow.md` の残りが 49 バイトになる（R7）。** 次に文を足すときは、既存の文を削る必要がある。
- **元に戻す方法**: 実装の commit（`workflow.md`、reference とテンプレート、記録の移し替えの 3 つ）を revert する。`docs/plans/` に書かれた残件は revert では消えないので、利用者が要否を見て消す。
- **計画から外れた点は無い。** 回収の段落は、計画どおり `record-migration.md` の「最後のタスクの書き方」の節の末尾に足した。計画の初稿は、`:24` の段落の直後に置く案だった。直後の文の「そのタスク」が指す先が切れると分かり、承認前に節の末尾へ直した。承認した計画と実装の間に、外れた点は無い。
- **提供しないもの。** 却下した代替案のうち、再検討の条件を持つのは次の 2 つである。
  - Stop hook による検出。利用者が、残件のある応答にファイルのパスが無いのを見つけたら、その応答の文面を材料に検討する。
  - GitHub issue への一本化。既存の一覧の掃除（`docs/plans/followup-capture-followups.md` の 2 つ目の項目）を終えた後に、利用者が一覧を開いて「解消」と書かれた項目が残っているのを見つけたら、検討する。
- 規則、テンプレート、skill は、引数なしの `chezmoi apply` を実行するまで `~/.claude/` に配置されない。

## References

- `docs/decisions/0029-workflow-records-move-into-adr.md`（K1 の表、K3 の `docs/plans/` の定義と出口）
- `git show a250c0de38:docs/plans/followup-capture.md`（出発点だった文書）
- `docs/plans/followup-capture-followups.md`（この作業が範囲の外に回した課題）
- 実装: ブランチ `docs/followup-capture`
