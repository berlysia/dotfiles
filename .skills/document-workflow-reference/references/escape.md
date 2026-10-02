# 誤って入った場合の脱出

routing を誤り、直接実行相当のタスクに research/plan を書いてしまったときに読む。禁止事項の要約は SKILL.md「誤って入った場合の脱出」にある。

guard は wfDir に `research.md` または `plan.md` が存在した時点で enforce を始める（`spec.md` 単独では始まらない）。allow には research.md の存在も要り、plan.md が承認済みでも research.md が無ければ `✗ research.md` で deny される。`workflow-state.json` の `mode` も条件だが、現在どの hook も書かない。直接実行相当のタスクに research/plan を書いてしまった場合、承認を経ずに抜ける経路は **wfDir の文書を消すこと** だけである。承認と対称に、消す操作もユーザーに委ねる。

1. routing を誤ったと 1 行で述べ、直接実行相当と判断した条件を含める。**まだ実装しない**。
2. `workflow-cli dir` の `wfDir=` 行で得たリテラルパスで削除コマンドを提示し、実行を依頼する。プロンプトで `! rm -f ...` と打てば同セッション内で実行できる。

   ```bash
   rm -f .tmp/sessions/<id8>/research.md .tmp/sessions/<id8>/plan.md .tmp/sessions/<id8>/spec.md .tmp/sessions/<id8>/plan-*.md
   ```

3. 実行後、次のツール呼び出しから guard と `workflow-bash-sync` は inactive になる。`workflow-cli status` で `plan.md` が missing 扱いになることを確認してから直接実行に戻る。
4. 残す価値がある内容は会話で要約して引き継ぐ。

機構メモ:

- `research.md` と `plan.md` の**両方**を消す。一方が残ると armed のまま。
- モデル自身の Bash `rm` も wfDir 配下の `.md` なら通る。ただし `rm "$WF/plan.md"` のようなシェル変数の形は deny される（guard は変数を展開せず cwd 相対で解決する）。`rm -r <wfDir>` も対象が `.md` でないので deny。通る場合もユーザーに委ねるのは、routing 誤りの自己判定を guard の外で単独実行しないため（steering を一方的に無効化しない）。
- `.tripwire-baseline` などの残りは無害で 7 日で GC される。ただし同セッションで後から workflow に入り直すと、古い `.tripwire-baseline` との差分が 1 回 off-plan として報告される。気になるなら一緒に消す。
- `/clear` も脱出になる（新 session id で新 wfDir になる）。会話文脈を失う代わりにコマンドは不要。
- `DOCUMENT_WORKFLOW_WARN_ONLY=1` は脱出ではなく guard 全体の無効化で、起動時 env でしか効かない。routing 誤りの対処に使わない。
