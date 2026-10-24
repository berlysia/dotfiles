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

## macOS の symlink で起きる不具合を lint で防ぐ

macOS の `/tmp` と `/var` は `/private` の下への symlink で、次の 2 つの書き方はそこで外れる。

- メイン判定を `import.meta.url === pathToFileURL(process.argv[1]).href` で書く。Node はエントリの URL を realpath にするので、この比較は一致しない。CLI は何もせずに 0 で終わる。`import.meta.main` を使う。同じ形が `.skills/tanteki/scripts/lint.mjs` と `tests/lib/ja-baseline/extract.mjs` に残っている
- テストのフィクスチャを `mkdtempSync(join(tmpdir(), ...))` で作り、realpath で記録されたパスと文字列で比べると一致しない。`realpathSync` で包む

決めること: どの道具で書くか（oxlint に当たる規則があるか、ast-grep を入れるか）。2 つ目は `mkdtempSync(join(tmpdir()` の 222 か所のうち 73 か所しか包んでおらず、比べないテストでは包まなくてよい。一律に禁じるか、記録と比べるテストに限るかを決める。
