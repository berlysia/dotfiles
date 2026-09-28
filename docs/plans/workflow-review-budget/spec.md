# Spec: Document Workflow 検証フェーズの強度を緩める（ラウンド上限の機構化・prose 変更での追加レビュアー停止）

## Goal

Document Workflow の手順（round / stamp / triage / Executive Summary / 人間承認）を保ったまま、歩留まりの低いレビューを機構で止める。対象は (a) R4 以降の確認ラウンド、(b) コードを触らない変更へのコード品質系の追加レビュアー。1 ラウンドあたりの必須レビュアー構成と再実行規則は変えない。

## Experience Delta

- 変更前: R3 で決着しなくても `workflow-cli round` が R4・R5 を受け付け、確認だけのラウンドが続く（9 文書中 3 文書が R4 以降、R4 以降の新規指摘 0/4）。markdown の skill を 1 ファイル直す plan にも architecture / security / resilience が推奨される
- 変更後: R3 を終えた文書に `round` を打つと拒否され、人間に判断を仰ぐ（人間の指示があれば `--extend --reason "<指示内容>"` で続行し、その記録が残る）。`## Files` が prose だけの plan では追加レビュアーを推奨しない

## Architecture

変更は review 判定の共通層（`lib/workflow-review-core.ts`）と CLI（`cli/workflow.ts`）に閉じる。推奨（`buildRecommendation`）と round 骨格（`cmdRound`）が同じ判定関数を呼ぶ既存構造（ADR-0015 Amendment 2026-09-24）に乗せる。

```
plan.md / plan-N.md ──parseFilesPaths()──► isProseOnlyChange()
                                               │ true → 追加レビュアー 0（推奨文に理由 1 行）
                                               ▼ false / Files 無し（spec.md を含む）
                                         selectReviewers()（キーワード、既存のまま）
cmdRound() ── currentRound >= 3 → 拒否
              --extend --reason <text> → 許可し <wfDir>/round-extensions.log に追記
```

- `parseFilesPaths`: guard の `parseFilesSection`（`implementations/document-workflow-guard.ts:501`）から「`## Files` の fenced code block を行ごとに読み、書式違反の block は捨てる」部分を lib に切り出す。guard は切り出した関数の結果に既存の realpath 解決を掛ける。review 選定と guard が「Files に何が載っているか」で食い違わないよう、パーサを 1 本にする

## Alternative Approaches (Greenfield View)

### 差分最小案 (Incremental)

推奨文の文言だけを強める（「Round 4 を絶対に始めない」「prose なら追加レビュアーを省略してよい」）。コード変更は文言のみ。

→ 不採用。R3 で止める文言は既にあり（`lib/workflow-review-core.ts:588-592`）、それでも 3 文書が R4 以降に進んだ。ADR-0015 は同種の prompt 統制が守られない事例（P1〜P8）から「帳簿と検知を機構に移す」と決めており、その教訓に反する。

### 白紙設計案 (Greenfield)

ゼロから設計するなら、レビュー強度を「変更の種類」から決める。文書に `Change Kind: prose | code | design` のような宣言を持たせ、種類ごとにレビュアー集合とラウンド予算を表で引く。起源: レビューの価値は「何を変えるか」で決まり、ラウンド数や本文のキーワードは代理指標にすぎない。

→ 部分採用。「変更の種類で集合を決める」は採り、種類の判定は宣言ではなく既存の `## Files`（テンプレートで必須、guard が既にパース）から導く。宣言行を足すと、モデルが書き忘れる・誤申告する経路が増える（ADR-0015 の帳簿を手作業に載せない方針）。ラウンド予算の種類別化は採らない。観測した R4 以降のゼロ歩留まりは種類を問わず出ており、一律 3 で足りる。

### 採用案と理由

白紙案の「変更対象から強度を決める」をハイブリッドで採用する。判定入力は既存の `## Files`、ラウンド上限は一律 3 を CLI で強制する。根拠: `## Files` は plan.md / plan-N.md のテンプレート（`home/dot_claude/templates/plan-execution.md:8-24`）で必須かつ guard の enforce 対象なので、欠落時は既に実装がブロックされる。新しい宣言より書き忘れにくい。

## Key Decisions

- **K1: ラウンド上限を CLI で強制する（レビュー 1 周あたり 3 ラウンド）** — `workflow-cli stamp` が書く auto-review marker に `round=<N>`（stamp 時点の `## Reviewer Outputs (Round N)` 数）を足す。`cmdRound` は「現在のラウンド数 − 最後に `verdict=pass` だった marker の `round` 値」を今回の周のラウンド数とし、これが 3 以上なら verdict を問わず非 0 終了で拒否する。pass marker が無い、または `round` フィールドの無い旧 marker しか無い場合は基準を 0 とする（文書の全ラウンドを数える保守側）。数え方をこうするのは 2 つの理由から: (1) marker の verdict だけを見ると、stamp を挟まずに `round` を重ねたとき古い pass で素通りする。基準になる pass marker は stamp（reviewer 台帳の検証つき）でしか作られないので、stamp なしの連打は周のラウンド数を増やすだけになる。(2) 文書の全生涯で累積すると、承認後の正当な再レビュー（spec 改訂で plan-N.md の parent-spec-hash がずれて再承認する経路、`rules/workflow.md` 二層モード節）まで塞ぐ。pass 後の再レビューは新しい周として 3 ラウンドの予算を持つ。拒否メッセージは「Executive Summary に未解決の指摘を載せて人間に方針を仰ぐ。人間が続行を指示した場合だけ `--extend --reason "<指示内容>"` で再実行」。`--extend` は空でない `--reason` を必須とし、許可時に `<wfDir>/round-extensions.log` へ `<ISO8601>\t<doc>\t<nextRound>\t<reason>` を 1 行追記し、stdout に `extended beyond round budget (3)` と書く。`--extend` は上限判定だけを外すもので、`--full` とは独立に併用できる（`--full` 有無による full / delta の判定は従来どおり）。3 は既存の推奨文の予算と同じ値で、観測（R3 の新規指摘 3/7、R4 以降 0/4）で R3 はまだ実益があるため下げない
  - 参照: `home/dot_claude/hooks/cli/workflow.ts:415-434`（`buildMarkerLine`、`round=` を足す箇所）
  - 参照: `home/dot_claude/hooks/lib/workflow-marker.ts:47-89`（`parseLatestAutoReviewMarker`。未知キーを無視するので `round=` 追加で既存の guard 判定は変わらない。最後の pass marker の `round` を返す関数を同ファイルに足す）
  - 参照: `home/dot_claude/hooks/cli/workflow.ts:261-278`（`cmdRound`、`currentRound` の算出）
  - 参照: `home/dot_claude/hooks/lib/document-hash.ts:127-135`（`countReviewerOutputsRounds`）
  - 参照: `home/dot_claude/hooks/lib/workflow-review-core.ts:588-592`（既存の文言上の予算。R3 到達時の文言を「`round` は拒否される。人間の指示があれば `--extend --reason`」に揃える）
- **K2: `## Files` が prose だけなら追加レビュアーを選ばない** — `listRecommendedReviewers` の full round 分岐で、`selectReviewers` の前に `isProseOnlyChange(content)` を評価する。`## Files` の fenced block から得たパスが 1 件以上あり、全件の拡張子（末尾の `.tmpl` は外して判定）が `.md` / `.mdx` / `.markdown` / `.txt` / `.rst` / `.adoc` のいずれかなら true。Files が無い・パースできたパスが 0 件なら false（既存のキーワード方式に戻る。spec.md は常にこちら）。必須レビュアー（SPEC_REVIEWERS / PLAN_REVIEWERS）と delta round の規則は変えない。true のとき推奨文に `Additional reviewers: skipped (all ## Files entries are prose). If this plan changes code, list those paths in ## Files.` を出す
  - 参照: `home/dot_claude/hooks/lib/workflow-review-core.ts:283-293`（`selectReviewers`）
  - 参照: `home/dot_claude/hooks/lib/workflow-review-core.ts:437-466`（`listRecommendedReviewers`、full round で追加分を足す箇所）
  - 参照: `home/dot_claude/hooks/implementations/document-workflow-guard.ts:501-545`（切り出す既存パーサ）
- **K3: 文書側を機構に揃える** — `home/dot_claude/rules/workflow.md` の step 5 に「R3 を終えた文書に `round` は打てない。続行は人間の指示で `--extend --reason`」「`## Files` が prose だけなら追加レビュアーは付かない」を各 1 行で足す。`.skills/document-workflow-reference/SKILL.md` の `workflow-cli` 仕様に `--extend` / `--reason` と `round-extensions.log` を足す。ADR-0015 に Amendment（2026-09-28）を足し、K1・K2 と観測値を記録する
  - 参照: `home/dot_claude/rules/workflow.md:36-38`（step 5.1 / 5.2）

## Risks

- **R1**: R3 で本当に未解決の設計問題が残っているのに止まる → 止まる先は人間の判断で、`--extend` で続行できる。止めるのは「人間に見せずに回り続けること」だけ
- **R2**: `--extend` をモデルが人間の指示なしに付ける → 指示元を機構では検証できない（ADR-0015 の Approval 行と同じく prompt 統制として受容）。代わりに `--reason` 必須と `round-extensions.log` で使用を事後に追えるようにする。再評価トリガー: log に人間の指示に対応しない reason が 1 件
- **R3**: `## Files` の書き漏れで、コードを触る plan が prose と判定される → 推奨文の 1 行で書き漏れの補正を促す。必須レビュアー（logic-validator ほか）は判定に関係なく走る。実装時は guard が Files に無いファイルへの書込を warn / 記録する（`document-workflow-guard.ts:166, 220`）
- **R4**: prose だけの変更でもセキュリティ上重要な文書がある（例: permission 設定を説明する rules、autonomous-lane charter）→ 必須 4 名は残る。追加レビュアーが必要なら operator が推奨外で Agent を起動することは妨げない
- **R5**: spec.md には `## Files` が無いので、二層モードで実体が prose だけでも spec 層ではキーワード選定で追加レビュアーが付きうる → 既知の限界として受容。spec 層は設計判断を扱い、コード関連語を含まない spec は稀。plan-N.md 側は K2 が効く
- **R6**: marker に `round=` を足すことで既存の marker 読み手が壊れる → marker は hash 計算前に除去される（`lib/document-hash.ts:64`）ので hash は動かない。`parseLatestAutoReviewMarker` は未知キーを読み飛ばす。既存テスト（`workflow-marker` / guard / cli）を無変更で通すことを受入条件にする
- **R7**: `parseFilesSection` の切り出しで guard の挙動が変わる → guard の既存テスト（`tests/unit/document-workflow-guard.test.ts`）を無変更で通すことを受入条件にする
- **R8**: 周の起点になる pass marker は `stamp --verdict pass` の自己申告で作れる（`cmdStamp` は reviewer の起動証跡だけを見て、各 `### <slug>` の verdict 行とは突き合わせない。同じラウンドへの再 stamp も通る）。偽の pass で周のカウンタが 0 に戻る → prompt 統制の限界として受容する。偽の pass は「レビューを打ち切って人間の承認に回す」方向に働き、ラウンドを回し続ける動機（pass を得たい）とは逆向きなので、上限が防ぎたい「人間に見せずに回り続ける」経路にはならない。承認は人間のみ（ADR-0001）で、偽 pass の文書は承認依頼の Executive Summary で人間の目に入る。再評価トリガー: Reviewer Outputs に非 pass が残るのに pass marker が付いた事例 1 件（そのときは `stamp --verdict pass` を必須レビュアーの verdict 行と突き合わせる機構を追加する）

## Phase 1 で意図的に提供しない体験 (任意)

### 追加レビュアーの blocker 時の再実行縮小

- **代替経路確認**: `home/dot_claude/hooks/lib/workflow-review-core.ts:370`（blocker → full）は据え置く。K1 の上限で、blocker が続いても R3 で人間の判断に回る（research R6 の 3 ラウンド連続 blocker は、K1 があれば R3 後に停止）
- **非提供対象**: 追加レビュアーの blocker で必須 4 名を再実行しない変更。1 ラウンドあたりのレビュアー数を減らす案で、ユーザーが選んだ「ラウンド数を減らす」と異なる軸
- **将来の予定**: K1 導入後も blocker 起因の full round がコストの主因として観測されたら再検討する

### 追加レビュアーのカタログ修正

- **代替経路確認**: `home/dot_claude/hooks/lib/workflow-review-core.ts:125-270` が未インストールの `compound-engineering:review:*` を参照している（research R5）。K2 により prose 変更ではこの参照が推奨に出なくなる
- **非提供対象**: カタログの slug をローカル agent に張り替える変更、および台帳の記録漏れの修正。本オーダー（検証コストの緩和）とは別の不具合で、ADR-0015 K9 の決定にも関わる
- **将来の予定**: 別の小さな変更として提案する（Executive Summary の Open Questions に記載）

## ISO 25010 次元選択

- **機能適合性（正確性）**: ラウンド拒否・`--extend` の記録・prose 判定が、仕様どおりの入力で仕様どおりの出力になること
- **保守性（修正性）**: Files パーサを 1 本化し、guard と review 選定の判定が食い違わないこと
- **対象外**: 性能効率性（判定は文書 1 本の文字列処理で、既存の hook 予算内）、セキュリティ（承認経路と guard の enforce 条件は変えない）、互換性（hash 正規化を変えない。K1・K2 は hash に関与しない。進行中の R4 以降の文書は `--extend` で続行できる）

## Approval

- Plan Status: complete
- Review Status: pass
- Approval Status: approved

## Reviewer Outputs (Round 1)

### logic-validator

- verdict: needs-work
- 主指摘: K1 は最新 marker の verdict で判定するが marker にラウンド番号が無く、stamp を挟まず `round` を重ねると古い pass で素通りする。K2 は Files の書き漏れで誤判定しうる。K3（カタログ張替え）は既存テスト 3 本を壊し Goal にも無い

### scope-justification-reviewer

- verdict: needs-work
- 主指摘: K1・K2・K4 は根拠あり。K3（カタログ張替え、performance / simplicity 除外）と ADR-0015 K9 の取り消しはオーダーに紐づかないスコープドリフト

### decision-quality-reviewer

- verdict: pass
- 主指摘: 支配軸の取り違えなし。`--extend` が機構化の看板の下で prompt 統制に留まる点は人間確認事項

### greenfield-perspective-reviewer

- verdict: needs-work
- 主指摘: K4 は 1 ラウンドの厚みを削る案でユーザーの選んだ軸とずれ、K1 だけで足りる。`--extend` の理由・指示元が構造化して残らない

<!-- auto-review: pending -->
<!-- intent-triage: pending -->

## Reviewer Outputs (Round 2)

### logic-validator

- verdict: needs-work
- 主指摘: 前回指摘は解消。新規: 全生涯の累積カウントは承認後の正当な再レビュー（parent-spec-hash ずれでの再承認）を塞ぐ。`--extend` と `--full` の併用可否が未定義

### scope-justification-reviewer

- verdict: pass
- 主指摘: 旧 K3 の切り出しでスコープドリフトは解消。parser 切り出し・round-extensions.log は K1/K2 に直結し妥当

### decision-quality-reviewer

- verdict: pass
- 主指摘: 支配軸と整合。`--reason` 必須化は prompt 統制の限界を事後追跡で受容する形で過不足なし

### greenfield-perspective-reviewer

- verdict: pass
- 主指摘: 前回指摘は解消。軽微: spec.md は prose 判定の対象外になる既知の限界を Risks に明記するとよい（R5 として反映）

<!-- auto-review: verdict=needs-work; hash=02b531621804002cc148ec80eb65132391f70a6ad8edc38a20d5e1c708bb635c; design-hash=011f37510e3f6e48e99be0888c0b259349e4a5aff01df5fa277f22e1bdad1055; at=2026-09-28T03:15:02.756Z; reviewers=logic-validator+scope-justification-reviewer+decision-quality-reviewer+greenfield-perspective-reviewer -->
<!-- intent-triage: adopted=7; excluded=0; at=2026-09-28T03:15:02.772Z -->

## Reviewer Outputs (Round 3)

### logic-validator

- verdict: needs-work
- 主指摘: Round 2 の (a) 累積カウント・(b) `--extend`/`--full` 併用は解消。新規: 周の起点の pass marker は `stamp --verdict pass` の自己申告で作れ（verdict 行と未突合、同一ラウンド再 stamp 可）、偽 pass でカウンタが戻る。機構で塞ぐか受容リスクとして明記を → R8 として明記し、人間が「A: 受容して進む」を選択（2026-09-28）。未解決指摘なし

### scope-justification-reviewer

- verdict: pass (carried from Round 2)
- 主指摘: Round 2 で pass、再実行なし

### decision-quality-reviewer

- verdict: pass (carried from Round 2)
- 主指摘: Round 2 で pass、再実行なし

### greenfield-perspective-reviewer

- verdict: pass (carried from Round 2)
- 主指摘: Round 2 で pass、再実行なし

<!-- auto-review: verdict=needs-work; hash=dd3496addb2fddc9876ce515d024415fee2b8a4d9e17947e43e2da1f51089523; design-hash=b842c117fd6318f79c583aa40c106bb1650d1e874727fa9bb1fe12eb92c441c9; at=2026-09-28T03:19:13.984Z; reviewers=logic-validator+scope-justification-reviewer+decision-quality-reviewer+greenfield-perspective-reviewer -->
<!-- intent-triage: adopted=4; excluded=0; at=2026-09-28T03:19:14.005Z -->

<!-- auto-review: verdict=needs-work; hash=d30a4525b37414f7b6904f8880d3e925955beb8f22240e7621a45d5871897033; design-hash=b842c117fd6318f79c583aa40c106bb1650d1e874727fa9bb1fe12eb92c441c9; at=2026-09-28T03:24:28.964Z; reviewers=logic-validator -->
<!-- intent-triage: adopted=1; excluded=0; at=2026-09-28T03:24:28.981Z -->

<!-- auto-review: verdict=pass; hash=566b3b7283def8b508e631c67fd5e68a199b5e67ad3af7514db7675fbc5992ae; design-hash=b842c117fd6318f79c583aa40c106bb1650d1e874727fa9bb1fe12eb92c441c9; at=2026-09-28T03:27:16.284Z; reviewers=logic-validator -->
