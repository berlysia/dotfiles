# heavy のテストを、変えたパスで絞って pre-push で実行する

## 今の形（2026-10-23 に観察）

- pre-commit は unit（`bun run test`）だけを実行する。heavy は、`.chezmoiremove` まわりのパスを変えたときに、`tests/chezmoiremove-coverage.test.mjs` を直接実行するだけである
- pre-push は jactionlint と gitleaks だけを実行する
- heavy の全部（`home/dot_claude/hooks/tests/heavy/` の 36 ファイルと `tests/heavy/` の 2 ファイル）を実行するのは、CI と `bun run check` だけである。手元では 66 秒かかった
- PR #378 では、ADR に `.tmp/sessions/` を書いたことを `doc-structure.test.ts` が CI で初めて見つけた。heavy を最後に実行したのは ADR を書く前だった

pre-push で heavy を全部実行する案は、push のたびに約 1 分待つので採らなかった。

## やりたいこと

push する差分のパスに関係する heavy のテストだけを、pre-push で実行する。

- 各 heavy のテストのファイルの先頭に、そのテストが見るパスを書く（例: `doc-structure.test.ts` なら `docs/decisions/` と `docs/plans/`）。対応の一覧を別のファイルに持つと、テストを足したときにずれるので、テストの隣に置く
- pre-push は、push する範囲の変更パスを各ファイルの宣言と照らし、当たったファイルだけを `node --test` で実行する
- 宣言の無い heavy のファイルは、pre-push では実行せず、今までどおり CI に任せる
- 負荷に弱いテストで push が止まることがあるので、スキップの環境変数を 1 つ用意する

## 決めること

- 宣言の書き方（コメントの形か、export する定数か）と、宣言の抜けを見つける方法（宣言の無いファイルを数える、など）
- 今の pre-commit の `.chezmoiremove` の扱いを、この仕組みに寄せるか
