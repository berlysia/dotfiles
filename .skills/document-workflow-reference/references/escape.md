# 誤って入った場合の脱出

routing を誤り、直接実行相当のタスクに research/plan を書いてしまったときに読む。禁止事項の要約は SKILL.md「誤って入った場合の脱出」にある。次のフローを同じセッションで白紙から始めるときも、同じ `workflow-cli reset` を使う（SKILL.md「記録の移し方」）。

guard は wfDir に `research.md` または `plan.md` が存在した時点で enforce を始める（`spec.md` 単独では始まらない）。allow には research.md の存在も要り、plan.md が承認済みでも research.md が無ければ `✗ research.md` で deny される。`workflow-state.json` の `mode` も条件だが、現在どの hook も書かない。直接実行相当のタスクに research/plan を書いてしまった場合、承認を経ずに抜ける経路は **wfDir 直下の文書を外すこと** だけである。`workflow-cli reset` は直下の全エントリを `archive/<日時>/` へ退避するので、文書も帳簿（`approvals.log`、`reviewer-runs.log`、`.tripwire-baseline` など）も一度に外れる。

実行はモデルが行う。守りの主は退避による可逆性で、消さずに `archive/` に残すので、GC までの 7 日間は手で戻せる。確認トークンは「利用者に見せた一覧」と「実行時の一覧」を結びつけるだけで、利用者が答えたことの証明ではない。確認は AskUserQuestion で必ず取る。

1. routing を誤ったと 1 行で述べ、直接実行相当と判断した条件を含める。**まだ実装しない**。
2. `workflow-cli reset` を引数なしで実行する（dry-run。何も動かさない）。出力の承認状態・退避対象・7 日の注記・確認トークンを、そのまま AskUserQuestion に載せて利用者に見せる。

   ```bash
   workflow-cli reset
   ```

3. 利用者が承諾したら、dry-run が出力した `workflow-cli reset --confirm <トークン>` をそのまま実行する。承諾が無い、または質問がキャンセルされたら実行しない。dry-run の後に直下の文書の集合や承認状態が変わると、トークンが合わず拒否される。そのときは 2 からやり直す。

   ```bash
   workflow-cli reset --confirm <トークン>
   ```

4. 実行後、次のツール呼び出しから guard と `workflow-bash-sync` は inactive になる。`workflow-cli status` で `plan.md` が missing 扱いになることを確認してから直接実行に戻る。
5. 残す価値がある内容は会話で要約して引き継ぐ。

機構メモ:

- `reset` は `archive` 以外の直下のエントリを全部動かすので、`research.md` と `plan.md` の**両方**が外れる。列挙は持たないので、帳簿が増えても漏れない。
- `followups/` にファイルが 1 件でもあると、dry-run でも `--confirm` でも拒否される。残件は `docs/plans/` へ移すのが規約で、archive に入れると GC で消えるため。誤入のときは、残すか捨てるかを利用者に聞く。残すなら `docs/plans/` へ移し、捨てるなら利用者が決めた方法で外す。gate が閉じていてモデルの `mv` が通らないときは、利用者に `! mv ...` を頼む。
- 手で戻すときは、`archive/<日時>/` の中身を wfDir 直下へ `mv` で戻す。戻すと guard が再び arm される。自動で戻す手段は無い。
- reset 直後の Bash で `[workflow-bash-sync] tripwire re-armed` が一度出ることがある。次のフローに入ったときの正常な通知で、対処は要らない。
- 対象は現セッションの wfDir だけで、別セッションの dir を指す `--wf-dir` は拒否される。`archive/` 自体は退避の対象にならない。
- `/clear` も脱出になる（新 session id で新 wfDir になる）。会話文脈を失う代わりにコマンドは不要。
- `DOCUMENT_WORKFLOW_WARN_ONLY=1` は脱出ではなく guard 全体の無効化で、起動時 env でしか効かない。routing 誤りの対処に使わない。
