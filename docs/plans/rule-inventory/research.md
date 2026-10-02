# Research: Document Workflow 規則の棚卸し（セッション B）

作業 worktree: `.git/worktree/docs/rule-inventory`（branch `docs/rule-inventory`、base `9365b7d`）。引き継ぎは `.tmp/docs/handoff-document-workflow-trim.md`。

## 対象と前提

- 対象は `home/dot_claude/rules/workflow.md`（常時ロード、11,429 bytes、予算 12,288）と `.skills/document-workflow-reference/SKILL.md`（必要時だけ読む、18,524 bytes）。`references/*.md` は読まれる頻度が低いので対象から外す。
- 規則は W01-W40（workflow.md）と S01-S17（SKILL.md）に分けた。一覧は scratchpad の `rules.md` にある。
- 調査は 2 本に分けて委譲し、要点は自分で確かめた（`workflow-review-core.ts:863-885` の `buildSummaryReminder`、`:816-818` のトリアージ指示、`:168-195` のラウンド予算の案内）。

## 使用実績の窓（分母）

- 残っている transcript は 2026-09-24〜10-03 の約 10 日分だけ。対話セッション（`entrypoint=cli`）は 91 本、そのうち Document Workflow を使ったのは 44 本。内訳は chezmoi 20、my-secretary 19、その他 5。
- chezmoi 20 本のうち 14 本は workflow 自体を作る作業で、新しい機構の試験が使用として数えられている（ask-approval、reframer、承認書き込みの deny など）。
- **結論**: 窓が 10 日しかなく、実際に使っているプロジェクトも 2 つだけなので、使用 0 件は弱い証拠にしかならない。脱出、S3 移行、ラウンド 9 超などは設計上まれにしか起きない規則なので、0 件で当然である。使用実績を単独で削除の根拠にはできない。

## hook 出力の到達性（削除判断の軸）

ADR-0025 K5 の ENFORCED は「hook・CLI が同じ文面を出すか、機械的に強制する」である。ただし、どの出口がモデルに届くかは次のとおり分かれる。

- 届く: PostToolUse の `additionalContext`、Stop hook の block 理由、CLI の stdout と stderr（Bash の結果として届く）、PreToolUse の deny 理由。
- 届かない: PreToolUse で exit 0 のときの stderr（`document-workflow-guard.ts:345` のコメント）。実装フェーズの off-plan 警告（`guard:261,311`）はここに当たる。SessionStart の `systemMessage` も UI に出るだけである（`session.ts:287-291` のコメント）。
- deny しても理由を示さない強制や、何も言わずに通す処理（`classifyExemption`、GC）は、規則を事前に知らせない。事前に知らないと危害が出る規則（例: `$HOME` に書かない）は、強制されていても文書に残す必要がある。

## 規則表（workflow.md）

> この表の W19、W32、W34、W35、W40 の判定は、spec.md の D4 が上書きした。この 5 つは削らずに残す。W17 は括弧書きだけを外す。表の判定は、Round 1 時点の調査結果として残す。

列の意味: 強制 = 強制または実行する箇所 / 到達 = その時点でモデルに届く出力が同じ指示を伝えるか（y / p / n）/ 使用 = 44 本中で該当した本数 / テスト = 文字列を検査しているテスト。

| id      | 内容                                                        | 強制                             | 到達                                   | 使用                            | テスト                                | 判定                                                                                                                                                                     |
| ------- | ----------------------------------------------------------- | -------------------------------- | -------------------------------------- | ------------------------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| W01     | 詳細は skill                                                | —                                | —                                      | Skill 4                         | budget: `document-workflow-reference` | 残す                                                                                                                                                                     |
| W02     | wfDir と `workflow-cli dir`                                 | cli `cmdDir`                     | p                                      | 8                               | budget: `workflow-cli`                | 残す                                                                                                                                                                     |
| W03     | Routing 6 項目                                              | なし                             | n                                      | approach-check 3                | mechanical-lane-routing               | 残す                                                                                                                                                                     |
| W04/W05 | 必須トリガー / 承認前の実装禁止                             | gate（research.md 以後）         | y                                      | — / deny 28                     | —                                     | 残す（作業前の判断に要る）                                                                                                                                               |
| W06     | 誤入時は自分で消さない                                      | なし（wfDir の .md は対象外）    | n                                      | 0                               | —                                     | 残す。参照する節名のずれを直す（「脱出手順」→「誤って入った場合の脱出」）                                                                                                |
| W07-W13 | step 1-4                                                    | 一部 gate                        | 一部 y                                 | 34-35                           | —                                     | 残す                                                                                                                                                                     |
| W14     | 推奨 reviewer を並列実行                                    | plan-review-automation           | y                                      | 38                              | —                                     | 残す（手順の骨格）                                                                                                                                                       |
| W15     | Reviewer Outputs を書く                                     | round が骨格を挿入               | p                                      | 28                              | —                                     | 残す                                                                                                                                                                     |
| W16     | 帳簿は CLI、hash の手転記禁止、起動証跡                     | cli round/stamp                  | y（`cli:832`）                         | 38                              | —                                     | 「起動証跡が無いと stamp は通らない」の 1 文を削る（ENFORCED、出力に同じ指示がある）                                                                                     |
| W17     | 差分再レビュー / `--full` / 軽微なら stamp のみ             | core `planRoundReviewers`        | y（`core:775`、round の出力）          | 28                              | —                                     | 再実行の集合の説明を削り、「Key Decisions / 白紙案を変えたら `--full`」と「全員 pass で軽微なら stamp のみ」は残す。前者は `core:775` が伝えるが、変更する前に判断が要る |
| W18     | 予算、延長時の Executive Summary、Round 7 以降は Risks      | cli の拒否 + core の案内         | p（Risks の件は出ない）                | extend 15 / 予算到達 23         | —                                     | 残す（拒否時の案内と重なるのは一部だけ）                                                                                                                                 |
| W19     | トリアージ必須、記録、事前に提示しない                      | 推奨文 `core:817-818`            | y                                      | 37                              | —                                     | 「トリアージ前に提示しない」を削る（`core:818` が同じ文面を出す）                                                                                                        |
| W20     | ask-approval → AskUserQuestion                              | cli + recorder                   | y                                      | ask 4（dotfiles のみ）/ 発話 33 | —                                     | 残す（新しい経路）                                                                                                                                                       |
| W21     | 実装開始、オフロード宣言                                    | gate / 宣言は強制なし            | y / n                                  | 9                               | —                                     | 残す                                                                                                                                                                     |
| W22     | ターン終端規則                                              | `resume-incomplete-work` が一部  | p                                      | Stop の block 25                | —                                     | 残す（block の発火が多く、文書だけでは足りていない）                                                                                                                     |
| W23/W24 | 二層の承認順、parent-spec-hash                              | gate                             | p                                      | 15 / 9                          | —                                     | 残す                                                                                                                                                                     |
| W25     | 成果物は Edit/Write で書く                                  | bash-sync は推奨だけ             | n                                      | Bash で書いた 21                | —                                     | 残す。理由の文は古い（`de2882f` 以後、データだけの heredoc はマスクされる）ので、インタプリタの heredoc に絞って直す                                                     |
| W26     | 必須 reviewer の ssot                                       | core の定数                      | y                                      | 37-38                           | budget、drift                         | 残す（テストが依存）                                                                                                                                                     |
| W27-W29 | Alternatives / No Placeholders / ISO                        | placeholder-scan が一部          | p                                      | 34 / 9 / 39                     | —                                     | 残す                                                                                                                                                                     |
| W30     | 承認は人間のみ                                              | guard の deny                    | y                                      | 3                               | budget: 3 文字列                      | 残す（テストが依存、CRITICAL）                                                                                                                                           |
| W31     | 再承認、取り消し                                            | gate                             | p                                      | —                               | —                                     | 残す                                                                                                                                                                     |
| W32     | research/plan は承認前も編集可                              | `classifyExemption` が黙って通す | n                                      | —                               | —                                     | 削る（NOISE: 試せば通る。判断に影響しない）                                                                                                                              |
| W33     | guard の対象、使い捨ての置き場                              | guard + `SCRATCH_HINT`           | y（deny の後）                         | deny 28                         | —                                     | 短くする。「`$HOME`・他 repo・dotfiles に書かない」は残す（guard はプロジェクト外を対象外にするので deny されず、事前に知る必要がある）                                  |
| W34     | 実装フェーズの off-plan は warn                             | guard の stderr                  | n（届かない）                          | ログ 20 dir                     | —                                     | SKILL.md へ移す（MOVE。機構の説明で、運用の手順ではない）                                                                                                                |
| W35     | Executive Summary の書式                                    | `buildSummaryReminder`           | y（`verdict=pass` 時に同じ書式を出す） | 32                              | —                                     | 書式の欄の一覧を SKILL.md へ移し、workflow.md には「いつ置くか」だけ残す（理由は下記）                                                                                   |
| W36     | Experience Delta の自己検証、レビュー無しで pass と書かない | stamp の台帳                     | p                                      | —                               | —                                     | 残す                                                                                                                                                                     |
| W37     | Scope Guard の兆候                                          | なし                             | n                                      | Skill 1                         | —                                     | 残す（兆候の一覧は scope-guard skill に無く DUP にならない。使われていないことだけでは削らない）                                                                         |
| W38     | Session Artifact Retention                                  | GC は黙って動く                  | n                                      | 再配置 8                        | —                                     | 残す                                                                                                                                                                     |
| W39     | Task Completion Protocol                                    | completion-gate が一部           | p                                      | 25                              | —                                     | 「期待を勝手に下げたり steering を無効化しない」を削る（`~/.claude/CLAUDE.md` の Prohibitions と DUP）                                                                   |
| W40     | 起動軸 pull / push                                          | なし                             | —                                      | 測れない                        | —                                     | 節を削る（DUP: `autonomous-lane.md` は CLAUDE.md の `@` で常時ロードされ、C3 と「位置づけ」に同じ内容がある）。`autonomous-lane.md:5` の参照を直す                       |

### W35 を消さずに移す理由

`buildSummaryReminder` は `verdict=pass` で承認前のときに一度だけ出る。ラウンド予算の拒否時の案内（`core:177,185,191`）は、pass でなくても「Executive Summary を出して人間に聞く」と指示するが、書式は出さない。消すと pass でない経路で書式を見られなくなるので、SKILL.md に移す。

## 規則表（SKILL.md）

SKILL.md は deny や迷いが起きたときに読む機構の説明である。対話セッション 44 本のうち、この skill を開いたのは 4 本だった。hook が同じことをしているのは当然なので、ENFORCED は SKILL.md の文を削る根拠にならない。削れるのは DUP / NOISE / MOVE だけである。

- S01-S05、S07、S13-S17: 機構の説明。残す。
  - S07 は `document-hash.test.ts` が文字列を検査している。
  - S08 は `mechanical-lane-routing.test.ts` が文字列を検査している。
- S06 / S10 / S12（脱出 / 引き継ぎ / S3）: セッション A で要約と references に分けた。使用は 0、1、0 件だが、設計上まれな規則なので残す。
- S13 の workflow-cli サブコマンド節（約 2.9KB）: 使用頻度の低い部分は L120（`--wf-dir` の検証、出力形式、`dir`）だけである。`--wf-dir` を使ったのは 7 本あった。skill 自体がまれにしか読まれないので、分けても常時の負担は減らず、読む手間が 1 つ増える。**分けない**（引き継ぎ事項の検討結果）。
- 増える内容: W35 の書式（約 0.6KB）と W34 の off-plan（約 0.2KB）。

## 相互参照（壊れている、またはずれているもの）

- `workflow.md:22`「脱出手順」→ 実際の節名は「誤って入った場合の脱出」（A からの引き継ぎ）。
- `.skills/test-design/SKILL.md:31` は workflow.md の「品質特性の選択ガイド」を参照しているが、その節は存在しない。実体は SKILL.md の「ISO 25010 特性選択ガイド」にある。
- `.skills/test-design/SKILL.md:43` は workflow.md の「テスト観点の記述品質ルール」を参照しているが、この節も存在しない。規則の中身は参照のすぐ下に書かれている。
- `autonomous-lane.md:5` は workflow.md の「起動軸（pull / push）」節を参照している。W40 を消すと壊れる。
- `autonomous-lane.md:15,58` は「routing 表」と書いているが、A で箇条書きに変えた。
- `plan-review-automation.ts:258` のコメントが「workflow.md 'prescribed-fix carry-forward'」と書いているが、実体は SKILL.md にある。コードのコメントでモデルには届かないので、**対象外**とする。
- `docs/decisions/0025-…` K3 の「今回はラウンド予算だけを分けた」は、A で 3 節を追加で分けたので実態とずれている（A からの引き継ぎ）。

## テストへの影響

- `workflow-md-budget.test.ts`: サイズの上限は `12 * 1024`。ADR-0025 K6 の式（実測 + 1KB を 1KB 単位で切り上げ）で再計算し、値が変われば定数とコメントを直す。ssot マーカー、`workflow-cli`、`document-workflow-reference`、CRITICAL の 3 文字列は残す。
- `mechanical-lane-routing.test.ts`: workflow.md L14 と SKILL.md の mechanical-lane 節は触らない。
- `document-hash.test.ts`: SKILL.md の carry-forward 節は触らない。
- `deployed-docs-repo-refs.test.ts`: 新しく書く文に ADR 番号や配置元のパスを入れない。

## ADR への含意

- K5 の前提を変える点は 2 つある。(1) ENFORCED は「強制がある」ではなく「その時点でモデルに届く出力が同じ指示を伝える」を要件にする。黙って通す処理や stderr だけの警告は根拠にしない。(2) 使用実績は単独では削除の根拠にしない。優先順位の目安と、hook が実際に届いていることの確認にだけ使う。
- K3 の事実のずれを直す。
- 形式は「新しい ADR で K5 を改訂し、0025 の K3 は本文を最小限に直す」と「0025 を改訂する」から選ぶ（spec の Key Decision）。
