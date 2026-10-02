# Spec: AskUserQuestion による承認の経路を足す

## Goal

Document Workflow の承認を、利用者が文字列を打たずに、AskUserQuestion の選択肢を押すだけで済むようにする。複数の文書も 1 回の質問でまとめて承認できるようにする。発話（`承認` / `approve`）の経路は残す。あわせて、判断を求める点が複数あるときは AskUserQuestion でまとめて聞く、というルールを書く。

## Experience Delta

- 変更前: 承認待ちが 2 件以上あると、`承認 spec.md plan-3.md` という完全一致の文字列を打つ必要があった。recorder の返答も 1 件ずつ打つよう案内していた。判断を求める点は、model が文章で並べることがあった。
- 変更後: model が Executive Summary を出した直後に、承認の質問（multiSelect）を出す。利用者は承認する文書にチェックを付けて送るだけで済み、記録した文書と hash が画面に出る。議論したいときは Esc でキャンセルしてチャットし、済んだら `approve` と打つ。承認待ちが 1 件ならそれで記録され、2 件以上なら model が同じ質問を出し直す。1 回の質問に載るのは 3 件までで（AskUserQuestion の選択肢は 2〜4 個）、4 件以上待っているときは記録の後にもう一度質問が出る。

## Architecture

```
model ──(1) workflow-cli ask-approval ──▶ AskUserQuestion の入力 JSON（文書名と hash を埋めたもの）
model ──(2) AskUserQuestion(その JSON をそのまま)
          │
          ├─ PreToolUse: document-workflow-guard
          │     承認の質問なのに answers / annotations が入っていたら deny（K4、多層防御）
          │
          ├─ 利用者が選ぶ ──▶ PostToolUse: approval-answer-recorder（新規、K2）
          │     tool_response だけを読み、記録時点の状態から質問を作り直して
          │     構造ごと完全一致したときだけ記録（K3）
          │     approvals.log へ追記 → 承認行を approved に書き換え → 結果を通知
          │
          └─ 利用者が Esc ──▶ PostToolUse は発火しない（T4、1 試行）→ 何も記録しない
                              → チャットで議論 → 利用者が `approve`
                              → UserPromptSubmit: approval-recorder（既存）
                                   候補 1 件: 記録（今のまま）
                                   候補 2 件以上: 記録せず、(1)(2) をやり直すよう model に返す（K6）
```

- 記録の手順（ledger への追記 → 承認行の書き換え → 読み直しての確認）は、今の `recordOne` を lib に移して 2 つの recorder で共有する（K5）。
- gate（ADR-0023 K8 の「最新の承認 hash = 現在の hash」）は変えない。経路がいくつあっても、gate が見るのは `approvals.log` だけである。どの部品が落ちても、失敗は「記録されない」側に倒れる。
- モジュールの依存と分担（矢印は「依存される側 ← 依存する側」）:
  - `lib/workflow-approval.ts`（葉のまま、node 組込みだけに依存）: 固定文と定数、`buildApprovalQuestions`（組み立て）、`isApprovalLikeQuestion`（承認らしい質問の判定）、`matchApprovalAnswer`（応答と作り直した質問の照合。hash は引数で受ける）。すべて純関数。
  - `lib/workflow-gate.ts`（既存。葉を import する）← `lib/workflow-approval-record.ts`（新規）: `recordOne`（移設）と `verifyAndRecordApprovalAnswer(wfDir, toolResponse, session)`。後者は文書名の検証 → gate から候補と hash を取得 → 葉の照合 → `recordOne` を行い、結果を構造化した値で返す。
  - hook（2 つの recorder）: record lib を呼び、結果を整形して出力するだけ。照合の規則は持たない。
  - CLI（`ask-approval`）: `listApprovalCandidates`（gate）と `buildApprovalQuestions`（葉）を組み合わせるだけで、implementations を import しない。
  - guard: 葉の `isApprovalLikeQuestion` と `lib/guarded-tools.ts` の `GUARDED_TOOLS` を import する。循環は無い（葉は何も import せず、`guarded-tools.ts` も何も import しない）。

## Alternative Approaches (Greenfield View)

### 差分最小案 (Incremental)

AskUserQuestion の経路は作らない。`parseApprovalUtterance` の区切りを広げ（`、` `,` を許す、2 つ目以降の `承認` を許す）、recorder の 2 件以上のメッセージを「`承認 spec.md plan-3.md` とまとめて打つ」に変え、Executive Summary にもその例を載せる。

- 利点: 変更は正規表現と文言だけで、guard の判定（`isApprovalShapedPrompt`）も同じ関数なので自動で追随する。
- 欠点: 利用者は依然として文書名を正確に打つ必要がある。利用者の指摘「手で打てない完全一致は使えないのと同じ」は解消しない。形を広げるほど、予約したプロンプトの deny（課題 J）の判定も広がる。

### 白紙設計案 (Greenfield)

ゼロから作るなら、承認は「人間が、表示された版を見て、明示的に選ぶ」操作である。Claude Code でそれを満たす UI は AskUserQuestion で、回答は PostToolUse の `tool_response` に利用者の値として届く（T2 で実測）。予約したプロンプトは UI に答えられないので、課題 J の経路も構造的に無い。発話の経路は、ADR-0023 で発話しか手段が無かったから作られたもので、白紙からなら「選択肢を押す」が主経路になる。発話は、質問をキャンセルして議論した後に戻る道として残す。

信頼の根は「利用者が打った文字列」から「model が出した UI への利用者のクリック」に変わる。UI の文面を model が自由に書けると、表示を偽って別の意味の選択を承認にできる。白紙からなら、UI の文面を model に書かせず、仕組みの側（CLI）が生成した文面と一字一句同じときだけ記録する。こうすると、利用者が見た文面は仕組みが決めたものだけになる。

### 採用案と理由

白紙設計案を採る。発話は消さずに残す。

- 差分最小案はオーダーの本義（打たずに一括で承認する）を満たさない。
- ADR-0023 が (c) を却下した理由は「任意の時点で承認と打てなくなる」と「`tool_response.answers` が未実測」の 2 つだった（ADR-0023「改訂（2026-10-03）」節の却下した案）。前者は、発話を残して経路を足すことで成り立たない。後者は本セッションで実測した（research の T2〜T4）。同じ節の却下理由はこの 2 つだけで、予約したプロンプト（課題 J）の論点は、AskUserQuestion の回答を予約で作れないので生じない。
- 発話を消す案は採らない。議論の後に利用者が打つ `approve` の受け皿として必要だからである。

## Key Decisions

- **K1: 記録は PostToolUse の `tool_response` だけを読む** — `tool_input` は読まない。PreToolUse の時点の `tool_input.answers` は model が入れた値だった（T2: Pre は `A`、Post は利用者の `B`）。PostToolUse の `tool_input` も T2 では `B` だったが、`tool_input` は model の入力として定義された値なので根拠にしない。実測は各 1 試行で、配備後に同じ手順で再確認する（R6）。
  - 参照: `research.md` 実測の表 T2
  - 参照: `home/dot_claude/node_modules/@anthropic-ai/claude-agent-sdk/sdk-tools.d.ts:3749-3935`（`AskUserQuestionOutput`）
- **K2: 新しい PostToolUse hook `approval-answer-recorder.ts`** — settings の matcher は `AskUserQuestion`。加えて hook の中でも `tool_name === "AskUserQuestion"` を厳密に確かめる（matcher は正規表現で、似た名前の別ツールを入口で落とすため）。登録の確認: `session.ts` の SessionStart の監査（今は PreToolUse の guard の matcher だけを見る）を広げ、PostToolUse に `approval-answer-recorder.ts` を参照する entry があり、その matcher が `AskUserQuestion` を覆うかも報告する。既存の `auditGuardWiring` には混ぜず、独自の try/catch を持つ別の関数にする（1 つの監査の失敗が他を巻き込まない、という `session.ts` の既存の方針）。export されている `extractGuardMatcher` のシグネチャは変えず、event 名とファイル名を引数にとる一般化した探索関数に委譲する。登録が欠けても失敗は「記録されない」側に倒れて気付きにくいため。既存の UserPromptSubmit の recorder には混ぜない。イベントも入力の形も違い、1 ファイルにすると分岐が増えるだけなので分ける。出力の整形（`[approval-answer-recorder]` の接頭辞、`hookEventName: "PostToolUse"`、`systemMessage` と `additionalContext`）は hook 側に置き、lib には入れない。
  - 参照: `home/dot_claude/hooks/implementations/approval-recorder.ts:47-59`（UserPromptSubmit 側の出力の形）
  - 参照: `home/dot_claude/node_modules/cc-hooks-ts/dist/index.d.mts:979-1003`（`PostToolUseHookOutput`）
- **K3: 承認の質問の形と照合（CLI の生成結果と完全一致）**
  - 形: 1 回の呼び出しに質問は 1 つだけ。`question` は固定文 `Document Workflow の承認: 承認する文書にチェックを付けてください（議論したいときは Esc）`、`header` は `承認`（12 文字の上限内）、`multiSelect: true`、`preview` は付けない。選択肢は文書ごとに `label` = 文書名、`description` = `hash=<現在の hash の先頭 12 桁>` だけ。最後に文書でない選択肢 `承認しない`（`description` も固定文）を置く。選択肢は 2〜4 個という制約から、1 回に載せる文書は 3 件まで。4 件以上待っているときは、`listApprovalCandidates` の順で先頭 3 件を出し、記録の後に CLI をもう一度呼ぶと残りが出る。同じ固定文の質問を 1 回に複数並べないのは、`answers` が質問文をキーにした map で、キーが衝突するからである。
  - 照合の手順（`verifyAndRecordApprovalAnswer`）:
    1. 型の検査: `tool_response` が object で、キーが `questions` / `answers` / `annotations` だけであること。`questions` が長さ 1 の配列、`answers` が「文字列 → 文字列」の object であること。
    2. 文書名の検証: `tool_response.questions[0].options` の `label` から `承認しない` を除いた列を取り出す。この列は model が決めた値なので、gate や ledger に渡す前に、全件が `^(spec|plan|plan-[1-9][0-9]*)\.md$` に一致すること、重複が無いこと、1〜3 件であること、すべて記録時点の `listApprovalCandidates(wfDir)` に含まれること、を確かめる。
    3. 作り直し: その列（応答に載った順のまま）と、gate から読んだ各文書の現在の hash で `buildApprovalQuestions` を呼ぶ。結果と `tool_response.questions` を深い等価（object のキーの順は問わない、配列の順は問う）で比べ、一致したときだけ承認の質問として扱う。比較に使ったキー（`question` / `header` / `options` の `label`・`description` / `multiSelect`）が `tool_response.questions` に載ることは T2・T3 で確かめた（research）。
    4. 回答の照合: `answers` の値を `, ` で分け、各要素を作り直した側の `label` の集合と照らす。
    5. 記録: 照合で読んだ hash をそのまま `recordOne` に渡す（K5）。
  - 判定の順（返答が汎用の文に埋もれないよう固定する）: (0) `tool_name` が `AskUserQuestion` でなければ何もしない → (1) `isApprovalLikeQuestion` が偽なら何もしない → (2) `agent_id` → (3) `afkTimeoutMs` → (4) `response` → (5) 手順 1 の残りの型の検査 → (6) 手順 2 → (7) 手順 3 → (8) 回答の中身（`承認しない` だけ / `notes` / 自由入力 / 照合）→ (9) 記録。(2)〜(4) はそれぞれ下の個別の返答を出し、(5) と (7) の不通過は「形が違う」の返答、(6) の不通過は候補落ちの返答を出す。
  - 承認らしいが形が合わない質問: 次の 3 条件が `isApprovalLikeQuestion` の定義で、guard（K4）と同じ関数を使う。どれかに当たるのに手順 1〜3 を通らない呼び出しは、黙って捨てず、「承認の質問の形と違うので記録していない。`workflow-cli ask-approval` の出力をそのまま渡す」と返し、利用者向けの `systemMessage` には `approve <文書名>` の例を添える。`question` が `Document Workflow の承認` で始まる / 選択肢に `承認しない` がある / `question` が `承認` を含み、かつ選択肢の `label` のどれかが手順 2 の文書名の形をしている。最後の条件は、model が CLI を通さずに「spec.md を承認しますか」と言い換えた質問を捕まえるためのもので、文書名を含まない一般の質問（「この方針で進めてよいか」など）は判定の外に置く。判定の外の質問には何も出さない（意図的な限定。AskUserQuestion を一般の質問の経路として使うため）。
  - 記録しない条件（fail-closed）: 手順 1〜3 のどれかを通らない（`afkTimeoutMs`・`response` などの未知のキー、応答の形の変化を含む）/ `agent_id` がある / 回答の要素のどれかが正規の `label` と一致しない（空の回答を含む）/ `承認しない` と文書が同時に選ばれている / `annotations` に `notes` がある / hook 自身の例外。文書が承認できる状態か（ready で現在の版が未承認か）は、手順 2 の「記録時点の候補に含まれる」で確かめる。`listApprovalCandidates` は `ready && !alreadyApproved` で絞るので、別の条件は置かない。重複した要素（`spec.md, spec.md`）は 1 件として扱う。`label` に `, ` が含まれないことは手順 2 の文書名の形で保証される。
  - 返答の種類:
    - 記録した: 文書ごとに「`<文書> を hash=<先頭 12 桁> で承認として記録した`」を `systemMessage`（利用者に見える）と `additionalContext` で返す。
    - 一部だけ記録できた（K8）: 文書ごとに状態を分けて返す。「記録した」「log には記録したが承認行の書き換えに失敗した（`ask-approval` をもう一度呼ぶとこの文書が質問に出る）」「記録できなかった（何も書いていない。`ask-approval` をもう一度呼ぶとこの文書が質問に出る）」。利用者向けの `systemMessage` には、model が再質問しないときの出口として `approve <文書名>` の例を添える。
    - 手順 2 で候補に含まれない文書があった: 「形が違う」ではなく、「`<文書>` は承認待ちでなくなった（版が変わった、または既に承認済み）。`ask-approval` からやり直す」と返す。
    - `承認しない` だけが選ばれた: 失敗ではなく「利用者は承認しなかった。何を直すか聞く」と返す。再質問させない。過去の版への承認は取り消さない（取り消しは承認行を pending に戻す、の今のまま）。
    - `notes` がある: 記録せず、notes の本文を返して「先にこの指摘を扱う」と伝える。
    - 自由入力（`response` がある、または Other に打った文字列で `label` と一致しない）: 記録せず、入力された文字列を返して「承認ではなく利用者の発言として扱い、内容に答える」と伝える。
    - `afkTimeoutMs` がある: 記録せず、「利用者が離席していた。利用者が戻って発言するまで質問を出し直さない」と返す。
    - それ以外の記録しない条件: 理由と次の一手（`workflow-cli ask-approval` からやり直す、または議論して `approve`）を返す。
    - 例外: 既存の recorder と同じく「記録できなかった可能性がある。`workflow-cli status` で確認する」と返す。
  - Pre/Post を `tool_use_id` で結び付ける案は採らない。UI を通さずに host が `answers` を返す経路（SDK の `canUseTool` など）では、PreToolUse は `answers` 無しで通るので、結び付けても区別できない。その経路は R7 で扱う。
  - 参照: `research.md` 実測（T3: multiSelect は `, ` 区切り。T2: `tool_response.questions` に表示した質問がそのまま載る）
  - 参照: `home/dot_claude/node_modules/@anthropic-ai/claude-agent-sdk/sdk-tools.d.ts:3907-3911`（`answers` は質問文 → 回答の map）
  - 参照: `home/dot_claude/hooks/lib/workflow-gate.ts:568-602`（`evaluateApprovalReadiness`）
- **K4: guard は、承認らしい質問に `answers` / `annotations` が入っていたら deny する（多層防御）** — 記録は K1 で `tool_response` だけを読むので、この deny が無くても model の値では記録されない。それでも置くのは、UI を通らない経路で model の `answers` が結果になる可能性が未実測で残るからである（R3）。
  - 配線: `AskUserQuestion` を `lib/guarded-tools.ts` の `GUARDED_TOOLS` と `.settings.hooks.json.tmpl:4` の PreToolUse matcher に足す。guard のローカルの `GUARDED_TOOLS`（`document-workflow-guard.ts:37-45`）はやめて lib のものを import し、集合を 1 か所にする。ローカルにしていた理由は「guard の module graph を変えない」ことだったが、guard は既に `lib/workflow-approval.ts` を import しており、`guarded-tools.ts` は何も import しないので、import しても guard が壊れる経路は増えない。`GUARDED_TOOLS_FOR_TESTING` は lib の集合を再 export して残し、`tests/unit/guarded-tools.test.ts` の一覧と `session.ts` の matcher の監査のテストを合わせる。
  - 判定: 予約ツールの分岐とは別の分岐として、wfDir の解決より前に置く。AskUserQuestion はこの分岐で必ず return して、後続の書き込みの評価に進ませない（予約ツールの分岐は例外で deny、この分岐は下のとおり扱いが違うので、1 つにまとめない）。判定は K3 と同じ `isApprovalLikeQuestion`（承認らしい質問の判定）を使う。承認らしい質問に `answers` か `annotations` があれば deny、それ以外は allow。`isApprovalLikeQuestion` は入力の形を型ガードで確かめ、どんな入力にも例外を投げず boolean を返す全域関数にする。
  - 例外（防御のための分岐）: `isApprovalLikeQuestion` は例外を投げないので、ここに来るのは `tool_input` の読み出し自体が失敗する場合（getter が例外を投げる値など）に限られる。分岐の中で例外が起きたときは、`tool_input.answers` か `annotations` が空でなければ deny、空なら警告の `systemMessage` を出して allow する。model が壊れた `questions` を渡して判定を例外に追い込み、`answers` 付きで通すことを防ぐため。正規の AskUserQuestion の呼び出しは `answers` を持たないので、これで一般の質問は止まらない（K9 で AskUserQuestion を一般の質問の経路にしたことを壊さない）。
  - 判定の限界: 全角空白やゼロ幅文字、言い換えで `isApprovalLikeQuestion` を外すことはできる。その質問は recorder の完全一致（K3）を通らないので記録されず、影響はこの多層防御の層を外れることに限られる。
  - 文言の整理: `lib/guarded-tools.ts` の docstring を、評価の種類が 3 つ（書き込みの評価 / 予約ツールの prompt の文面 / AskUserQuestion の質問の内容）になったことに合わせて直す。`SCHEDULING_TOOLS` はローカルに残し、そのコメント（`:46-47`、今は「module graph を変えないため」）は、ローカルに保つ理由を「guard の分岐の種類を表す集合で、registration の集合（`GUARDED_TOOLS`）とは意味が違うため」に書き換える。
  - 包含の不変条件: `buildApprovalQuestions` の出力は、どの入力でも `isApprovalLikeQuestion` を満たす。そうでないと、guard の deny をすり抜けた質問が recorder の照合を通る組み合わせができる。`isApprovalLikeQuestion` は `questions` の全要素を調べる（2 問目に承認らしい質問が混ざっていても拾う）。
  - 参照: `home/dot_claude/hooks/implementations/document-workflow-guard.ts:37-49`、`:89-110`（ローカルの集合と予約ツールの分岐）
  - 参照: `home/dot_claude/hooks/lib/guarded-tools.ts`、`home/dot_claude/hooks/implementations/session.ts:85-110`
- **K5: 記録の手順を lib に移して共有し、照合に使った hash をそのまま記録する** — `recordOne` と `setApprovalLineApproved` を `approval-recorder.ts` から `lib/workflow-approval-record.ts`（新規）へ移して export する。記録する hash は、照合（K3 の作り直し、または発話の経路の readiness）で読んだ値を引数で渡し、記録の直前に読み直さない。返す文言の「もう一度『承認 X』と書く」は、経路に依らない「`workflow-cli status` で確認する」に変える。`approvals.log` の行に、どの経路で記録したかを `via`（`"utterance"` / `"ask"`）として足す。gate は経路を区別しないので、2 つの経路のうち弱い方が全体の強度になる。あとから監査できるようにするためで、読み手（`parseRecord`）は知らないキーを無視するので `v` は 1 のまま変えない（research）。`via` は各 recorder が定数で書き、`tool_response` や `tool_input` からは導かない。読み手として、`workflow-cli status` の approval の行に、最新の承認の `via` を表示する（無い行は `via=unknown`）。gate は `via` を見ない。
  - 冪等性と並行: `recordOne` は冪等にしない。ledger に同じ文書・同じ hash の行が 2 つ並んでも、読み手は文書ごとに最後の行だけを使うので結果は変わらない（`lib/workflow-approval.ts` の `readLatestApprovals`）。2 つの recorder が近接して発火する場合の扱いは今の recorder と同じで、ledger への追記は O_APPEND の 1 回の write（`appendApproval`）、承認行の書き換えは一時ファイルからの rename で、どちらも途中の状態を残さない。書き換えの後に読み直して確かめる（`recordOne`）。新しいリスクは増えない。
  - 参照: `home/dot_claude/hooks/implementations/approval-recorder.ts:69-131`、`:206-213`
- **K6: 素の `approve` で候補が 2 件以上なら、AskUserQuestion で聞き直させる（案 (i)）** — 何も記録しない。model には「`workflow-cli ask-approval` の出力で AskUserQuestion を出す」と返し、利用者向けの `systemMessage` には、model が質問を出さないときの出口として文書名付きの発話の例（`approve spec.md plan-1.md`）も 1 行添える。全部を承認する案 (ii) は採らない。議論の結果、一部の文書だけ直すことが普通にあり、意図しない文書まで承認されるからである。文書名を付けた発話（全か無か）は今のまま残す。
  - 参照: `home/dot_claude/hooks/implementations/approval-recorder.ts:190-200`
- **K7: 質問の JSON は `workflow-cli ask-approval` が出す** — 新しいサブコマンド。承認待ちの文書（`listApprovalCandidates`。承認以外の条件（Plan / Review / marker / parent-spec-hash）を満たし、現在の版が未承認の文書だけを返す）の先頭 3 件から、AskUserQuestion の入力（`{"questions": [...]}`）を JSON で標準出力に出す。標準エラーには「回答の後に `[approval-answer-recorder]` の返答が無ければ記録されていない。`workflow-cli status` で確かめる」と、4 件以上あるときは「残り N 件は記録の後にもう一度呼ぶと出る」を出す。候補が 0 件なら終了コード 1 と理由を出す。
  - builder の責務: `buildApprovalQuestions(docs: {name: string, hash: string}[])` は完全な hash を受けて内部で先頭 12 桁に切る。入力の順を保ち、並べ替えない。文書名が手順 2 の形でない、または 0 件か 4 件以上のときは例外を投げる（黙って切らない）。3 件に切るのは呼び出し側（CLI）の責務で、recorder は応答に載った列をそのまま渡す。CLI に生成させる理由は、質問に現在の hash を埋める必要があり、hash は model が手で写せる値ではないからである。K3 は完全一致で照合するので、model が固定文や hash を 1 文字でも違えると記録されない。固定文・選択肢の組み立ては `lib/workflow-approval.ts` の `buildApprovalQuestions(docs: {name, hash}[])` に置く。候補を引数で受ける純関数にして、`workflow-approval.ts` を node 組込みだけに依存する葉のまま保つ。固定文・`承認しない`・`hash=` の接頭辞・桁数（12）・1 回の上限（3）はこのファイルの export 定数にし、CLI・guard・recorder が同じ定数を使う。
  - 照合を「label と hash だけ」に緩め、質問文を自由にする案は採らない。質問文や説明を model が自由に書けると、表示を偽った選択が承認になる（K3）。
  - 参照: `home/dot_claude/hooks/cli/workflow.ts:189-210`（サブコマンドの分岐と usage）
  - 参照: `home/dot_claude/hooks/lib/workflow-gate.ts:611-625`（`listApprovalCandidates`）
- **K8: 事前の照合は全か無か、記録は文書ごと** — 選ばれた文書のうち 1 つでも K3 の記録しない条件に当たれば、何も記録しない。文書名を付けた発話（ADR-0023 K7 の「名前を付けた承認は全か無か」）と同じ規則にする。照合を通った後の記録（ledger への追記と承認行の書き換え）は、今の recorder と同じく文書ごとに行い、文書をまたぐトランザクションは持たない。途中で失敗したときは、記録できた文書とできなかった文書を分けて返す。回復の手段は再質問で足りる: `listApprovalCandidates` は、ledger には書いたが承認行が書き換わっていない文書も候補に残す（`workflow-gate.ts:605-610` の docstring）ので、`ask-approval` をもう一度呼べば、残りが質問に出る。
  - 参照: `home/dot_claude/hooks/implementations/approval-recorder.ts:178-189`、`:203-205`
  - 参照: `home/dot_claude/hooks/lib/workflow-gate.ts:605-625`
- **K9: 判断を求める点が複数あるときは AskUserQuestion でまとめて聞く。承認の依頼も同じターンで質問まで出す** — `rules/workflow.md` のターン終端規則に足す。承認の依頼は、Executive Summary を出した同じターンで `workflow-cli ask-approval` → AskUserQuestion まで行う。回答の後に `[approval-answer-recorder]` の返答が無ければ、`workflow-cli status` で記録を確かめてから進む（hook が配備されていないセッションでも気付けるように）。Executive Summary の Next Action は「質問に答える / 議論したいときは Esc でキャンセルしてチャットし、済んだら `approve`」に変える。
  - 発火点を rule だけに頼らないため、`workflow-cli triage` の成功時の出力に、次の一手として `workflow-cli ask-approval` を 1 行出す。triage は承認の依頼の直前に必ず通る手順（共通フロー step 6）である。
  - 参照: `home/dot_claude/rules/workflow.md`（共通フロー step 6・7、ターン終端規則、CRITICAL 節、Executive Summary）
  - 参照: `home/dot_claude/hooks/cli/workflow.ts:871`（`cmdTriage`）
- **K10: `rules/workflow.md` の上限は上げず、同じ量を削る** — 今 13,312 byte で `workflow-md-budget.test.ts` の上限ちょうど。上限は、読み込みのたびに払うコストを抑えるために置いたもので、文言の追加を理由に上げると上限の意味が無くなる。workflow.md に残すのは、操作の要点と真正性の不変条件（承認は人間だけ、model は AskUserQuestion の `answers` を入れない、承認行と `approvals.log` を書かない）。承認の手順の細部（全か無か、取り消し方、K3 の記録しない条件、hash が動いたときの再承認）は reference skill に置く。
  - 見積もり（2026-10-03 の `wc -c`）: 追加はターン終端規則への K9 の 2 文（約 300 byte）、Executive Summary の Next Action の置き換え（約 +100 byte）、共通フロー step 7 と CRITICAL 節の発話の記述を両経路に直す分（約 +150 byte）で、計 約 550 byte。削る候補は共通フロー 5.3（予算）の段落（現在 796 byte）で、詳細は既に reference skill の「ラウンド予算」にあるので、要点と参照の 1〜2 文（約 250 byte）に縮めて 約 550 byte を空ける。足りなければ CRITICAL 節（現在 1,307 byte）の「hash が動く改訂は再承認…取り消しは…」の行を reference skill に移す。
  - 完了条件（plan-2）: `workflow-md-budget.test.ts` が通ること。真正性の不変条件が workflow.md に残っていることを、`workflow-md-budget.test.ts` に固定文字列の検査として足して確かめること。検査する文字列は 3 つ: `## CRITICAL: 承認は人間のみ`（既存の見出し）、``AskUserQuestion の `answers` を入れない``、``承認行と `approvals.log` を書かない``。3 つ目は `approvals.log` が別の文脈でも出るので、「書かない」まで含めた文で検査する。後ろの 2 つは今の本文に無いので、本文への追加とテストの追加を同じタスクで行う。言い換えで落ちないよう、文言は plan-2 でこの 3 つに固定し、テストと本文を同じコミットで変える。
  - 参照: `home/dot_claude/hooks/tests/unit/workflow-md-budget.test.ts`
- **K11: ADR-0023 に新しい改訂節を足す** — 「改訂（2026-10-03）」節の (c) の却下は書き換えず、後ろに「改訂: AskUserQuestion の経路」節を足す。書くことは、(c) の却下理由 2 つ（打てなくなる・未実測）のそれぞれがどう解消したか、実測 T2〜T4、信頼の根が変わったことと K3 の完全一致で補ったこと、質問に載せる文書の集合と順序は model が選べて、保証されるのは利用者の選択を経由することだけであること、`承認しない` は記録に残らず過去の承認を取り消さないこと、ledger の `via`、残るリスク（R3・R6・R7・R8）。
  - 参照: `docs/decisions/0023-workflow-identity.md`（「改訂（2026-10-03）」節の却下した案）
- **K12: 承認の案内を新しい経路に合わせる** — 次の文言が「会話で『承認 X』と打つ」だけを案内しているので、AskUserQuestion の経路を主にした案内に変える。guard の deny 文（予約ツール `document-workflow-guard.ts:98`・`:106`、K9 の承認行と ledger の deny）、recorder の返答（`approval-recorder.ts:115`・`:124`・`:129`・`:197`）、reference skill（`.skills/document-workflow-reference/SKILL.md` の 16 行目と「承認の記録」節）。変更後に、旧文言（「会話で『承認 X』と打つ」だけを案内する文）が残っていないことを grep で確かめる（plan-2）。
  - 参照: `home/dot_claude/hooks/implementations/document-workflow-guard.ts:96-108`

## Risks

- **R1: 実行中のセッションには新しい hook が入らない** → 本セッションで、設定の変更が実行中のセッションに反映されない場面があった（research）。古いセッションでは AskUserQuestion で答えても記録されず、recorder の返答も出ない。K9 で、返答が無ければ `workflow-cli status` で確かめるようにした。発話の経路はそのまま使える。配備後の確認は `chezmoi apply` の後に起動したセッションで行う（plan-2）。
- **R2: 離席による自動解決の挙動が未実測** → `afkTimeoutMs` を含む未知のキーがある応答は記録しない（K3）。型の説明（「人が答えた経路では必ず無い」）だけが根拠なので、この条件は外さない。離席時は質問を出し直さないよう返す。
- **R3: UI なしで通る経路で、model の `answers` が結果になりうる（未実測）** → K4 で、承認らしい質問に `answers` を入れた呼び出しを PreToolUse で止める。permission 層は AskUserQuestion を常に `ask` にしている（`permission-llm-evaluator.ts` の `USER_DECISION_TOOLS`）。
- **R4: 要約と質問の間に文書が変わる** → 利用者には hash が見えないので、Executive Summary を出した後、`ask-approval` を呼ぶ前に model が文書を書き換えると、利用者は古い要約を見たまま新しい版を承認しうる。これは発話の経路にもある既存のリスクで、この変更で増えも減りもしない。質問の表示から回答までの間の変更は、K3 の作り直しの照合で hash が合わず記録されない。
- **R5: サブエージェントの中の AskUserQuestion に `agent_id` が載るか未実測（受容するリスク）** → `agent_id` があれば記録しない。載らない場合は、サブエージェントが出した承認の質問に利用者が答えると記録される。承認はメインの会話で行うという ADR-0023 の趣旨からは外れるが、利用者が CLI の生成した文面を見て自分で選んだことは K3 で保証される。この差は受容し、ADR に書く。
- **R6: 実測は各 1 試行** → K1（`tool_response.answers` は利用者の値）、T4（Esc で PostToolUse が発火しない）、`tool_response.questions` のキー（K3 の作り直しの照合の前提）の根拠は各 1〜2 試行である。配備後の確認（plan-2）で、新しいセッションで次を確かめる: `ask-approval` の出力で出した質問に答えると、作り直しの照合を通って記録されること（偽陰性が無いこと）/ model が `answers` を入れた承認の質問が guard に止められ、そのとき PostToolUse が発火しない（発火しても記録されない）こと / Esc で何も記録されないこと / `workflow-cli status` に `via=ask` が出ること / SessionStart の監査が PostToolUse の登録を報告すること。結果は `approvals.log` と recorder の返答で確かめる。T4 が外れて Esc でも PostToolUse が発火した場合、`answers` が空か利用者の値でないので、K3 の照合で記録されない。
- **R7: 非対話の実行（`claude -p`、SDK、CI）で、host が回答を返す経路** → その経路で `tool_response` に何が載るかは未実測。K3 は知らないキーがあれば記録しないので、残るのは「host が対話と同じ形（`questions` / `answers` だけ）で回答を返す場合」に絞られる。CI の自律レーンは設計面に触れない（autonomous-lane C3）ので Document Workflow の承認を行う場面は無いが、これは規約によるもので、仕組みとして非対話を検出して止めることはしない。閉じたと主張せず、ADR に残す。
- **R8: 信頼の根が「打った文字列」から「model が出した UI へのクリック」に変わる** → 打つ手間が意図の確認になっていたのに比べ、クリックは軽い。また、質問に載る文書の集合は model が選べ、利用者が見るのは文書名と hash の先頭だけで、内容との対応は model の Executive Summary に依存する（R4 と同根）。緩和は 3 つ: K3 の完全一致で、質問の文面は CLI の生成したものだけになる / 記録したら文書と hash を `systemMessage` で必ず利用者に見せる / ledger の `via` で、どの経路の承認かをあとから監査できる。発話の経路も、承認する文書と要約の対応は model に依存しており、この点の強さは変わらない。質問に載せる文書の集合と順序は model が選べ、保証されるのは利用者の選択を経由することだけである（K11 にも書く）。複数の文書を 1 回のクリックでまとめて承認できることを直接抑える仕組みは置かない（承認前に見えるのは文書名と hash の先頭だけ）。これはオーダーの「一気に承認する」の裏返しで、受容するリスクとする。
- **R9: 承認の依頼の発火点は助言にとどまる** → K9 の rule と `workflow-cli triage` の出力は model への助言で、質問を出すことを強制しない。model が出さなかった場合も、利用者は発話の経路（`approve`、文書名付き）で承認できる。強制する案として、承認待ちの文書がある状態でターンが閉じるときに Stop hook で質問を促す案を検討したが、採らない。議論の途中や、利用者が後で承認すると言った場面でも毎ターン発火して誤発火が多く、この変更の範囲（承認の経路を足す）を超えるため。また、CLI を通さずに言い換えた質問（文書名を `label` に含まないもの）は、記録も警告もされない（K3 の判定の外）。記録されないので安全側だが、利用者の回答は捨てられる。

## ISO 25010 次元選択

- **機能適合性（正確性）**: 選んだ文書だけが、照合に使った hash で記録されること。記録しない条件（K3）の各項目で記録されないこと。部分失敗の後に再質問で残りを記録できること。
- **セキュリティ（真正性・否認防止）**: model が入れた `answers` では記録されないこと（K1・K4）。CLI の生成結果と一字でも違う質問では記録されないこと（K3）。文書名の形でない `label`（パスを含むものなど）や候補に無い文書名では、gate にも ledger にも渡らないこと（K3 手順 2）。`buildApprovalQuestions` の出力が常に `isApprovalLikeQuestion` を満たすこと（K4 の包含）。承認の質問でない AskUserQuestion に影響しないこと。ledger の行に `via` が残ること。
- **使用性（操作性）**: 承認待ちが 3 件までなら 1 回の質問で承認できること。キャンセルの後に `approve` で戻れること。記録の結果が利用者に見えること。
- **保守性（変更容易性）**: 固定文・定数・組み立て・照合を `lib/workflow-approval.ts` の 1 か所に置き、CLI・guard・recorder が同じものを使うこと。
- **対象外**: 性能効率（PostToolUse の hook が 1 つ増えるだけで、AskUserQuestion 以外では発火しない）、互換性（gate と `approvals.log` の形式は変えない）、信頼性のうち可用性（hook が落ちても記録されないだけで、発話の経路が残る）。

## Approval

- Plan Status: complete
- Review Status: pass
- Approval Status: approved

## Reviewer Outputs (Round 1)

### logic-validator

- verdict: needs-work
- 主指摘: 同じ固定文の質問を複数並べると `answers`（質問文がキー）が衝突し、12 件への分割は成り立たない。`承認しない` だけを選んだ場合を失敗として返すと model が再質問に走る。K4 の fail-closed がすべての AskUserQuestion に及ぶ。実測が 1 試行であることが Risks に無い。

### scope-justification-reviewer

- verdict: needs-work
- 主指摘: K7 の CLI は「hash を model が手で写せない」ことを理由に明記すれば必要と言える。K4 は純粋な多層防御なので、そう明記する。K10 は削る対象と量を書く。guard の deny 文と reference skill の更新が Key Decision に無い。

### decision-quality-reviewer

- verdict: needs-work
- 主指摘: 信頼の根が「利用者が打った文字列」から「model が組み立てた UI へのクリック」に変わることを、ADR-0023 R4 と同列に扱うのは過小評価。`tool_response.questions` を CLI の生成結果と全体一致で照合する。成功時に何を承認したかを必ず通知する。真正性の不変条件は workflow.md に残す。

### greenfield-perspective-reviewer

- verdict: needs-work
- 主指摘: 固定文と少しずれた承認らしい質問が黙って無視される。承認依頼の発火点が rule だけで、triage の返答など機構の側に次の一手を出す場所が無い。素の `approve` が通らないときの出口（文書名付きの発話）を返答に添える。

### architecture-boundary-analyzer

- verdict: needs-work
- 主指摘: GUARDED_TOOLS は lib・guard のローカル集合・settings の matcher の 3 か所にある。`isApprovalQuestion` / `buildApprovalQuestions` は候補を引数で受ける純関数にして、`workflow-approval.ts` を葉のまま保つ。固定文・`hash=`・桁数は 1 か所の定数にする。

### security-vulnerability-analyzer

- verdict: needs-work
- 主指摘: description の `hash=` より後ろ・header・preview を model が自由に書けるので、表示の偽装で誤った選択を承認にできる。recorder は記録時点の状態から質問を再計算し、`tool_response.questions` と構造ごと完全一致したときだけ記録する。`tool_response` の未知のキーは記録しない。質問文の衝突。`tool_name` を厳密に確認する。

### resilience-analyzer

- verdict: needs-work
- 主指摘: 全か無かは事前チェックだけで、記録は文書ごと。部分失敗の通知と回復手段を決める。guard の例外の扱いを、承認の質問に限って fail-closed にする。承認らしいが形が合わない質問を黙って捨てない。照合に使った hash をそのまま記録に渡す（読み直さない）。

<!-- auto-review: pending -->
<!-- intent-triage: pending -->

## Reviewer Outputs (Round 2)

### logic-validator

- verdict: needs-work
- 主指摘: 完全一致の対象のうち header・multiSelect・キー順が `tool_response.questions` にそのまま載るかの裏付けが無い。深い等価（キー順を無視）で比べると決める。Other の自由入力の返答が未定義。ask-approval が ready な文書だけを載せることの明記。R5 は「問題ない」と断定せず受容するリスクとして書く。

### scope-justification-reviewer

- verdict: needs-work
- 主指摘: Round 1 の 4 点は解消。K10 の削る節と追加量の見積もりが spec に無い。R6 に「完全一致が実際に通ること」を足す。K12 は旧文言が残らないことを grep で確かめる形にする。

### decision-quality-reviewer

- verdict: needs-work
- 主指摘: 信頼の根の移動（要約と質問の乖離、クリックは発話より意図の確認が弱い）を独立した Risk にする。弱い方の経路が全体の強度になるので、ledger に経路を記録する。R7 は未知キーの fail-closed で範囲を絞って書ける。不変条件が削減後も workflow.md に残ることをテストする。

### greenfield-perspective-reviewer

- verdict: pass
- 主指摘: Round 1 の 6 点は解消か理由付きで受容。triage の出力は助言で強制ではないことを Risks に一言。K10 は plan-2 の完了条件に `wc -c` を入れれば足りる。

### architecture-boundary-analyzer

- verdict: needs-work
- 主指摘: guard のローカルの GUARDED_TOOLS を残すか lib から import するかを決める。作り直しの照合の置き場所（葉の純関数・record lib・hook の分担）を決める。12 桁の切り詰めと 3 件の上限を builder の責務に一意に定め、入力順を保つ。PostToolUse の登録の確認を plan-2 に足す。

### security-vulnerability-analyzer

- verdict: needs-work
- 主指摘: model が決めた label を文書名として gate と ledger に渡す前に、`^(spec|plan|plan-[1-9][0-9]*)\.md$` で検証し、重複・4 件以上・候補に無い名前を拒否する。集合と順序は model が選べることを ADR に書く。`buildApprovalQuestions` の出力が常に `isApprovalLikeQuestion` を満たすことをテストする。`tool_response` と `answers` の型を検査する。

### resilience-analyzer

- verdict: needs-work
- 主指摘: 部分失敗の各状態の返答文を決める。K4 の例外で allow されても K1 で記録されないことを K4 に明記。ask-approval の出力に「返答が無ければ未記録」を出す。承認らしい質問の判定の範囲を意図的な限定として書く。`承認しない` は過去の承認を取り消さないことを ADR に書く。

<!-- auto-review: verdict=needs-work; hash=d6cfb2669e165e853ef29742b8c11193bd840d548e976a9ad0b3ed95cc9909c8; design-hash=b277608f958651c9ca22d21f17cb386a0ed36d507c0ebc62b654b241972523d0; round=1; at=2026-10-02T19:45:48.720Z; reviewers=logic-validator+scope-justification-reviewer+decision-quality-reviewer+greenfield-perspective-reviewer+architecture-boundary-analyzer+security-vulnerability-analyzer+resilience-analyzer -->
<!-- intent-triage: adopted=42; excluded=0; at=2026-10-02T19:46:36.749Z -->

## Reviewer Outputs (Round 3)

### logic-validator

- verdict: pass
- 主指摘: Round 2 の 4 点は解消。K3 手順 2 と K8、K7 の builder と CLI の切り詰めに矛盾は無い。軽微: 手順 2 の候補落ちを「形が違う」と返すのは不正確。ready の条件は候補の判定と重なる。R8 と K11 の文言を揃える。

### scope-justification-reviewer

- verdict: pass
- 主指摘: Round 2 の 3 点は解消。`via` と guard の import 元の切り替えは根拠がありスコープ内。軽微: grep の範囲を plan-2 に明記。import 元の切り替えと AskUserQuestion の追加は既存テストを先に通す順にする。

### decision-quality-reviewer

- verdict: needs-work
- 主指摘: `via` を読む仕組みが無く書くだけの記録になっている。不変条件の grep の対象文字列を固定する。複数文書を 1 クリックで承認する危険を直接下げる緩和は無いので、受容するなら明記する。

### greenfield-perspective-reviewer

- verdict: pass
- 主指摘: 白紙再構築と一致。軽微: 4 件以上は複数回になることを Experience Delta に書く。Stop hook などの強制案を検討して見送った理由を R9 に書く。

### architecture-boundary-analyzer

- verdict: needs-work
- 主指摘: guard が lib を import するのは問題なし（`:47-48` のコメントは直す）。`lib/guarded-tools.ts` の docstring を第 3 の評価種別に合わせ、AskUserQuestion の分岐は予約ツールと別に実装して必ず return する。PostToolUse の登録を確かめる仕組み（session.ts の監査の拡張など）が無い。

### security-vulnerability-analyzer

- verdict: pass
- 主指摘: Round 2 は解消、新しい偽造経路は無い。軽微: `isApprovalLikeQuestion` を例外を投げない全域関数にし、例外時でも `answers` / `annotations` があれば deny する。`via` は recorder の定数で書く。PreToolUse で deny したときに PostToolUse が発火しないことを R6 で確かめる。

### resilience-analyzer

- verdict: needs-work
- 主指摘: 部分失敗の返答にも発話の出口を添える。`recordOne` が冪等かを決める。2 つの recorder の並行は既存と同じ前提なら受容と書く。CLI を通さない言い換えの質問は記録も警告もされないことを R9 に書く。

<!-- auto-review: verdict=needs-work; hash=1942fa6b122af9870dcd6c1cbe85e3c452efba40b77d333b636a9da676a22c6f; design-hash=0cf4dfc57ca6d133cdaa6ae98220bdf16c6458b605ac81769b48c95d48025976; round=2; at=2026-10-02T19:49:44.653Z; reviewers=logic-validator+scope-justification-reviewer+decision-quality-reviewer+greenfield-perspective-reviewer+architecture-boundary-analyzer+security-vulnerability-analyzer+resilience-analyzer -->
<!-- intent-triage: adopted=33; excluded=0; at=2026-10-02T19:49:44.668Z -->

## Reviewer Outputs (Round 4)

### logic-validator

- verdict: pass
- 主指摘: 致命的な矛盾なし（K8 の回復経路、GUARDED_TOOLS の消費者を確認）。軽微: K3 の返答の判定順を固定する。K4 の例外分岐は防御的と明記。K3 の 3 条件が `isApprovalLikeQuestion` の定義であると書く。`approvals.log` の検査は文脈つきに。→ 反映済み。

### decision-quality-reviewer

- verdict: pass
- 主指摘: Round 3 の 3 点は解消。軽微: 固定文字列の 2・3 つ目は本文への追加とテストを同じタスクに。`via` の 3 通りをテストで固定。→ K10 に反映、残りは plan で扱う。

### architecture-boundary-analyzer

- verdict: pass
- 主指摘: K4 の分岐は解消。軽微: SessionStart の監査は別関数・独自の try/catch・matcher の被覆まで確かめる。`SCHEDULING_TOOLS` のコメントは消さず理由を書き換える。行番号でなく識別子で参照。→ 反映済み。

### resilience-analyzer

- verdict: pass
- 主指摘: Round 3 の 3 点は解消し、コード側の主張（`readLatestApprovals`・`appendApproval`・`recordOne`）も確認。軽微: 「形が違う」の返答にも発話の出口を添える。発話の経路の既存テストの期待文言も更新する。→ 前者は反映済み、後者は plan で扱う。

### scope-justification-reviewer

- verdict: pass (carried from Round 3)
- 主指摘: Round 3 で pass、再実行なし

### greenfield-perspective-reviewer

- verdict: pass (carried from Round 3)
- 主指摘: Round 3 で pass、再実行なし

### security-vulnerability-analyzer

- verdict: pass (carried from Round 3)
- 主指摘: Round 3 で pass、再実行なし

<!-- auto-review: verdict=needs-work; hash=bc875bb036cf301fcc438232bd7e1b17deb4ee8be78d483e50f3b10db36f157f; design-hash=194b79ec19bbd900c587892ffa0fc15c7f44346a3005b329e9343bb5ee88402a; round=3; at=2026-10-02T19:53:22.307Z; reviewers=logic-validator+scope-justification-reviewer+decision-quality-reviewer+greenfield-perspective-reviewer+architecture-boundary-analyzer+security-vulnerability-analyzer+resilience-analyzer -->
<!-- intent-triage: adopted=24; excluded=0; at=2026-10-02T19:53:22.322Z -->

<!-- auto-review: verdict=pass; hash=98dfec921058b7bc43fc11c288ae0bedfe7daac7ce28c000f8228f2ce7384c15; design-hash=2db44bebf6f68ebc619ddc6344a26279ec430795cbc60d8aaf5299e7518e3963; round=4; at=2026-10-02T19:55:36.868Z; reviewers=logic-validator+decision-quality-reviewer+architecture-boundary-analyzer+resilience-analyzer -->
<!-- intent-triage: adopted=15; excluded=0; at=2026-10-02T19:55:36.883Z -->
