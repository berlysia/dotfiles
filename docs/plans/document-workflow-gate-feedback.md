# Document Workflow の gate と rules への持ち越し

cpk-events のセッション（2026-10-29）から届いたフィードバックのうち、まだ手を付けていない項目。
受け口は dotfiles-feedback の private repo の 20261029T063524Z-5f77d01329df である。
片付いた項目は消し、空になったらこのファイルを消す。

## 生成物の書き込みが Scope の外として止まる

- 観察: gitignore 済みの生成物（fixture のコピー）への書き込みを、委任中の gate が spec の Scope の外として止めた。
  同じコピーを利用者が `!` で実行すると通った。
- cpk-events のセッションの見立て: gate が守るのは Claude の書き込みだけなので、承認を経ずに人へ手を動かしてもらう抜け道になる。
- やること: gitignore 済みの生成物を別に扱えるかを決める。
  止め続けるなら、利用者が代わりに実行したことも記録に残す。

## 実装中に見つかった Scope の漏れを足す手段が無い

- 観察: spec の Scope から 1 ファイル漏れていると、plan か spec の承認をやり直すしかない。
- やること: 「このファイルを Scope に足す」に利用者が一言で同意できる経路を検討する。
  上の抜け道が要らなくなる。

## Scope のディレクトリの項目が前方一致で照合されていないらしい

- 観察: Scope にあるディレクトリ（末尾が `/`）の中のファイルを書くと、そのたびに記録が残った。
  記録先は `off-plan-writes.log` で、Scope の外への書き込みとして扱われていた。
- やること: 末尾が `/` の項目の照合を確かめ、誤りなら直す。
  誤検知が log に混ざると、本当に Scope の外の書き込みが埋もれる。

## 完了の gate が、計画した途中の失敗を読めない

- 観察: 承認済みの plan は「ある task までは typecheck が通らない」と決めていた。
  それでも Stop の completion-gate が typecheck を走らせ、3 回止めた。
- やること: 承認済みの plan が途中の失敗を宣言している間は、gate がその宣言を読む形を検討する。

## Bash の書き込み先の判定で手数が増える

- 観察: 書き込み先を変数で書くと止まり、リテラルの絶対パスで書き直した。
  japanese-check の gate は、同じコマンドの中で review を記録するより前に判定し、commit を止めた。
- やること: 安全側に倒れているので害は無い。
  手数を減らせるかを、ほかの改修のついでに見る。

## テストを走らせる実装を Codex に渡す前提

- 観察: Codex の sandbox では、Python のテストが `listen EPERM 127.0.0.1` で動かなかった。
- やること: 「テストを走らせて確かめる実装は Codex に向かない場合がある」を model-offloading の rule に足すかを決める。

## spec の改訂後、済んだ plan-N が新しい plan の書き込みを拒む

提案・未決。出どころ: dotfiles-feedback 20261029T092651Z-3e3e0951e7db。

- **観察**（2026-10-29、session 5b0ab66e、二層モード）: plan-1 から plan-4 は、承認・実装・merge まで済んでいた。
- その後 spec.md を改訂して再承認したので、plan-1 から plan-4 の parent-spec-hash が今の spec の hash と合わなくなった。
- 新しく承認した plan-5 の Files に、plan-1 から plan-4 と同じファイル（テストのファイルなど）が載っていた。
- `lib/workflow-gate.ts` の `evaluateTarget`（570-592 行付近）は、書き込み先を Files に載せた plan を番号の順に見て、最初の 1 つで判定する。blocked の plan が先に見つかると、すぐ deny を返す。
- 承認済みの plan-5 があっても、済んだ plan-1 から plan-4 が先に blocked と判定された。共有するファイルへの書き込みは拒まれた。
- 利用者の判断で、plan-1 から plan-4.md を workflow dir の `archive/` に移した。gate は workflow dir の直下しか読まないので、これで通った。
- 困る点: 実装し終えた plan を退役させる、仕組みで決まった手順が無く、手で移すしかない。
- **送った人の提案**（どちらか）:
  - 承認済みのいずれかの plan が書き込み先を列挙していれば許す（最初の 1 つで決めない）
  - 実装済みの plan を退役させる workflow-cli のコマンドを足す
- **未決**: 前者は gate の判定を緩めるので、blocked の plan と承認済みの plan が同じファイルを挙げたときの優先を決める。後者は、退役した plan の記録を `archive/` のどこに残すかを決める。

## インタプリタの heredoc の書き込みが Document Workflow の gate を通る

提案・未決。出どころ: dotfiles-feedback 20261029T092651Z-37cb7225efe0。

- **観察**（2026-10-29、session 5b0ab66e）: 実装を委譲した sonnet の subagent が、worktree のテストのファイルを書き換えた。書き方は Python の heredoc（`python3 - <<...`）で、gate に拒まれなかった。
- 同じファイルを Edit ツールで書こうとすると、gate に拒まれた。subagent 自身がこの差に気づき、作業を中断して報告した。
- 書いた先は、どれも承認済みの plan の Files に入っていた。承認の範囲を外れた書き込みは起きていない。
- `workflow.md` は「インタプリタの heredoc は guard が書き込みと判定しうる」と書いているが、今回は判定されずに通った。
- **送った人の提案**: インタプリタの heredoc や `-c` で書き込む経路を、Bash の guard で書き込みとして扱う。判定できないときは拒む側に倒す。
- 対象: Bash guard、document-workflow-guard。
- **未決**: 通った理由（判定の対象外だったのか、書き込み先を読み取れなかったのか）は確かめていない。現行の guard の判定を読み、通ったコマンドの形を再現するところから始める。
