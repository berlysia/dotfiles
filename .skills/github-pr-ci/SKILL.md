---
name: github-pr-ci
description: GitHub の PR を更新・マージするとき、required check を待つとき、CI の失敗や取り込み制約を調べるときに使う。PR 本文の執筆規範、ローカルだけの Git 操作、履歴書き換えには使わない。
---

# GitHub の PR と CI

## 必須チェックを待ってマージする

1. 対象 PR の head SHA、base、`mergeStateStatus` と、保護ルール・ruleset の必須チェックを確認する。直接 push の可否と PR の取り込み条件は別に調べる。管理者の bypass で push が通っても、必須チェックを満たした証拠にはならず、手元のフックもサーバーの検査を代替しない。
2. head SHA に対する check-run と commit status の両方を読む。`statusCheckRollup.__typename` で区別し、`CheckRun` の `name` / `conclusion` と `StatusContext` の `context` / `state` を確認する。名前だけでなく作成元も照合する。このリポジトリのマージ判定では Bot が作成した commit status を対象とし、自分で success を付けて条件を満たさない。
3. 集約役の `status-check` がある場合は、そのワークフローの集約対象も読む。個別ジョブが成功しても、集約結果が pending なら待つ。paths や実行条件による skipped と、実行前の cancelled を区別し、未実行を一律に成功としない。
4. push 直後はチェックが未登録のことがある。登録を確認してから `~/.local/bin/delivery-policy wait <PR 番号>` を Bash の `run_in_background: true` で起動して待つ。台帳は読まず、merge しない。終了コードは、0 が必須チェックの成功（または merge 済み）、10 が同じコマンドの再起動、11 が head の変化（もう 1 回だけ起動し直す）、12・30・40 が人に戻す、である。完了の通知が届くまで出力ファイルを読まず、`gh run watch` や `gh pr checks --watch` も自分で起動しない。チェックがないための即時終了や待機時間切れを成功とせず、待機終了時に head SHA と必須チェックの保留・失敗を再確認する。`BLOCKED` や `base branch policy prohibits the merge` だけで原因を決めない。
5. マージの許可があり、CI 待ちなら auto-merge を使える。確認した SHA を `--match-head-commit` に渡し、確認後に head が変われば再確認する。エラーが勧める `--admin` で保護を迂回しない。

## PR 更新と Actions の確認

- `gh pr edit` が Projects classic などの GraphQL エラーで更新前に失敗したら、REST に切り替える。同じ更新を `PATCH /repos/{owner}/{repo}/pulls/{number}` で行い、本文などの対象項目を取得し直す。コマンドの終了だけでは更新を確認できない。
- Actions の検査が手元と食い違うときは、検査器のバージョン、実行する検査の一覧、checkout 元、ローカル action の参照元を比較する。`./` の action は checkout された内容を読むため、workflow のコミットから解決する参照との違いを確認する。`run` 内に外部由来の式を直接展開せず、値は env 経由で渡す。
- SARIF の送信とジョブの失敗を別々に確認する。指摘で非ゼロ終了すると upload が実行されない構成では、検査 step だけ失敗を許して送信し、合否を決める処理を別にする。Security タブへの登録だけで必須チェックが失敗するとは限らない。

## CI の基盤障害と変更による失敗を分ける

1. `cancelled` はジョブの steps、注釈、開始時刻を読む。steps が空で、無関係な複数ジョブが同時に停止したなら、runner・queue・基盤の状態を調べる。同じ失敗が2回続いたら、3回目の再実行前に status page とリポジトリ全体の queue を確認する。
2. 再実行後はジョブ ID と所要時間を前回と比較し、実際に新しい実行が始まったか確かめる。バックグラウンド処理やパイプ末尾の exit 0 だけで成功とせず、出力とジョブの結論を読む。
3. 同じ検査を base でも実行し、既存故障か調べる。paths 付きの検査は、以前の故障が無関係な PR で初めて現れることがある。base も失敗するなら修正を別 PR に分け、元の PR に混ぜない。ブランチ追従後は、フォーマッタ更新の影響もあるため lint を再実行する。

## 取り込み制約を実証する

1. リポジトリ設定の許可されたマージ方法と、ruleset の対象ブランチ・`allowed_merge_methods`・bypass 権限を分けて読む。ruleset は `--admin` なしでも迂回されることがある。PR 経由の squash 禁止から、直接 push も禁止だとは推定しない。
2. 制約を変更する依頼では前後の設定を比較し、意図した項目以外が変わったら戻して止まる。制約を移す場合は新しい制約を有効にしてから旧制約を外し、制約が緩む時間を作らない。
3. 実証を依頼された場合だけ、成功すれば実際に取り込まれる試行を行う。先にチェック未完了や古いブランチなど他の阻害要因を除く。PR が open のままという結果では拒否と断定せず、API の拒否理由と規則の評価記録を確認する。予想外に取り込まれた場合や判定不能なら止めて報告する。
4. 取り込み後はコミットの親を確認し、merge commit と元のコミット列が残ったか確かめる。結果を確認してから、設定値、日付、適用範囲、拒否理由または bypass、戻し方を ADR に記録する。設定変更自体は Git の履歴に残らないためである。

## マージ後の後片付け

`gh pr merge --delete-branch` はリモートのマージと削除が済んだ後、別 worktree での checkout が原因で手元の処理だけ失敗することがある。再度マージする前に PR の状態とリモートブランチを確認する。
手元の削除は `git-safety` の取り込み判定と残存ファイル確認に従う。使用中判定が残るなら、対象 worktree を cwd にしたバックグラウンド処理も調べる。別作業の worktree は触らない。
マージの依頼だけで `chezmoi apply` まで実行しない。apply は稼働中の他セッションが使う設定やフックも変更する。
