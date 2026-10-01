# Plan: ラウンド予算の自己延長（Round 6 まで）と、上限での reframer 判断（続行は Round 9 まで / 問題変形は人間へ）

## Goal

Document Workflow のレビューが 3 round で収束しないとき、着地見込みがあればモデルの判断で Round 6 まで続行できるようにする。6 round でも pass しなければ、問題の変形を選択肢に含めた検討を専用サブエージェント `review-reframer`（エージェント定義で上位モデル Fable を指定）に任せる。reframer が現在の枠組みのままの続行を推奨すれば Round 9 まで延長してよく、変形・現状承認・取り下げを推奨した場合と Round 9 でも着地しない場合は、その結果を添えて人間に判断を仰ぐ。

モデル名はエージェント定義の frontmatter にだけ書き、Agent tool の引数・CLI のフラグ・承認者名・定数には書かない（ユーザー指示）。モデルを差し替えるときに直すのは 1 行だけになる。

## Key Decisions

### K1: 閾値を 3 段にし、段階判定と許可表を core の純粋関数に集約する

`ROUND_BUDGET = 3` を維持し、`ROUND_SELF_CAP = 6`（モデル判断での自己延長の上限）と `ROUND_REFRAMER_CAP = 9`（reframer 判断での延長の上限）を追加する。9 は予算と同じ 3 round 刻みに合わせた設計上の値で、ユーザーが指定した値でも収束分析に基づく値でもない（再評価トリガーで見直す。承認依頼の Open Questions にも書く）。判定対象は周内の round 数 `roundsInCycle`（= 現在の `## Reviewer Outputs (Round N)` 数 − 最後の pass marker の `round=`。pass marker が無ければ現在の Round 数そのもの）。

`lib/workflow-review-core.ts` に次を置き、CLI の拒否と `buildRecommendation` の通知の両方がこれだけを使う（片方だけ直して乖離する経路を消す）:

- `type RoundBudgetPhase = "open" | "self-extendable" | "reframer-review" | "human-only"`
- `type ExtensionApprover = "human" | "self" | "reframer"`
- `getRoundBudgetPhase(roundsInCycle: number): RoundBudgetPhase` — `< ROUND_BUDGET` → open、`< ROUND_SELF_CAP` → self-extendable、`< ROUND_REFRAMER_CAP` → reframer-review、それ以外 → human-only
- `getRoundsInCycle(content: string): number` — `Math.max(0, countReviewerOutputsRounds(content) - lastPassMarkerRound(content))`。CLI と通知が同じ入力の算出を使う（pass marker の `round=` が見出し数を超える異常値は 0 に丸め、open 側に倒す。現行 CLI の差分計算と同じく、異常値で延長を拒否する方向には倒さない）
- `bareSlug(subagentType: string): string` と `isRecordedAgentSlug(subagentType: string): boolean` — 現在 `reviewer-run-recorder.ts:55` と `cli/workflow.ts:367` に private で重複している `bareSlug` を core に移して export し、両者が import する。`isRecordedAgentSlug` は「reviewer のロースターの slug か `REFRAMER_AGENT`」で、台帳に記録される名前の定義を core の 1 か所にする。ロースター由来の集合 `REVIEWER_SLUGS` も core に移し、`reviewer-run-recorder.ts` は既存テスト（`reviewer-run-recorder.test.ts:8,22-27`）のために core から re-export するだけにする
- `isExtensionAllowed(phase: RoundBudgetPhase, approver: ExtensionApprover): boolean` — 下表の許可表そのもの。CLI は承認者を引数にこれを呼ぶだけにし、許可表を CLI に書かない
- `formatRoundBudgetHeadline(phase: Exclude<RoundBudgetPhase, "open">): string` — `Round budget reached (3)` / `Round self cap reached (6)` / `Round reframer cap reached (9)`。CLI の拒否文と通知が同じ見出しを使う
- `formatRoundBudgetGuidance(phase: Exclude<RoundBudgetPhase, "open">, docName: string): string` — K3 / K4 の案内文（K4 の記録ファイル名を含めるため文書名を受け取る）
- `sanitizeExtensionReason(reason: string): string` と `formatExtensionLogLine(entry: { at: Date; doc: string; round: number; approver: ExtensionApprover; reason: string }): string` — K2 のサニタイズと列順を持つ純粋関数。CLI は空判定に前者を、追記に後者を使う
- `getReframerReviewFileName(docName: string): string` — `reframer-review.${docName}`（例: `reframer-review.plan.md`）
- `parseLatestReframerReview(content: string): { round: number; agent: string; recommendation: string } | null` — K4 の記録ファイルのうち最後の `## Reframer Review (Round N)` 節を読む。節の本文は次の `## ` 行で終わる。`- agent:` / `- recommendation:` は行頭一致で読み、どちらかが欠ける、またはどちらかが節内に 2 行以上あれば null を返す（`- rejected:` などの本文に `- recommendation: (a)` を紛れ込ませて推奨を偽装する経路を塞ぐ）
- `REFRAMER_AGENT = "review-reframer"`（エージェント名。モデル名ではない）

| roundsInCycle（周内の round 数） | phase           | 素の `round`                | `--self-extend`         | `--reframer-extend`                              | `--extend`（人間の指示） |
| -------------------------------- | --------------- | --------------------------- | ----------------------- | ------------------------------------------------ | ------------------------ |
| 0〜2                             | open            | 可                          | 可（log・延長表示なし） | 可（log・延長表示なし）                          | 可（log・延長表示なし）  |
| 3〜5（Round 4〜6 を作る）        | self-extendable | 拒否（予算文言）            | 可（log に `self`）     | 拒否                                             | 可（log に `human`）     |
| 6〜8（Round 7〜9 を作る）        | reframer-review | 拒否（reframer 検討の文言） | 拒否                    | 可（log に `reframer`、K2 の 5・6 を満たすとき） | 可（log に `human`）     |
| 9 以上                           | human-only      | 拒否（人間判断の文言）      | 拒否                    | 拒否                                             | 可（log に `human`）     |

どのフラグも `--reason` 必須。人間の `--extend` には上限を設けない（オーダーは人間の判断に上限を求めていない）。

### K2: 延長は承認者ごとに別フラグにし、log に承認者を記録する

`--extend` は「人間の指示」という意味のまま残す。ADR-0015 の再評価トリガー（「人間の指示に対応しない reason が log に 1 件出たら再評価」）はこの意味に依存しており、モデルや reframer の判断で同じフラグを使うとトリガーが雑音になる。

- 新フラグ `--self-extend`（モデル判断）と `--reframer-extend`（reframer の (a) 推奨に基づく判断）。いずれも boolean
- 引数検査の順序（先に当たったものを返す）: 0. 文書名が `basename(docName) === docName` かつ `.md` で終わる、を満たさなければ拒否（`../plan.md` や `sub/plan.md` で記録ファイルの場所が wfDir の外に出ること、log の doc 列の表記が割れることを防ぐ。延長フラグの有無にかかわらず `round` 全体に適用）
  1. `--extend` / `--self-extend` / `--reframer-extend` のうち 2 つ以上 → 拒否（どの承認かが曖昧になる）
  2. `--self-extend` または `--reframer-extend` と `--full` の同時指定 → 拒否（K3 条件 2 を CLI で見える形にする。Key Decisions を変える修正はモデル / reframer 判断の範囲外で、人間の `--extend` に回す）
  3. 延長フラグで reason が `sanitizeExtensionReason` の後に空 → 拒否
  4. phase による判定（`isExtensionAllowed`。拒否文は `formatRoundBudgetHeadline(phase)` と `formatRoundBudgetGuidance(phase, docName)`）
  5. `--reframer-extend` かつ phase が reframer-review のときだけ（open では延長自体が不要なので、記録なしで素の `round` と同じく通す）、記録ファイル `<wfDir>/getReframerReviewFileName(docName)` を `parseLatestReframerReview` で読み（最後の節の N を `reviewRound` とする）、次の全てを満たさなければ満たさなかった条件を名指しして拒否する:
     - 記録ファイルと節が存在する
     - `reviewRound === lastPassMarkerRound + ROUND_SELF_CAP`（今の周で、Round 6 の結果が出た直後の相談。周内の相談を 1 回に固定し、後の round を名乗る節を足して通り直す経路を塞ぐ）
     - `agent` の値が `REFRAMER_AGENT` と完全一致（trim 後）
     - `recommendation` の値が `(a)` と完全一致（trim 後。`(a) 続行` のような付随テキストは不一致として拒否し、書式を固定する）
  6. 5 と同じ条件のときだけ、reframer の起動記録を検査する。`.round-baseline` の Round `reviewRound` の時刻を `readRoundBaselineTime` で得て、`readLedgerSlugsAtOrAfter` でその時刻以降に `review-reframer` の行があるかを見る。baseline が無ければ「baseline missing」、行が無ければ「no review-reframer run recorded」と区別して拒否する（baseline が書けなかった場合は fail-safe に拒否側へ倒れる）。記録は `reviewer-run-recorder` が行う（K4）
- `sanitizeExtensionReason`: 制御文字と行区切り（U+0000〜U+001F、U+007F〜U+009F、U+2028、U+2029）を空白 1 つに置換し、前後の空白を除き、500 文字で切り詰める。reason はモデルが生成し、文書由来の文字列を含みうるため、列の偽装や偽の行の注入を防ぐ。守るのは「1 行・5 列」という形式だけで、承認者列の真正性ではない（下記「受容した限界」）
- `round-extensions.log` の形式: `<ISO8601>\t<doc>\t<round>\t<human|self|reframer>\t<reason>`（`formatExtensionLogLine`）。承認者列は reason より前に置く。この変更より前の 4 列の行は承認者列が無く、`human` 扱いで読む（読み手は人間と grep だけで、互換コードは作らない）
- stdout（phase が open のときは出さない。数値は定数から組み立てる）:
  - `--self-extend`: `self-extended beyond round budget (${ROUND_BUDGET}); self cap ${ROUND_SELF_CAP}`
  - `--reframer-extend`: `reframer-extended beyond self cap (${ROUND_SELF_CAP}); reframer cap ${ROUND_REFRAMER_CAP}`
  - `--extend`: 既存の `extended beyond round budget (${ROUND_BUDGET})`
- Approval 行の保護は既存の `wouldTouchApprovalStatus` 検査（`cli/workflow.ts` の round 内）がそのまま効く。新フラグはこの検査の前で分岐を終えず、挿入内容も変えない
- 検査はここで止める（greenfield Round 5 指摘）。推奨の書き換えのように CLI で閉じられない穴は受容した限界に書き、機構の追加は再評価トリガーが発火してから検討する

### K3: 「着地見込み」はプロンプト上の判定基準として定義し、機械判定しない（`--full` 併用拒否を除く）

モデルが自己延長してよい条件（全て満たす）:

1. 直近の埋まった round の reviewer verdict 行に `blocker` が無い（`planRoundReviewers` が full に戻す条件と同じ行を見る）
2. 残る指摘が Key Decisions / 白紙案を変えずに直せる（直すと `--full` が要るなら満たさない。CLI は `--self-extend --full` を拒否する）
3. 残る指摘が前 round より狭まっている: 非 pass reviewer 数が減った、または数が同じでも指摘の中身が局所化している（同じ指摘の再発ではない）

非 pass 数は目安であり、最終判断は条件 2・3 の内容評価で行う。数を判定条件にしない理由は Alternatives 案 B。

`--self-extend` の reason には「非 pass 数の推移 N→M と、残る指摘の要約」を書く（例: `non-pass 3→1; remaining: T2 の境界値を具体化`）。条件を満たさなければ自己延長せず、Round 6 を待たずに Executive Summary で人間に仰ぐ（現行と同じ）。

延長した周では、Executive Summary の Review Status に承認者ごとの延長回数を書く（例: `pass / Round 8（self-extended 3, reframer-extended 2）`）。人間が延長の事実を承認依頼の時点で見られるようにする。

### K4: Round 6 で着地しなければ reframer に選択肢を検討させ、続行だけは reframer の判断で Round 9 まで進める

**エージェント定義**: `home/dot_claude/agents/review-reframer.md` を新設する。frontmatter は `name: review-reframer`、`tools: Read, Glob, Grep`、`model: fable`。モデル名が現れるのはこの 1 行だけで、Agent tool の呼び出しは `subagent_type: review-reframer` のみを渡し `model` 引数を書かない。reframer は reviewer ではないので、reviewer のロースター（`SPEC_REVIEWERS` / `PLAN_REVIEWERS` / `REVIEWER_CATALOG`）には入れない。

- Fable を当てる理由の主軸はユーザー指示（「行き詰まったら Fable で検討させるとよいかもね」「Fable が判断するならさらにセルフエクステンドを選んでも良いかもね」）。行き詰まりの原因はモデルの能力より文書の枠組みにあることが多く、最も効くのは 6 round 分の修正に引きずられていない新しいコンテキストで見直させることで、サブエージェントにするのはこのため。そこに上位 tier を当てるのは、`model-offloading.md` の表で難所を上位 tier に回す考え方に沿う。上位モデルが必要だという主張は未検証で、再評価トリガーで観測する
- 本文（エージェントへの指示）: 入力として受け取るもの（対象文書のパス、全 round の非 pass 指摘の要約 — どの指摘が round をまたいで残ったか / 再発したか）と、下記 3 の出力要件、「採否は人間またはメインループが決める。自分は推奨だけを返す」

**発火**: phase が reframer-review に入り、Round 6 の結果が stamp 済みで pass でないとき、CLI の拒否文と通知の両方（`formatRoundBudgetGuidance("reframer-review", docName)`）で次を指示する。

通知（`buildRecommendation`）は、最新 auto-review marker の `round=` が `## Reviewer Outputs` 見出し数と一致する（= 最新 round が stamp 済み）ときだけ段階の案内を出す。`round` が空の骨格を挿入した直後は、前 round の古い結果で reframer 相談を促さないためである。`round=` の無い旧 marker は一致扱いにする（従来どおり案内を出す）。CLI の拒否は次の `round` 呼び出しで起きるので、この条件は要らない。

1. 周内でまだ相談していなければ、Agent tool で `subagent_type: review-reframer` を 1 つ起動する。起動できなければ、結果なしとして Open Questions に書き人間に仰ぐ（代わりのエージェントやモデルで代替しない。代替すると「reframer の判断」という延長条件の意味が変わるため）
2. 入力: 対象文書のパスと、全 round の非 pass 指摘の要約
3. 出力要件（エージェント定義の本文に書く）:
   - 収束しない原因の仮説（再発した指摘と、その根にある Key Decision / 前提）
   - 次の 4 択それぞれの利点・欠点と推奨 1 つ
     - (a) 現在の枠組みのまま続行。推奨する場合は、K3 の 3 条件に照らした着地見込みと、Round 9 までに着地させるための修正方針を書く
     - (b) 問題を変形する: `/scope-guard` による分解 / spec + plan-N への分割 / ゴール・制約・Key Decision の再定義。**この文書に固有の変形案を最低 1 つ、再発指摘との対応付きで示す**。(b) を推奨する場合は新しい Key Decisions の骨子まで書く
     - (c) 既知の未解決指摘を明記して現状で承認に回す
     - (d) 取り下げ
4. 記録: メインループは reframer の結果を、推奨にかかわらず記録ファイル `<wfDir>/reframer-review.<docName>`（例: `reframer-review.plan.md`）の末尾に節として足す（N は相談時点の最新 stamp 済み round）。ファイルが無ければ Write で作り、あれば Edit で末尾に足す（Write は全置換なので既存の節を消さないため）。各フィールドは 1 行で書く。対象文書には書かないので、文書の hash / design-hash は変わらない。記録ファイルは `getWorkflowDocumentType` で文書種別にならず（`spec.md` / `plan.md` / `plan-N.md` のいずれでもない）、自動レビューの対象にもならない。guard は wfDir 配下の `.md` への書き込みを承認前でも許す（`document-workflow-guard.ts` `isDocumentPath`）。節の本文に `## ` で始まる行を書かない（次の節の見出しと区別するため）
   ```
   ## Reframer Review (Round N)
   - agent: review-reframer
   - recommendation: <(a)|(b)|(c)|(d)>
   - rejected: <推奨以外の 3 択を退けた理由>
   - hypothesis: <収束しない原因の仮説>
   - plan: <(a) なら Round 9 までの修正方針 / (b) なら変形案と新 Key Decisions の骨子>
   ```
5. 推奨による分岐:
   - (a) のとき: メインループは `--reframer-extend --reason "reframer: (a) <着地見込みの要約>; rejected: <(b)〜(d) を退けた理由の要約>"` で Round 9 まで続行してよい。人間には聞かない。承認依頼の Executive Summary に、延長回数・記録ファイルのパス・節の要約を必ず載せる（人間が reframer の判断に気づける経路はここだけなので必須）
   - (b)(c)(d) のとき: 結果を Executive Summary の Open Questions に載せて人間の判断を待つ。変形はスコープやゴールを動かし、(c) は承認に関わり、(d) はオーダーを取り下げるので、いずれもメインループも reframer も自分では選ばない。「(b) の採否は人間が決める設計」であることを Open Questions に 1 行添える
6. 相談は周内で 1 回（CLI も K2 の 5 で節の round を周の入り口に固定する）。Round 7〜8 が pass しなくても再相談せず、reframer の修正方針に沿って続ける。通知は reframer-review の間は毎 round 出るため、案内文に「記録ファイルに今の周の節があれば do not relaunch」を含める

phase が human-only（Round 9 が埋まっても pass しない）のとき、`formatRoundBudgetGuidance("human-only", docName)` は次を指示する: 記録ファイルの節の要約と Round 7〜9 の経過を Executive Summary に載せて人間に仰ぐ。続行は人間の `--extend --reason` だけ。reframer を再起動しない。

**起動の記録**: `reviewer-run-recorder`（PostToolUse `Agent`）の記録判定を core の `isRecordedAgentSlug(subagentType)` に置き換える（`REVIEWER_SLUGS` と同じく名前空間を外して照合）。stamp の必須 reviewer 照合は必須 slug の有無だけを見るので、台帳に `review-reframer` 行が増えても影響しない。

## Alternatives (Greenfield View)

- **案 A（差分最小）**: `ROUND_BUDGET` を 9 に上げ、文言だけ「3 以降は着地見込みがあるとき、6 以降は reframer に聞いてから」とする。変更は定数 1 つと文書だけ。ただし Round 4〜9 が素の `round` で通り、延長した事実も、誰の判断かも残らない。ADR-0015 が「文言だけの予算は 3/9 文書で破られた」と観測した形に戻る
- **案 B（白紙設計）**: 予算を round 数でなく収束度で決める。各 round の非 pass 数・blocker 有無を CLI が数え、改善が止まった時点で自動的に止める。ゼロから作るなら「止める理由」を直接測るこちらが自然、というのが起源。しかし verdict の数は収束の計器として粗い（1→1 でも中身は着地寸前のことがある。delta round は非 pass だけを再実行するので数は構造的に減りやすい）。計器が測る量と「着地見込み」が一致しない。K3 が非 pass 数を目安にとどめ、判定条件にしないのも同じ理由
- **案 C（中間: blocker のみ機械拒否）**: K3 の条件 1 だけ CLI で判定する。blocker は既に `planRoundReviewers` が full に戻す条件として検出している。ただし blocker は「設計を戻す必要」であって「着地しない」とは別で、1 箇所の直しで解ける blocker もある。ADR-0015 は延長の是非を prompt 統制に置いている。一方、延長フラグと `--full` の併用拒否はフラグの組み合わせだけで判定でき計器の妥当性を問わないため、K2 で採る
- **案 D（reframer 判断の延長に上限を設けない）**: reframer が (a) を推奨する限り、再相談しながら延長を続ける。ユーザーの「Fable が判断するなら」を最も広く取る案。却下理由は上限の有無: 上限が無いと、モデル / reframer 判断だけで回り続ける round 数に歯止めが無くなる。ADR-0015 が予算で塞いだのはこの無制限の経路である。採用案も Round 4〜9 の最大 6 round は人間抜きで進むが、CLI はモデル / reframer 判断のフラグを Round 10 以降拒否する（ただし `--extend` はモデルも打てるので、Round 10 以降が人間の判断であることは機械的には保証されない。受容した限界 2）
- **案 E（Agent tool の `model` 引数でモデルを指定する）**: エージェント定義を作らず、`general-purpose` に `model` 引数を渡す。ファイルが 1 つ減る。ユーザー指示（ツールの引数にモデル名を書かない）に反し、モデル名が CLI の案内文・定数・テストに散る。既存の reviewer エージェントは全て frontmatter の `model:` でモデルを決めており（`home/dot_claude/agents/*.md`）、同じ置き場に揃える
- **案 F（reframer の結果を対象文書の中に節として書く）**: Round 4〜5 で一度採った形。人間が承認対象の文書の中で直接読める。しかし節を stamp 後に足すと文書 hash が変わるため `lib/document-hash.ts` の正規化に節の除去を足す必要があり、除去の終端条件（後続の `## Reviewer Outputs` との並び）や fenced code 内の見出しの誤検出という、hash の中核に新しい境界問題を持ち込む（Round 5 logic-validator 指摘）。記録ファイルに分ければ hash 系は変更不要で、人間は Executive Summary の必須記載（パスと要約）から辿れる。既存の帳簿（`reviewer-runs.log` / `round-extensions.log` / `.round-baseline`）も全て文書外の wfDir にある
- **採用: 3 段閾値 + core の純粋関数群 + 承認者別フラグ + 判定基準は prompt + reframer はエージェント定義 + 結果は wfDir の記録ファイル（K1〜K4）**。理由: (1) 延長の事実と承認者が `self` / `reframer` として log に残り、既存の再評価トリガーを壊さない（案 A はこれを失う）。(2) Round 10 以降は `--extend` 以外を CLI が拒否するので、モデル / reframer 判断のフラグによる延長は有限（案 D はこれを失う。`--extend` の人間性は受容した限界 2）。(3) 収束判定の機構化（案 B/C）は計器の妥当性が未確認で、再評価トリガー（下記）で観測してから判断できる。(4) モデル名はエージェント定義の 1 行に閉じる（案 E はこれを失う）。(5) hash の計算を変えない（案 F はこれを失う）

## 既存観測との関係、受容した限界、再評価トリガー

ADR-0015 は Round 4 以降の新規実質指摘を 0/4 文書と観測している。標本は 4 と小さく、今回はユーザーの判断で自己延長と reframer 判断の延長を導入する。Amendment にはこの観測を把握したうえで変えたことを書く。

受容した限界（重要度順）:

1. **`--reframer-extend` で人間抜きに Round 7〜9 の最大 3 round を進める根拠は、「記録ファイルの Reframer Review 節」と「台帳の `review-reframer` 起動記録」の 2 つで、記録ファイルはメインループが書く**。CLI は節の存在・周の入り口の round・エージェント名・推奨値と、Round 6 の baseline 以降の起動記録を検査するので、reframer を起動せずに進むこと、記録を書かずに進むこと、(b)〜(d) の推奨で進むこと、周内で相談をやり直すことはできない。一方、次は検知できない: reframer が (b)〜(d) を推奨したのに (a) と書くこと（推奨の書き換え）、reframer を空に近い入力で起動して台帳だけを満たすこと、起動記録が別文書向けの reframer 起動であること（台帳はセッション単位で文書・stamp 時点と結びつかない）、台帳ファイル自体の偽造。記録ファイルは文書外にあり hash に関わらないので、後からの書き換え（既存の節を消して書き直すことを含む）も hash の変化として現れず、CLI も検知しない。Executive Summary の記載（パスと要約）が人間の確認経路になる
2. `human` 行は人間による承認を証明しない。`--extend` はモデルも打てるので、承認者列はどのフラグが打たれたかの記録にすぎない。人間の指示を機械的に確かめる手段（トークン等）は本オーダーの範囲外
3. 着地見込み（K3）の判定は機械検証しない
4. reason は自由記述なので、reason 形式の再評価トリガーは人間の目視で数える
5. Round 7〜9 の延長は、ユーザーの追加指示「Fable が判断するならさらにセルフエクステンドを選んでも良いかもね」を「続行の判断に限って reframer に委ねる」と解釈したもので、オーダー本文の「6 ラウンドまで」を越える。解釈の範囲は K4 の分岐に閉じ、承認依頼の Executive Summary の Risks に書く（T4 の workflow.md の文言にも Risks への記載を含める）
6. Fable を当てる効果は未検証。reframer の推奨（(a)〜(d)）と、その後の結果（(a) なら Round 9 以内に pass したか、それ以外なら人間がどれを選んだか）を、reframer-review に入った周ごとに ADR の観測として残す

観測手段: `round-extensions.log` の `self` / `reframer` 行で周を特定し、同じ文書の auto-review marker（`verdict=pass; ...; round=N`）と記録ファイルで、その周の到達点と結果を見る。周は到達した最大 phase で 1 つに分類する（reframer-review まで進んだ周は reframer 側だけで数え、self 側では数えない）。

再評価トリガー:

- self-extendable が最大 phase の周のうち、Round 6 までに pass せず reframer-review に入った周が 2 件出たら、K3 の条件か自己延長の上限を見直す
- reframer-review 以上に進んだ周のうち、Round 9 までに pass しなかった周が 2 件出たら、reframer 判断での延長をやめるか上限を見直す
- `self` 行の reason に非 pass 数の推移（N→M）が無い事例、または `reframer` 行の reason が `reframer: (a)` で始まらない事例が 1 件出たら、reason 形式の機械検査を検討する
- reframer-review に入った周で、reframer を起動できず人間に回った事例を数え、2 件出たらエージェント定義のモデル指定を見直す
- 記録ファイルの内容が reframer の出力と食い違っていた事例が 1 件でも見つかったら、`--reframer-extend` を廃止して人間判断に戻す
- `--reframer-extend` の検査（K2 の 5・6）が、記録ファイルの節が reframer の (a) 推奨と一字一句一致し起動記録もあるのに拒否した事例が 2 件出たら、検査の段数を減らす（過剰側の観測）

## Files

```
# 新規作成
home/dot_claude/agents/review-reframer.md

# 編集
home/dot_claude/hooks/lib/workflow-review-core.ts
home/dot_claude/hooks/cli/workflow.ts
home/dot_claude/hooks/implementations/reviewer-run-recorder.ts
home/dot_claude/rules/workflow.md
.skills/document-workflow-reference/SKILL.md
docs/decisions/0015-document-workflow-operator-ergonomics.md

# テスト
home/dot_claude/hooks/tests/unit/workflow-cli.test.ts
home/dot_claude/hooks/tests/unit/workflow-review-core.test.ts
home/dot_claude/hooks/tests/unit/reviewer-run-recorder.test.ts
home/dot_claude/hooks/tests/unit/test-helpers.ts
```

## Tasks

### T1: core の段階判定・許可表・文言・log 整形・Reframer Review 解析（TDD）

**Files:**

- 編集: `home/dot_claude/hooks/lib/workflow-review-core.ts:57-65`（K1 の定数・型・関数を追加）、`:584-593`（`buildRecommendation` の通知を置き換え）
- 新規: `home/dot_claude/agents/review-reframer.md`（T1 の一致テストが読むので T1 で作る。内容は T4 の記述どおりで、T4 では作り直さない）
- テスト: `home/dot_claude/hooks/tests/unit/workflow-review-core.test.ts:452-475`
- 参照: 同テストの `rounds(n)` ヘルパー（既存）、`lastPassMarkerRound`（`lib/workflow-marker.ts:97`）、`countReviewerOutputsRounds`（`lib/document-hash.ts`、core が re-export 済み）、`parseLatestAutoReviewMarker`（core 内、既存）

- [ ] Step 1: 失敗するテスト（数値は定数を import して組み立て、案内文の包含 assert はフラグ名・エージェント名・定数値・固定句に絞る）
  - `getRoundBudgetPhase` の表駆動: 0→open、2→open、3→self-extendable、5→self-extendable、6→reframer-review、8→reframer-review、9→human-only、12→human-only
  - `isExtensionAllowed` の表駆動: 4 phase × 3 approver の 12 通りが K1 の表どおり（open は全 true、self-extendable は human/self、reframer-review は human/reframer、human-only は human のみ）
  - `getRoundsInCycle`: rounds(4) → 4、rounds(9) + pass marker `round=3` → 6、rounds(3) + `round=` の無い旧 pass marker → 3、rounds(3) + pass marker `round=3` → 0、rounds(2) + pass marker `round=5`（異常値）→ 0
  - `bareSlug`: `"a:b:review-reframer"` → `"review-reframer"`、`"logic-validator"` → そのまま。`isRecordedAgentSlug`: `"logic-validator"`・`"review-reframer"`・`"x:review-reframer"` → true、`"general-purpose"`・`"review-reframer-x"`・`""` → false
  - `formatRoundBudgetHeadline`: 3 phase がそれぞれ `Round budget reached (3)` / `Round self cap reached (6)` / `Round reframer cap reached (9)`
  - `formatRoundBudgetGuidance("self-extendable", "plan.md")` が `--self-extend --reason` と `--extend --reason` を含み、`--reframer-extend` を含まない
  - `formatRoundBudgetGuidance("reframer-review", "plan.md")` が `subagent_type: ${REFRAMER_AGENT}`、`reframer-review.plan.md`、`(a)`〜`(d)`、`/scope-guard`、`--reframer-extend --reason`、`--extend --reason`、`String(ROUND_REFRAMER_CAP)`、`do not relaunch` を含み、`--self-extend` と `model` を含まない
  - `formatRoundBudgetGuidance("human-only", "plan.md")` が `--extend --reason` を含み、`--self-extend` も `--reframer-extend` も含まない
  - 3 つの案内文と見出しのいずれにも `fable`・`opus`・`sonnet` が現れない（大文字小文字を無視）
  - `sanitizeExtensionReason`: `"a\tb\nc"` → `"a b c"`、U+2028 → 空白、U+007F → 空白、`"  x  "` → `"x"`、600 文字 → 500 文字、改行 1 文字だけ → `""`
  - `formatExtensionLogLine({ at, doc: "plan.md", round: 4, approver: "self", reason: "a\tb\nc" })` → `<at.toISOString()>\tplan.md\t4\tself\ta b c`
  - `getReframerReviewFileName("plan.md")` → `reframer-review.plan.md`、`("plan-2.md")` → `reframer-review.plan-2.md`
  - `parseLatestReframerReview`: 節が 2 つあれば後者を返す。`- agent:` / `- recommendation:` の値を trim して返す（`(a) 続行` は `"(a) 続行"` のまま返し、完全一致の判定は CLI 側）。節が無ければ null。見出しの N が数値でなければ null。節の本文は次の `## ` 行で終わる。`- agent:` 行が無い / `- recommendation:` 行が無い / `- recommendation:` 行が 2 行ある（2 行目が `- rejected:` の後に紛れた `- recommendation: (a)`）→ いずれも null。`- agent: review-reframer` が前の節にだけあり最後の節に無い → null
  - エージェント定義との一致: `home/dot_claude/agents/review-reframer.md` の frontmatter `name:` の値が `REFRAMER_AGENT` と一致する（ファイルを読んで照合）。`REFRAMER_AGENT` が `SPEC_REVIEWERS` / `PLAN_REVIEWERS` / `REVIEWER_CATALOG` のいずれにも含まれない
  - `buildRecommendation`（最新 marker が needs-work で `round=` が見出し数と一致するとき）:
    - rounds(2) → 3 種の見出しのいずれも含まない
    - rounds(3)、rounds(5) → `Round budget reached (3)` と `--self-extend --reason` を含み、`Round self cap reached` を含まない
    - rounds(6)、rounds(8) → `Round self cap reached (6)` と `review-reframer` と `--reframer-extend` を含み、`--self-extend` を含まない
    - rounds(9)、rounds(10) → `Round reframer cap reached (9)` と `--extend --reason` を含み、`--reframer-extend` を含まない
    - rounds(9) で pass marker `round=3` と、その後の needs-work marker `round=9` あり（周内 6）→ `Round self cap reached`
    - rounds(6) で pass marker `round=3` と、その後の needs-work marker `round=6` あり（周内 3）→ `Round budget reached` を含み `Round self cap reached` を含まない
  - stamp 済み判定: rounds(6) + needs-work marker `round=5`（Round 6 は骨格のみ）→ 3 種の見出しのいずれも含まない。rounds(6) + `round=6` → `Round self cap reached`。rounds(6) + `round=` の無い needs-work marker → `Round self cap reached`（旧 marker は一致扱い）
  - 既存「pass で周がリセットされたら沈黙」「rounds(3) で `--extend --reason` を含む」はそのまま
- [ ] Step 2: `cd home/dot_claude && bun test hooks/tests/unit/workflow-review-core.test.ts` で FAIL を確認
- [ ] Step 3: 実装。`bareSlug` を core に移して export し、`cli/workflow.ts` と `reviewer-run-recorder.ts` の private 実装を import に置き換える（挙動は同一）。`review-reframer.md` を T4 の記述どおりに作る。`buildRecommendation` は、最新 marker が pass でなく、かつ（marker の `round=` が無いか、見出し数と一致する）とき、`getRoundBudgetPhase(getRoundsInCycle(planContent))` が open 以外なら `formatRoundBudgetHeadline(phase)` と `formatRoundBudgetGuidance(phase, basename(planPath))` を出す。現行の固定文言（「`workflow-cli round` will refuse the next round ... Only if the human tells you to continue」）は残さず全置換する
- [ ] Step 4: PASS を確認

### T2: CLI の延長フラグと 3 段判定（TDD）

**Files:**

- 編集: `home/dot_claude/hooks/cli/workflow.ts:109`（`BOOLEAN_FLAGS` に `self-extend`・`reframer-extend`）、`:293-303`（K2 の検査順序 1〜6）、`:345-351`（`formatExtensionLogLine` で追記、stdout）
- 編集: `home/dot_claude/hooks/tests/unit/test-helpers.ts:706-780`（`SeedWorkflowOptions` に `extraBaselines?: { round: number; at: string }[]`（`.round-baseline` に追記する行）、`ledgerEntries?: { slug: string; at: string }[]`（任意時刻の台帳行）、`omitBaseline?: boolean`（`round` の既定 baseline 行を書かない）を足す。既存の `ledgerSlugs` と `round` の挙動は変えない）
- テスト: `home/dot_claude/hooks/tests/unit/workflow-cli.test.ts:225-310`
- 参照: `seedWorkflow` / `ROUND_DEPS` / `runWorkflowCli`（既存 fixture）、T1 の関数群、`cli/workflow.ts` の `readRoundBaselineTime` / `readLedgerSlugsAtOrAfter`（既存、stamp の台帳照合で使用中）

- [ ] Step 1: 失敗するテストを追加・変更する（`seedWorkflow({ doc: "plan-1.md", round: N, ledgerSlugs: [] })`。pass marker は既存「fresh budget」テストと同じく文書末尾への追記で作る。記録ファイルは `writeFileSync(join(wf, "reframer-review.plan-1.md"), ...)` で作る。reframer の許可ケースでは、節の round R について `omitBaseline: true`、`extraBaselines: [{ round: R, at: "2000-01-01T00:00:00.000Z" }]`、`ledgerEntries: [{ slug: "review-reframer", at: "2000-01-01T01:00:00.000Z" }]` のように固定時刻を与える（実時刻に依存させず、文字列比較 `at >= baseline` を安定させる。R ≠ round のケースも同じ形で作れる）。「Round 6 の baseline なし」は `omitBaseline: true` で `extraBaselines` を与えない。「起動記録が baseline より前」は `ledgerEntries` の `at` を `"1999-12-31T23:00:00.000Z"` にする。stdout / stderr の数値は定数を import して組み立てる。log の時刻は `^\d{4}-\d{2}-\d{2}T` で照合する）
  - 表駆動マトリクス: round ∈ {2, 3, 5, 6, 8, 9} × 呼び出し ∈ {素の `round`, `--self-extend --reason x`, `--reframer-extend --reason x`（round ∈ {6, 8} では記録ファイルに節 `(Round 6)`・`agent: review-reframer`・`recommendation: (a)` を置き、`omitBaseline: true`・`extraBaselines: [{ round: 6, at: "2000-01-01T00:00:00.000Z" }]`・`ledgerEntries: [{ slug: "review-reframer", at: "2000-01-01T01:00:00.000Z" }]` を与える。round=2 は記録も baseline 調整もなしで exit 0（open では手順 5・6 を行わない）。その他の round は phase で拒否されるので裏付けは無関係）, `--extend --reason x`} の 24 通りで、exit code が K1 の表どおり。exit 0 のときは Round N+1 が挿入され、phase が open 以外なら log 末尾行の承認者列が期待値。exit 1 のときは Round N+1 が無く、stderr に `formatRoundBudgetHeadline(phase)` を含む（手順 5・6 で拒否されるケースは下の個別テストで扱い、マトリクスでは裏付けを満たした状態にする）。open（round=2）の延長 3 種は log が存在せず stdout に `extended beyond` を含まない
  - 個別の文言:
    - round=3 `--self-extend --reason "non-pass 2→1; remaining: x"` → stdout に `self-extended beyond round budget (3); self cap 6`、log が `\tplan-1\.md\t4\tself\tnon-pass 2→1; remaining: x$`、`doesNotMatch(r.stdout, /^extended beyond/m)`
    - round=6 `--reframer-extend --reason "reframer: (a) x; rejected: y"`（裏付けあり）→ stdout に `reframer-extended beyond self cap (6); reframer cap 9`、log が `\t7\treframer\treframer: \(a\) x; rejected: y$`
    - round=6 素の `round` → stderr に `Round self cap reached (6)`・`review-reframer`・`reframer-review.plan-1.md`
  - 裏付けの検査（いずれも round=6、`--reframer-extend --reason x`。指定の 1 点以外は裏付けを満たす）:
    - 記録ファイルなし → exit 1、stderr に `reframer-review.plan-1.md`
    - 記録ファイルはあるが節なし → exit 1、stderr に `Reframer Review`
    - `recommendation: (b)` → exit 1、stderr に `recommendation`
    - `recommendation: (a) 続行` → exit 1、stderr に `recommendation`（完全一致）
    - `agent: general-purpose` → exit 1、stderr に `review-reframer`
    - 節が `(Round 5)`（周の入り口より前）/ `(Round 7)`（入り口より後）→ いずれも exit 1、stderr に `round`
    - 節が 2 つ（`(Round 6)` の後に `(Round 7)`）→ 最後の節で判定され exit 1（相談のやり直しを塞ぐ）
    - Round 6 の baseline なし → exit 1、stderr に `baseline missing`
    - 起動記録なし → exit 1、stderr に `no review-reframer run recorded`
    - 起動記録が Round 6 の baseline より前の時刻だけ → exit 1、stderr に `no review-reframer run recorded`
    - 起動記録が `plugin:review-reframer`（名前空間付き）→ exit 0（台帳は bare slug で照合）
  - 周のリセット:
    - round=3 + pass marker `round=3`（周内 0）、素の `round` → exit 0
    - round=8 + pass marker `round=3`（周内 5）、`--self-extend --reason x` → exit 0、log が `\t9\tself\tx$`
    - round=9 + pass marker `round=3`（周内 6）、`--self-extend --reason x` → exit 1、stderr に `Round self cap reached (6)`。同条件で節 `(Round 9)` と Round 9 の baseline・起動記録付き `--reframer-extend --reason x` → exit 0、log が `\t10\treframer\tx$`
    - 同じ周で節が `(Round 6)`（前の周の入り口）→ exit 1
    - round=11 + pass marker `round=3`（周内 8）、節 `(Round 9)` と Round 9 の baseline・起動記録付き `--reframer-extend --reason x` → exit 0。round=12 + 同（周内 9）→ exit 1、stderr に `Round reframer cap reached (9)`
    - round=6 + pass marker `round=3`（周内 3）、`--self-extend --reason x` → exit 0、log が `\t7\tself\tx$`
    - round=3 + `round=` の無い旧 pass marker（周内 3）、素の `round` → exit 1、stderr に `Round budget reached (3)`
  - 引数検査:
    - 文書名 `../plan-1.md` / `sub/plan-1.md` / `plan-1.txt` / `.md` → いずれも exit 1、stderr に `document name`。`sub\plan-1.md`（バックスラッシュ入り。POSIX の `basename` は区切りとみなさない）→ そのような文書は無いので exit 1、stderr に `document not found`、stderr に `document name`（手順 0。延長フラグなしでも同じ）
    - round=3、延長フラグ 2 つ以上の 3 組み合わせ（reason 付き）→ exit 1、stderr に `use only one of --extend, --self-extend, --reframer-extend`
    - round=3、`--self-extend --extend --full --reason x` → `use only one of`（手順 1 が 2 に先行）
    - round=3 `--self-extend --full --reason x`、round=6 `--reframer-extend --full --reason x` → exit 1、stderr に `cannot be combined with --full`
    - round=3 `--extend --full --reason x` → exit 0（人間の延長は `--full` を併用できる）
    - 検査順序の固定: round=3 `--self-extend --extend`（reason なし）→ `use only one of`。round=3 `--self-extend --full`（reason なし）→ `cannot be combined with --full`。round=2 と round=9 の `--self-extend --full --reason x` → どちらも `cannot be combined with --full`（phase より先）。round=9 `--reframer-extend`（reason なし）→ `--reason`（phase より先）。round=6 `--reframer-extend --reason x`（記録ファイルなし）で phase は許可、手順 5 で拒否
    - round=3、`--self-extend`（reason なし）/ `--self-extend --reason "   "` / `--extend --reason "   "` / `--self-extend --reason` に改行 1 文字だけ → いずれも exit 1、stderr に `--reason`
  - サニタイズ（整形は T1 で検証済み。ここでは CLI 経路を 1 本）: round=3 `--self-extend --reason "a\tb\nc"` → log 全体が 1 行で `\t4\tself\ta b c$`
  - 既存の `--extend --reason ... --full` テスト: log 期待を `\t4\thuman\tuser: continue once$` に、stdout 期待を `/^extended beyond round budget \(3\)$/m` にし、`doesNotMatch(/self-extended|reframer-extended/)` を追加
  - 既存「refuses a 4th round in the same review cycle」（`workflow-cli.test.ts:225-239`）: 期待値 `/round budget \(3\)/` を `formatRoundBudgetHeadline("self-extendable")` の包含に書き換え、`/--extend --reason/` に加えて `/--self-extend --reason/` を assert する
  - stamp への非影響: 既存の stamp 成功テストと同じ条件で `ledgerSlugs` に必須 slug と `review-reframer` を並べても stamp が exit 0
  - 既存「round 3 許可」「pass 後リセット」はそのまま
- [ ] Step 2: `cd home/dot_claude && bun test hooks/tests/unit/workflow-cli.test.ts` で FAIL を確認
- [ ] Step 3: 実装（K2 の検査順序 1〜6。空判定は `sanitizeExtensionReason` の後。正規表現が oxlint の `no-control-regex` に当たる場合は `String.fromCharCode` で組み立てた文字集合で判定する。拒否文は `refusing: ${docName}: ` + `formatRoundBudgetHeadline(phase)` + `since the last pass.` + `formatRoundBudgetGuidance(phase, docName)`。手順 5・6 の拒否文は満たさなかった条件を名指しする。log は phase が open 以外のときだけ追記）
- [ ] Step 4: PASS を確認し、`cd home/dot_claude && bun run test && bun run typecheck` と、リポジトリルートで `npm run lint:oxlint` が通ることを確認

### T3: reframer の起動記録（TDD）

**Files:**

- 編集: `home/dot_claude/hooks/implementations/reviewer-run-recorder.ts:67-77`（記録判定を core の `isRecordedAgentSlug` に置き換える）
- テスト: `home/dot_claude/hooks/tests/unit/reviewer-run-recorder.test.ts`
- 参照: 同テストの既存ケース（reviewer は記録、`general-purpose` は無視、名前空間付き slug の正規化）

- [ ] Step 1: 失敗するテスト: `subagent_type: "review-reframer"` と `"some-plugin:review-reframer"` の Agent 呼び出しが、それぞれ台帳に 1 行記録される（2 列目は記録時の値のまま）。`general-purpose` は従来どおり記録されない
- [ ] Step 2: `cd home/dot_claude && bun test hooks/tests/unit/reviewer-run-recorder.test.ts` で FAIL を確認
- [ ] Step 3: 実装: `if (!isRecordedAgentSlug(subagentType)) return context.success({});`（`REVIEWER_SLUGS` の export は既存テストが参照していれば残す）
- [ ] Step 4: PASS を確認

### T4: エージェント定義・文書・ADR

**Files:**

- 編集: `home/dot_claude/rules/workflow.md:39`
- 編集: `.skills/document-workflow-reference/SKILL.md:134, 152-157`
- 編集: `docs/decisions/0015-document-workflow-operator-ergonomics.md`（Amendment 追記）
- 参照: `home/dot_claude/agents/greenfield-perspective-reviewer.md`（frontmatter の書式: `name` / `description` / `tools` / `model` / `color`）、同 ADR の Amendment (2026-09-28) の書式

- [ ] （T1 Step 3 で作る）`review-reframer.md` の内容。frontmatter: `name: review-reframer`、`description`（「Document Workflow のレビューが round 6 で収束しないときに、問題変形を含む 4 択を検討する。推奨だけを返し、採否は決めない」旨と用例 1 つ）、`tools: Read, Glob, Grep`、`model: fable`、`color`。本文: K4 の入力・出力要件 3・記録ファイルの節の形式（本文に `## ` 行を書かない、各フィールドは 1 行、`- agent:` / `- recommendation:` は 1 回だけ）・「推奨だけを返す」
- [ ] 旧文言とモデル名の参照先を洗い出す: `git grep -n -e "Round budget reached" -e "extended beyond round budget" -e "--extend --reason" -e "ROUND_BUDGET" -e "round-extensions" -- ':!docs/plans' ':!docs/decisions'`。ヒットのうち本 Files に無いものがあれば、その扱い（更新 / 歴史記録として据え置き）を決めてから進む。`docs/plans` と `docs/decisions` の既存記述は歴史記録として据え置く。加えて `git grep -n -i fable -- home/dot_claude/hooks .skills/document-workflow-reference home/dot_claude/rules/workflow.md` のヒットが 0 件（モデル名はエージェント定義にだけある）
- [ ] `workflow.md` 5.3 を 3〜5 行で: 「pass 後 3 round で素の `round` は拒否。K3 の着地見込みがあれば Round 6 まで `--self-extend --reason "<non-pass N→M; 残り>"` で続行してよい。Round 6 でも pass しなければ `review-reframer` サブエージェントに問題変形を含む 4 択を検討させ、結果を `<wfDir>/reframer-review.<doc>` に書く。(a) 続行の推奨なら Round 9 まで `--reframer-extend --reason "reframer: (a) ...; rejected: ..."`、それ以外の推奨か Round 9 でも未着地なら Open Questions に載せて人間に仰ぐ。Executive Summary に承認者別の延長回数と、reframer を使った周では記録ファイルのパス・要約を書き、Round 7 以降に進んだことを Risks に書く。人間の指示による続行は `--extend --reason`」
- [ ] SKILL.md: round コマンドの書式に `--self-extend` / `--reframer-extend`。ラウンド予算節に K1 の表、K2 の検査順序・サニタイズ・log 形式（承認者列、旧 4 列は human 扱い）、K3 の条件と reason 形式、K4 のエージェント・発火条件・記録ファイルの名前と節の形式・分岐・相談 1 回の規則、受容した限界、観測手段、再評価トリガー
- [ ] ADR-0015 に `## Amendment (2026-10-01): 自己延長を Round 6 まで、reframer 判断の延長を Round 9 まで認め、問題変形は人間に回す` を追加。0/4 の観測を把握したうえでのユーザー判断であること、9 が刻み幅に合わせた値であること、K2 の理由、案 A〜F の却下理由、reframer に Fable を当てる理由（ユーザー指示）とモデル名をエージェント定義に閉じた理由、受容した限界（重要度順）、再評価トリガー
- [ ] `chezmoi apply` を実行し、`test -f ~/.claude/agents/review-reframer.md` が真、`grep -c reframer-extend ~/.claude/rules/workflow.md ~/.claude/skills/document-workflow-reference/SKILL.md` がどちらも 1 以上
- [ ] 起動と記録の smoke 確認: Agent tool で `subagent_type: review-reframer` を 1 回起動し（入力は本 plan.md のパスと「Round 1〜5 の非 pass 指摘の要約」）、4 択と推奨を返すことと、`reviewer-runs.log` に `review-reframer` 行が増えたことを確認する。結果を Write で `<wfDir>/reframer-review.plan.md` に書けること（guard に拒否されないこと）も確認する。起動できなければ実装は完了扱いにせず、frontmatter の `model` 値をユーザーに確認する

## テスト計画 (ISO 25010)

### 機能適合性（機能正確性）

T1〜T3 の Step 1 に列挙したケースそのもの。要約:

- 周内 round 数 {2, 3, 5, 6, 8, 9} × 呼び出し 4 種の 24 通りが K1 の表どおり（T2 の表駆動）。phase × approver の 12 通りの許可表（T1 の表駆動）
- pass marker の後は周内の数で段階が決まる（周内 0 / 3 / 5 / 6 / 8 / 9 の CLI ケース）
- 引数検査の順序: 複数の延長フラグ → `--full` 併用 → reason 空 → phase → 記録ファイル → 起動記録
- 通知は最新 round が stamp 済みのときだけ段階を案内する

### セキュリティ（完全性）

- reason `"a\tb\nc"` → log は 1 行のまま、末尾列が `a b c`、承認者列は `self` のまま
- `--reframer-extend` は、記録ファイルなし / 節なし / 周の入り口以外の round / 節の追加による相談のやり直し / agent 不一致 / 推奨が `(a)` と完全一致しない / baseline なし / 起動記録なし・baseline より前のとき拒否（T2）
- reframer の記録は文書外なので、文書の hash / design-hash は変わらない（`lib/document-hash.ts` を変更しない。既存の hash 系テストがそのまま通る）
- 既存の Approval 行保護（`wouldTouchApprovalStatus`）は round 挿入の経路上に残る。既存テストがそのまま通ることで確認する

### 保守性（変更容易性）

- CLI の拒否文と通知の見出し・案内・許可判定は core の関数から来る: T1 が定数を import して包含を assert し、T2 が同じ見出し関数の出力を stderr で照合する
- モデル名はエージェント定義にだけある: T1 の「案内文と見出しに `fable`・`opus`・`sonnet` が現れない」テストと、T4 の `git grep -i fable` 0 件の確認
- エージェント名は core の `REFRAMER_AGENT` とエージェント定義の `name:` で一致する（T1）

### 対象外

- 性能効率性: 判定は文書 1 つと小さな帳簿ファイルの文字列走査で、既存と同じ計算量

## Approval

- Plan Status: complete
- Review Status: pass
- Approval Status: approved

## Reviewer Outputs (Round 1)

### logic-validator

- verdict: needs-work
- 主指摘: `--self-extend --full` の扱いが未定義で K3 条件 3 と矛盾。K1 表見出しが 2 周目で誤り（周内 round 数）、予算内 `--self-extend` の挙動・Round 7 以降のハードキャップ通知の繰り返し・K3 条件 2 が停滞を許す点が未定義

### scope-justification-reviewer

- verdict: pass
- 主指摘: 再評価トリガーが log だけでは数えられない、`--extend` 自己使用の限界と旧 4 列 log の扱いを明記、T3 に旧文言の参照網羅確認を追加

### decision-quality-reviewer

- verdict: needs-work
- 主指摘: K4 のサブエージェントに文書固有の具体的な変形案（再発指摘との対応、推奨時は新 Key Decisions 骨子）を出させる。自己延長の回数を Executive Summary に必須記載

### greenfield-perspective-reviewer

- verdict: pass
- 主指摘: 変形案の具体化を出力要件に、K3 の数は目安で最終判断は内容評価と明記、ハードキャップ到達時にサブエージェント結果が Open Questions に無い事例を再評価トリガーに

### architecture-boundary-analyzer

- verdict: needs-work
- 主指摘: 閾値判定を core の純粋関数 1 つに集約し CLI と通知が共有、案内文言も共有、承認者列を型 `ExtensionApprover` で共有

### security-vulnerability-analyzer

- verdict: needs-work
- 主指摘: reason の TAB/改行で log 列を偽装できるため制御文字をサニタイズ、`--extend` の人間性も未検証である点を受容限界に明記、Approval 行保護の維持

### test-quality-evaluator

- verdict: needs-work
- 主指摘: 既存 `/extended beyond/` が self 文言にも一致、round=2 の記録なし・round=4・round=7・pass 後周内 6 の組み合わせ・空白 reason・エラー優先順位のテスト不足、定数を import して assert

<!-- auto-review: pending -->
<!-- intent-triage: pending -->

## Reviewer Outputs (Round 2)

### logic-validator

- verdict: pass
- 主指摘: Round 1 指摘は全て解消。軽微: サニタイズ正規表現の lint 抵触に備え Step 4 に lint、旧通知文言の全置換を明記、検査順序を round=2/6 の `--full` 併用でも固定（反映済み）

### scope-justification-reviewer

- verdict: pass
- 主指摘: 追加分は全て根拠が plan 内にある。軽微: サニタイズは形式のみ守り真正性は守らない旨、N→M トリガーは目視、ADR 旧文言は据え置きの明記（反映済み）

### decision-quality-reviewer

- verdict: pass
- 主指摘: Round 1 指摘は解消。軽微: Fable の理由をユーザー指示主軸にし能力不足の断定を弱める、モデル名を定数化し起動失敗時は opus（反映済み）

### greenfield-perspective-reviewer

- verdict: pass
- 主指摘: incremental is appropriate。軽微: Fable 失敗時の代替（反映済み）、自己延長周の追跡は手作業で観測後に機構化で妥当

### architecture-boundary-analyzer

- verdict: pass
- 主指摘: Round 1 指摘は解消。軽微: `getRoundsInCycle` を core から共有、stdout の数値を定数から組み立て（反映済み）

### security-vulnerability-analyzer

- verdict: pass
- 主指摘: Round 1 指摘は解消。軽微: DEL/U+0085/U+2028-2029 もサニタイズ、reason 長さ上限 500（反映済み）

### test-quality-evaluator

- verdict: pass
- 主指摘: Round 1 指摘はほぼ解消。軽微: 検査順序の競合ケース追加、`--extend` の空白 reason、サニタイズ後空、正規表現の簡略化と年の非固定（反映済み）

<!-- auto-review: verdict=needs-work; hash=650e131112065677349c1448270470f2931f628f1b54ecb1ec5cf8c9e2f834ac; design-hash=bf9a0bf6cfbc27708713948d5854289665e75b625b84e1acc76493d862f9bc7d; round=1; at=2026-09-30T21:32:38.658Z; reviewers=logic-validator+scope-justification-reviewer+decision-quality-reviewer+greenfield-perspective-reviewer+architecture-boundary-analyzer+security-vulnerability-analyzer+test-quality-evaluator -->

## Reviewer Outputs (Round 3)

### logic-validator

- verdict: needs-work
- 主指摘: 通知は空の Round 6 骨格の挿入時点で fable-review に入り、Round 6 の結果前に Fable 相談枠を消費しうる（stamp 済み判定が要る）。opus 代替時の `--fable-extend` 禁止が案内文に無い、再評価トリガーの周分類が重複しうる

### scope-justification-reviewer

- verdict: pass
- 主指摘: 全変更に根拠あり。軽微: Round 9 は 3 刻みの設計選択でユーザー指定値ではないと ADR に明記

### decision-quality-reviewer

- verdict: pass
- 主指摘: advisory。K4 の分岐は本義と整合。軽微: 案 D の却下理由を上限の有無に絞る、9 は収束分析に基づかない旨、fable reason に (b)〜(d) を退けた理由を含める

### greenfield-perspective-reviewer

- verdict: pass
- 主指摘: incremental with documented gap。軽微: fable 行が推奨を裏付けない、(b) は人間採否と Open Questions に明記、opus 代替周の件数観測

### architecture-boundary-analyzer

- verdict: pass
- 主指摘: 軽微: フラグ×phase 許可表を core の `isExtensionAllowed` に、見出しを `formatRoundBudgetHeadline` で共有、log 行整形を core の純粋関数に

### security-vulnerability-analyzer

- verdict: needs-work
- 主指摘: `--fable-extend` は Fable の (a) 推奨の自己申告だけで Round 9 まで人間抜きで進める。Fable 出力の保存と CLI 検査で裏付ける、`human` 行は人間承認を証明しないと明記、この経路を受容限界の最重要として書く

### test-quality-evaluator

- verdict: pass
- 主指摘: 軽微: フラグ×phase マトリクスを表駆動で網羅、周リセットの境界（周内 0/5/8、旧 marker）、複数フラグ+`--full` の検査順序

<!-- auto-review: verdict=pass; hash=4c11f2a57a0becb7a681986e317e7b920becab5db4d679c137a269de93926340; design-hash=d07f06607637671fa75cb89f8f294d4bacb8d273f00d0b7a1a5ac0b8827ca1fc; round=2; at=2026-09-30T21:36:08.209Z; reviewers=logic-validator+scope-justification-reviewer+decision-quality-reviewer+greenfield-perspective-reviewer+architecture-boundary-analyzer+security-vulnerability-analyzer+test-quality-evaluator -->
<!-- intent-triage: adopted=46; excluded=0; at=2026-09-30T21:36:15.754Z -->

## Reviewer Outputs (Round 4)

### logic-validator

- verdict: needs-work
- 主指摘: Round 3 の 3 点は解消。`## Reframer Review` 節は hash の正規化対象外なので stamp 後の追記で hash が崩れ、(b)〜(d) で人間承認に回ると guard が deny しうる。検査 5 の `round` が節の N か曖昧、N の上限検査が無い

### scope-justification-reviewer

- verdict: pass
- 主指摘: 追加要素は全て根拠あり。軽微: Round 7〜9 はユーザー指示の解釈拡張であることを Risks に、案内文の包含 assert は最小語に絞る

### decision-quality-reviewer

- verdict: pass
- 主指摘: Round 3 指摘は反映済み。advisory: Executive Summary への Reframer Review 要約は人間が気づける唯一の経路として必須のまま残す

### greenfield-perspective-reviewer

- verdict: pass
- 主指摘: incremental is appropriate。起動証跡の機構化と観測の自動化は受容で足りる

### architecture-boundary-analyzer

- verdict: pass
- 主指摘: 軽微: agent 定義の `name` と `REFRAMER_AGENT` の一致テスト、reframer は reviewer 集合の対象外と明記、起動の smoke 確認

### security-vulnerability-analyzer

- verdict: pass
- 主指摘: 軽微: reframer 起動を台帳に記録し CLI が照合する案を検討、案 D の「必ず人間に戻る」は `--extend` の人間性未検証の注記が要る、hash 影響と recommendation の照合方法

### test-quality-evaluator

- verdict: pass
- 主指摘: 条件付き pass。既存「refuses a 4th round」の期待値 `round budget (3)` の更新漏れ、節の N の上限検査とテスト、「再起動しない」文言と marker `round=` の明記

<!-- auto-review: verdict=needs-work; hash=2bbf39fa93df862b9f4ed0737b0cfd146c3852facf62658c5ee881b8266e3f45; design-hash=c35d81df73fe82574f42eccc4dc69cebe085ddd090aa38e2d50c5e0f8b9eac86; round=3; at=2026-09-30T21:41:25.016Z; reviewers=logic-validator+scope-justification-reviewer+decision-quality-reviewer+greenfield-perspective-reviewer+architecture-boundary-analyzer+security-vulnerability-analyzer+test-quality-evaluator -->

## Reviewer Outputs (Round 5)

### logic-validator

- verdict: needs-work
- 主指摘: Round 4 の 3 点は解消。seedWorkflow は節の round の baseline や任意時刻の台帳行を作れず test-helpers.ts の拡張が要る。Reframer 節除去の終端条件が未定義、fenced code 内の見出し誤検出、起動記録は文書・stamp 時点と結びつかない限界の明記

### scope-justification-reviewer

- verdict: pass
- 主指摘: 追加 4 点は Round 4 指摘への必須対応。軽微: Risks への解釈拡張の記載を T4 でも明文化、T3 Step 3 が薄い

### decision-quality-reviewer

- verdict: pass
- 主指摘: hash 除外と台帳検査は支配軸に整合。advisory: 検査段数の過剰側を観測する再評価トリガー（正当な運用の誤拒否）を足す

### greenfield-perspective-reviewer

- verdict: pass
- 主指摘: incremental with documented gap。reframer 記録は文書外の帳簿ファイルにすれば hash 正規化を触らずに済む（別ファイル案を Alternatives で比較）。検査の積み増しはここで止める、上限 9 は設計値と Open Questions に

### architecture-boundary-analyzer

- verdict: pass
- 主指摘: 軽微: 見出し正規表現の単一化、recorder の判定を `bareSlug(...) === REFRAMER_AGENT` に、baseline 無しの前提をテストで固定

### security-vulnerability-analyzer

- verdict: pass
- 主指摘: 軽微: 台帳は起動のみ証明（内容・完了は未検証）と限界に追記、節本文に `## ` を書かない規則、周内 1 回を CLI で強制（`reviewRound == lastPass + ROUND_SELF_CAP`）

### test-quality-evaluator

- verdict: pass
- 主指摘: 軽微: fixture で baseline / 台帳時刻を足す手順の明記、正規化の境界ケース、台帳に review-reframer 行があっても stamp が通ることの固定

<!-- auto-review: verdict=needs-work; hash=ff62368d3ccb6f8926725a206b550b7e55ddc4197c77df9128bd76e5494c4d8c; design-hash=77f7dc22113f956b5b8ba7abcad11ef26bd908592006825481eed4b3a1f1b27b; round=4; at=2026-09-30T21:46:03.099Z; reviewers=logic-validator+scope-justification-reviewer+decision-quality-reviewer+greenfield-perspective-reviewer+architecture-boundary-analyzer+security-vulnerability-analyzer+test-quality-evaluator -->

## Reviewer Outputs (Round 6)

### logic-validator

- verdict: pass
- 主指摘: Round 5 の 4 点は解消（記録ファイルは文書種別外・guard は許可・周の算術も整合）。軽微: ledger の時刻を固定値に、baseline なしの作り方、記録は Edit で追記し各フィールドは最初の 1 行を採る（反映済み）

### scope-justification-reviewer

- verdict: pass
- 主指摘: 別ファイル化と test-helpers 追加は根拠あり。軽微: 検査段数の重さは過剰拒否トリガーで担保済み

### decision-quality-reviewer

- verdict: pass
- 主指摘: advisory。aligned。承認依頼で 0/4 観測と逆向きの拡張であること、Round 7〜9 の解釈拡張を Risks の先頭に置く

### greenfield-perspective-reviewer

- verdict: pass
- 主指摘: incremental is appropriate に近い。ROUND_REFRAMER_CAP=6 で Round 7〜9 を外せることを Open Questions に添える

### architecture-boundary-analyzer

- verdict: pass
- 主指摘: 軽微: `bareSlug` の重複を core に一本化、記録判定を `isRecordedAgentSlug` に集約（反映済み）

### security-vulnerability-analyzer

- verdict: pass
- 主指摘: 軽微: docName の basename 検査、`- recommendation:` 重複時は null、Write は全置換なので Edit で追記（反映済み）

### test-quality-evaluator

- verdict: needs-work
- 主指摘: T1 の name 一致テストが T4 で作るファイルを読む順序依存、baseline なしを作る fixture が無い、`getRoundsInCycle` 異常値と欠落フィールドのテスト不足（反映済み: agent 定義を T1 で作る、`omitBaseline` 追加、テスト追加）

<!-- auto-review: verdict=needs-work; hash=8be9397d78d55f263b0323542b133c55e40c9a9edc178b580cd23bc6b55cce7a; design-hash=ec01e3ce109ea869a43387d9b89e4ba38ae7baf39211ca45867f5e3e45ab7d72; round=5; at=2026-09-30T21:51:51.131Z; reviewers=logic-validator+scope-justification-reviewer+decision-quality-reviewer+greenfield-perspective-reviewer+architecture-boundary-analyzer+security-vulnerability-analyzer+test-quality-evaluator -->

## Reviewer Outputs (Round 7)

### logic-validator

- verdict: pass
- 主指摘: Round 6 以降の変更に回帰なし。軽微: `REVIEWER_SLUGS` も core に移し recorder は re-export、マトリクスの reframer 許可行の baseline 構成を明記（反映済み）

### test-quality-evaluator

- verdict: pass
- 主指摘: Round 6 指摘は解消。軽微: open での `--reframer-extend` は記録不要と K2 に明記、`isRecordedAgentSlug` と docName の負例、節外の `- agent:` のケース（反映済み）

### scope-justification-reviewer

- verdict: pass (carried from Round 6)
- 主指摘: Round 6 で pass、再実行なし

### decision-quality-reviewer

- verdict: pass (carried from Round 6)
- 主指摘: Round 6 で pass、再実行なし

### greenfield-perspective-reviewer

- verdict: pass (carried from Round 6)
- 主指摘: Round 6 で pass、再実行なし

### architecture-boundary-analyzer

- verdict: pass (carried from Round 6)
- 主指摘: Round 6 で pass、再実行なし

### security-vulnerability-analyzer

- verdict: pass (carried from Round 6)
- 主指摘: Round 6 で pass、再実行なし

<!-- auto-review: verdict=needs-work; hash=661f3dc8edaf0a1ba04262db90ed00a72d42468ebff5801f27aee8215e7a2344; design-hash=636b486bf160b6685416be4bbca9d53c6ff79e266fa42040ef58e75e8c30e116; round=6; at=2026-09-30T21:56:33.052Z; reviewers=logic-validator+scope-justification-reviewer+decision-quality-reviewer+greenfield-perspective-reviewer+architecture-boundary-analyzer+security-vulnerability-analyzer+test-quality-evaluator -->
<!-- intent-triage: adopted=74; excluded=1; at=2026-09-30T21:56:37.609Z -->

<!-- auto-review: verdict=pass; hash=4ccb7343018b1a3303fa0dc145fce6d78156cae01b29fabaa40d655099838095; design-hash=f837e05a759767b4b8485f1f225a045066df3f4150d34d1be4fef0b3e51f69ff; round=7; at=2026-09-30T21:58:22.350Z; reviewers=logic-validator+test-quality-evaluator -->
<!-- intent-triage: adopted=5; excluded=0; at=2026-09-30T21:58:22.365Z -->
