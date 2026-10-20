# ADR の整理で持ち越した課題

ADR を「決定と、再検討に要る事柄」に絞ったときに、ADR から移した観測項目と未実施の案。片付いた項目は消し、空になったらこのファイルを消す。項目を消す commit の本文に、消した項目の名前を書く。

## ADR-0006 二層モードの観測

二層モードは既に使っているので、運用の実績を集めて判断する。

- 二層と単層の選ばれ方を見て、routing の表が機械的な判定に足りているかを評価する
- spec の承認後に plan-N.md を改訂した例で、再レビューが plan-N.md に閉じているかを確かめる
- parent-spec-hash の不一致の起こり方を見る。極端に多ければ承認の流れが破綻している。極端に少なければ、連鎖の検証の必要性を見直す

## ADR-0007 の採否

二層運用の最初の 5 セッションまたは 30 日という観察期間は、過ぎている見込みが高い。次の 3 つを集計し、2 つ以上で差が出れば accepted、出なければ閉じて Status を改める。

- placeholder と曖昧語の reviewer の指摘の回数（spec、plan、plan-N の別）
- brainstorming の 1 ラウンドあたりの質問の数（中央値と最頻値）
- spec の self-review の marker の有無

採らない条件: ADR-0006 だけで足りる、自動レビューと重なる、一問一答が負担になる。

## ADR-0008 で見送った案

Deferred-2 と Deferred-7 は閉じたので載せない。

- **Deferred-1（code-aware draft hook）**: spec や plan に新しい関数名や API を書いたとき、関連する既存ファイルを読むよう PostToolUse の hook で促す。見直すのは、「想像で関数名を書く」失敗が、同じ系統のプロジェクトで 3 セッション続けて指摘されたとき
- **Deferred-3（早期の 1 reviewer）**: plan-N の最初の 1〜2 タスクを書いた時点で logic-validator だけを走らせる。見直すのは、1 つの plan-N で同じ前提の取り違えが 2 セッション以内に 2 件以上起きたとき
- **Deferred-4（セッションをまたぐ記憶）**: 教訓をセッションの外に置き、プロジェクトをまたいで引き継ぐ。見直すのは、別のプロジェクトでも Document Workflow を使い、2 つ以上で同じ失敗の型が出たとき。lessons-learned は撤去したので、前提から見直す
- **Deferred-5（未使用の定数）**: `workflow-paths.ts` の `plan-review.md` / `plan-review.json` の定数を、別ファイルへの記録に使う。見直すのは、Reviewer Outputs が長くなり、本文の半分以上を占める状態が続いたとき
- **Deferred-6（HMAC による改ざんの検知）**: Deferred-4 を実装するときに合わせて判断する。または、教訓に当たるファイルが外部のストレージに移り、書き手が複数になったとき。対象が無ければ閉じる

## ADR-0012: 癖のカタログの一般化を明記する

CPK-C108 の `notes/prose-style.md` に、癖のカタログが `berlysia-writing` の `quirks.md` へ一般化されたことを書く。それまで、2 つのファイルの食い違いを検知する仕組みは無い。

## ADR-0013 の観測項目

- `env-rejected` が起動時のサマリに出るか。出るなら、pin の書き方の誤りか、ADR-0013 の Consequences 2（サブディレクトリから起動したときの縮退）が実際に起きている
- `unresolvable` がツールを呼ぶたびに出続けるか。出続けるなら、ADR-0013 の Consequences 3 の kill-switch か、session id の形の違反を疑う。正常時にも鳴る警告に近づくので、頻度が分かったら `docs/plans/workflow-guard-followups.md` の課題 H の設計の入力にする

## ADR-0015 の受入基準と観測

- 変更の後の 5 セッションで `docs/scripts/workflow-session-audit.mjs` を回し、Reviewer Outputs と intent-triage の欠落が 0 件で、推奨の注入量が round 数 × 2KB 以下であることを確かめる
- ラウンド予算: 新しい実質の指摘が Round 4 以降で 0/4 という標本は小さい。設計そのものが動く周は、差分の再レビューの周と分けて数える

## ADR-0027 の未対応の課題

- symlink: `auto-approve` の allow は解決先を見ない
- `!` の付いた deny の除外を hook が行わない
- Read の規則を Glob、Grep、LS に当てていない（パスを取り出す関数が、Glob では `pattern` だけを返し、LS では何も返さない）
- 一致する規則が無いときに `ask` を返す動作。allow の外では `claude -p` の Edit と Write が通らない見込み
- 危険なパスの扱いが Edit と Write で違う
- `file-access-guard` の判定の順序（D6 の不変条件）をテストで固定する
- 別のセッションの workflow dir の文書を Write で上書きできる
- chezmoi の誘導がこのリポジトリで働いていない。source の場所を repo の直下で探し、`.chezmoiroot`（`home`）を見ない
- hook が読む設定ファイルの集合を本体に合わせる（サブディレクトリからの起動、worktree のローカル設定、`--settings`、CLI のフラグ、managed settings、`CLAUDE_CONFIG_DIR`）
- worktree に入った後、基準が本体と合わなくなる場面（追加の作業ディレクトリへの `cd`、対話で外への `cd` が承認された場合、subagent や再開したセッションで名前が合わない場合）で、基準を本体に合わせる。案は PostToolUse で `EnterWorktree` の結果を記録すること。場面が実際に起きたら検討する

## ADR-0027 の未確認の事実

- `claude -p` で PreToolUse の `ask` が拒否になるか。確かめたら ADR-0027 の Amendments に足す
- managed settings の `/x` の基準
- `--settings` に JSON の文字列で渡した規則の基準
- `/cd` の後の基準と `transcript_path` の名前（`claude -p` では `/cd` を使えない）
- 長いパスでの名前の切り詰め、symlink からの起動、再開、subagent、入れ子の `EnterWorktree`
- 対話で、worktree に入った後に外へ `cd` した結果
- 追加の作業ディレクトリへ `cd` した場面での本体の基準
- `///x` や `/../x` の本体の読み方と、worktree に入った後の元の checkout への `sed -i` の扱い

## ADR-0028: 委任の質問の既定の選択

AskUserQuestion の画面で、2 問目の既定の選択がどうなるかを確かめていない（「委任しない」を先頭に置いた）。実機で確かめる。
