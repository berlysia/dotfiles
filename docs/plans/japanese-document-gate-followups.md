# 日本語文書のゲートの残件

ADR-0047 の作業で、範囲の外に回したことを置く。

## Codex で観測していない挙動

Codex 0.163.0 では、Bash の PreToolUse・PostToolUse と Stop の入力を実測した。次の 2 つは観測していない。

- apply_patch のときの PostToolUse の入力の形。今はパッチの本文から対象のパスを取る `patchTargetPaths` に頼っている
- Stop で `{decision: "block"}` を返したときと、`systemMessage` を返したときに、Codex が利用者にどう見せるか。フックは故障の知らせを stderr にも出すが、Codex がそれを表示するかも分かっていない

確かめ方: 一時的な `CODEX_HOME` に入力を書き出すだけのフックを置き、`codex exec --dangerously-bypass-hook-trust` で apply_patch を 1 回使わせる。Stop の扱いは、block を返すフックで同じように試す。
