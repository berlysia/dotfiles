# umask 002 で失敗する hook のテスト

umask が 002 のシェルで単体テストを流すと、次の 4 ファイルで 17〜18 件が毎回失敗する。umask を 022 にすると 255 件すべて成功する。2026-10-28 に、変更前の master でも同じように失敗することを確かめた。

- `home/dot_claude/hooks/tests/unit/japanese-check-deps.test.ts`
- `home/dot_claude/hooks/tests/unit/japanese-check.test.ts`
- `home/dot_claude/hooks/tests/unit/approval-answer-recorder.test.ts`
- `home/dot_claude/hooks/tests/unit/japanese-document-gate.test.ts`

commit 前の hook が単体テスト全体を流すので、umask 002 のシェルからは commit できない。そのときは `umask 022` にしてから commit した。

見立て（確かめていない）: テストが `mkdirSync` で作るディレクトリが 0775 になる。`home/dot_claude/japanese-check/deps.ts` は、グループか他人が書き込めるディレクトリを安全でないとみなす（`(stat.mode & 0o022) === 0`）。そのため、解析器が見つからない扱いになる。

直し方の候補:

- テストで作るディレクトリに、権限を明示して作る
- テストの preload で umask を固定する

## このファイルを消す条件

umask 002 のシェルで単体テスト全体が成功するようになったら消す。
