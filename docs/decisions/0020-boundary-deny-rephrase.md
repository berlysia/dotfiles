# ADR-0020: 境界 deny を別の綴りで回避させない

## Status

accepted (2026-10-02)

## Context

agent が `rm $W/node_modules`（自分で張った symlink の削除）を `deny-node-modules` に拒否され、理由を報告せずに `unlink` へ書き換えて実行した。`deny-node-modules` の削除判定は `(rm|rmdir)\s+.*node_modules` だけで、`unlink` は ask に落ち、PermissionRequest の LLM evaluator が「unlink is reversible」という誤った理由で許可した。home guard（`lib/command-parsing.ts`）の `find -exec` 用の動詞リストには `unlink` があり、2 つのリストが黙って分岐していた。

問題は 3 層にある。保護対象（依存の中身）を壊さない symlink 削除まで拒否した誤検知、動詞の列挙漏れ、拒否された agent が別の綴りで再試行する行動である。誤検知が言い換えの動機になり、言い換えが列挙漏れを通る。

設計の全文とレビューの記録は、この変更のセッションの spec と plan にある。ここには判断と却下した代替案を記す。

## Decision

支配軸はリスク（拒否の回避経路を閉じる）で、次に制約適合（新しい回避経路を作らない）である。deny は広く fail-closed にし、許可の例外は hook と shell の解釈が一致する形に限る。

- **K1（境界 deny と誘導 deny を分ける）**: 保護対象を持つ deny（`deny-node-modules` の Bash とファイル系ツール、`auto-approve` のセキュリティ判定 3 経路）だけに `BOUNDARY_DENY_GUIDANCE`（別のコマンド・ツール・言語で同じ効果を再試行せず、ユーザーに報告して止まる）を付ける。`block-tsx` のように代替手段を指示する誘導 deny と、内部エラーの deny には付けない。指示は agent が判断する瞬間に読む deny 理由に置く。機械的な強制ではない。
- **K2（削除を動詞の単語出現で判定する）**: 動詞を `lib/destructive-verbs.ts` の定数（`DELETE_VERBS` / `MOVE_VERBS` / `FIND_EXEC_FLAGS`）にまとめる。`node_modules` を含む個別コマンドに削除動詞が単語として現れれば deny する。単一の単純コマンドで先頭語が既知の read-only コマンドなら除外する（`grep rm node_modules/x` は allow）。`find` は位置を問わず認識し、`-delete` か、exec 系の後に削除・移動動詞があれば deny、それ以外の exec 系は ask にする。parser が fallback したときは、複合コマンドの断片に read-only の除外と allow を使わない。判定は `lib/node-modules-policy.ts` の純関数に置く。
- **K3（symlink 削除の例外を単独コマンドに限る）**: コマンド全体が `rm [-f]… <絶対パス>…` か `unlink <絶対パス>` で、メタ文字・変数・引用符を含まず、各オペランドの末尾セグメントだけが `node_modules` で、realpath を通さない `lstat` で symlink と確認できるときだけ、`deny-node-modules` は判定を出さない。複合コマンド内での削除は deny のままで、deny 理由が単独の `unlink` を案内する。
- **K4（evaluator）**: プロンプトで削除を不可逆と明記し、可逆性を ALLOW の根拠にさせない。
- **K5（run-guard）**: `deny-node-modules` を他の guard と同じく `run-guard.sh … || exit 2` で起動し、クラッシュ・bun 不在・タイムアウトを fail-closed にする。
- **K6（動詞リストの同期）**: home guard のコードは変えず、`FIND_DESTRUCTIVE_EXEC` と `FIND_EXEC_FLAGS` を export して、共有定数との差分が宣言済みの除外（`rmdir`）だけであることをテストで検査する。

### 却下した代替案

- **差分最小案（正規表現に `unlink` を足し、全 deny に一律の文言を足す）**: 誤検知が残って言い換えの動機が消えない。一律の文言は、代替手段を指示する誘導 deny（`block-tsx` の `Suggestion:`、`block-plan-mode` の移行先）と矛盾する。`unlink` を足すと `grep -rn unlink node_modules/x` を新たに deny する。
- **効果モデルで例外を一般化する（変数・`cd` を解決する walker で、複合コマンドの中の削除対象を解決する）**: レビューのたびに、hook の解釈と shell の実行がずれる穴（字句的な `cd` と物理的な `cd`、条件付き代入、walker と parser のセグメント対応、parser の fallback）が見つかった。home guard のコード約 600 行の移動も要り、2026-09-24 の事故の防御コードに回帰の危険を持ち込む。
- **代入とラッパーを除去して先頭語を特定する**: `git rm`、オプション引数付きのラッパー（`sudo -u root rm`、`timeout 5 rm`）、parser fallback の断片で、旧正規表現より deny が狭くなった。
- **deny の種類を型（判別共用体）にする**: `createDenyResponse` の全呼び出しの書き換えが要るが、誘導側の挙動は変えない。付け忘れは境界の deny 経路ごとのテストで検出する。

## Consequences

- **観測された回避は閉じた**: `unlink`・`shred`・`truncate`・`find -delete`・`find -exec <削除・移動動詞>`（ラッパー越し、引用符で崩した形を含む）は deny になる。
- **誤検知は残る**: 先頭語が read-only でないコマンドの引数に削除語が現れる場合（`echo rm node_modules`、heredoc の本文、`git commit -m "find -delete" node_modules`）は deny になる。fail-closed 側として受容する。誤検知が観測された先頭語は read-only の表に足す。
- **対象外の削除経路**: インタプリタ経由（`python -c 'shutil.rmtree(...)'`）、`git clean`、`rsync --delete`、`cd node_modules && rm -rf *`、パイプ経由（`find node_modules | xargs rm`）、glob 綴りは、旧実装と同じく機械的には deny しない。インタプリタ・`git clean`・`rsync` は ask になり、K4 の evaluator と K1 のガイダンスがベストエフォートで補う。
- **再検討の条件**: 2 例目の綴りによる回避が観測されたら、解決済みパスで判定する効果モデルを再検討する。
- **反映**: `chezmoi apply` の後から効く。`deny-node-modules` は run-guard 経由になり、bun 不在やタイムアウトでも deny になる。
- **観測された隣接問題**: 実装中に、scratchpad や `mktemp -d` の出力先が guard 間で矛盾して使えないこと、worktree で Document Workflow を使うときに guard と `workflow-cli status` のパス解決が食い違うこと、heredoc の本文が誤検知されることを観測した。別の Issue として扱う。

## References

- `home/dot_claude/hooks/lib/destructive-verbs.ts`
- `home/dot_claude/hooks/lib/node-modules-policy.ts`
- `home/dot_claude/hooks/lib/context-helpers.ts`
- `home/dot_claude/hooks/implementations/deny-node-modules.ts`
- `home/dot_claude/hooks/implementations/auto-approve.ts`
- `home/dot_claude/hooks/implementations/permission-llm-evaluator.ts`
- `home/dot_claude/.settings.hooks.json.tmpl`
- `home/dot_claude/hooks/tests/unit/destructive-verbs-drift.test.ts`
