# ADR-0037: `workflow-cli reset` で workflow dir の直下を `archive/` へ退避し、次のフローを白紙で始める

## Status

accepted (2026-10-20)

`references/escape.md` と SKILL.md「誤って入った場合の脱出」にあった規約「消す操作は利用者に委ねる」を置き換える。ADR-0029 が決めていなかった「移して commit した後の wfDir の扱い」も、この ADR で決める。

## Context

利用者から次の依頼があった。

> Document Workflowの文書類を移動・破棄して次のDWフローを始めることが頻発しているので、初期化・クリーンアップ操作ができるようになると望ましそう

方針の分かれ目は、AskUserQuestion で 3 点を確かめた（2026-10-20）。

- 退避か削除か: **`archive/` へ退避**
- 誰が実行するか: **モデルが確認後に実行**（それまでの「消す操作は利用者が `!` で行う」を改める）
- 誤入時の脱出も統合するか: **統合する**

観察した現状は次のとおりである。

- 同じセッションで次の Document Workflow を始めるには、(1) 移す節を移す、(2) 直下の文書を消す（利用者の `!` 実行）、(3) 気づけば `.tripwire-baseline` も消す、をその都度組み立てていた。消し忘れたファイルは、気づかれないまま次のフローに残る。`reviewer-runs.log` はセッション単位で文書単位ではないため、残ると次のフローの `stamp` に前フローのレビュアーが数えられうる。`.round-baseline` と `round-extensions.log` が残ればラウンド予算が前フローから続く。
- 直下には文書のほかに `approvals.log`、`reviewer-runs.log`、`off-plan-writes.log`、`.round-baseline`、`round-extensions.log`、`.tripwire-baseline`、`plan-review.cache.json` などの帳簿が並ぶ。一覧も手順もコードに無く、毎回列挙し直していた。
- 状態を読む側は wfDir の直下だけを見る。`workflow-gate.ts` の `isWorkflowActive`（`existsSync` で research / plan の存在を見る）と `findPlanNumberedFiles`（`readdirSync(wfDir)`）、`session.ts` の起動時要約、`workflow-bash-sync.ts` の早期 return（research / plan / spec がどれも無ければ何もしない）がそうである。サブディレクトリへ動かしたファイルは arm しない。
- 世代・リセット・アーカイブの概念はコードに無かった。
- モデル自身の Bash `rm` は、wfDir 配下の `.md` なら guard を通る。つまり「利用者に委ねる」は規約上の取り決めで、機構の担保ではなかった。通らないのは、`.md` 以外（帳簿）と、変数経由のパス、`rm -r <wfDir>` である。
- `resolveTargetWfDir` は `.tmp/sessions` の厳密な子孫なら、解決した dir と違う `--wf-dir` も警告付きで受け入れる。ADR-0023 は、`/clear` 後に他セッションの承認済み plan を CLI が書き換えた不具合（#197）を扱っている。
- ADR-0015 K5 は「bookkeeping を書くのは CLI だけ」と決めている。帳簿を動かす操作は CLI が担うのが筋である。
- ADR-0029 R1 は、移さなかった内容は GC（7 日）で失われると認めている。退避なら、この回復の窓が保たれる。

確かめていない前提が 1 つある。利用者が `!` で打ったコマンドが PreToolUse hook を通るかは、公式ドキュメントに記述が無く、未確認である。今回の方針（モデルが確認後に実行）では結論に影響しないので、確かめずに進めた。

## Decision

- **K1: サブコマンド `reset` を足す。** `--confirm` が無ければ何も動かさず（dry-run）、退避先・承認状態・実装フェーズ・退避対象の名前・確認トークンを出す。`--confirm <トークン>` は、今の状態から計算したトークンと一致するときだけ退避する。対象が 0 件なら `nothing to reset` で終了コード 0、`archive/` は作らない。余分な位置引数は `unexpected argument` で拒否する。
- **K2: 退避先は `<wfDir>/archive/<UTC 日時>/`（`YYYYMMDDTHHMMSSmmmZ`）。直下の `archive` 以外の全エントリを rename する。** ファイル・dot ファイル・ディレクトリ・symlink を entry ごと動かし、symlink は辿らない。中身の書き換えも複製もしない。列挙を持たないので、帳簿が増えても漏れない。順序は文書（`plan.md`、`spec.md`、`plan-N.md`、`research.md`、`workflow-state.json`）が先で、残りは名前の昇順とする。途中で失敗したときに、帳簿が残って文書が消えた状態（未承認側）に倒れるためである。退避先が既にある場合は、非 recursive の `mkdir` が失敗して直下は不変のままになる。
- **K3: `followups/` 配下に通常ファイルか symlink が 1 件以上あれば、dry-run でも `--confirm` でも拒否する。** symlink は辿らず 1 件と数え、入れ子も数える。残件は `docs/plans/` へ移すのが規約（`references/record-migration.md`）で、archive に入れると GC で消えるためである。空の `followups/` は対象として退避する。
- **K4: 対象は現セッションの wfDir（`deps.wfDir`）だけ。** `--wf-dir` が `deps.wfDir` と違う値なら拒否する（ADR-0023）。他のサブコマンドの「警告付きで受け入れる」挙動は変えない。`deps.wfDir` の親が `<project root>/.tmp/sessions` でない（`DOCUMENT_WORKFLOW_DIR` の pin が深い位置や archive の中を指す）場合も拒否する。wfDir 自体が symlink、`archive` が通常のディレクトリでない場合も拒否する。
- **K5: 誤入時の脱出も `reset` に置き換える。** 「消す操作は利用者が行う」を、「モデルが dry-run の出力（承認状態・退避対象・7 日の注記）を AskUserQuestion で見せ、承諾後に `--confirm` で退避する」に改める。次のフローを同じセッションで始めるときも同じコマンドを使う。
- **K6: guard のコードは変えない。** `workflow-cli reset` は round / stamp / triage のどれでもないので、書き込みに分類されず許可される。この「未分類なので許可」をテストで固定し、将来 guard が CLI のサブコマンドを分類し直したときに気づけるようにした。
- **K7: 承認済みの plan があっても拒否しない。** 承認・実装・commit を終えた後に次のフローへ移るのが主な使いどころで、そこでは必ず承認済みの plan がある。代わりに dry-run に承認状態（文書ごとの `approved` / `not approved`）と実装フェーズかどうかを出し、確認の質問に載せる。

### 置き換えた規約と、その理由の置き換え

それまでの規約は「承認と対称に、消す操作もユーザーに委ねる」で、理由は、モデルが自分の routing 誤りを単独で判断して steering を外すことを避けるためだった。この理由を、次の 2 つで置き換えた。

- **可逆性（主）**: 消さずに `archive/` に残すので、GC までの 7 日間は手で `mv` して戻せる。戻すと guard は再び arm される。自動で戻す手段は作っていない。
- **確認トークン（補助）**: dry-run が出すトークンを `--confirm` に要求する。トークンは「見せた一覧」と「実行時の一覧」を結びつける。トークンの式は公開なので、同意の証明ではない。人間が答えたことは証明しない。

トークンは、wfDir の絶対パス、対象のうち名前が `.md` で終わる entry とディレクトリの「種別 名前」、文書ごとの承認状態、実装フェーズの行を連ねた文字列の sha256 の先頭 12 桁である。

- **ファイルの中身を含めない理由**: 承認済み文書の書き換えは、hash の不一致として承認状態の変化に現れる。中身を含めても上積みが少ない。
- **hook が書く帳簿を含めない理由**: `workflow-bash-sync` が、dry-run を実行した Bash の直後に `.tripwire-baseline` や `off-plan-writes.log` を書く。含めると最初の `--confirm` が必ず一致しなくなる。これらは退避はされる。実際の dry-run で、予期していなかった hook のファイル `testament-state.json` が直下に現れた。一覧を持たない設計なので、これも追加の変更なしで退避の対象に入った。

### 却下した代替案

- **差分最小案: `escape.md` の `rm` コマンドに帳簿を足して列挙する**: 列挙が手順書に固定され、帳簿が増えるたびに古くなる。毎回組み立てる・消し漏れる、という今の痛みが残る。削除なので、移し忘れた節は即座に失われる。`.md` 以外は guard が `rm` を deny するので、帳簿はそもそも消せない。
- **白紙設計案: フローごとに世代ディレクトリを切る（wfDir を `.tmp/sessions/<id8>/<世代>/` にする）**: ゼロから設計すれば、「1 セッション = 1 フロー」という前提を外し、wfDir の導出に世代を入れるのが自然である。起源は ADR-0013 の導出が session id だけを鍵にしたことにある。却下した理由は、導出が guard・全 recorder・CLI・`session.ts` が共有する設計面（ADR-0013 / ADR-0023）で、`DOCUMENT_WORKFLOW_DIR` の pin や `/clear` 後の引き継ぎ（`references/session-handoff.md`）まで波及するためである。読み手がすべて直下だけを見るので、直下を `archive/` へ動かすだけで、導出を変えずに世代切替と同じ効果が得られる。
- **確認の記録化（承認と同じ仕組み。`ask-reset` の回答を recorder が ledger に記録し、`reset` は記録が無ければ拒否する）**: recorder・ledger・guard の保護を足す費用がかかる。今でもモデルの `rm *.md` で guard は外せる。reset はそれより広く、ledger まで直下から外すが、消さずに archive に残すので、広がった分は可逆性で埋まる。費用に見合う上積みが無い。悪用の実例が出たら再検討する。
- **承認済みの plan があれば拒否する**: 承認・実装・commit を終えた後に次のフローへ移るのが主な使いどころで、そこでは必ず承認済みの plan がある。拒否すると主な使い方を塞ぐ。承認状態を見せて確認に載せる（K7）ことで代える。
- **規約だけ（AskUserQuestion で聞いてから `--yes`）**: 聞かずに `--yes` しても、確認の後に一覧が変わっても気づけない。トークンなら、後者は検出できる。

## Consequences

- **Risks**
  - **R1: 確認を取らずに dry-run → `--confirm` を続けて実行できる。** トークンの式は公開なので、dry-run を経ずに計算することさえできる。トークンは確認の質問と一覧を結びつけるだけで、人間が答えたことは証明しない。reset は `rm *.md` より広く、ledger（`approvals.log`、`off-plan-writes.log`、`reviewer-runs.log`）も直下から外す。ただし消さずに archive に残すので、記録は GC までは読める。守りの主は手順書の規約と可逆性である。
  - **R2: archive は GC で session dir ごと消える。** GC の 7 日は、session dir の直下の最終変更（reset の rename を含む）から数える。退避は「すぐには失わない」だけで、恒久保存ではない。dry-run の出力にこの注記を載せ、確認の質問で利用者に見せる。
  - **R3: 今の読み手（guard、`session.ts`、`workflow-bash-sync`、`status`）はすべて直下だけを見る。** 将来どれかが再帰的に探すようになると、archive が arm しうる。`isWorkflowActive` と `status` を直接確かめるテストを置き、その変更時にテストが失敗するようにした。
  - **R4: recorder が reset と同時に `approvals.log` や `reviewer-runs.log` に追記すると、直下に新しいファイルができうる。** rename は entry ごとにアトミックなので、ファイルの中身は損なわれない。残ったファイルは次の reset で退避される。
- **未確認のまま採用した点**: 利用者が `!` で打ったコマンドが PreToolUse hook を通るかは未確認である（Context 参照）。通らないなら「モデルの Bash からは deny、利用者の `!` は通る」で人間専用を機構で担保できるが、今回の方針はそれに頼らない。
- **既知の制約**
  - `docs/scripts/workflow-session-audit.mjs` は `archive/` の中を見ない。退避したフローの記録は、この監査の対象から外れる。
  - GC の 7 日は、直下の最終変更から数える。reset はその rename で session dir の mtime を新しくするので、退避した記録は reset から 7 日後まで残る。
- **受け入れた競合**: `archive` の `lstat` から `mkdir` までの間に、`archive` を別のものに差し替える競合がある。突けるのはローカルで同時に動く実行者だけなので、受け入れた。
- **`RunWorkflowCliDeps` に `renameEntry`（rename の差し替え口、任意項目）を足した。** 途中で失敗したときの挙動（それまでに移した名前と失敗した entry を stderr に出し、残りは動かさず、巻き戻さない）を、失敗系のテストで確かめるためである。既定は `renameSync` で、実環境の挙動は変わらない。
- **確かめたこと（根拠）**: 次をテストで固定した（`workflow-cli.test.ts` の `workflow-cli: reset`、`document-workflow-guard.test.ts` の reset のケース）。
  - reset 後に `isWorkflowActive` が false になり、`status` の gate checklist で `plan.md` の行が ✗ になる
  - reset 後に元と同じ内容の `plan.md` を書いても、`approvals.log` は archive 側にあるので承認されない
  - reset 後の `round` は Round 1 から始まり、前フローの `reviewer-runs.log` のレビュアーを `stamp` が数えない
  - guard は `workflow-cli reset` を deny せず、`rm -r <wfDir>` は今までどおり deny する

  2026-10-20 に全体のテストを実行し、4219 件中 pass 4206・fail 0・skip 13 だった。typecheck も通った。実際の session の wfDir に対する dry-run でも、承認状態・実装フェーズ・対象・トークンが期待どおりに出た。

- 規則と手順書は、引数なしの `chezmoi apply` を実行するまで `~/.claude/` に配置されない。

### 計画から外れた点

- **実装をテストより先に書いた。** strict な TDD の順序ではなかった。その代わり、テストの強さを変異で確かめた。トークンから承認行を外す、`followups/` の確認を無効にする、別の wfDir の拒否を無効にする、のそれぞれでテストが失敗することを確認した。
- **`findPlanNumberedFiles` は export されていない。** 計画は直接確かめるテストを置くとしていたが、`isWorkflowActive` と `status` を通して、plan-N が列挙されないことを確かめる形に代えた。
- **予期していなかった hook のファイル `testament-state.json` が、実際の dry-run で直下に現れた。** 列挙を持たない設計（K2）により、追加の変更なしで退避の対象に入った。

### 範囲の外に回した課題

該当なし。

## References

- 置き換えた規約: `.skills/document-workflow-reference/references/escape.md`、`.skills/document-workflow-reference/SKILL.md`（「誤って入った場合の脱出」）
- 関連する決定:
  - `docs/decisions/0013-workflow-dir-session-derivation.md`（wfDir の導出）
  - `docs/decisions/0015-document-workflow-operator-ergonomics.md`（K5: bookkeeping を書くのは CLI だけ）
  - `docs/decisions/0023-workflow-identity.md`（他セッションの dir を触らない）
  - `docs/decisions/0029-workflow-records-move-into-adr.md`（R1: 移さなかった内容は GC で失われる）
- 実装:
  - `home/dot_claude/hooks/cli/workflow.ts`（`cmdReset`）
  - `.skills/document-workflow-reference/references/escape.md`
  - `.skills/document-workflow-reference/references/record-migration.md`
  - `.skills/document-workflow-reference/references/session-handoff.md`
  - `home/dot_claude/rules/workflow.md`
- テスト:
  - `home/dot_claude/hooks/tests/unit/workflow-cli.test.ts`
  - `home/dot_claude/hooks/tests/unit/document-workflow-guard.test.ts`
