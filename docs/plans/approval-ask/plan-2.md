<!-- spec-ref: spec.md -->

# Plan: AskUserQuestion による承認の経路（文書・配備・確認）(Execution layer)

spec.md の K9・K10・K11・K12（文書の部分）と、R1・R6 が前提にしている配備と配備後の確認を行う。plan-1 の実装がすべてコミットされてから着手する（コードの文言の修正はすべて plan-1 にあり、このタスクではコードを変えない）。

## Files

```
# 編集
home/dot_claude/rules/workflow.md
home/dot_claude/hooks/tests/unit/workflow-md-budget.test.ts
.skills/document-workflow-reference/SKILL.md
docs/decisions/0023-workflow-identity.md

# 新規作成（セッション成果物の退避）
docs/plans/approval-ask/research.md
docs/plans/approval-ask/spec.md
docs/plans/approval-ask/plan-1.md
docs/plans/approval-ask/plan-2.md
```

## Tasks

### T1: workflow.md の承認の記述を両経路に直し、同じ量を削る（spec K9・K10）

**Files:**

- 編集: `home/dot_claude/rules/workflow.md`（共通フロー 5.3・step 7、ターン終端規則、CRITICAL 節、Executive Summary の Next Action）
- テスト: `home/dot_claude/hooks/tests/unit/workflow-md-budget.test.ts`
- 参照: `.skills/document-workflow-reference/SKILL.md` の「ラウンド予算」節（5.3 の詳細の移し先）

- [ ] **Step 1: 前提の確認** — 5.3 から削る項目が reference skill にあることを確かめる。`rg -n 'self-extend|non-pass N→M|review-reframer|reframer-review\.|reframer-extend|Round 9|Executive Summary|Round 7|--extend' .skills/document-workflow-reference/SKILL.md` の出力で、次の 6 項目それぞれに当たる行があること: 自己延長の 3 条件と reason の形 / Round 6 の reframer と記録ファイル / Round 9 までの `--reframer-extend` / Executive Summary の承認者別の延長回数 / Round 7 以降の Risks / 人間の `--extend --reason`。無い項目は、その節に移す文を書き足してから次に進む。
- [ ] **Step 2: 失敗するテストを書く** — `workflow-md-budget.test.ts` に、既存と同じ top-level の `test("keeps the approval invariants in the operator guide", ...)` を足し、workflow.md が次の 3 つの固定文字列をそれぞれ含むことを `ok(content.includes(s), ...)` で確かめる: `## CRITICAL: 承認は人間のみ`、``AskUserQuestion の `answers` を入れない``、``承認行と `approvals.log` を書かない``。
- [ ] **Step 3: 失敗を確認** — 実行: `node --import ./home/dot_claude/hooks/tests/preload-test-env.mjs --test home/dot_claude/hooks/tests/unit/workflow-md-budget.test.ts`。期待: 2 つ目と 3 つ目の文字列が無くて FAIL。
- [ ] **Step 4: 本文を変える**（置き換え後の文。各行は 1 行で書く。1 項目を変えるたびに `wc -c home/dot_claude/rules/workflow.md` を記録する）
  1. 5.3（先に削って余裕を作る）→ `- **5.3 予算**: pass 後 3 round で素の \`round\` は拒否。着地見込みがあれば \`--self-extend\`、Round 6 で未着地なら \`review-reframer\`、人間の指示なら \`--extend\`。条件・記録・Executive Summary への書き方は \`/document-workflow-reference\`「ラウンド予算」。\`## Files\` が prose のみなら追加レビュアーなし。`
  2. CRITICAL 節の 1 段落目 → `人間が承認の質問で文書を選ぶか、会話で \`approve\` / \`承認\` と書くと、hook がその版の hash を \`approvals.log\` に記録し、gate はこの hash と現在の hash の一致を求める。Claude は AskUserQuestion の \`answers\` を入れない。承認行と \`approvals.log\` を書かない（guard が deny）。\`/execute-plan\` は承認ではない。`
  3. step 7 → `7. **承認**: Executive Summary の直後に \`workflow-cli ask-approval\` の出力をそのまま AskUserQuestion に渡し、人間が文書を選ぶ。キャンセルされたら議論し、済んだら人間が \`approve\` と打つ（下記 CRITICAL）。`
  4. ターン終端規則の末尾に足す → `判断を求める点が複数あるときは、文章で並べず AskUserQuestion でまとめて聞く。承認の依頼は同じターンで質問まで出し、回答の後に \`[approval-answer-recorder]\` の返答が無ければ \`workflow-cli status\` で確かめる。`
  5. Executive Summary の Next Action → `- **Next Action**: 続けて出す承認の質問で文書を選んでください / 議論したいときは Esc でキャンセルしてチャットし、済んだら \`approve\` / 追加修正を依頼してください`
  6. 5 の後に 13312 byte を超えていたら: CRITICAL 節の「hash が動く改訂は再承認が要る。…」の行を reference skill の「承認の記録」節に移す（同じ内容がその節に既にあれば削るだけ）。それでも超えるなら、ここで止めて利用者に報告する（上限を上げるかは利用者が決める。spec K10）。
- [ ] **Step 5: 通過を確認** — Step 3 のコマンドで PASS。`wc -c` が 13312 以下。`rg -n '会話で .承認.（複数なら文書名も）' home/dot_claude/rules/workflow.md` が 0 件。
- [ ] **Step 6: コミット** — `git add home/dot_claude/rules/workflow.md home/dot_claude/hooks/tests/unit/workflow-md-budget.test.ts .skills/document-workflow-reference/SKILL.md`（Step 1・4-6 で skill を変えた場合）→ `docs(rules): approve through AskUserQuestion and batch decision questions`。

### T2: reference skill の承認の節と CLI の節を直す（spec K12）

**Files:**

- 編集: `.skills/document-workflow-reference/SKILL.md`（三状態の節の Approval Status の行、「承認の記録」節、`workflow-cli` のサブコマンドの節）
- 参照: spec.md K3（判定の順・記録しない条件・返答の種類）、K5（`via`）、K6、K7、K8

- [ ] **Step 1: 変更**
  - Approval Status の行 → `- **Approval Status**: \`pending\` → \`approved\`（**人間のみ**。承認の質問で文書を選ぶか、会話で \`approve\` と書くと hook が記録して書き換える。下記「承認の記録」）`
  - 「承認の記録」節の先頭に、AskUserQuestion の経路の項目を足す: `workflow-cli ask-approval` が質問の JSON を出す（承認待ちの先頭 3 件、標準エラーに注意）/ `approval-answer-recorder`（PostToolUse）が `tool_response` だけを読み、記録時点の状態から作り直した質問と深い等価で一致したときだけ記録する / 記録しない条件（spec K3 の一覧）/ 返答の種類（decline・notes・freeText・afk・malformed・notCandidate・部分失敗）/ 照合は全か無か、記録は文書ごと、回復は `ask-approval` の再実行 / ledger の行の `via`（`utterance` / `ask`）と `status` の表示 / guard は承認らしい質問の `answers` / `annotations` を deny する。
  - 既存の発話の項目を直す: 「名前なしは、承認待ちがちょうど 1 件のときだけ記録する」の後に「2 件以上なら記録せず、model に `ask-approval` で聞き直させる」を足す。診断の次の 1 手を「承認の質問で選ぶか、会話で `approve <文書名>` と書く」に変える。
  - `workflow-cli` のサブコマンドの節に `workflow-cli ask-approval` の項を足す（出力の形、3 件の上限、標準エラー、終了コード 1 の条件）。`status` の項に `approval via:` の行を足す。`triage` の項に「成功時に次の一手として `ask-approval` を出す」を足す。
- [ ] **Step 2: 検証** — `rg -n '会話で『承認 <文書名>』と書く|会話で .承認. と書くと hook' .skills/document-workflow-reference/SKILL.md` が 0 件。`rg -c 'ask-approval' .skills/document-workflow-reference/SKILL.md` が 3 以上。`bun run test`（`document-hash.test.ts` と `mechanical-lane-routing.test.ts` は同じ SKILL.md を読む）が通る。
- [ ] **Step 3: コミット** — `docs(skills): describe the AskUserQuestion approval route`。

### T3: 旧案内が残っていないことを確かめる（spec K12、確認のみ）

コードの文言の修正は plan-1（T3・T4・T6）で行い、その肯定形の確認（新しい文言に `ask-approval` と `approve` が含まれること）は plan-1 のテストにある。このタスクは文書を含む全体の否定形の確認だけを行う。

- [ ] **Step 1: 検証** — `rg -n '会話で.{0,6}承認|承認 <文書名>|「承認 |『承認 |承認.{0,4}(と書|と打|と入力)|ask the user to write|says 承認|type 承認|write 承認|(type|write|say) .?approve' --glob '!docs/decisions/**' --glob '!docs/plans/**' --glob '!**/tests/**' --glob '!.tmp/**' .` の出力を 1 件ずつ見る。発話の経路（`approve` / `承認`）だけを案内し AskUserQuestion の経路に触れない箇所が残っていれば、その箇所を spec K12 の方針に直す。直す箇所がこのタスクの Files（workflow.md・SKILL.md）なら T1・T2 のコミットに足し、それ以外（コード、他の rule、template）なら plan-1 に戻して利用者に報告する（このタスクでは Files の外を変えない）。

### T4: ADR-0023 に改訂節を足す（spec K11）

**Files:**

- 編集: `docs/decisions/0023-workflow-identity.md`（末尾の References の前）
- 参照: spec.md の Alternative Approaches・K11・Risks、research.md の実測の表

- [ ] **Step 1: 変更** — 「## 改訂（2026-10-03）: AskUserQuestion による承認の経路」節を、「改訂（2026-10-03）: 予約したプロンプトの承認（課題 J）」節の後ろに足す。前の節の本文は書き換えない。書く項目（spec K11 の列挙と、spec の Risks で「ADR に書く」としたもの）:
  - 前の節の (c) の却下を差し替えること。却下理由 2 つの解消: 「任意の時点で打てなくなる」は発話を残して経路を足すので成り立たない / 「`tool_response.answers` が未実測」は research の実測の試行 T2〜T4 で実測した（research の表を載せる。plan のタスク番号ではない）。
  - 決定: spec K1〜K9 の要約（各 1〜2 行）。K4 は実装に合わせて書く（`GUARDED_TOOLS_FOR_TESTING` は残さず、集合と配線の食い違いはテンプレートの matcher のテストで検出する。plan-1 T6 Step 1 の逸脱とその理由）。
  - 信頼の根の移動と K3 の完全一致による補い。質問に載せる文書の集合と順序は model が選べ、保証されるのは利用者の選択を経由することだけ。
  - `承認しない` は記録に残らず、過去の承認を取り消さない。ledger の `via`。
  - 残るリスク: R3・R5・R6・R7・R8（spec の Risks の要約）と R9（発火点は助言）。
  - R1 の補足: 起動済みのセッションに hook の変更が入らないのは従来どおりで、この変更に固有なのは「`workflow-cli` は呼ぶたびに読まれて `chezmoi apply` の直後から新しい挙動になるが、hook の登録は起動時にしか読まれない」ずれだけである。起動済みのセッションで `ask-approval` を使うと、回答しても記録されない。`ask-approval` の標準エラーの注意と、`approve` の発話で回復できる。
  - 再訪の条件: Claude Code の更新で `tool_response` の形が変わったとき（記録しない側に倒れるので、T6 と同じ手順で測り直す）。
- [ ] **Step 2: 検証** — `rg -n '改訂（2026-10-03）: AskUserQuestion' docs/decisions/0023-workflow-identity.md` が 1 件。`git diff docs/decisions/0023-workflow-identity.md` に削除行（`-` で始まる行）が無い。
- [ ] **Step 3: コミット** — `docs(decisions): record the AskUserQuestion approval route in ADR-0023`。

### T5: 配備する

- [ ] **Step 1: 前提の確認**（順序: plan-1 の全コミット → このプランの T1・T2・T4 のコミット → この確認 → 配備）
  - `git log --oneline` に plan-1 の T1〜T9 のコミット（`feat(hooks): wire the approval answer recorder` まで）と、このプランの T1・T2・T4 のコミットがある。恒久的な戻しに使うため、plan-1 の全コミットとこのプランの T1・T2・T3 のコミット（コードと、`ask-approval` を案内する文書。T3 で直しを別のコミットにした場合はそれも）の SHA を、古い順に 1 行 1 つで `~/.claude/backups/approval-ask.commits.txt` に書く。書き込みは `(umask 077 && mkdir -p ~/.claude/backups && printf '%s\n' <SHA…> > ~/.claude/backups/approval-ask.commits.txt)` の形で行う（ディレクトリが無くても作り、作成の時点から権限を絞る）。SHA は `git log --oneline` の件名で 1 つずつ選び、範囲指定で集めない（並行セッションのコミットが間に入っていても含めないため）。書いた後に `git show --stat --format=%s $(cat ~/.claude/backups/approval-ask.commits.txt)` で、すべてこの作業のコミットであることを確かめる。T4 の ADR のコミットは含めない（戻したことを ADR に追記する方が記録として正しい）。
  - `bun run test`・`bun run typecheck`・`bun run lint` が通る。
  - `git status --short` が空である。空でなければ（並行して動いている別のセッションの作業中の変更を含む）、`chezmoi apply` で一緒に配備されるので、ここで止めて利用者に報告する。配備は、利用者がそれらの変更をコミットするか片付けた後に行う。
  - `chezmoi status` の一覧を利用者に示す。このプランで変わる見込みの配備先は、`~/.claude/settings.json`、`~/.claude/hooks/` の下、`~/.claude/rules/workflow.md`、`~/.local/bin/workflow-cli` の参照先（`~/.claude/hooks/cli/workflow.ts`）、`~/.claude/skills/document-workflow-reference/`（rsync）である。これ以外の配備先や run script が一覧に出たら、それが何の変更かを利用者に確認してもらう。
- [ ] **Step 2: 退避** — セッションの scratchpad は再起動で消えうるので、永続の場所に置く。作成の時点から権限を絞るため umask の中で行う: `(umask 077 && mkdir -p ~/.claude/backups && cp ~/.claude/settings.json ~/.claude/backups/settings.json.pre-approval-ask) && jq -e . ~/.claude/backups/settings.json.pre-approval-ask > /dev/null`。最後のコマンドが 0 で終わる（JSON として読める）ことを確かめる。
- [ ] **Step 3: 配備** — 利用者の了承を得てから `chezmoi apply` を実行する（`$HOME` の設定を書き換える操作）。settings.json は run script（`run_onchange_update-settings-json.sh.tmpl`）が作るので、パス指定ではなく引数なしで行う。
- [ ] **Step 4: 配備の確認** — `jq -r '.hooks.PreToolUse[] | select(any(.hooks[]; .command | contains("document-workflow-guard"))) | .matcher' ~/.claude/settings.json` の出力が `Write|Edit|MultiEdit|NotebookEdit|Bash|CronCreate|ScheduleWakeup|AskUserQuestion` と完全に一致する。`jq -r '.hooks.PostToolUse[] | select(any(.hooks[]; .command | contains("approval-answer-recorder"))) | .matcher' ~/.claude/settings.json` の出力が `AskUserQuestion` と完全に一致する。
- [ ] **Step 5: 利用者への通知** — 次を伝える。
  - 起動済みのセッション（このセッションと並行しているセッションを含む）は新しい hook を持たないので、承認は発話の `approve` で行うか、再起動する。
  - 戻し方（3 段。どれも利用者のシェルで実行でき、guard が Claude の操作を止める場合でも使える）:
    1. 緊急（AskUserQuestion の誤動作。例: すべての AskUserQuestion が deny される、回答が記録されない）: `cp ~/.claude/backups/settings.json.pre-approval-ask ~/.claude/settings.json` を実行してセッションを起動し直す。戻るのは hook の登録（matcher と PostToolUse の entry）だけで、hook のコード・`workflow-cli`・workflow.md は新しいまま。これは暫定の措置で、次に `.settings.*` を変えて `chezmoi apply` すると上書きされる。配備の後に `claude plugin` が書いた `enabledPlugins` もこの時点の値に戻る。
    2. 恒久（コードの誤動作を含む）: リポジトリで `git revert --no-edit $(tac ~/.claude/backups/approval-ask.commits.txt)`（Step 1 で書いた SHA を新しい順に戻す。範囲指定ではないので並行セッションのコミットを巻き込まない）を実行してから `chezmoi apply`。コードと、`ask-approval` を案内する workflow.md・SKILL.md が一緒に戻る。revert が衝突したら `git revert --abort` で元に戻し、衝突したファイルを利用者が見て判断する（1 の暫定措置はそのまま使える）。配備の後に `approvals.log` に書かれた `via` のキーは、戻した後の旧コードの読み手（`parseRecord`）が無視するので、ledger はそのまま使える（research）。戻したことは ADR-0023 の改訂節に追記する。
    3. 最終手段（guard が Write / Edit / Bash を誤って止め、2 の操作もできない）: `jq '.hooks.PreToolUse |= map(select(all(.hooks[]; ((.command // "") | contains("document-workflow-guard")) | not)))' ~/.claude/settings.json > ~/.claude/settings.json.tmp && mv ~/.claude/settings.json.tmp ~/.claude/settings.json` で guard の登録を外し、セッションを起動し直して 2 を行う。2 の後の `chezmoi apply` で guard の登録は戻る。（`.command` の無い hook があっても落ちないよう `// ""` を付けている。jq が失敗したときは `&&` で `mv` が走らず、settings.json は変わらない）
  - T6 が合格し戻す必要が無くなったら、`rm ~/.claude/backups/settings.json.pre-approval-ask ~/.claude/backups/approval-ask.commits.txt` で退避ファイルを消す（利用者が行う）。

### T6: 配備後の確認（spec R6、新しいセッション、使い捨ての repo）

配備の後に、利用者が使い捨ての repo で起動した新しいセッションで行う。実在の作業の wfDir を使わないのは、確認で書く承認が実在の gate を開かないようにするため。このセッション（配備前に起動）では行わない。spec R6 の確認項目（偽陰性なし・answers の deny・Esc・`via=ask`・SessionStart の監査）に加え、Step 4・5 は spec K3・K4 の不変条件（形が違う質問は記録されない、一般の質問は止まらない）の実機確認、Step 7 は K6 の実機確認として足している。

- [ ] **Step 0: 準備（利用者）** — 利用者のシェルで `echo "${DOCUMENT_WORKFLOW_DIR-unset}"` が `unset` であることを確かめる（設定されていると、新しいセッションの wfDir が使い捨ての repo の外を指しうる）。続けて `d=$(mktemp -d) && cd "$d" && git init -q && echo "$d" && claude` を実行する（表示された `$d` を控える）。新しいセッションの最初の出力（SessionStart）に、PostToolUse の recorder の登録を報告する行があり「covers」であること、`/hooks` に PostToolUse の `AskUserQuestion` が見えることを確かめる。
- [ ] **Step 1: fixture（新しいセッションの model）** — 次の 1 行で、承認待ちの spec.md と plan-1.md を wfDir に作る（test-helpers の関数で、Review が pass の marker と正しい hash を持つ文書を書く。marker を手で書かない。gate と `evaluateApprovalReadiness` が見るのは marker の verdict と hash で、`reviewer-runs.log` は見ないので、これで承認待ちになる）。先頭の `case` で、WF が使い捨ての repo（Step 0 の `$d`、ここでは新しいセッションの cwd）の `.tmp/sessions/` の下でなければ何もせずに止める:
      `WF="$(workflow-cli dir | sed -n 's/^wfDir=//p')"; case "$WF" in "$PWD"/.tmp/sessions/?*) ;; *) echo "abort: WF=$WF"; exit 1;; esac; WF="$WF" bun -e 'import {buildPlanContent,buildPlanNContent,computeWorkflowRepoPlanHash} from "/home/berlysia/.local/share/chezmoi/home/dot_claude/hooks/tests/unit/test-helpers.ts"; import {mkdirSync,writeFileSync} from "node:fs"; const wf=process.env.WF; mkdirSync(wf,{recursive:true}); const o={planStatus:"complete",approvalStatus:"pending",review:{verdict:"pass"}}; const spec=buildPlanContent(o); writeFileSync(wf+"/research.md","# fixture\n"); writeFileSync(wf+"/spec.md",spec); writeFileSync(wf+"/plan-1.md",buildPlanNContent(o,["a.ts"],computeWorkflowRepoPlanHash(spec)));'`
      この Bash の書き込みが新しいセッションの guard に止められたら、model は別の書き方（heredoc、別の interpreter など）で迂回せず、同じ 1 行を利用者が自分のシェル（`cd "$d"` した後）で実行する。`workflow-cli ask-approval` が 2 件（spec.md・plan-1.md）の質問を出せば準備完了。出なければここで止め、出力を利用者に報告する。各 Step の前に同じ 1 行を実行して承認待ちの状態に戻す（承認行が pending に戻り、文書は候補に戻る）。
- [ ] **Step 2: 記録される（偽陰性が無い、2 件と 1 件）** — `ask-approval` の出力で AskUserQuestion を出し、利用者が 2 件とも選ぶ。判定は `tail -2 "$WF/approvals.log"` の 2 行が `via:"ask"` で、`workflow-cli status` に `via=ask` が出ること。fixture を戻し、利用者が spec.md だけを選ぶ → `approvals.log` が 1 行増えて spec.md だけ。
- [ ] **Step 3: model の answers が止まる** — 同じ質問を `answers` 付きで出す → guard が deny する。判定は `approvals.log` の行数が変わらないこと。
- [ ] **Step 4: 形が違う質問は記録されない** — 次の 2 つをそれぞれ出し、利用者が spec.md を選ぶ。(a) CLI を通さずに言い換えた質問（`question` が「spec.md を承認しますか」、選択肢が `spec.md` と `いいえ`）、(b) `ask-approval` の出力の description の hash を 1 文字変えた質問（`answers` は付けない）。判定はどちらも `approvals.log` の行数が変わらないこと。
- [ ] **Step 5: 一般の質問は止まらない** — 一般の質問（「どちらがよいか」）を `answers` 付きで出す → guard が deny しない。
- [ ] **Step 6: Esc** — 質問を Esc でキャンセルする → `approvals.log` の行数が変わらない。
- [ ] **Step 7: 2 件以上の素の approve（spec K6 の確認）** — fixture を戻し（承認待ち 2 件）、利用者が `approve` と打つ → `approvals.log` の行数が変わらず、model が `ask-approval` の質問を出す。
- [ ] **Step 8: 記録** — 結果（各 Step の合否と、判定に使った `approvals.log` の行）を、このセッションに戻ってから ADR-0023 の改訂節の末尾に「配備後の確認（日付、Claude Code の版）」として追記してコミット（`docs(decisions): record post-deploy checks for the approval route`。spec K11 の「残るリスク R6」の解消状況として書く）。1 つでも不合格なら、その Step と観測を書いて利用者に報告し、T5 Step 5 の戻し方を使うかを利用者が決める。修正は別の計画にする。使い捨ての repo（`$d`）の削除は利用者が行う。

### T7: セッション成果物を退避する

根拠: rules/workflow.md の Session Artifact Retention（「`.tmp/sessions/` は 7 日超で GC される。残す成果物はセッション終了前に再配置する: 実装計画 → `docs/plans/`」）。前例: `docs/plans/workflow-identity/`。

残すもの: 実測 T2〜T4 の生の記録（research）、却下した代替案と各ラウンドのレビュー指摘（spec の Alternative Approaches・Reviewer Outputs）、タスクごとのテスト設計（plan-1・plan-2）。残さないもの: `approvals.log`・`reviewer-runs.log`・marker の帳簿（セッション固有の状態）。残さなければ、ADR-0023 の改訂節は要約だけになり、K3 の照合条件や記録しない条件の一覧を見直すときの根拠（どの指摘から足したか）が 7 日後に失われる。

- [ ] **Step 1: 前提** — T6 Step 8 の記録がコミットされている（合格でも不合格でも、結果が ADR に書かれていること）。ただし、T6 が利用者の都合で始められないまま、このセッションの wfDir の作成（2026-10-03）から 6 日が過ぎそうなら、GC で失われる前に Step 2 を先に行い、T6 の結果は後で ADR にだけ追記する。
- [ ] **Step 2: 複製とコミット** — wfDir の `research.md`・`spec.md`・`plan-1.md`・`plan-2.md` の最終版（承認済みの版。Reviewer Outputs を含む）を `docs/plans/approval-ask/` に複製する。ADR-0023 の改訂節（T4）の補足として、節の末尾に「設計の全文: `docs/plans/approval-ask/`」の 1 行を足す。コミット `docs(plans): keep the approval-ask workflow documents`。

## ISO 25010 具体テストケース

### 機能適合性

- **入力**: T6 Step 2 の操作（2 件を選ぶ）→ **期待**: `approvals.log` の最後の 2 行の `via` が `"ask"`、`workflow-cli status` の出力に `via=ask`。
- **入力**: T6 Step 7 の操作 → **期待**: `approvals.log` の行数が変わらず、model が AskUserQuestion を出す。

### セキュリティ

- **入力**: T6 Step 3・Step 4 の操作 → **期待**: `approvals.log` の行数が変わらない。
- **入力**: `workflow-md-budget.test.ts` → **期待**: 3 つの固定文字列の検査が通る。

### 使用性

- **入力**: T6 Step 5・Step 6 の操作 → **期待**: 一般の質問は deny されない。Esc で何も記録されず、エラーも出ない。

### 保守性

- **入力**: `wc -c home/dot_claude/rules/workflow.md` → **期待**: 13312 以下。

### 回復性（配備）

- **入力**: T5 Step 2 の後に `jq -e . ~/.claude/backups/settings.json.pre-approval-ask` と `stat -c %a` → **期待**: JSON として読めて終了コード 0、権限が `600`。

## Approval

- Plan Status: complete
- Review Status: pass
- Approval Status: approved

## Reviewer Outputs (Round 1)

### logic-validator

- verdict: needs-work
- 主指摘: T3 の grep が英語の deny 文に掛からず、直す対象のコードを plan-2 が抱えている（plan-1 へ移す）。T1 の容量の確認を項目ごとにし、移す項目の存在を先に rg で確かめる。T7 は T6 の記録の後に限る。reference skill の CLI 節に `ask-approval` を足す。

### scope-justification-reviewer

- verdict: needs-work
- 主指摘: T7 の成果物の退避は spec に根拠が無い（根拠を書くか外す）。T6 の Step 5・Step 6 の根拠を書き、Step 3 の判定は log の行数を主にする。T4 の「R1 の訂正」は「補足」と呼ぶ。T3 の grep の括弧の違い。

### architecture-boundary-analyzer

- verdict: pass
- 主指摘: コードの境界に触れない。軽微: 固定文字列の検査と rg の確認が二重。

### security-vulnerability-analyzer

- verdict: needs-work
- 主指摘: T6 の fixture が実在のセッションの承認状態を汚し、marker の手書きが stamp の証跡を迂回する（使い捨ての repo で行う）。言い換えの質問・hash を変えた質問・一般の質問 + answers の実機確認、1 件と複数件の確認を足す。T3 の grep の範囲と書き方。

### deployment-readiness-evaluator

- verdict: needs-work
- 主指摘: 引数なしの `chezmoi apply` が並行セッションの未コミットの変更や無関係な run script まで配備する（作業ツリーの確認と差分の照合）。ロールバックの手順が無い（settings.json の退避と、利用者のシェルで実行できる復旧コマンド）。起動済みのセッションへの通知と、plan-1 のコミットの確認。

<!-- auto-review: pending -->
<!-- intent-triage: pending -->

## Reviewer Outputs (Round 2)

### logic-validator

- verdict: pass
- 主指摘: Round 1 は解消、fixture の呼び出しは test-helpers のシグネチャと一致。軽微: `workflow-md-budget.test.ts` は top-level の `test(...)`。fixture が guard に止められたときの代替。`git status` が空であることの前提。jq のパスの違いの注記。

### scope-justification-reviewer

- verdict: needs-work
- 主指摘: T6 の fixture が新しいセッションの guard に止められうる。T6 Step 4・5 は K3・K4 の実機確認として追加したと書く。T7 の ADR への追記の位置づけ、T6 が長引いたときの T7 の先行。

### security-vulnerability-analyzer

- verdict: needs-work
- 主指摘: WF が使い捨ての repo の下にあることを確かめていない（`DOCUMENT_WORKFLOW_DIR` が残っていると実在の wfDir を上書きする）。fixture が止められたときの手順。T3 の grep の別表記。退避ファイルの権限と後始末。

### deployment-readiness-evaluator

- verdict: needs-work
- 主指摘: 退避先が scratchpad で永続でない。settings.json の復元では guard のコードは戻らない（2 段の戻し方と最終手段）。復元は次の apply で上書きされる暫定措置。T5 の前に T1・T2・T4 をコミットする順を明記。

### architecture-boundary-analyzer

- verdict: pass (carried from Round 1)
- 主指摘: Round 1 で pass、再実行なし

<!-- auto-review: verdict=needs-work; hash=fc59ffa32b96f6f19f127e8d55dc15342995cfaaaa6c8ad76dcbe37f2c9bc9c1; design-hash=6b31000b6d9bbf5bf726eacb9c53186f741d1ade8a20418d2b79c233cdf427ca; round=1; parent-spec-hash=98dfec921058b7bc43fc11c288ae0bedfe7daac7ce28c000f8228f2ce7384c15; at=2026-10-02T20:07:59.284Z; reviewers=logic-validator+scope-justification-reviewer -->
<!-- intent-triage: adopted=18; excluded=0; at=2026-10-02T20:07:59.314Z -->

## Reviewer Outputs (Round 3)

### logic-validator

- verdict: needs-work
- 主指摘: Round 2 は反映済み、rollback の jq と `case` は実行して確認。恒久の戻しが plan-2 の文書の変更（`ask-approval` の案内）を戻さない。範囲の revert が並行セッションのコミットを巻き込みうる。

### scope-justification-reviewer

- verdict: pass
- 主指摘: Round 2 の 3 点は解消。軽微: T7 の ADR への追記は配備の後のコミットになる。

### security-vulnerability-analyzer

- verdict: pass
- 主指摘: Round 2 の 4 点は解消、`tool_input` の veto の却下に同意。軽微: 退避の作成から chmod までの権限の窓、T3 の grep の別表記（「承認と書く」など）。

### deployment-readiness-evaluator

- verdict: pass
- 主指摘: Round 2 は解消。軽微: 最終手段の jq は `.command` の無い hook で落ちる（`(.command // "")` にする）。範囲の revert の前に範囲の中身を確かめる。控えた SHA を永続の場所に書く。

### architecture-boundary-analyzer

- verdict: pass (carried from Round 2)
- 主指摘: Round 2 で pass、再実行なし

<!-- auto-review: verdict=needs-work; hash=b009c96a2ad5ab3d2a6ebc7d23810e3fd5421f2655519ee26cdf15a843cc7065; design-hash=6ae4e6d77f9480c81fc7af2b9a2e23529888989b6c5d8f8c5ff6cd2cc519598b; round=2; parent-spec-hash=98dfec921058b7bc43fc11c288ae0bedfe7daac7ce28c000f8228f2ce7384c15; at=2026-10-02T20:13:27.122Z; reviewers=logic-validator+scope-justification-reviewer -->
<!-- intent-triage: adopted=14; excluded=0; at=2026-10-02T20:13:27.151Z -->

## Reviewer Outputs (Round 4)

### logic-validator

- verdict: needs-work
- 主指摘: Round 3 の 2 点は解消（`tac` で新しい順に revert、T1 の revert で本文とテストが一緒に戻る）。T5 Step 1 が `~/.claude/backups` を作る前に書き込む。T3 の追加コミットが SHA の一覧から漏れうる。軽微: revert の衝突時の手順、旧コードが `via` を無視するかの確認。

### scope-justification-reviewer

- verdict: pass (carried from Round 3)
- 主指摘: Round 3 で pass、再実行なし

### security-vulnerability-analyzer

- verdict: pass (carried from Round 3)
- 主指摘: Round 3 で pass、再実行なし

### deployment-readiness-evaluator

- verdict: pass (carried from Round 3)
- 主指摘: Round 3 で pass、再実行なし

### architecture-boundary-analyzer

- verdict: pass (carried from Round 3)
- 主指摘: Round 3 で pass、再実行なし

<!-- auto-review: verdict=needs-work; hash=90ff75e18adbdc1a8ada1f65378dcc410b2b9673128397cdb1a9aee094a3ec01; design-hash=4375f9a3a51cce45cadee8a913072b9dca85ce2c8cb9dad7d2ae8867749a1acc; round=3; parent-spec-hash=98dfec921058b7bc43fc11c288ae0bedfe7daac7ce28c000f8228f2ce7384c15; at=2026-10-02T20:16:44.915Z; reviewers=logic-validator+scope-justification-reviewer -->
<!-- intent-triage: adopted=8; excluded=0; at=2026-10-02T20:16:44.947Z -->

## Reviewer Outputs (Round 5)

### logic-validator

- verdict: pass
- 主指摘: Round 4 の 4 点は解消、新しい矛盾なし。軽微: T4 の「T2〜T4」が plan のタスク番号と紛らわしい → research の試行と明記して反映済み。

### scope-justification-reviewer

- verdict: pass (carried from Round 4)
- 主指摘: Round 4 で pass、再実行なし

### security-vulnerability-analyzer

- verdict: pass (carried from Round 4)
- 主指摘: Round 4 で pass、再実行なし

### deployment-readiness-evaluator

- verdict: pass (carried from Round 4)
- 主指摘: Round 4 で pass、再実行なし

### architecture-boundary-analyzer

- verdict: pass (carried from Round 4)
- 主指摘: Round 4 で pass、再実行なし

<!-- auto-review: verdict=needs-work; hash=94dca87723fd057c793d6f0b6de536175b2e5d849c14a8e12df73ad4ee984be9; design-hash=6996ab96a6b56fa86ce375322dc5d575c39b7c10bb955ae7c8d1a2a6de648ded; round=4; parent-spec-hash=98dfec921058b7bc43fc11c288ae0bedfe7daac7ce28c000f8228f2ce7384c15; at=2026-10-02T20:18:20.891Z; reviewers=logic-validator -->
<!-- intent-triage: adopted=4; excluded=0; at=2026-10-02T20:18:20.907Z -->

<!-- auto-review: verdict=pass; hash=ad67bda021b2d97617e571ef005ee71816b3145460c46e099557bcb9a1ffafc9; design-hash=43e8d18d12390c956167e4c0630219b69ef0eec0d03f731813507a2d914adca9; round=5; parent-spec-hash=98dfec921058b7bc43fc11c288ae0bedfe7daac7ce28c000f8228f2ce7384c15; at=2026-10-02T20:19:15.712Z; reviewers=logic-validator -->
<!-- intent-triage: adopted=2; excluded=0; at=2026-10-02T20:19:15.729Z -->
