# 人だけに許す操作を、Remote Control からも確認つきで実行できるようにする

ほかのセッションから dotfiles-feedback で届いた提案（2026-10-29）。
受け口は dotfiles-feedback の private repo の issue #8 である。
片付いたらこのファイルを消す。

## 困っていること

- 人だけに許す操作は、出先から Remote Control で作業していると実行できない。ssh で入り直すしかない
- 対象の操作は次の 2 つの CLI にある
  - `agent-learnings` の `add --common`・`promote`・`rekey`・`init`
  - `dotfiles-feedback triage --to issue`
- 人の判定は `home/dot_claude/hooks/lib/agent-caller.ts` の `isHumanCaller` だけで決めている。条件は「TTY がある」かつ「エージェントの環境変数が無い」である
- Remote Control から `!` で実行すると `CLAUDECODE` が付き、TTY も無いので拒否される

## 提案の方向

- `delivery-policy ask` と同じ方式で、人の確認を取る。CLI が出した質問を、エージェントが AskUserQuestion にそのまま渡し、利用者の回答を hook が記録する
- エージェントは `answers` を書けないので、自分で承認したことにはできない。この質問は Remote Control からも答えられる
- 手元の端末で TTY から実行する今の方式は残す

## 守る条件

- エージェントが自分で権限を広げられない今の性質を保つ
- 回答の記録はエージェントから書けない場所に置き、1 回の操作にだけ有効にする
- 質問には、実行する中身（対象の id、`--common` の本文など）を全部出し、利用者が中身を見て答えられるようにする

## 決めること

- dotfiles-feedback の spec は、人の判定が環境変数と TTY からの推定であることを受け入れている（R5）。新しい方式でこの前提がどう変わるかを、spec を持つ Document Workflow で決める
- agent-learnings と dotfiles-feedback で、確認の仕組みを 1 つの共有部品にするか
- 回答の記録の置き場と、使い終えた記録を消す時機
