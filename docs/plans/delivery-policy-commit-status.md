# delivery-policy merge が commit status の必須チェックを待ち続ける

## 起きていること

`delivery-policy merge <PR>` が、必須チェック `status-check` が通っていても終了コード 10（未完了）を返し続ける。

- `home/dot_claude/hooks/cli/delivery-policy.ts` の GraphQL は、`checkSuites` の `checkRuns` だけを読む。
- このリポジトリの `status-check` は commit status（GraphQL の `StatusContext`）として報告される。#379、#380、#381、#383 で確認した。
- 一致する check-run が 0 件のとき、`outcomeOfContext` は `pending` を返す。そのため commit status の必須チェックは、いつまでも未完了と判定される。

## 直すときに決めること

- commit status（`statuses` または `statusCheckRollup` の `StatusContext`）も読み、`state` で判定する。
- 必須チェックが app に結び付いている（`integrationId` がある）とき、commit status をどう照合するか。
- 守られたパス（`PROTECTED_PATHS`）の変更なので、この修正の PR は自動 merge されない。

## それまでの扱い

`status-check` が pass になったのを `gh pr checks <PR>` で確かめてから、利用者が `gh pr merge <PR> --merge --delete-branch` を実行する。
