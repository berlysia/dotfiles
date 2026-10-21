# workflow-cli reset の確認を、承認と同じ仕組みに載せる

## 今の形（2026-10-21 に観察）

- `workflow-cli reset` は退避する一覧と confirm token を出し、「after confirming with the user, run: workflow-cli reset --confirm <token>」と案内する
- 利用者に確かめるのはモデルの役目で、モデルが AskUserQuestion で聞き、回答を見て `--confirm <token>` を自分で実行する
- token は出力に出ているので、モデルが利用者に聞かずに実行しても機構は止めない（確認は指示を守ることにだけ頼っている）

## 承認の形

- `workflow-cli ask-approval` が質問を出し、利用者の回答を `approval-answer-recorder` hook が `approvals.log` に記録する。モデルは `answers` を入れられず、承認行も書けない（guard が deny）

## やりたいこと

reset の確認も、利用者の回答を hook が記録し、`--confirm` はその記録があるときだけ通る形にする。例: `workflow-cli ask-reset` の質問への回答で、hook が token を記録する。

## 決めること

- 記録の置き場（`approvals.log` と同じ帳簿か、別か）と、記録の有効期限（token を出した後に wfDir が変わったら無効にするか）
- 会話で「reset して」と書いた場合を、承認の `approve` と同じく記録として扱うか
- ADR-0037（workflow-cli reset）の Amendments に書くか、新しい ADR にするか
