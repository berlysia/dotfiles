# 日本語文書のゲートの残件

ADR-0047 の作業で、範囲の外に回したことを置く。

## Codex で観測していない挙動

Codex 0.163.0 では、Bash の PreToolUse・PostToolUse と Stop の入力を実測した。次の 5 つは観測していない。

- apply_patch のときの PostToolUse の入力の形。今はパッチの本文から対象のパスを取る `patchTargetPaths` に頼っている
- translationese-scan の PostToolUse が返す `additionalContext` を、Codex が利用者やモデルにどう見せるか
- Codex は hooks.json に項目を足すと hook を信頼し直すまで動かない（ADR-0042）。translationese-scan を足した後、信頼し直した環境で実際に動くか
- apply_patch のパーサーが、行頭に空白のある見出し（` *** Add File: x`）を見出しとして適用するか。適用するなら、その書き込みはゲートと translationese-scan に追跡されない
- Stop で `{decision: "block"}` を返したときと、`systemMessage` を返したときに、Codex が利用者にどう見せるか。フックは故障の知らせを stderr にも出すが、Codex がそれを表示するかも分かっていない

確かめ方: 一時的な `CODEX_HOME` に入力を書き出すだけのフックを置き、`codex exec --dangerously-bypass-hook-trust` で apply_patch を 1 回使わせる。Stop の扱いは、block を返すフックで同じように試す。

## macOS でだけ落ちる単体テスト

`home/dot_claude/hooks/tests/unit/japanese-document-gate.test.ts` の 8 件（「workflow directory exclusion」「Bash attribution」など）は、macOS で実行すると落ちる。Linux の CI では通る。

`tmpdir()` が `/var/folders/...` を返す一方で、追跡の記録には realpath の `/private/var/folders/...` が入る。テストは `tmpdir()` の形のパスを期待しているので一致しない。

直し方の候補: フィクスチャの根を作った直後に `realpathSync` で揃える。確かめ方: macOS で `npm run test` を流し、この 8 件が通ること。
