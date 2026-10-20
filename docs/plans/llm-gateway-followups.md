# llm-gateway セッションの持ち越した課題

`docs/llm-gateway-sessions.md` の仕組み（`claude()` 関数）について、今は実装していない将来案。

## 専用コマンドへの移行

非対話の `ope -g claude` や bash 環境で gateway セッションを使う必要が生じたら、関数ではなく専用コマンド（例: `claude-gateway`）に移行する。
このコマンドが `op run` による env 注入から `claude` の起動までをまとめて行う形にすれば、起動経路に依らずトークンが渡る。
`docs/llm-gateway-sessions.md` の「既知の制限とトラブルシュート」のうち、関数が読まれるかどうかに起因するものは、構造的になくなる。
