# hooks のテストの実行環境で持ち越した課題

claude-sessions（ADR-0059）を実装する途中で観察した、テストの実行環境の課題。umask と statusline の 2 件は claude-sessions の変更と無関係で、実行時間の 1 件は原因をまだ調べていない。片付いた項目は消し、空になったらこのファイルを消す。

## umask 002 で japanese-check のテストが失敗する

2026-10-29 の観察:

- umask 002 のシェルで `bun run test` を実行すると、17〜18 件が失敗する。失敗するテストは次のとおり
  - `home/dot_claude/hooks/tests/unit/japanese-check-deps.test.ts`
  - `home/dot_claude/hooks/tests/unit/japanese-document-gate.test.ts`
  - `home/dot_claude/hooks/tests/unit/approval-answer-recorder.test.ts`
  - japanese-check 本体のテスト
- 同じファイルを umask 022 で実行すると、すべて成功する
- japanese-check は、解析器の実行環境のディレクトリに group の書き込み権限があると「安全でない」と判定する。umask 002 では、テストが mkdtemp で作るディレクトリに group の書き込み権限が付く
- completion gate と pre-commit の hook はシェルの umask を引き継ぐ。そのため、変更と関係なくこれらのテストで止まる

直し方の候補（未決定）:

- テストで一時ディレクトリを作った直後に `chmod 700` する
- `home/dot_claude/hooks/tests/preload-test-env.mjs` で `process.umask(0o022)` を設定する

## statusline のテストが負荷で時間切れになる

`tests/usage-line-statusline.test.mjs` の「statusline.ts alone (hooks missing)」は、unit 全件の実行中に spawnSync の 1 秒の期限を超えて失敗することがある。単独で実行すると成功する。

## unit 全件の実行時間が上限を超えている

2026-10-29 に umask 022 で unit 全件を 3 回実行し、中央値 64.5 秒、最大 70.6 秒だった。上限の 1 分を超えている。ほかの重い処理が動いていた時間帯で、claude-sessions の追加前の基準値は測っていない。

- master で同じ手順を 3 回実行し、追加前と比べる
- 遅いファイルを特定し、ファイルの分割、プロセス起動から関数呼び出しへの置き換え、heavy への移動のどれで戻すかを決める
