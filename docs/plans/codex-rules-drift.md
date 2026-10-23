# Codex が配布先の rules に書き足すと chezmoi apply が止まる

Codex は、許可した操作を `~/.codex/rules/default.rules` の末尾に `prefix_rule(...)` として書き足す。
chezmoi は、自分が前回書いた後に配布先が変わっていると、上書きしてよいかを TTY で尋ねる。
TTY の無い実行（モデルの Bash など）では、そこで apply が止まる。
止まると、後に走る段（スキルの同期など）も走らない。

2026-10-23 には、`bun run test` と `bun run typecheck` の 2 行が続けて書き足された。
利用者の判断で、どちらもソースの `home/dot_codex/rules/default.rules` に取り込んだ（#372 と #375）。

## 決めること

- 書き足しのたびに 1 行ずつ取り込むか、仕組みを変えるか
- 仕組みを変えるなら、どの形にするか。たとえば chezmoi の `modify_` スクリプトで配布先の書き足しを残す、Codex の rules をソースから外して配布先だけで持つ、などの案がある

どれも Codex に与える許可の範囲に関わるので、着手するときは Document Workflow（plan.md）を通す。

## このファイルを消す条件

扱いを決めて片付けたとき。
