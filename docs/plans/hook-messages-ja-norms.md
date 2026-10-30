# hook の応答の日本語に規範を当てる（Sarashina に試させる）

## きっかけ

利用者の発言（2026-10-29）:「日本語規範の適用とかはsarashinaにやらせてみても良いかもね、hookの応答内容の日本語に規範が効いてないので」

## 観察した例（このセッションで出た hook の文面）

- plan-review-automation（plan を Edit した後）: 「plan-2.md changed (hash …); Round 10: 前回提示の推奨のまま。reviewer 実行後 workflow-cli round/stamp」。主語と述語が無く、次に何をするかが読み取れない。英語と日本語が混ざる。
- Document workflow gate の deny: 英語の長文と日本語の Next 行が混ざる。

## やること

1. `home/dot_claude/hooks/` 配下で、利用者かモデルに日本語の文面を返す箇所を列挙する（文字列の出どころの一覧）。
2. 文面ごとに、ja-notation・tanteki の規範で直す。書き直しは Sarashina に hook 1 つずつ渡す（規模 S。渡すのは公開リポジトリの追跡ファイルの該当文字列だけ）。結果はメインループが規範と元の意味で確かめて採否を決め、`delegation record` に残す。
3. 文面を照合している既存テストを直す。

## 前提と注意

- Sarashina への委譲は、plan-2 で入口 `delegation offload` ができた後なら入口から、それより前なら route が候補に出したときに直接起動する。
- 文面の変更は hook の挙動を変えないこと。複数の hook にまたがるので Document Workflow（plan.md）で進める。
