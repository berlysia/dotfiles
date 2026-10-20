# ADR-0037: `workflow-cli reset` で workflow dir の直下を `archive/` へ退避し、次のフローを白紙で始める

## Status

accepted (2026-10-20)

`references/escape.md` と SKILL.md「誤って入った場合の脱出」にあった規約「消す操作は利用者に委ねる」を置き換える。ADR-0029 が定めていなかった、記録を移して commit した後の wfDir の扱いも、この ADR で決める。

## Context

利用者から、Document Workflow の文書類を移動・破棄して次の DW フローを始めることが頻発しているので、初期化・クリーンアップ操作ができるようになると望ましい、という依頼があった。方針の分かれ目は、AskUserQuestion で 3 点を確かめた（2026-10-20）。

- 退避か削除か: **`archive/` へ退避**
- 誰が実行するか: **モデルが確認後に実行**（それまでの「消す操作は利用者が `!` で行う」を改める）
- 誤入時の脱出も統合するか: **統合する**

観察した現状は次のとおりである。

- 同じセッションで次の Document Workflow を始めるには、(1) 移す節を移す、(2) 直下の文書を消す（利用者の `!` 実行）、(3) 気づけば `.tripwire-baseline` も消す、をその都度組み立てていた。消し忘れたファイルは、気づかれないまま次のフローに残る。`reviewer-runs.log` はセッション単位で文書単位ではないため、残ると次のフローの `stamp` に前フローのレビュアーが数えられうる。`.round-baseline` と `round-extensions.log` が残ればラウンド予算が前フローから続く。
- 直下には文書のほかに `approvals.log`、`reviewer-runs.log`、`off-plan-writes.log`、`.round-baseline`、`round-extensions.log`、`.tripwire-baseline`、`plan-review.cache.json` などの帳簿が並ぶ。一覧も手順もコードに無く、毎回列挙し直していた。
- 状態を読む側（gate、起動時の要約、Bash 同期の hook）は wfDir の直下だけを見る。サブディレクトリへ動かしたファイルは arm しない。世代・リセット・アーカイブの概念はコードに無かった。
- モデル自身の Bash `rm` は、wfDir 配下の `.md` なら guard を通る。つまり「利用者に委ねる」は規約上の取り決めで、機構の担保ではなかった。通らないのは、`.md` 以外（帳簿）と、変数経由のパス、`rm -r <wfDir>` である。
- CLI は他セッションの wfDir を、警告付きで受け入れる場合がある。ADR-0023 は、`/clear` 後に他セッションの承認済み plan を CLI が書き換えた不具合を扱っている。
- ADR-0015 K5 は、帳簿を書くのを `workflow-cli` に限っている。帳簿を動かす操作も CLI が担うのが筋である。
- ADR-0029 R1 は、移さなかった内容は GC（7 日）で失われると認めている。退避なら、この回復の窓が保たれる。

## Decision

- **K1: サブコマンド `reset` を足す。** `--confirm` が無ければ何も動かさず（dry-run）、退避先・承認状態・実装フェーズ・退避対象の名前・確認トークンを出す。`--confirm <トークン>` は、今の状態から計算したトークンと一致するときだけ退避する。対象が 0 件なら何もせず終了コード 0 で終わる。
- **K2: 退避先は `<wfDir>/archive/<UTC 日時>/`。直下の `archive` 以外の全エントリを rename する。** ファイル・dot ファイル・ディレクトリ・symlink を entry ごと動かし、symlink は辿らない。中身の書き換えも複製もしない。列挙を持たないので、帳簿が増えても、hook が後から足すファイルも漏れない。順序は文書が先で、残りは名前の昇順とする。途中で失敗したときに、帳簿が残って文書が消えた状態（未承認側）に倒れるためである。失敗した時点で止め、それまでに移した名前と失敗した entry を出し、巻き戻さない。退避先が既にあれば、直下は不変のまま失敗する。
- **K3: `followups/` 配下に通常ファイルか symlink が 1 件以上あれば、dry-run でも `--confirm` でも拒否する。** 残件は `docs/plans/` へ移すのが規約（`references/record-migration.md`）で、archive に入れると GC で消えるためである。空の `followups/` は対象として退避する。
- **K4: 対象は現セッションの wfDir だけ。** `--wf-dir` が現セッションの wfDir と違う値なら拒否する（ADR-0023）。他のサブコマンドの「警告付きで受け入れる」挙動は変えない。pin された wfDir がセッション用の作業ディレクトリの直下でない場合（深い位置や archive の中を指す場合）、wfDir 自体が symlink の場合、`archive` が通常のディレクトリでない場合も拒否する。
- **K5: 誤入時の脱出も `reset` に置き換える。** 「消す操作は利用者が行う」を、「モデルが dry-run の出力（承認状態・退避対象・7 日の注記）を AskUserQuestion で見せ、承諾後に `--confirm` で退避する」に改める。次のフローを同じセッションで始めるときも同じコマンドを使う。
- **K6: guard のコードは変えない。** `workflow-cli reset` は round / stamp / triage のどれでもないので、書き込みに分類されず許可される。この「未分類なので許可」をテストで固定し、将来 guard が CLI のサブコマンドを分類し直したときに気づけるようにした。
- **K7: 承認済みの plan があっても拒否しない。** 承認・実装・commit を終えた後に次のフローへ移るのが主な使いどころで、そこでは必ず承認済みの plan がある。代わりに dry-run に承認状態（文書ごとの `approved` / `not approved`）と実装フェーズかどうかを出し、確認の質問に載せる。

### 置き換えた規約と、その理由の置き換え

それまでの規約は「承認と対称に、消す操作もユーザーに委ねる」で、理由は、モデルが自分の routing 誤りを単独で判断して steering を外すことを避けるためだった。この理由を、次の 2 つで置き換えた。

- **可逆性（主）**: 消さずに `archive/` に残すので、GC までの 7 日間は手で `mv` して戻せる。戻すと guard は再び arm される。自動で戻す手段は作っていない。
- **確認トークン（補助）**: dry-run が出すトークンを `--confirm` に要求する。トークンは「見せた一覧」と「実行時の一覧」を結びつける。式は公開なので、同意の証明ではなく、人間が答えたことは証明しない。

トークンの元は、wfDir の絶対パス、対象のうち `.md` の entry とディレクトリの種別と名前、文書ごとの承認状態、実装フェーズである。ファイルの中身は含めない。承認済み文書の書き換えは、hash の不一致として承認状態の変化に現れ、中身を含めても上積みが少ないためである。hook が書く帳簿も含めない。`workflow-bash-sync` が dry-run を実行した Bash の直後に書くので、含めると最初の `--confirm` が必ず一致しなくなる。これらも退避はされる。

## 却下した代替案

- **差分最小案: `escape.md` の `rm` コマンドに帳簿を足して列挙する**: 列挙が手順書に固定され、帳簿が増えるたびに古くなる。毎回組み立てる・消し漏れる、という今の痛みが残る。削除なので、移し忘れた節は即座に失われる。`.md` 以外は guard が `rm` を deny するので、帳簿はそもそも消せない。
- **白紙設計案: フローごとに世代ディレクトリを切る（wfDir の導出に世代を入れる）**: ゼロから設計すれば、「1 セッション = 1 フロー」という前提を外すのが自然である。起源は ADR-0013 の導出が session id だけを鍵にしたことにある。却下した理由は、導出が guard・全 recorder・CLI・起動時の要約が共有する設計面（ADR-0013 / ADR-0023）で、wfDir の pin や `/clear` 後の引き継ぎ（`references/session-handoff.md`）まで波及するためである。読み手がすべて直下だけを見るので、直下を `archive/` へ動かすだけで、導出を変えずに世代切替と同じ効果が得られる。
- **確認の記録化（承認と同じ仕組み。`ask-reset` の回答を recorder が ledger に記録し、`reset` は記録が無ければ拒否する）**: recorder・ledger・guard の保護を足す費用がかかる。今でもモデルの `rm *.md` で guard は外せる。reset はそれより広く、ledger まで直下から外すが、消さずに archive に残すので、広がった分は可逆性で埋まる。費用に見合う上積みが無い。悪用の実例が出たら再検討する。
- **承認済みの plan があれば拒否する**: 主な使い方を塞ぐ。承認状態を見せて確認に載せる（K7）ことで代える。
- **規約だけ（AskUserQuestion で聞いてから `--yes`）**: 聞かずに `--yes` しても、確認の後に一覧が変わっても気づけない。トークンなら、後者は検出できる。

## Consequences

- **R1: 確認を取らずに dry-run → `--confirm` を続けて実行できる。** トークンの式は公開なので、dry-run を経ずに計算することさえできる。reset は `rm *.md` より広く、ledger（`approvals.log`、`off-plan-writes.log`、`reviewer-runs.log`）も直下から外す。ただし消さずに archive に残すので、記録は GC までは読める。守りの主は手順書の規約と可逆性である。
- **R2: archive は GC で session dir ごと消える。** 退避は「すぐには失わない」だけで、恒久保存ではない。GC の 7 日は、session dir の直下の最終変更から数えるので、reset の rename で新しくなり、退避した記録は reset から 7 日後まで残る。dry-run の出力にこの注記を載せ、確認の質問で利用者に見せる。
- **R3: 今の読み手（guard、起動時の要約、`workflow-bash-sync`、`status`）はすべて直下だけを見る。** 将来どれかが再帰的に探すようになると、archive が arm しうる。reset 後に gate が arm しないことをテストで固定し、その変更時にテストが失敗するようにした。
- **R4: recorder が reset と同時に `approvals.log` や `reviewer-runs.log` に追記すると、直下に新しいファイルができうる。** rename は entry ごとにアトミックなので、ファイルの中身は損なわれない。残ったファイルは次の reset で退避される。
- **未確認のまま採用した点**: 利用者が `!` で打ったコマンドが PreToolUse hook を通るかは、公式ドキュメントに記述が無く未確認である。通らないなら「モデルの Bash からは deny、利用者の `!` は通る」で人間専用を機構で担保できるが、今回の方針（モデルが確認後に実行）はそれに頼らない。
- **承認は引き継がない**: `approvals.log` も退避されるので、reset の後に元と同じ内容の plan.md を書いても承認されたことにならない。承認を取り直す。
- **既知の制約**: `docs/scripts/workflow-session-audit.mjs` は `archive/` の中を見ない。退避したフローの記録は、この監査の対象から外れる。
- **受け入れた競合**: `archive` の存在確認から作成までの間に、`archive` を別のものに差し替える競合がある。突けるのはローカルで同時に動く実行者だけなので、受け入れた。

## References

- 置き換えた規約: `.skills/document-workflow-reference/references/escape.md`、`.skills/document-workflow-reference/SKILL.md`（「誤って入った場合の脱出」）
- 関連する決定:
  - `docs/decisions/0013-workflow-dir-session-derivation.md`（wfDir の導出）
  - `docs/decisions/0015-document-workflow-operator-ergonomics.md`（K5: 帳簿を書くのは CLI だけ）
  - `docs/decisions/0023-workflow-identity.md`（他セッションの dir を触らない）
  - `docs/decisions/0029-workflow-records-move-into-adr.md`（R1: 移さなかった内容は GC で失われる）
