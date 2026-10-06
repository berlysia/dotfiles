# ADR-0029: Document Workflow の記録を ADR へ移し、計画を作業ツリーに残さない

## Status

accepted (2026-10-07)

## Context

Document Workflow の成果物（spec・research・plan）は `.tmp/sessions/` に書かれ、7 日で GC される。
これまでは、作業が終わるたびに成果物を `docs/plans/<name>/` へ写し、ADR には骨子だけを書き、全文は `docs/plans/` の spec にあるとパスで指していた。
その結果 `docs/plans/` が増え続けた。

2026-10-07 の計測は次のとおりである。

| 種別                        | ファイル数 | 行数   | 割合 |
| --------------------------- | ---------- | ------ | ---- |
| `plan.md` / `plan-N.md`     | 52         | 43,486 | 75%  |
| `spec.md`                   | 20         | 8,749  | 15%  |
| `research.md`               | 30         | 3,274  | 6%   |
| その他（一覧、evidence 等） | 21         | 2,530  | 4%   |
| 計                          | 123        | 58,039 |      |

- plan は bite-size TDD の計画で、テストと実装のコードを含む。実装後はリポジトリの実体と重複する。
- 外から参照の無い 9 単位と hook のキャッシュ 3 件を消しても（`52dc6fd447`）、減ったのは 18% だった。残りを固定していたのは、ADR 11 本からのパス参照と、計画どうしが互いを「前例」として指すパス参照である。パスで指される限り、その計画は消せない。
- `docs/plans/` には、終わった作業の成果物と、これからの作業の記録（持ち越した課題の一覧、未着手の調査）が同じ場所にあった。
- 保存の規則は `rules/workflow.md` の Session Artifact Retention 節の 1 文、リンクの規則は `rules/developer-experience.md` の 1 文だけだった。どちらも根拠を書いた ADR が無く、commit `a0790fc`（2026-04-23）と `d1b0254`（2026-03-09）で入った。何を残すかの判断は、計画を残す commit の本文に毎回書かれていた。
- `docs/plans/` のファイルの存在を読む hook・CI・スクリプトは無い。`.skills/adr-session/` は `plan:` の frontmatter を前提にした記述を持つが、その形の ADR は 1 本も無い。
- 計画を残す commit は、master に直接か merge commit で入っている。直近 40 件に squash merge は無い。commit を指す参照は、この運用が続く限り辿れる。
- 逆の例として、ADR-0008 の References は `.tmp/sessions/85f6f6e4/spec.md` などを指している。GC の対象なので、今は読めない参照である。

同じ内容を 2 つの文書が持つと片方だけが古くなる、という観察は、このリポジトリで繰り返し出ている（ADR-0013 の「証拠を 2 つの永続文書へ同じ粒度で書くと片方だけが腐る」、ADR-0025 K2 の「参照先にしか基準や手順がない参照は、内容を配置される文書へ移す」）。
ADR が骨子だけを書いて全文を計画に預ける形は、この観察に反していた。

## Decision

- **K1: 作業の終わりに、決まった節を恒久文書へ移す。spec・research・plan は commit しない。** 移す節と行き先は次の表で固定する。

  | 元       | 節                                                                        | 行き先                                                |
  | -------- | ------------------------------------------------------------------------- | ----------------------------------------------------- |
  | spec     | Key Decisions、Alternative Approaches の却下した案、Risks、提供しない体験 | ADR の Decision / Consequences                        |
  | research | 決定の根拠になった計測と事実                                              | ADR の Context。100 行を超える場合は `docs/research/` |
  | plan     | 計画から外れた点、実装中に分かったこと                                    | ADR の Consequences                                   |
  | どれでも | 範囲の外として次に回した課題                                              | `docs/plans/` の持ち越した課題の一覧                  |
  | どれでも | 上の行に当たらないが、決定の理由を読むのに要る内容                        | ADR の Context                                        |
  | 移さない | Tasks、Files、テストケース、Reviewer Outputs、Approval、Scope             | 残さない                                              |

  単層モードの `plan.md` は spec と plan を兼ねるので、両方の行を当てる。
  移す作業は計画の最後のタスクとして行う（二層モードでは、最後に実行する plan-N）。
  計画の外の手順にしないのは、ADR と規則の文書が保護対象で、承認済みの計画の Files に載っていないと書けないためである。
  そのタスクは commit の本文に、原本の `##` 見出しの一覧と、表の 1〜5 行目それぞれの「移した先の文書と節」または「該当なし」を書く。

- **K2: ADR を書かない作業は、決定を commit の本文に書く。** Contextual Commits の `decision` / `rejected` / `learned` の行を使い、文書は残さない。

- **K3: `docs/plans/` は、今後やりたいことを置く場所にする。** やると決めたか、やりたいが、まだやっていないことである。作業中の成果物と、終わった作業の成果物は置かない。置くものは 2 種類ある。
  - 持ち越した課題の一覧（`<主題>-followups.md`）: 終わった作業が範囲の外に回した課題を並べる。片付いた項目は消し、空になったらファイルを消す。項目を消す commit の本文に、消した項目の名前を書く。
  - 未着手の作業の出発点（主題の名前だけのファイル。冒頭に「未着手」と書く）: 調査、未解決の設計判断、次のセッションの起動プロンプトなど。その作業が終わったら、K1 に従って節を移し、最後のタスクと同じ commit でファイルを消す。
  - 2 種類は名前で見分け、置き場は分けない。名前の「plans」は「今後やること」の意味で中身と合うので、改名しない。
  - 出口の規則を置くのは、片付いた項目が一覧に残っていたためである（`docs/plans/workflow-guard-followups.md` の課題 J など）。この ADR の作業では、既存の片付いた項目を消していない。

- **K4: 作業ツリーに無い記録は `git show <commit>:<path>` で指す。** そのまま実行できるコマンドを、バッククォートで囲んで書く。commit は 10 桁以上の hash で、既定のブランチから辿れるものに限る。書く人が `git merge-base --is-ancestor <commit> <既定のブランチ>` の終了コード 0 で確かめる。
  - コマンドの形にしたのは、読み方が参照そのものに書いてあり、記法の説明を別に持たずに済むためである。ファイルを指せば内容が、ディレクトリを指せば配下の一覧が返り、存在しないパスは終了コード 128 で失敗する。パスはリポジトリのルートからの相対で、どのディレクトリから実行しても同じ結果になる。
  - `git show` という固定の語で始まるので、パス:行番号（`session.ts:322`）や hash の記録と取り違えない。

- **K5: 既存の計画は、参照を `git show 52dc6fd447:<path>` に書き換えてから消した。** `52dc6fd447`（`52dc6fd44787550389e3dc812563e435c832e764`）は掃除の commit で、その時点の `docs/plans/` の全 97 ファイルを持つ。内容は ADR へ移していない。
  - 書き換えたのは、`docs/plans/` の外にある 36 行である（ADR 9 本の 32 行、`CONTEXT.md`、`docs/agent-vm.md`、`hooks/lib/complexity-delta.ts` と `dot_local/bin/executable_agent-vm` のコメント各 1 行）。
  - 書き換え方は 4 通りに固定した。ファイルを指す参照は、パスの前に `git show 52dc6fd447:` を付ける。ディレクトリを指す参照は、同じ接頭辞を付けて末尾を `/` にする。先頭のパスの後ろに名前を並べる行は、先頭のパスだけを書き換える（後ろの名前は、先頭がファイルなら同じディレクトリ、先頭がディレクトリならその配下を指す）。`CONTEXT.md` の `@path` は、`@` を外してコマンドの形にする（`@path` は作業ツリーのファイルを読む規約のため）。
  - 残した 7 ファイル: `workflow-guard-followups.md`、`hook-target-diagnostics-followups.md`、`insight-digest-hardening-followups.md`、`git-write-protection/follow-ups.md`、`unmanaged-file-drift-detection.md`、`scratchpad-gc/research.md`、`greenfield-reviewer-observation.md`。残りの 90 ファイルを消した。
  - 順序は、参照を書き換える、検証する、ファイルを消す、検証する、とした。書き換えと削除は別の commit で、どの commit でも参照が指す先が存在する。

- **K6: 書き換えの完了は、一度きりの検証で判定した。常設の検査は入れない。** 判定基準は 3 つである。`docs/plans/` の外にある `git show 52dc6fd447:docs/plans/<path>` が 36 件で、すべて `git cat-file -e` が終了コード 0 を返すこと。後ろに並ぶ `.md` の名前が、定めた指す先に存在すること。`52dc6fd447:` の付かない `docs/plans/<path>` が、作業ツリーにあるパスだけを指すこと。

- **K7: 規則は 4 か所を書き換えた。**
  - `rules/workflow.md` の Session Artifact Retention 節: K1〜K3 の要点と、付属文書への案内。行き先は「ADR を持つプロジェクトでは ADR、持たなければ commit の本文、どちらも合わなければそのプロジェクトの記録の慣習」とした。
  - `document-workflow-reference` skill の付属文書 `references/record-migration.md`（新規）: K1 の表、最後のタスクの書き方、`docs/plans/` に置くもの、K4 の記法。SKILL.md から案内する。
  - `rules/developer-experience.md` の Knowledge Management: K4 の文。検査があるとは書かない（この規則はほかのプロジェクトにも配置され、そこには検査が無い）。
  - `templates/plan-execution.md`: Tasks の末尾に「記録を移す」タスクの枠。規則を覚えているかに頼らず、計画の手順に入れるためである。

- **K8: 書き込み先の大半が保護対象なので、委任を使わなかった。** ADR、規則、テンプレート、skill、`CONTEXT.md` は保護対象で、plan を人間が承認した。

## 却下した代替案

- **plan だけを外し、spec と research はこれまでどおり `docs/plans/` に写す**: 増え方は約 4 分の 1 になるが、ADR が spec をパスで指す限り、指された spec と research は消せない。固定の原因が残る。
- **既存の ADR へ、spec と research の内容を書き足す**: ADR が指す単位の spec と research は 8,935 行あった。書き足した内容を 1 本ずつ原本と照合する必要があり、機械的に検証できない。参照の書き換えなら `git cat-file -e` で全件を検証できる。
- **記録するときに要約して残す**: ADR、要約、原本の 3 つが同じ内容を別の粒度で持つことになる。要約は誰もレビューしていない新しい文書で、承認した原本とも一致しない。節を選んで ADR へ移し原本を捨てる形なら、写しは 1 つである。
- **`<commit>:<path>` だけの記法**: 機械的には取り出せる（16 進 10 桁以上、コロン、パスの並びは、ほかに 1 件も無かった）が、初めて読む人に読み方が伝わらない。
- **pre-commit で参照を毎回確かめる常設の検査**: 検査に使う `git cat-file -e` は、既定のブランチから辿れなくなった commit でも手元にあれば通る。履歴の書き換えを検出できないので、謳う効果が出ない。計画を指す commit 参照は K5 の 36 行で閉じた集合になり、これからの作業は新しい参照を作らない。
- **これからの作業の原本を、専用の ref やブランチに保存する**: 「原本は残さない」という決定に反する。
- **`docs/plans/` の改名、2 種類の置き場の分割**: 名前は中身と合う。置き場を分けると、パスのまま残した 13 行の書き換えが要る。

## Consequences

- **戻らない損失がある（R1）。** これからの作業は spec・research・plan を commit しないので、指す先の commit ができない。ADR へ移さなかった内容は、7 日の GC の後どこにも残らない。機械的な照合は無い。歯止めは、移す節を表で固定すること、表に当たらない内容の受け皿（5 行目）、最後のタスクが原本の見出しの一覧と行き先を commit の本文に書くこと、人間が ADR の差分を読むことである。抜けに気づいて原本から拾い直せるのは、GC までの 7 日の間だけである。
- **レビューと承認の経過が残らない（R2）。** plan 層の Reviewer Outputs と Approval は、これからの作業では永久に残らない。レビューの経過は決定の根拠ではないので受け入れた。承認の記録（`approvals.log`）はこれまでも残していない。
- **commit 参照が辿れなくなりうる（R3）。** master の履歴を書き換えた場合である。検出する仕組みは入れていない。`52dc6fd447` が origin/master にあることは、書き換えの前に確かめた。
- **検索の範囲が変わる（R4）。** `git grep` で過去の spec と research が当たらなくなる。既存分は下の「過去の計画の読み方」の方法で検索できるが、これからの作業の spec と research には同じ手段が無い。検索に掛かるのは、ADR と commit の本文である。
- **ADR を書かない作業の決定は commit の本文に分かれ、一覧が無い（R5）。** `git log --grep='^decision'` で拾える。
- **ほかのプロジェクトにも効く（R6）。** 規則は `~/.claude/rules/` に配置される。ADR も Contextual Commits も使わないプロジェクトのために、行き先の順序を規則の文に書き、テンプレートのタスクは書き換えてよい枠にした。
- **既存の ADR 9 本は、単独では読めないままである。** 参照の表記だけを変え、全文を計画に預ける文は残した。ある ADR を改訂する機会があれば、その ADR だけを K1 の形に直してよい。
- **計画から外れた点が 1 つある。** 残した `docs/plans/git-write-protection/follow-ups.md` の 3 行が、消す隣のファイル（`spec.md`、`research.md`、`acceptance.md`）を名前だけで指していた。設計の時点では参照を `docs/plans/` で始まる文字列として数えていたので、同じディレクトリの隣を名前だけで指す書き方が抜けていた。計画のレビューで見つかり、K4 を当てて書き換えた。残した 7 ファイルのうち、消したファイルを指していたのはこの 3 行だけである。
- **提供しないもの。**
  - 参照の常設の検査。計画を指す commit 参照が K5 の 36 行のほかに書かれるようになったら、再検討する。
  - ADR の骨組みを spec から生成する仕組み。最後のタスクで節の移し漏れが実際に起きたら、再検討する。
  - `.skills/adr-session/` の修正。別の作業として扱う。
  - `docs/plans/` を対象にした GC。K1 と K3 の後は、終わった作業の成果物が入らない。
- 規則、テンプレート、skill は、引数なしの `chezmoi apply` を実行するまで `~/.claude/` に配置されない。

## 過去の計画の読み方

- 読む: ADR に書かれたコマンドをそのまま実行する。例: `git show 52dc6fd447:docs/plans/agent-vm/spec.md`
- 一覧を見る: `git show 52dc6fd447:docs/plans/agent-vm/`
- 検索する: `git grep <pattern> 52dc6fd447 -- docs/plans`
- 作業ツリーに戻す: `git checkout 52dc6fd447 -- docs/plans/<path>`
- shallow clone では、先に `git fetch --unshallow` が要る。
- 参照を別の形へ移すときは、`git show 52dc6fd447:` という固定の接頭辞を置換の手掛かりにできる。

## References

- `docs/decisions/0013-workflow-dir-session-derivation.md`（同じ証拠を 2 つの永続文書に書かない判断）
- `docs/decisions/0025-deployed-docs-self-contained.md`（参照先にしか無い内容を移す判断、付属文書の置き場）
- `docs/decisions/0008-document-workflow-feedback.md`（読めなくなった参照の例）
- 掃除の commit: `52dc6fd447`
- 実装: ブランチ `docs/workflow-record-retention`
