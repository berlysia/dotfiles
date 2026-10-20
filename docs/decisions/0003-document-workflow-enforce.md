# ADR-0003: Document Workflow Guard enforce mode migration

## Status

accepted

[ADR-0013](0013-workflow-dir-session-derivation.md) が、enforce の前提だった「`DOCUMENT_WORKFLOW_DIR` が hook プロセスへ届く」ことを訂正した（pin 起動していないセッションでは guard が無言で skip していた）。enforce するという本 ADR の決定は変わらない。

## Context

Document Workflow Guard は ADR-0001 で、段階導入のため `DOCUMENT_WORKFLOW_WARN_ONLY=1` つきで入れた。guard は Write/Edit/Bash の呼び出しを横取りして、plan 承認前の実装を防ぐ。

移行の条件は、warn-only の期間に誤検知が観測されないこと。warn-only 期間の `[would-block]` は stderr にしか出ず、ログに残らなかったため、事後の分析はできなかった。代わりに、単体テストが承認前後の plan、auto-review marker、hash 検証、Bash 書き込み検出、セッション別 workflow ディレクトリを網羅して通ることを根拠に、解除条件を満たしたと判断した。

## Decision

hook コマンドから `DOCUMENT_WORKFLOW_WARN_ONLY=1` を外し、enforce mode に移す。

将来ほかのプロジェクトで段階導入するため、実装の `DOCUMENT_WORKFLOW_WARN_ONLY` の経路は残す。

## Consequences

- plan 未承認の実装は警告でなく deny される
- `DOCUMENT_WORKFLOW_WARN_ONLY` は、一時的なデバッグに引き続き使える
- 新しいセッションは `chezmoi apply` の後に enforce mode になる
