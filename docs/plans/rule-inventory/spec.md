# Spec: Document Workflow 規則の棚卸しと削除基準の改訂

## Goal

常時ロードされる `workflow.md` から、次の 2 種類の文を外す。

- hook や CLI がその場で同じ指示を出し、その指示を見逃しても後で機構に止められる文。
- ほかの文書と重複する文。

あわせて、ADR-0025 K5 の削除基準を、調査で分かった次の 2 点に合わせて改訂する。

- 出力がモデルに届くかどうか。
- 使用実績をどう扱うか。

## Experience Delta

- 変更前:
  - workflow.md は 11,429 bytes で、予算 12,288 bytes に対する余裕は 859 bytes。規則を 1 つ足すたびに削る作業が要る。
  - workflow.md の一部の文は、CLI のエラーや hook の推奨文と同じことを言っている。
  - ADR-0025 K5 の ENFORCED は「強制がある」だけで成り立つ。そのため、モデルに届かない stderr の警告も、1 回しか出ない通知も、削除の根拠になりえた。
  - 存在しない節名の参照が 3 箇所ある（test-design skill の 2 箇所と、workflow.md の「脱出手順」）。ADR-0025 K3 の記述は、事実とずれている。
- 変更後:
  - workflow.md は約 320B 小さくなり（11,429 → 約 11,110 bytes）、予算の余裕は約 1.18KB になる。見積もりは D4 で、実測は plan で行う。
  - 棚卸しの結果、workflow.md の大半の規則は残る。理由は 3 つある。作業の前に判断が要る。届く出口が無い。通知が 1 回きりで、見逃すと取り返せない。
  - 削除の基準は 2 つの条件を両方満たすことを要件にする。1 つは、その時点でモデルに届く出力が同じ指示を伝えること。もう 1 つは、指示を見逃しても後で機構が止めること。
  - 使用実績は、単独では削除の根拠にしないと明記する。
  - 節名の参照は、実在する節を指す。

## Architecture

文書の役割分担は変えない。

- `workflow.md`（常時ロード）: 作業の前と最中に、モデルが自分で判断する規則。
- `SKILL.md`（必要時に読む）: 機構の説明。今回は内容を移さない。
- hook・CLI の出力: 規則が届く経路の 1 つ。今回は変更しない。

## Alternative Approaches (Greenfield View)

### 差分最小案 (Incremental)

ADR-0025 K5 の 5 タグをそのまま使い、research.md の判定表で根拠が付く文だけを削る。ADR の修正は、K3 の事実のずれだけにする。

- 起源: セッション A と同じ手順で、基準は変えない。
- 欠点: ENFORCED は、モデルに届かない stderr の警告（off-plan）でも成り立つ。1 回だけ出てコンパクションで消える通知（トリアージの指示）でも成り立つ。基準がそのままだと、残すべき文に根拠を付けて削れてしまう。引き継ぎが求める「前提を変える」にも答えていない。

### 白紙設計案 (Greenfield)

規則を、モデルがそれを必要とする時点ごとに並べ替える。

- 作業の前に判断が要る規則は、常時ロードの文書に置く。
- 出来事が起きたその時点で届き、見逃しても機構が止める規則は、hook と CLI の出力に任せる。
- 機構の説明は skill に置く。
- 届かない出口（PreToolUse で exit 0 のときの stderr）は、文書で補う。ただし本来は、hook の側で届く出口に直す。

起源: 規則の置き場を「誰が、いつ、それを必要とするか」で決めると、この形になる。

### 採用案と理由

白紙設計案の配置の原則を採る。ただし今回は hook の出口を直さない。採用案は白紙設計案とほぼ同じ形になり、違いは次の 2 点だけである。

- 届かない出口を直す作業を見送り、ADR-0026 の帰結に課題として記録する（K6）。hook の変更は文書の棚卸しとは別のテストと検証を要する。research.md で届かないと分かった出口は off-plan の警告 1 つで、その規則（W34）は workflow.md に残すので、今回は害が生じない。
- 配置の判定には、research.md の表の「到達」列（実測）と、D1 の「見逃しても止まるか」を使う。到達が n と判定された 7 行（W03, W06, W25, W32, W34, W37, W38）は、hook で置き換えられないので残す。
- research.md の表のうち、W19、W32、W34、W35、W40 の判定は、この spec の D4 が上書きする。

## Key Decisions

spec の決定は D1-D7 と呼ぶ。ADR-0025 の決定（K1-K6）と区別するためである。

- **D1: ENFORCED の要件を 2 条件の AND にする**
  - (a) 届くこと: hook・CLI の出力が、規則が当てはまる時点かその直前にモデルに届き、同じ指示を伝える。届く経路は、PostToolUse の `additionalContext`、Stop の block 理由、CLI の出力、deny の理由である。
  - (b) 見逃しても止まること: (a) の通知がコンパクションなどで失われても、違反は後で機構に止められる。機構とは、deny、CLI の非 0 終了、gate の拒否を指す。人が気づくことは (b) に含めない。
  - 次のものは根拠にしない。PreToolUse で exit 0 のときの stderr、SessionStart の `systemMessage`、黙って通す処理。
  - 適用の例:
    - W16（起動証跡）は stamp が失敗するので (b) を満たす。
    - W19（トリアージ前に提示しない）は、提示した後では取り返せないので (b) を満たさない。
  - 参照: `home/dot_claude/hooks/implementations/document-workflow-guard.ts:261,311`（off-plan の警告は `console.error` の後に `context.success({})` を返す。`:345` のコメントは内部エラーの経路について、PreToolUse で exit 0 のとき stderr はモデルに届かないと書いている。off-plan の経路も同じく exit 0 である）
  - 参照: `home/dot_claude/hooks/implementations/session.ts:287-291`（`systemMessage` は UI に出るだけ）
  - 参照: `home/dot_claude/hooks/lib/workflow-review-core.ts:816-818`（トリアージの指示は、reviewer の推奨文と一緒に 1 回出るだけ）
  - 参照: `home/dot_claude/hooks/cli/workflow.ts:832`（台帳に起動証跡が無ければ stamp が失敗する）
- **D2: 使用実績は単独で削除の根拠にしない**
  - transcript で測れる窓は約 10 日で、実際に使っているプロジェクトは 2 つしかない。脱出（0 件）や S3 移行（0 件）は、設計上まれにしか起きない規則である。
  - 使用実績は、削る候補の優先順位の目安と、hook が実際に発火していることの確認にだけ使う。
  - 参照: research.md「使用実績の窓（分母）」
- **D3: SKILL.md には ENFORCED を削除の根拠として当てない**
  - SKILL.md は、deny や迷いが起きたときに機構を説明する文書である。hook が強制していることは、説明を消す理由にならない。SKILL.md の文を削れるのは DUP / NOISE / MOVE のときだけとする。
  - workflow-cli サブコマンド節の頻度の低い部分（`--wf-dir` の検証、出力形式）は references に分けない。skill 自体が 44 本中 4 本でしか読まれず、分けても常時の負担は減らないからである。
  - 参照: `.skills/document-workflow-reference/SKILL.md:110-120`
- **D4: workflow.md で外す文と直す文**
  - バイト数は、外す文字列と新しい文を `wc -c` で測った値である。
  - 外す文:
    - **ENFORCED**（D1 の (a)(b) を満たす）:
      - W16 の「起動証跡（`reviewer-runs.log`）が無いと stamp は通らない。」（74B、`:35`）。
        - (a): stamp が失敗したときに、CLI が同じ指示を出す（`cli/workflow.ts:832`）。
        - (b): stamp が非 0 で終わる。
      - W17 の括弧書き「（`round` / `stamp` もこの集合）」（39B、`:36`）。
        - 「前 round の非 pass reviewer + `logic-validator` だけ再実行」の本文は残す。stamp が強制するのは常駐 reviewer の分だけで、内容で選ばれた reviewer を飛ばしても止まらないからである（`cli/workflow.ts:810-813`）。
        - 括弧書きは、`round` と `stamp` がこの集合を使う、という機構の説明である。正確には、stamp の要求は round の出力の部分集合（常駐 reviewer の分）である（`cli/workflow.ts:810-813`）。
        - round の出力（`re-run: …; carried: …`、`cli/workflow.ts:647-653`）が、reviewer を走らせる直前にその集合を示す。常駐の分が欠ければ stamp が非 0 で終わる。
        - 「Key Decisions / 白紙案を変えたら `--full`」と「全員 pass で軽微なら stamp のみ」は残す。どちらも round を実行する前に、モデルが判断することだからである。
      - W33 の「実装系書き込み（Write/Edit/NotebookEdit/Bash）は `document-workflow-guard` が制御する。」と「`.tmp/` もプロジェクト内なので対象になる」の説明部分（差し引き 133B 減、`:93`）。
        - (a): 承認前に書き込もうとしたその時点で、deny の理由と `SCRATCH_HINT`（`document-workflow-guard.ts:56`）が届く。
        - (b): 書き込みは deny される。
        - 置き場の指示と禁止先は、残す文に入れる。新しい文は「承認前の使い捨て作業は session の scratchpad か `mktemp -d` の出力先に、リテラルの絶対パスで書く（`.tmp/` も guard の対象。他 repo・`$HOME`・dotfiles には書かない）。」とする。禁止先は guard の管轄外（プロジェクト外は対象外）なので、事前に知らせる必要がある。
    - **DUP**:
      - W39 の「ユーザーの期待を勝手に下げたり steering を無効化しない。」（79B、`:118`）。`home/dot_claude/CLAUDE.md:62`（配置先は `~/.claude/CLAUDE.md`、常時ロード）の Prohibitions に「Never lower user expectations or disable steering unilaterally」がある。
  - 直す文:
    - W25（`:51`、14B 減）の理由。「Bash の heredoc は中身を guard が書き込みと誤検出しうる」は古い。`de2882f` 以後、データだけの heredoc はマスクされる（`document-workflow-guard.ts:410-411`）。インタプリタの heredoc は書き込みとして判定される（`.skills/document-workflow-reference/SKILL.md:58`）。新しい文は「インタプリタの heredoc（`python3 - <<…` など）は guard が書き込みと判定しうる。Edit / Write なら `plan-review-automation` も発火する。」とする。
    - W06（`:22`、21B 増）の「脱出手順」を「誤って入った場合の脱出」に直す。
  - 残す文:
    - W19 の「トリアージ前に提示しない」。D1 の (b) を満たさない。
    - W35 の Executive Summary の書式（`:96-106`）。`buildSummaryReminder` は、pass の後に文書を Write / Edit したときにだけ、同じ hash につき 1 回出る（`plan-review-automation.ts:36-42,95-100`）。stamp を Bash で実行して終える経路では出ないので、(a) を満たさない。
    - W32（承認前の編集の許可、`:92`）。届く出口が無く（黙って通す）、DUP 先として示せる文も無い。
    - W34（off-plan）。届く出口が無い。この規則を伝える経路は workflow.md だけである。
    - W40（起動軸）。ADR-0011 の決定 1 がこの節を workflow.md に置いており、決定 6 の根拠でもある。
    - W30 の CRITICAL、ssot マーカー、mechanical-lane の行、`workflow-cli` と `document-workflow-reference` への言及。テストが文字列を検査している。
    - 共通フローの step 番号と節名（「Session Artifact Retention」など）。ほかの文書が参照している（`workflow-gate.ts:198` の step 1、`external-review.md:44` の共通フロー 5、`context-md.md:15`）。
  - 削減量の合計は 74 + 39 + 133 + 79 + 14 − 21 = 318B で、11,429 → 11,111 bytes になる。
  - 参照: `home/dot_claude/rules/workflow.md:22,35-36,51,93,118`
  - 参照: `home/dot_claude/hooks/tests/unit/workflow-md-budget.test.ts:25-73`
- **D5: test-design skill の壊れた節名参照（2 箇所）を直す**
  - `.skills/test-design/SKILL.md:31` の「`@~/.claude/rules/workflow.md` の「品質特性の選択ガイド」」を、「`/document-workflow-reference` の「ISO 25010 特性選択ガイド」」に直す。
  - `:43` の「`@~/.claude/rules/workflow.md` の「テスト観点の記述品質ルール」を適用する:」から、参照を外す。規則の中身はすぐ下の 3 項目に書かれている。文は「次の記述品質ルールを適用する:」にする。
  - `autonomous-lane.md` は変えない（W40 を残すので、`:5` の参照は壊れない）。`:15,58` の「routing 表」は ADR-0011 の用語で、Task Intake Routing を指すと読めるので直さない。
  - コードのコメント（`plan-review-automation.ts:258`）は、モデルに届かないので直さない。
- **D6: ADR は新規の ADR-0026 に書き、ADR-0025 は最小限の修正にとどめる**
  - D1-D3 の基準の変更は、ADR-0026 に「ADR-0025 K5 を改訂する」と明記して書く。
  - ADR-0026 の帰結には次の 3 つを書く。
    - 消した文の一部は、ほかの場所の文面に依存している。その文面を変えるときは、workflow.md に戻す必要がないか確かめる。依存先は次の 4 つである。
      - `cli/workflow.ts` の stamp の台帳エラー（W16）。
      - round の出力の `re-run:` 行（W17）。
      - `document-workflow-guard.ts` の deny と `SCRATCH_HINT`（W33）。
      - `~/.claude/CLAUDE.md` の Prohibitions（W39）。
    - 届かない出口（PreToolUse で exit 0 のときの stderr）を `additionalContext` に直す課題は見送った。直せば W34 は D1 を満たす。
    - 次の 2 つも、機構に置き換えれば D1 を満たして削れる。
      - W19（トリアージ前に提示しない）。たとえば、triage marker が無いときに Stop hook で止める。
      - W35（Executive Summary の書式）。たとえば、pass の stamp の出力に書式を含める。
    - いずれも hook の変更を伴うので、今回は見送った。
  - ADR-0025 の修正は次の 2 点だけにする。
    - Status に「K5 は ADR-0026 で改訂」を足す。ENFORCED の定義が変わったことを、読み手が Status から知れるようにする。
    - K3 の「今回はラウンド予算だけを分けた」を、事実（後の作業で、脱出、S3 移行、workflow dir の引き継ぎも分けた）に直す。
  - ADR-0025 は accepted 済みの経緯の記録である。基準の変更を別の文書にすれば、いつ何を変えたかを追える。
  - 却下: ADR-0025 の K5 を書き換える。記録としての ADR-0025 が、当時の判断の根拠と食い違う。
  - 参照: `docs/decisions/0025-deployed-docs-self-contained.md`（Status、K3、K5）
- **D7: 予算の定数は ADR-0025 K6 の式で再計算する**
  - 式は「実測値 + 1KB を 1KB 単位で切り上げ」（ADR-0025 K6、`0025:41`）。
  - 実測が 11,264 bytes 以下なら値は 12KB のままで、定数は変えない。見積もりは 11,111 bytes である。
  - 現在の 11,429 bytes にこの式を当てると 13KB になる。削った後の値で計算する。
  - テストのコメント（`workflow-md-budget.test.ts:21-24`、「about 11KB」）は、実測に合わせて直す。
  - 参照: `home/dot_claude/hooks/tests/unit/workflow-md-budget.test.ts:21-25`

## Risks

- **R1: 配置は worktree の変更では起きない。**
  - `chezmoi` の source と `workingTree` は main checkout を指す。`.skills/` は `workingTree` から rsync される。worktree の変更は、master に merge するまで `~/.claude` にも `~/.codex` にも届かない。
  - 対処:
    - merge 後に引数なしの `chezmoi apply` を実行する。
    - `~/.claude/rules/workflow.md`、`~/.claude/skills/test-design/SKILL.md`、`~/.codex/skills/test-design/SKILL.md` を source と diff する。
    - plan の検証手順に入れる。
- **R2: 文字列を検査するテストが壊れる。**
  - 対処: 実装後に全テストを実行する。特に次の 5 本を確かめる。
    - `workflow-md-budget`
    - `mechanical-lane-routing`
    - `document-hash`
    - `deployed-docs-repo-refs`
    - `plan-review-automation`（ssot の drift）
- **R3: ENFORCED で消した文は hook の文面に依存し、その文面をテストは守っていない。**
  - 依存先は stamp の台帳エラー、round の `re-run:` 行、guard の deny、`~/.claude/CLAUDE.md` の 4 つである。
  - 対処:
    - ADR-0026 の帰結に依存先を書く（D6）。
    - 文面を守るテストがあるかを plan で確かめる。無ければ、今回は記録だけにとどめると plan に書く。
- **R4: 使用実績の窓が短い。**
  - 対処: D2 のとおり、使用実績を理由に削る文はない。

## ISO 25010 次元選択

- **保守性（修正性）**: workflow.md の予算の余裕が 1KB 以上になり、規則を足すときに削る作業が要らなくなる。
- **機能適合性（正確性）**: 削った文の内容が、hook・CLI の出力か、ほかの常時ロード文書に実在する。節名の参照がすべて実在する節を指す。
- **対象外**: 性能効率性、セキュリティ、互換性。文書だけの変更で、hook の挙動は変えない。承認と書き込みの規則（W30、W33 の禁止先）は残す。

## Approval

- Plan Status: complete
- Review Status: pass
- Approval Status: approved

## Reviewer Outputs (Round 1)

### logic-validator

- verdict: needs-work
- 主指摘: W19 の通知は reviewer を起動する前に 1 回出るだけで、規則が効く時点（結果の報告）には届かない。白紙案を退ける根拠の「n が 12 件」は research の表と合わない。K5 の「4 箇所」は 6 箇所の誤り。spec の K 番号と ADR-0025 の K 番号が混ざる。

### scope-justification-reviewer

- verdict: needs-work
- 主指摘: K5 の直し先が具体的でない（test-design:43、autonomous-lane:5）。削減量の見積もりがない。W34 を MOVE とした価値を示していない。

### decision-quality-reviewer

- verdict: pass
- 主指摘: 支配軸（保守性と整合性）はずれていない。K7 が引く「K6 の式」の出所が spec 内にない。ENFORCED で消した規則が hook の文面に依存していることを記録していない。W32 を NOISE とした根拠が弱い。

### greenfield-perspective-reviewer

- verdict: needs-work
- 主指摘: 白紙案が藁人形になっている（判断時点で並べ替える案が自然な白紙案で、採用案とほぼ同じ形になる）。W25 は縮めるのではなく、現状に合わせて訂正する。届かない出口を hook 側で直す課題を、見送りとして記録する。

### architecture-boundary-analyzer

- verdict: needs-work
- 主指摘: hook の通知はその場限りで、コンパクションで失われる。K1 は R1 で Executive Summary についてだけこれを認め、W19 と W17 には当てていない。書式を SKILL.md に移すと、同じ書式を 3 か所で持つことになる。

### security-vulnerability-analyzer

- verdict: needs-work
- 主指摘: W40 を消すと、ADR-0011 の決定 1（起動軸の小節を workflow.md に置く）と衝突する。W33 では、scratchpad と `mktemp -d` という置き場の指示も残す必要がある。（「budget テストは CRITICAL を検査しない」という指摘は誤り。`workflow-md-budget.test.ts` の 5 つ目のテストが検査している）

### deployment-readiness-evaluator

- verdict: needs-work
- 主指摘: worktree で変えても main checkout に merge するまで配置されない。merge 後に引数なしの `chezmoi apply` を実行し、`~/.claude` と `~/.codex` の両方と diff する手順がない。文字列を検査する 4 本のテストを、どの順で確認するかを書いていない。

<!-- auto-review: pending -->
<!-- intent-triage: pending -->

## Reviewer Outputs (Round 2)

### logic-validator

- verdict: needs-work
- 主指摘: W35 を縮める根拠が「承認者が気づく」になっている。D1 (b) は機構が止めることを求めるので、基準を使い分けている。W17 で stamp が強制するのは常駐 reviewer だけである。W32 を DUP とする根拠は弱い。W33 と W39 の依存が ADR の帰結から漏れている。数値が一部合わない（0.8KB と 750B、「4 つの文書」）。

### scope-justification-reviewer

- verdict: pass
- 主指摘: Round 1 の指摘は解消した。W17 は stamp が常駐 reviewer しか強制しないので、「`round` / `stamp` もこの集合」の部分だけを外す案を勧める。

### decision-quality-reviewer

- verdict: pass
- 主指摘: 支配軸は合っている。W35 で pass でない経路を扱う根拠が、評価語に近い。

### greenfield-perspective-reviewer

- verdict: pass
- 主指摘: 白紙案は正直に書かれ、ギャップは記録された。research の表が古い判定のまま残っている。W19 は機構にすれば削れるという方向を帰結に足すとよい。

### architecture-boundary-analyzer

- verdict: needs-work
- 主指摘: `buildSummaryReminder` は、pass の後に文書を Write / Edit したときだけ発火する（`plan-review-automation.ts:36-42,95-100`）。stamp を Bash で実行して終える標準の流れでは、一度も出ない。W35 は D1 の (a) も (b) も満たさない。予算は W35 を削らなくても足りる。

### security-vulnerability-analyzer

- verdict: pass
- 主指摘: 承認、scratch の置き場、書き込み禁止先、push レーンの不変条件はすべて残る。`:345` の参照は「同じ exit 0 の性質」と書くほうが正確である。W35 を縮めた後も `:106` の「verdict=pass と書かない」を残すことを明記する。

### deployment-readiness-evaluator

- verdict: pass
- 主指摘: R1 の前提を実測で確かめた。plan では全テストを実行し、apply の前に `chezmoi diff` で差分が 3 ファイルだけであることを確かめる。

<!-- auto-review: verdict=needs-work; hash=df30a8a72fd35fd65cdca92893b7feda40c5da294d11624b30582387ff136223; design-hash=0aeace4f0c96687bdb28f396514f2c0a92e13afc3a747309d4a32128ad9e8274; round=1; at=2026-10-02T21:41:49.901Z; reviewers=logic-validator+scope-justification-reviewer+decision-quality-reviewer+greenfield-perspective-reviewer+architecture-boundary-analyzer+security-vulnerability-analyzer+deployment-readiness-evaluator -->

## Reviewer Outputs (Round 3)

### logic-validator

- verdict: pass
- 主指摘: D1 の (a)(b) は、外す 4 件と残す 7 件のすべてに一貫して当てられている。W33 と W25 の削減量は、実測すると 1B ずつ小さい。plan の実測で確定する。

### scope-justification-reviewer

- verdict: pass
- 主指摘: すべての項目に根拠があり、スコープは逸脱していない。W16 の文面を固定するテストを足すか、記録だけにするかを plan で決める。

### decision-quality-reviewer

- verdict: pass
- 主指摘: 支配軸（整合性）と合っている。D7 の閾値を超えた場合の扱いを、plan に 1 行書く。

### greenfield-perspective-reviewer

- verdict: pass
- 主指摘: ギャップは D6 に記録された。「届かない出口は 1 つ」と「到達が n の 7 行」は数え方が違うので、注記する。research の表に superseded の注記を入れる。

### architecture-boundary-analyzer

- verdict: pass
- 主指摘: 4 件とも、(a) の経路は実在し、モデルに届く。W17 の「同じ集合」は不正確で、正しくは部分集合である（反映済み）。W33 の (b) は `DOCUMENT_WORKFLOW_WARN_ONLY=1` のとき成り立たない。W16 の (b) は、round を実行していないとき session 全体の台帳で判定される。`SCRATCH_HINT` のコメント（`guard:50`）が workflow.md と結合している。

<!-- auto-review: verdict=needs-work; hash=8abb99632e5103f936b863ac3a405726a524ce413e88d9d3fccda5c9f8d242f0; design-hash=4f5cf8c0b9d213dfaa75b5a99dbfd43c5c8883184ebaae1ae1af9334836a0424; round=2; at=2026-10-02T21:45:04.729Z; reviewers=logic-validator+scope-justification-reviewer+decision-quality-reviewer+greenfield-perspective-reviewer+architecture-boundary-analyzer+security-vulnerability-analyzer+deployment-readiness-evaluator -->

<!-- auto-review: verdict=pass; hash=071067977ee6d1ea1690e5af7b61277c3662a3bfbbb03247f20c0246d2de7687; design-hash=5b98e0060afd67cb3638e443f7e6120ed1b2e42c5fa8c01ad4771e5b57735238; round=3; at=2026-10-02T21:47:54.200Z; reviewers=logic-validator+scope-justification-reviewer+decision-quality-reviewer+greenfield-perspective-reviewer+architecture-boundary-analyzer -->
<!-- intent-triage: adopted=46; excluded=1; at=2026-10-02T21:48:02.537Z -->
