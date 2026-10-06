<!-- spec-ref: spec.md -->

# Plan: plan-N 事前委任の文書と ADR (Execution layer)

spec.md の K9 を実装する。
plan-1 と plan-2 でコードは入った。
この plan で、決定の記録（ADR-0028）、規約と手順書、spec のテンプレートを更新し、作業用の文書を消えない場所へ移す。

`## Files` とコマンドのパスは、リポジトリの直下からの相対で書く。
作業は plan-1、plan-2 と同じ worktree（ブランチ `feat/plan-delegation`）で行う。

この plan が従う制約は 3 つある。

- `home/dot_claude/rules/workflow.md` は 12288 バイトまでである（`home/dot_claude/hooks/tests/unit/workflow-md-budget.test.ts`）。現在 11119 バイトで、足せるのは 1169 バイトである。
- 配置される文書（`home/dot_claude/` と `.skills/` の `.md`、テンプレート）には、`ADR-` と 4 桁の数字、`docs/decisions/` と 4 桁の数字、`home/dot_claude/`、`.skills/` という文字列を書けない（`deployed-docs-repo-refs.test.ts`）。保護対象の一覧は、この形を避けて書く。
- `workflow.md` の「CRITICAL: 承認は人間のみ」の節には、テストが確かめる 3 つの文字列がある。この節の既存の文は変えない。

## Files

```
# 新規作成
docs/decisions/0028-plan-delegation.md
docs/plans/plan-delegation/README.md
docs/plans/plan-delegation/research.md
docs/plans/plan-delegation/spec.md
docs/plans/plan-delegation/plan-1.md
docs/plans/plan-delegation/plan-2.md
docs/plans/plan-delegation/plan-3.md

# 編集
docs/decisions/0006-document-workflow-two-layer.md
docs/decisions/0023-workflow-identity.md
docs/plans/workflow-guard-followups.md
home/dot_claude/rules/workflow.md
home/dot_claude/rules/autonomous-lane.md
home/dot_claude/templates/spec.md
.skills/document-workflow-reference/SKILL.md
CONTEXT.md
```

## Tasks

コードの変更は無いので、各タスクは「書く → 検査する → コミットする」の 3 段にする。
文書は Edit / Write で書く。コピー（T6）だけは `cp` を使う。
検査のコマンドは worktree の直下で実行する。

### T1: ADR-0028 を書く

**Files:**

- 新規作成: `docs/decisions/0028-plan-delegation.md`
- 参照: `docs/decisions/0023-workflow-identity.md:1-60`（書式の先例。frontmatter なし、`## Status` に `accepted (日付)`、決定は `- **K1（要約）**: 本文`、`### spec からの差`、`### 却下した代替案`）

- [ ] **Step 1: 次の内容で書く**

```markdown
# ADR-0028: spec の承認時に、plan-N の承認を委任できるようにする

## Status

accepted (2026-10-06)

## Context

二層モードでは、spec を承認した後も、plan-N を書くたびに承認待ちで実装が止まる。
2026-10-06 に `.tmp/sessions/*/approvals.log`（直近 7 日分）を数えたところ、二層の 6 セッションで plan-N の承認が 10 回あった。
集計は `docs/plans/plan-delegation/research.md` の「承認記録の集計」にある。
plan-N の個別承認が問題を見つけた回数の記録は無い。

依頼は「一定の状態を満たしたら人間の承認なしに先へ進む方法」だった。
対象は、spec 承認後の plan-N の個別承認に絞った。
初回の承認（spec.md、plan.md）の省略、承認後の改訂の再承認の省略、離席中の先行実装は、この決定の対象外である。

「一定の状態」に使える根拠は限られる。
review verdict、triage の件数、Reviewer Outputs は model が書く値で、承認の代わりにできない（ADR-0023）。
使えるのは、人間が事前に下した決定と、hook がパスから計算できる事実の 2 種類である。

設計の全文とレビューの記録は `docs/plans/plan-delegation/` にある。

## Decision

支配軸は安全機構の保全で、摩擦の削減はその次である。

- **K1（委任は spec の承認記録の属性）**: `approvals.log` の spec.md の行に `delegate: "plans-in-scope"` を足す。版は `v:1` のまま変えない。委任が有効なのは、spec.md が gate の 6 条件を満たし、その最終行に `delegate` があり、spec の `## Scope` が有効なときである。spec の hash が動けば、委任も無効になる。model は委任のために何も書かず、plan-N の承認行は `pending` のまま残る。
- **K2（plan-N の判定は 1 か所）**: gate の `classifyPlan` が plan-N を `approved`、`delegated`、`blocked` に分ける。書き込みの判定、実装フェーズの判定、診断、`workflow-cli status`、承認候補の列挙は、すべてこの関数を読む。`delegated` の条件は 4 つである。委任が有効である。plan-N が承認以外の gate 条件（Plan Status、Review Status、marker の verdict と hash、`parent-spec-hash`）を満たす。`## Files` が 1 件以上あり、全件が spec の `## Scope` に収まる。`## Files` に保護対象のパスが無い。
- **K3（範囲は spec の `## Scope`）**: 書式は `## Files` と同じで、コードブロックに 1 行 1 パスで書く。末尾が `/` の行は dir、それ以外はファイルを表す。行は 16 行まで、1 行 120 文字までとし、ASCII の英数字と `._/@+-` だけで書く（数値は記録時点のもの。現行の値は `home/dot_claude/hooks/lib/workflow-files.ts` の定数にある）。`/` で区切った要素に、空の要素、`.`、`..` を持たせない。違反が 1 行でもあれば、Scope 全体を無効とする。symlink を経由する行は、どの対象にも当たらない。照合は実際のパスで行い、dir の行は区切りを付けた前方一致とし、大文字と小文字を区別する。
- **K4（保護対象は固定のリスト）**: 次のパスは、Scope に書かれていても委任の対象にしない。`docs/decisions`、`.skills`、`.github/workflows`、`.git`、`.tmp/sessions` の下（先頭からの要素が一致するもの。`docs/decisions-x` は当たらない）。`.claude` または `dot_claude` という名前の dir の下。`CLAUDE.md`、`AGENTS.md`、`CONTEXT.md`（末尾の `.tmpl` を外して比べる）。判定は実際のパスに対して行い、大文字と小文字を区別しない。checkout の外へ解決されたパスと、解決できないパスは、判定できないものとして委任しない。現行のリストは `home/dot_claude/hooks/lib/workflow-files.ts` の定数にある。
- **K5（同じファイルを複数の plan-N が挙げた場合）**: 対象を挙げる最初の plan-N で結果を決める規則は変えない。例外は 1 つで、最初が `delegated` のときだけ、後ろに `approved` があればそちらを採る。

  | 対象を挙げる plan-N の並び                | 結果                |
  | ----------------------------------------- | ------------------- |
  | `approved` が最初                         | 許可（`approved`）  |
  | `blocked` が最初                          | deny。後ろは見ない  |
  | `delegated` が最初、後ろに `approved`     | 許可（`approved`）  |
  | `delegated` が最初、後ろは `blocked` だけ | 許可（`delegated`） |

- **K6（委任だけの実装フェーズの制限）**: 人間が承認した plan-N が 1 つも無く、`delegated` の plan-N だけで実装フェーズに入った場合、次の 3 つを課す。どの plan にも無いファイルへの書き込みは、Scope の内側で保護対象でないときだけ警告にし、それ以外は deny する。インタプリタ経由の書き込みの検査は外さない。tripwire は止めず、Scope の内側で保護対象でない変更だけを報告から外す。人間が承認した plan-N が 1 つでもあれば、3 つとも従来どおりである。
- **K7（委任を記録する経路は 1 つ）**: `workflow-cli ask-approval` は、候補に spec.md があり、委任できる Scope の行が 1 つ以上あるときだけ、2 問目（「委任しない」「委任する」の順）を出す。「委任する」の説明文には Scope の全行を出し、保護対象の行と symlink を経由する行には「委任の対象外」と付ける。記録側は 2 問とも現状から作り直し、応答と完全に一致したときだけ記録する。2 問目の答えは、1 問目が承認と決まった後で読む。委任は、1 問目で spec.md を選び、2 問目で「委任する」を選んだときだけ記録する。発話、予約したプロンプト、subagent の中の質問は、委任を記録しない。
- **K8（委任に基づく書き込みを知らせる）**: guard は、`delegated` の plan-N を根拠に書き込みを通した最初の 1 回で、利用者に見える通知を出す。単位は plan-N の版と spec の版の組である。委任だけの実装フェーズで通した、どの plan にも無いファイルへの書き込みも、ファイルと spec の版の組ごとに 1 回知らせる。記録は `<wfDir>/delegation-uses.log` に残し、ツールでの書き込みは `approvals.log` と同じ箇所で deny する。`workflow-cli status` は、委任が有効かどうかと、各 plan-N の分類を表示する。
- **K9（取り消しは既存の経路）**: spec.md の承認行を `pending` に戻すと、spec が未承認になり、委任も無効になる。新しい取り消しの発話は足さない。
- **K10（既定は個別承認）**: 委任は、人間が spec ごとに選んだときだけ適用する。

### 委任で人間が手放すもの

実装の前に plan-N の `## Files` と `## Tasks` を見る機会である。
plan-N のレビュー結果は model が要約して書く値で、委任はこれを人間が受け入れる決定である。
影響は K3、K4、K6 で Scope の内側に限り、K8 で後から追えるようにした。

### 既存の決定との関係

- **ADR-0006**: 同 ADR は、plan が spec の hash を継承して再承認を不要とする案を退けた。理由は、plan の独立性が失われ、1 つの plan の再計画が他の plan に波及することだった。この決定は plan-N の marker の hash と `parent-spec-hash` を残すので、その理由は当たらない。一方で、spec の改訂は全 plan-N の委任を同時に無効にする。この波及は残る。
- **ADR-0011 と `rules/autonomous-lane.md`**: 同規約は、ローカルの対話セッション内の自律実行を提供しないとし、実行時に trivial かどうかを判定する機構を禁じている。委任は、人間が起動した作業の中で、人間が spec と範囲を承認して成立する。機構が判定するのはパスの包含で、変更が trivial かどうかではない。ただし、人間の承認なしに plan-N が実装へ進む点は、文言の上で条項と緊張する。同規約の位置づけの節に、「自律実行」が system の起動する実行を指すことを書いた。
- **ADR-0023**: 承認を人間に限る機構（発話と質問の記録、model の書き込みの deny）は変えていない。委任は、同 ADR の質問の経路に 2 問目を足したものである。

### spec からの差

承認した spec から、実装計画で次の点を具体化・追加した。
以下の K の番号は、この ADR のものである。
spec の番号とは途中からずれる。spec の K5 がこの ADR の K6、K6 が K7、K7 が K8、K8 が K9 に当たる。この ADR の K5 と K10 は、spec では K5 の一部と採用案の理由に書かれていた。

- K3 の行の制限（文字、長さ、要素の形、symlink）は、レビューで見つかった経路を塞ぐために足した。ゼロ幅の文字や長い行は質問の表示を読み違えさせ、`.//` や symlink はリポジトリ全体を覆う。
- K4 の `.git` と `.tmp/sessions` は、Scope が workflow dir を覆うと承認の台帳を Bash で書けることから足した。
- K5 の並びの規則は、spec の「両方が挙げたら `approved` を採る」を、既存の「最初の plan-N が決める」規則を変えない形にしたものである。
- K6 のインタプリタ書き込みの検査と tripwire は、spec に無かった。「実装フェーズかどうか」を読んで挙動を緩めていた箇所を全部挙げ、委任だけのときに緩めてよいかを 1 つずつ決めた結果である。
- K8 の、どの plan にも無いファイルへの書き込みの通知は、spec に無かった。この書き込みは、従来は誰にも届かない標準エラーに出るだけだった。
- 通知の根拠は、`rules/code-quality.md` の「Recoverable State Must Announce Itself」ではない。同規約は害が見えた時点の信号を求めるもので、委任の正常な利用には当たらない。根拠は、人間が確認を手放した書き込みを後から追えるようにすることである。

### 却下した代替案

- **レビューが全員 pass なら自動で承認する**: 条件が model の書く値だけに依存する。ADR-0023 が退けた「人間が見ていない状態で model が承認を成立させる」と同じ形になる。
- **Scope を設けず、委任したらどこにでも書ける**: plan-N が spec の範囲を超えていないかが、reviewer の判断だけに依存する。依頼者が Scope で縛る案を選んだ。
- **委任を既定にする**: 設計判断を無人で実行する誤りは高くつき、不要な承認待ちは摩擦で済む（ADR-0011）。確認が残る向きを既定にした。
- **取り消しの発話を足す**: 台帳は最終行の hash で承認を決める。現在の hash で行を追記する発話は、未レビューの改訂を承認にしてしまう。
- **spec が plan の枠（名前と Files の集合）を宣言する**: plan の件数と分け方まで縛れるが、spec の承認時に全 plan の Files を決める必要がある。plan-N は spec の承認後に書くのが通常である。
- **保護対象を設けず、質問の説明文で人間に見せるだけにする**: Scope は model が書く値である。承認機構の実装が Scope に入ると、委任された plan-N がそれを書き換えられる。
- **委任の行に Scope の内容の要約値を持たせる**: 悪用には承認行の値を意図的に空にする操作が要り、ADR-0023 が耐性を主張しない範囲である。

## Consequences

- 委任を選んだ spec では、Scope に収まる plan-N がレビュー通過の時点で実装へ進む。選ばなかった spec と、単層モードは変わらない。
- 承認機構の実装、設定、決定記録、model が従う指示に触れる plan-N は、常に個別承認になる。この決定の実装自体も、委任を使わず個別に承認した。
- ASCII 以外の文字を含むパス、symlink を経由するパスは、Scope に書いても委任されない。
- Scope の広さの上限は機構で決めていない。人間が質問の説明文で全行を見て選ぶ。
- 保護対象のリストは、リポジトリごとの設計面を拾えない。リストに無い設計面は、Scope に書かないことで守る。
- 委任した後で、特定の plan-N だけを個別承認に戻す手段は無い。K9 の手順で、全体を個別承認に戻す。
- 人間が承認した plan-N が 1 つでもあると、どの plan にも無いファイルへの書き込みは、Scope の外でも、保護対象のパスでも、警告で通る。これは従来の二層モードと同じ挙動で、委任が足す権限ではない。保護対象は、委任が通すものだけを制限する。
- 進行中のセッションの `approvals.log` には `delegate` が無い。委任なしとして動くので、移行は要らない。hash の正規化は変えていない。

受容した限界は次のとおりである。

- plan-N の通過条件はすべて model が満たせる。reviewer の起動は台帳で確かめるが、verdict は model が書く。
- Bash の書き込みは、書き込み先を解析できた場合しか Scope と照合できない。解析できない Bash は、従来どおり deny される。
- 委任の記録は Scope の内容の要約値を持たない。hash の正規化には、承認行の値が空のとき次の行を落とす挙動がある（`docs/plans/workflow-guard-followups.md` の課題 L）。これを使って承認後に Scope を差し替えるには、承認行の値を意図的に空にする操作が要る。
- Bash による `approvals.log` と `delegation-uses.log` への追記は止めない（ADR-0023 と同じ）。後者に先に行を書くと、通知が出なくなる。
- `delegation-uses.log` の名前で FIFO を作られると、読み取りが止まる。
- Bash の書き込み先が、symlink を通ってから親へ戻る形（`link/../x`）だと、通知の重複抑止のキーが別のファイルと重なりうる。
- 通知の記録は、読み戻しと追記が 1 つの操作ではない。並列の呼び出しでは通知が 2 回出うる。記録に失敗した場合は、通知が書き込みのたびに出る。
- AskUserQuestion の画面で、2 問目の既定の選択がどうなるかは確かめていない。「委任しない」を先頭に置いた。
- この ADR の時点で、配備後の実機での確認は行っていない。確認したのは、単体テストと、hook を通したテストである。

## References

- 設計の全文: `docs/plans/plan-delegation/`（research、spec、plan-1 から plan-3。レビューの記録を含む）
- `docs/decisions/0006-document-workflow-two-layer.md`（継承案の却下）
- `docs/decisions/0011-autonomous-lane-charter.md`（誤りの費用の非対称、自律レーンの条項）
- `docs/decisions/0023-workflow-identity.md`（承認を人間に限る機構）
- `docs/plans/workflow-guard-followups.md` の課題 L（hash の正規化が次の行を落とす件）
- 実装: ブランチ `feat/plan-delegation`（PR で master に取り込む）
```

- [ ] **Step 2: 検査する**

実行: `grep -c "^- \*\*K" docs/decisions/0028-plan-delegation.md`
期待: `10`

実行: `bun run format:check`
期待: 終了コード 0。0 でなければ `bun run format` を実行し、変わった箇所が整形だけであることを `git diff` で確かめる。

- [ ] **Step 3: コミット**

```bash
git add docs/decisions/0028-plan-delegation.md
git commit -m "docs(decisions): record the plan delegation decision as ADR-0028"
```

### T2: ADR-0006 と ADR-0023 に ADR-0028 への参照を足す

**Files:**

- 編集: `docs/decisions/0006-document-workflow-two-layer.md`（`## Open observation items` の直前に節を足す）
- 編集: `docs/decisions/0023-workflow-identity.md`（`## References` の直前に節を足す）
- 参照: `docs/decisions/0015-document-workflow-operator-ergonomics.md:71`（`## Amendment (日付): 題` の先例）、`docs/decisions/0023-workflow-identity.md:80`（`## 改訂（日付）: 題` の先例）

- [ ] **Step 1: 次の節を足す**

ADR-0006 には、`## Open observation items` の見出しの直前に足す。

```markdown
## Amendment (2026-10-06): plan-N の承認を委任できる

ADR-0028 で、人間が spec の承認時に選ぶと、spec の `## Scope` に収まる plan-N が個別の承認なしで gate を通るようにした。

これは Rejected alternatives の Option B とは違う。
plan-N は自分の marker の hash と `parent-spec-hash` を持ち続け、省くのは plan-N の承認の記録だけである。
Option B を退けた理由（plan の独立性が失われる）は当たらない。

ただし、spec を改訂すると、全 plan-N の委任が同時に無効になる。
人間が改訂後の spec を承認し直すまで、委任で通っていた plan-N は止まる。
```

ADR-0023 には、`## References` の見出しの直前に足す。

```markdown
## 改訂（2026-10-06）: plan-N の承認の委任（ADR-0028）

ADR-0028 で、承認の質問に 2 問目を足した。
利用者が spec.md を選び、2 問目で「委任する」を選ぶと、`approvals.log` の spec.md の行に `delegate: "plans-in-scope"` が付く。

この ADR の決定は変えていない。

- 承認を記録するのは、利用者の発話と、利用者が答えた質問だけである。委任を記録するのは、質問の経路だけである。
- 記録側は、2 問とも現状から作り直し、応答と完全に一致したときだけ記録する。
- guard は、2 問目だけを出した質問でも、model が `answers` を埋めていれば deny する。2 問目の文も `Document Workflow の承認` で始まる。
- `delegation-uses.log`（委任で通した書き込みの記録）へのツールでの書き込みは、`approvals.log` と同じ箇所で deny する。Bash は対象外のままである。
```

- [ ] **Step 2: 検査する**

実行: `grep -n "ADR-0028" docs/decisions/0006-document-workflow-two-layer.md docs/decisions/0023-workflow-identity.md`
期待: 各ファイルに 1 行以上。

- [ ] **Step 3: コミット**

```bash
git add docs/decisions/0006-document-workflow-two-layer.md docs/decisions/0023-workflow-identity.md
git commit -m "docs(decisions): point ADR-0006 and ADR-0023 at the plan delegation decision"
```

### T3: 規約に委任を書く

**Files:**

- 編集: `home/dot_claude/rules/workflow.md:49`（二層モードの節）、`:94`（CRITICAL の節の末尾）
- 編集: `home/dot_claude/rules/autonomous-lane.md:5`（位置づけの節）
- 参照: `home/dot_claude/hooks/tests/unit/workflow-md-budget.test.ts:23`（上限 12288 バイト）

- [ ] **Step 1: 次の文を足す**

`workflow.md` の二層モードの節で、「承認順: …」の項目の次に 1 項目足す。

```markdown
- 委任: spec.md の承認の質問に 2 問目が出たら、利用者が委任を選べる。選ぶと、spec の `## Scope` に収まる plan-N.md は承認を待たずに通る（`workflow-cli status` の `✓ (delegated)`）。条件は reference skill「委任」。
```

`workflow.md` の「CRITICAL: 承認は人間のみ」の節の最後の項目の次に 1 項目足す。
この節の既存の文は変えない。

```markdown
- 委任を記録するのは利用者の回答だけ。Claude は 2 問目の `answers` も入れない。
```

`autonomous-lane.md` の位置づけの節の段落の末尾に、次の 2 文を足す。

```markdown
ここでいう自律実行は、system が起動する実行を指す。人間が起動した Document Workflow の中で、人間が spec の承認時に plan-N の承認を委任すること（`@~/.claude/rules/workflow.md` の「二層モード」節）は、pull レーンの承認の粒度であり、これに当たらない。
```

- [ ] **Step 2: 検査する**

実行: `wc -c home/dot_claude/rules/workflow.md`
期待: 12288 以下。超えた場合は、足した 2 項目の文を短くして収める。既存の文は削らない。

実行: `node --import ./home/dot_claude/hooks/tests/preload-test-env.mjs --test home/dot_claude/hooks/tests/unit/workflow-md-budget.test.ts home/dot_claude/hooks/tests/unit/deployed-docs-repo-refs.test.ts home/dot_claude/hooks/tests/unit/mechanical-lane-routing.test.ts`
期待: 3 ファイルとも PASS

- [ ] **Step 3: コミット**

```bash
git add home/dot_claude/rules/workflow.md home/dot_claude/rules/autonomous-lane.md
git commit -m "docs(rules): describe plan delegation in the workflow guide and the lane charter"
```

### T4: 機構リファレンスと spec のテンプレートに委任を書く

**Files:**

- 編集: `.skills/document-workflow-reference/SKILL.md:21-47`、`:59`、`:114`、`:118`
- 編集: `home/dot_claude/templates/spec.md:40-42`（`## Key Decisions` と `## Risks` の間）
- 参照: `home/dot_claude/hooks/lib/workflow-files.ts`（`parseScope`、`isProtectedPath`。文書に書く制限の出どころ）

配置される文書なので、`.skills` の後ろに `/` を付けない。`docs/decisions` の後ろに 4 桁の数字を続けない。

- [ ] **Step 1: SKILL.md を直す**

「K7 連鎖検証（二層）」の節の末尾（`parent-spec-hash` が欠落した plan-N.md は … の文の後）に、空行を挟んで次の節を足す。

```markdown
## 委任

人間が spec の承認時に委任を選ぶと、条件を満たす plan-N.md は、自分の承認なしで gate を通る。
plan-N.md の承認行は `pending` のまま残り、model は委任のために何も書かない。

**通る条件**（すべて満たすこと）:

- spec.md が gate の条件を満たし、`approvals.log` の spec.md の最終行に `delegate` があり、spec の `## Scope` が有効である。spec の hash が動くと、委任も無効になる。
- plan-N.md が、承認以外の条件（Plan Status、Review Status、marker の verdict と hash、`parent-spec-hash`）を満たす。
- plan-N.md の `## Files` が 1 件以上あり、全件が spec の `## Scope` に収まる。
- plan-N.md の `## Files` に、保護対象のパスが無い。

**`## Scope` の書き方**: `## Files` と同じく、コードブロックに 1 行 1 パスで書く。末尾が `/` の行は dir、それ以外はファイルを表す。`#` で始まる行はコメントである。空白を含む行があるコードブロックは、ブロックごと無視される。次の制限に合わない行が 1 つでもあると、Scope 全体が無効になる。

- 行は 16 行まで、1 行は 120 文字まで。
- 使える文字は、ASCII の英数字と `._/@+-` だけ。
- `/` で区切った要素は、空の要素、`.`、`..` であってはならない（`/` で始まる行、`./src/`、`a//b/` は無効）。

symlink を経由する行は無効にはならないが、どの対象にも当たらない。照合は大文字と小文字を区別する。

**保護対象**（Scope に書いても委任されない）:

- `docs/decisions`、`.skills`、`.github/workflows`、`.git`、`.tmp/sessions` の下（先頭からの要素が一致するもの）
- `.claude` または `dot_claude` という名前の dir の下
- `CLAUDE.md`、`AGENTS.md`、`CONTEXT.md`（末尾の `.tmpl` を外して比べる）

保護対象の判定は大文字と小文字を区別しない。checkout の外へ解決されるパスも委任されない。

**選び方**: `workflow-cli ask-approval` は、質問に出す 3 件の中に spec.md があり、委任できる Scope の行が 1 つ以上あるとき、2 問目（「委任しない」「委任する」）を出す。「委任する」の説明文には Scope の全行が出て、委任されない行には「委任の対象外」と付く。model は 2 問とも出力のまま AskUserQuestion に渡す。記録されるのは、1 問目で spec.md を選び、2 問目で「委任する」を選んだときだけである。発話（`承認 spec.md`）は委任を記録しない。

**委任だけで実装フェーズに入った場合**（人間が承認した plan-N.md が 1 つも無い）:

- どの plan にも無いファイルへの書き込みは、Scope の内側で保護対象でないときだけ警告で通る。それ以外は deny される。
- インタプリタの inline-script の書き込みは、承認前と同じく検査される。
- tripwire は動き続け、Scope の内側で保護対象でない変更だけを報告から外す。

**知らせ方**: guard は、委任で通した最初の書き込みで、plan-N.md の名前、hash の先頭 12 桁、取り消し方を利用者に知らせる。単位は plan-N.md の版と spec.md の版の組である。委任だけの実装フェーズで通した、どの plan にも無いファイルへの書き込みも、ファイルごとに 1 回知らせる。記録は `<wfDir>/delegation-uses.log` に残る。このファイルへの Write / Edit / MultiEdit は deny される。

**取り消し**: spec.md の承認行を `pending` に戻す。spec が未承認になり、委任も無効になる。その後の承認の質問で「委任しない」を選べば、plan-N.md は 1 つずつの承認に戻る。

**同じファイルを複数の plan-N.md が挙げた場合**: 対象を挙げる最初の plan-N.md で結果が決まる。最初が委任で通る plan のときだけ、後ろに人間が承認した plan があればそちらが採られる。
```

既存の文を 5 か所直す。

`:21` の design-hash の説明は変えない（`Scope` は既に対象に入っている）。

`:29` の `via` の項目の末尾に 1 文足す。

```markdown
// 置き換え前

- ledger の行には記録した経路 `via`（`utterance` / `ask`）が入る。gate は読まず、`workflow-cli status` が `approval via:` で表示する
  // 置き換え後
- ledger の行には記録した経路 `via`（`utterance` / `ask`）が入る。gate は読まず、`workflow-cli status` が `approval via:` で表示する。spec.md の行には `delegate` が付くことがある（下記「委任」）。gate はこれを読む
```

`:36` の deny の項目に、ファイル名を 1 つ足す。

```markdown
// 置き換え前

- model の Write / Edit / MultiEdit で承認行を approved にする、または `approvals.log` に書くことは guard が deny する（Bash は対象外）
  // 置き換え後
- model の Write / Edit / MultiEdit で承認行を approved にする、または `approvals.log` か `delegation-uses.log` に書くことは guard が deny する（Bash は対象外）
```

`:59` の tripwire の項目の末尾に 1 文足す。

```markdown
// 置き換え前の末尾
`git` 不在・200ms 超過では `.tripwire-disabled` を作り、一度だけ告知して skip する。
// 置き換え後の末尾
`git` 不在・200ms 超過では `.tripwire-disabled` を作り、一度だけ告知して skip する。委任だけで実装フェーズに入った場合も動く（上記「委任」）。
```

`:114` の `status` の項目の、`plan: plan-N.md ✓` を説明している箇所を直す。

```markdown
// 置き換え前
二層モードでは plan-N.md ごとに `plan: plan-N.md ✓`、または最初に満たしていない条件を添えた `plan: plan-N.md ✗ <条件>` の行も出す（`parent-spec-hash` の不一致を含む）。
// 置き換え後
二層モードでは plan-N.md ごとに `plan: plan-N.md ✓`、委任で通っていれば `plan: plan-N.md ✓ (delegated)`、または最初に満たしていない条件を添えた `plan: plan-N.md ✗ <条件>` の行も出す（`parent-spec-hash` の不一致を含む）。委任の条件から外れた plan は `✗ Approval Status (delegation: <理由>)` になる。`delegation: active` / `delegation: none` の行で、委任が有効かどうかも出す。
```

`:118` の `ask-approval` の項目の末尾に 1 文足す。

```markdown
// 置き換え前の末尾
承認待ちが 0 件なら非 0 で終わる。
// 置き換え後の末尾
承認待ちが 0 件なら非 0 で終わる。候補に spec.md があり、委任できる Scope の行があるときは、質問が 2 つになる（上記「委任」）。委任で通っている plan-N.md は候補に出ない。
```

- [ ] **Step 2: spec のテンプレートを直す**

`home/dot_claude/templates/spec.md` の `## Key Decisions` の節の最後（`- ...` の行）と `## Risks` の見出しの間に、次の節を足す。

````markdown
## Scope

このセクションは **任意**。plan-N.md の承認を委任したいときだけ書く。書かなければ、plan-N.md は 1 つずつ承認する。

plan-N.md が書き込んでよい範囲を、コードブロックに 1 行 1 パス（プロジェクトルート相対）で書く。末尾が `/` の行は dir、それ以外はファイルを表す。行の制限と、書いても委任されないパスは、`document-workflow-reference` skill の「委任」にある。下の例の行は、書き換えるまで無効である。

```
<dir>/
<path/to/file>
```
````

例の行は `<` と `>` を含むので、書き換えないかぎり Scope 全体が無効になる。
テンプレートを写しただけの spec が、意図せず委任できる状態にならないためである。

- [ ] **Step 3: 検査する**

実行: `node --import ./home/dot_claude/hooks/tests/preload-test-env.mjs --test home/dot_claude/hooks/tests/unit/deployed-docs-repo-refs.test.ts home/dot_claude/hooks/tests/unit/workflow-md-budget.test.ts home/dot_claude/hooks/tests/unit/document-hash.test.ts home/dot_claude/hooks/tests/unit/mechanical-lane-routing.test.ts`
期待: 4 ファイルとも PASS

実行: `grep -n '\.skills/' .skills/document-workflow-reference/SKILL.md home/dot_claude/templates/spec.md`
期待: 出力なし（終了コード 1）

テンプレートの例の行が無効であることを確かめる。
次のコマンドは、ファイルを書かない読み取りだけの検査である。

```bash
bun -e 'import { parseScope } from "./home/dot_claude/hooks/lib/workflow-files.ts"; import { readFileSync } from "node:fs"; console.log(JSON.stringify(parseScope(readFileSync("home/dot_claude/templates/spec.md", "utf-8"))));'
```

期待: `{"valid":false,"reason":"invalid-entry"}`

テンプレートの `spec.md` を編集すると、hook が同じ dir にキャッシュを作ることがある。
`git status --short` に `home/dot_claude/templates/plan-review.cache.json` が出たら、worktree の中のそのファイルを絶対パスで `rm` する。コミットには含めない。

- [ ] **Step 4: コミット**

```bash
git add .skills/document-workflow-reference/SKILL.md home/dot_claude/templates/spec.md
git commit -m "docs(skills): document plan delegation in the workflow reference and the spec template"
```

### T5: CONTEXT.md と課題の一覧を直す

**Files:**

- 編集: `CONTEXT.md:39`、`:57` の次
- 編集: `docs/plans/workflow-guard-followups.md`（末尾に課題 L を足す）
- 参照: `docs/plans/workflow-guard-followups.md:111-172`（課題 J。事実、実測と推論の区別、再訪のきっかけ、の形）

- [ ] **Step 1: CONTEXT.md を直す**

`:39` の design-hash の行を直す。`Scope` が抜けている。
design-hash の対象は `home/dot_claude/hooks/lib/document-hash.ts` の `DESIGN_SECTION_HEADINGS` で、`Scope` を含む。

```markdown
// 置き換え前

- `design-hash`: Key Decisions / Files / Tasks セクションのみのハッシュ (carry-forward 判定)
  // 置き換え後
- `design-hash`: Key Decisions / Files / Scope / Tasks セクションのみのハッシュ (carry-forward 判定)
```

「ADR-0015 で追加された語彙」の項目の最後（`operator guide / reference skill` の行）の次に、同じ深さで項目を足す。

```markdown
- **ADR-0028 で追加された語彙（2026-10-06）**:
  - **委任 (delegation)**: 人間が spec の承認時に選ぶと、spec の `## Scope` に収まる plan-N.md が自分の承認なしで gate を通る。記録は `approvals.log` の spec.md の行の `delegate: "plans-in-scope"`
  - **`## Scope`**: spec.md に書く、委任された plan-N.md が書き込んでよいパスの一覧。行の文字・長さ・形に制限があり、違反があると全体が無効
  - **保護対象**: Scope に書いても委任されないパス（承認機構の実装、設定、決定記録、model が従う指示）。`lib/workflow-files.ts` の定数
  - **classifyPlan**: plan-N.md を `approved` / `delegated` / `blocked` に分ける gate の関数。書き込みの判定、診断、`status` がこれを読む
  - **委任だけの実装フェーズ (delegated-only)**: 人間が承認した plan-N.md が無く、委任で通る plan だけがある状態。off-plan の緩和は Scope 内に限り、インタプリタ書き込みの検査と tripwire は残る
  - **delegation-uses.log**: 委任で通した書き込みを、利用者に知らせた記録。重複して知らせないための状態でもある
```

- [ ] **Step 2: 課題 L を足す**

`docs/plans/workflow-guard-followups.md` の末尾に足す。

```markdown
## 課題 L: 承認行の値が空のとき、hash の正規化が次の行を落とす

ADR-0028 のレビュー中に報告され、2026-10-06 に再現を確かめた。

- 実測: `computeDocumentHash(content, SPEC_NORMALIZERS)` は、承認行が `- Approval Status:`（値なし）または空白だけのとき、その次の行を hash から落とす。次の行だけが違う 2 つの文書が、同じ hash になる。

  | 承認行                            | 次の行が `LINE-A` | 次の行が `LINE-B` |
  | --------------------------------- | ----------------- | ----------------- |
  | `- Approval Status: pending`      | `3ff5ee5089d0`    | `9345699391c4`    |
  | `- Approval Status:`              | `ddc8b939f327`    | `ddc8b939f327`    |
  | `- Approval Status: `（空白のみ） | `ddc8b939f327`    | `ddc8b939f327`    |

- 原因: `home/dot_claude/hooks/lib/document-hash.ts` の正規化 `c.replace(/^(- Approval Status:)\s*.*$/m, "$1")` で、`\s*` が改行に一致する。値が空だと行末の改行を越え、続く `.*` が次の行を取り込む。
- 推論（未実測）: 承認の迂回には使いにくい。承認が記録されると承認行に `approved` が入り、次の行が hash に戻るので、記録した hash と合わなくなって gate が閉じる。テンプレートどおりの文書では、承認行の次は空行と marker なので害が出ない。
- 確認: 承認行を書き換える側（`home/dot_claude/hooks/lib/workflow-marker.ts` の `setApprovalStatusLine`）の正規表現は `/^- Approval Status:.*$/m` で、`\s*` を含まない。値が空の文書を承認しても、次の行は消えない。次の行を落とすのは hash の正規化の側だけである。
- 修正の案: `\s*` を `[ \t]*` にする。
- 再訪のきっかけ: hash の正規化を変えると、承認済みの進行中の文書がすべて deny される。reference skill の「S3 デプロイ移行手順」を伴う作業になる。他の理由で正規化を変えるときに、合わせて直す。
```

- [ ] **Step 3: 検査する**

実行: `grep -c "^## 課題 " docs/plans/workflow-guard-followups.md`
期待: 変更前より 1 多い（変更前の値は、編集の前に同じコマンドで確かめる）。

実行: `bun run format:check`
期待: 終了コード 0。0 でなければ `bun run format` を実行する。

- [ ] **Step 4: コミット**

```bash
git add CONTEXT.md docs/plans/workflow-guard-followups.md
git commit -m "docs: add plan delegation vocabulary and file the Approval Status hash quirk"
```

### T6: 作業用の文書を docs/plans へ移す

**Files:**

- 新規作成: `docs/plans/plan-delegation/` の 6 ファイル
- 参照: `docs/plans/document-workflow-overhaul/README.md`（凍結コピーの注記の先例）

`.tmp/sessions/` は 7 日で消える。
ADR-0028 が「設計の全文」として指す文書を、消えない場所に置く。

- [ ] **Step 1: コピーする**

コピー元は、メインの checkout の workflow dir である。
パスは変数にせず、そのまま書く。

```bash
mkdir -p docs/plans/plan-delegation
cp /home/berlysia/.local/share/chezmoi/.tmp/sessions/bf699e4a/research.md docs/plans/plan-delegation/research.md
cp /home/berlysia/.local/share/chezmoi/.tmp/sessions/bf699e4a/spec.md docs/plans/plan-delegation/spec.md
cp /home/berlysia/.local/share/chezmoi/.tmp/sessions/bf699e4a/plan-1.md docs/plans/plan-delegation/plan-1.md
cp /home/berlysia/.local/share/chezmoi/.tmp/sessions/bf699e4a/plan-2.md docs/plans/plan-delegation/plan-2.md
cp /home/berlysia/.local/share/chezmoi/.tmp/sessions/bf699e4a/plan-3.md docs/plans/plan-delegation/plan-3.md
```

コピーした文書の本文は直さない。

- [ ] **Step 2: README.md を書く**

`docs/plans/plan-delegation/README.md` を次の内容で書く。

```markdown
# plan-N の承認の委任 (2026-10-06)

人間が spec の承認時に選ぶと、spec の `## Scope` に収まる plan-N が個別の承認なしで実装へ進むようにした変更の記録。設計判断は `docs/decisions/0028-plan-delegation.md`。

- `research.md` — 承認機構の現状、直近 7 日の承認記録の集計、3 つの場面（plan-N の事前委任、改訂後の再承認、離席中の先行）の調査
- `spec.md` — 設計判断 K1 から K9、Risks、レビュー 3 ラウンドの Reviewer Outputs。K の番号は ADR-0028 のものと途中からずれる（対応は ADR の「spec からの差」）
- `plan-1.md` — 承認記録の `delegate`、`## Scope` の照合、保護対象、gate の `classifyPlan`
- `plan-2.md` — 承認の質問の 2 問目、通知、tripwire。「spec との関係」に、spec より厳しくした点と spec に無い決定がある
- `plan-3.md` — ADR-0028 と文書の更新

状態: 実装済み。ブランチは `feat/plan-delegation`。

注記: ここに置いた spec と plan は `.tmp/sessions/bf699e4a` からの凍結コピーで、`## Approval` と `<!-- auto-review -->` marker は承認時点の値である。整形で本文が変わると、marker の hash は現在の本文と一致しなくなる。ゲート判定に使われる文書ではない（workflow dir の外）。

今回着手しなかった場面（改訂後の再承認の省略、離席中の先行）の調査は `research.md` に残っている。
```

- [ ] **Step 3: 検査する**

実行: `ls docs/plans/plan-delegation/`
期待: `README.md`、`plan-1.md`、`plan-2.md`、`plan-3.md`、`research.md`、`spec.md` の 6 つ。それ以外のファイル（`plan-review.cache.json` など）があれば、コミットに含めず、ファイル名を完了報告に書く。

実行: `bun run format:check`
期待: 終了コード 0。0 でなければ `bun run format` を実行する。整形で凍結コピーの本文が変わるのは、README の注記のとおり許容する。

- [ ] **Step 4: コミット**

```bash
git add docs/plans/plan-delegation/README.md docs/plans/plan-delegation/research.md docs/plans/plan-delegation/spec.md docs/plans/plan-delegation/plan-1.md docs/plans/plan-delegation/plan-2.md docs/plans/plan-delegation/plan-3.md
git commit -m "docs(plans): keep the plan delegation research, spec and plans"
```

### T7: 全体の検査

**Files:**

- 参照: リポジトリ直下の `package.json` の `scripts`（`format`、`test`、`typecheck`、`lint`）

- [ ] **Step 1: 全テスト、型検査、lint を実行する**

実行: `bun run test`、`bun run typecheck`、`bun run lint`
期待: 3 つとも終了コード 0。`bun run test` の集計は、plan-2 の完了時（tests 3510、fail 0）から fail が増えていない。

- [ ] **Step 2: 配置される文書に、書けない文字列が無いことを確かめる**

実行: `grep -nE 'ADR-[0-9]{4}|docs/decisions/[0-9]{4}|home/dot_claude/|\.skills/' home/dot_claude/rules/workflow.md home/dot_claude/rules/autonomous-lane.md home/dot_claude/templates/spec.md .skills/document-workflow-reference/SKILL.md`
期待: この plan が足した行は出ない。既存の行が出た場合は、変更前（`git show 141c24e:<パス>`）にもある行であることを確かめる。

## ISO 25010 具体テストケース

spec の「ISO 25010 次元選択」のうち、文書に関わるのは機能適合性と使用性である。
セキュリティと信頼性は、plan-1 と plan-2 のテストが受け持つ。

### 機能適合性

文書の記述が、実装済みのコードと一致すること。

- **入力**: `home/dot_claude/templates/spec.md` を `parseScope` に渡す → **期待**: `{"valid":false,"reason":"invalid-entry"}`（T4）
- **入力**: `home/dot_claude/rules/workflow.md` のバイト数 → **期待**: 12288 以下（T3）
- **入力**: 配置される 4 つの文書を、書けない文字列の正規表現で検索 → **期待**: この plan が足した行は 0 件（T7）
- **入力**: SKILL.md の「委任」の節の制限（16 行、120 文字、文字の種類、要素の形）と、`lib/workflow-files.ts` の `MAX_SCOPE_ENTRIES`、`MAX_SCOPE_ENTRY_LENGTH`、`SCOPE_ENTRY_PATTERN`、`unsafe` → **期待**: 値と条件が一致する（T4。実装者が定数を読んで照合し、違いがあれば文書を定数に合わせて完了報告に書く）
- **入力**: SKILL.md と ADR-0028 の保護対象の一覧と、`lib/workflow-files.ts` の `PROTECTED_LEADING`、`PROTECTED_DIR_NAMES`、`PROTECTED_FILE_NAMES` → **期待**: 項目が一致する（T1、T4。同上）

### 使用性

読み手が、委任の条件と取り消し方を、手順書から見つけられること。

- **入力**: `rules/workflow.md` の二層モードの節 → **期待**: 「委任」の項目があり、reference skill の節の名前（「委任」）を指している（T3）
- **入力**: SKILL.md の `## 委任` の節 → **期待**: 通る条件、Scope の書き方、保護対象、選び方、委任だけの実装フェーズ、知らせ方、取り消し、同じファイルを複数の plan が挙げた場合、の 8 つの段落がある（T4）
- **入力**: `docs/decisions/0028-plan-delegation.md` → **期待**: `- **K` で始まる決定が 10 個ある（T1）
- **入力**: `docs/plans/plan-delegation/` → **期待**: 6 ファイルがあり、README.md に凍結コピーの注記がある（T6）

### 対象外

- **セキュリティ、信頼性**: この plan はコードを変えない。委任の成立条件と、失敗時に閉じる側へ倒れることは、plan-1 と plan-2 のテストが確かめている。
- **性能効率性、移植性**: 文書の変更で、実行時の挙動は変わらない。

## Approval

- Plan Status: complete
- Review Status: pass
- Approval Status: approved

## Reviewer Outputs (Round 1)

### logic-validator

- verdict: pass
- 主指摘: 計画の文が実装済みのコードと食い違う箇所は無く、書かれた検査も通る。委任が有効になる条件に「Scope が有効」が抜けている。テンプレートを Edit すると、同じ dir に hook のキャッシュが未追跡で残る。

### scope-justification-reviewer

- verdict: needs-work
- 主指摘: ADR の K の番号が spec とずれているのに対応が無い。spec の Risks の一部（plan-N ごとの取り消しなし、混在時の off-plan）が ADR に無い。同じ制限を 4 か所に書いていて、直す先が決まっていない。README のコミットの一覧が一意に埋まらない。

<!-- auto-review: pending -->
<!-- intent-triage: pending -->

<!-- parent-spec-hash は plan-review-automation hook が auto-review marker 生成時に挿入する。手で編集しない。 -->

## Reviewer Outputs (Round 2)

### logic-validator

- verdict: pass
- 主指摘: Round 1 の指摘は解消。足した文は実装済みのコードと合う。ADR の Consequences の「警告で通る」に、保護対象のパスも含むと書くと正確になる（反映済み）。

### scope-justification-reviewer

- verdict: pass
- 主指摘: Round 1 の 5 点は解消。番号の対応は正しい。文書の役割の分け方は妥当で、SKILL.md に数値を残すのは規約に反しない。ADR の References がブランチ名を指す点は軽微（先例に合わせて注記した）。

<!-- auto-review: verdict=needs-work; hash=1f8029112890c174a7515d6973f801f682e86dc81fd8b500af4d87fac5abb05b; design-hash=97c14e076b70775235a79ed28a729f4a37b841d8958673821c510b93bb1fecbd; round=1; parent-spec-hash=aa725fce432b4962f1355381f0f885195b9f804a337aab50d3254fe8a89b2c95; at=2026-10-06T06:01:43.558Z; reviewers=logic-validator+scope-justification-reviewer -->

<!-- auto-review: verdict=pass; hash=ed27fce68d1f2e53ad901a8cc390baf443428b7723d178a6e30ea1af89e065b4; design-hash=b35f81cd21bd24bfd3491c2a6bace8014b1b2fbd58bc05090fcc5b341b8b101d; round=2; parent-spec-hash=aa725fce432b4962f1355381f0f885195b9f804a337aab50d3254fe8a89b2c95; at=2026-10-06T06:04:35.135Z; reviewers=logic-validator+scope-justification-reviewer -->
<!-- intent-triage: adopted=17; excluded=0; at=2026-10-06T06:04:35.156Z -->
