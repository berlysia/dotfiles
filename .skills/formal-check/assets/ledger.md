# 形式検査の台帳: <対象の名前>

- 対象のリポジトリ: <リポジトリ>
- manifest: <置き場>/formal.json
- 作った日: <YYYY-MM-DD>

## 実装の主張

実装が守っている性質を、1 行に 1 つ書く。
file:line は必ず書く。
check id の欄が空の行は「未検査」と読む。
モデルの範囲の外にした主張は、対象外の欄に理由を書く。

| 主張                   | file:line   | check id                 | 対象外           |
| ---------------------- | ----------- | ------------------------ | ---------------- |
| <実装が守っている性質> | <path:line> | <check id、空なら未検査> | <空、または理由> |

## 機械検査の結果

check ごとに、アンカーの行と結果を書く。
blocked の check は「blocked（理由）」と書き、理由に表の error の code と `Recover with:` の行を引用する。
追従の 1 周で最初に実行した結果も、日付付きでここに書く。

<!-- check: <check id> -->

- 日付: <YYYY-MM-DD>
- verdict: <hold、violate、または blocked（理由）>
- 壊したモデル: <broken-variant の id と verdict>
- 実コードを壊す確認: <N/A、または結果>

### 実コードを壊す確認の記録

開始の行と終わりの行を対で書く。
終わりの行が無い開始の行は、途中で止まった確認である（SKILL.md の「途中で止まったときの回収」）。

- 開始: <YYYY-MM-DD>、worktree <絶対パス>、元の HEAD <commit>、元の status <git status --porcelain の出力。複数行なら行を「;」でつなぐ。空なら「変更なし」>、壊す予定のファイル <path の一覧>、コピーしたファイル <worktree の中の path の一覧、無ければ「なし」>
- 終わり: <YYYY-MM-DD>、worktree <開始の行と同じ絶対パス>、元の HEAD と status が記録と <同じ、または違い>

## 確認質問

finding の `question` を、利用者への問いとして引用する。
witness を書くときは引用として書き、秘密に見える値は伏せる。

| 質問 id | check id              | 問い              | 答え           |
| ------- | --------------------- | ----------------- | -------------- |
| <q1>    | <finding の check id> | <question の引用> | <未回答なら空> |
