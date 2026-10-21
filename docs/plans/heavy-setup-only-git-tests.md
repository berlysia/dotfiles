# setup でだけ git を使うので heavy に置いたテスト

## 今の形（2026-10-21 に観察）

次のテストは、本体が git の結果を使わないのに、`beforeEach` の setup かモジュールの読み込み時に git を起動するので、`tests/heavy/` に置いている。unit は git を起動しない規則のため。テストの中身は変えていない。

- `write-protection.test.ts` の `classifyWriteTarget`（10 件）: `beforeEach` が git の init・commit・worktree add を実行する。`holds when lstat fails with anything but ENOENT` は fake の `lstat` を使い、git の結果を要らない
- `bash-write-hold.test.ts` の `assessBashCommand - verified worktrees`（2 件）: `beforeEach` が同じく worktree を作る。`holds protected names inside the worktree` は、path の文字列だけで済むかもしれない（未確認）
- `working-tree-fingerprint.test.ts` の `12:`（baseline が無い）と `16:`（deadline が 0）: 本体は git を起動しない。`makeRepo()` が repo を作る

## やりたいこと

上のテストの setup を、git を使わない形に書き換えて unit に戻す。例:

- worktree の path を文字列で組み立てる（`write-protection`・`bash-write-hold`）
- `12:` と `16:` は `makeTempDir()` だけで済ませる（`working-tree-fingerprint`）

unit に戻せば、gate が再びこれらを走らせる。保護パスを hold にする判定（`write-protection`）が gate から外れている間は、`bun run test:heavy` で落ちたときの原因調査に頼っている。

## 決めること

- 書き換えて、テストが確かめていることが変わらないか。`classifyWriteTarget` は worktree の偽装・symlink での脱出を確かめる。実際の worktree でなければ確かめられない件は、heavy に残す
- 戻す対象を、`holds when lstat fails with anything but ENOENT` のように、本体が git を要らないと分かっているものに限るか
