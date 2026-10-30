# dotfiles-feedback の残件

dotfiles-feedback の CLI と運用で出た要望を書く。片付いたら、該当の節を消す。

## 送ったフィードバックに追記するコマンドが無い

提案・未決。出どころ: dotfiles-feedback 20261029T084310Z-eac71dea1be1。対象: `dot_local/bin/executable_dotfiles-feedback`。

- **観察**: 送ったフィードバックに、後から確かめたい点を足したかったが、`dotfiles-feedback` に追記のコマンドが無い。
- 送った人は、元の id（20261029T083851Z-eea90f8e8c20）を本文で参照して、別のフィードバックとして送った。triage のとき、2 件を手で突き合わせる必要がある。
- **送った人の提案**: 既存のフィードバックに本文を足すコマンド。例: `dotfiles-feedback append <#番号|id>`（本文は stdin）。
  - 足した本文は、元の本文と区別できる形（日時つきの節など）で残す
  - 送信済み（flush 済み）のものに足せるか、足せないなら新しい id を元の id に紐づけて送るか、どちらかの扱いを決める
- **未決**:
  - flush 済みのものに足せる場合、受け取り側の store をどう更新するか
  - 紐づけて送る場合、`show` で元と追記を並べて出すか

## plan-5 と plan-6 の残件

提案・未決。出どころ: plan-5（PR #480）の実機での確認、plan-6 のレビュー。決定は `docs/decisions/0060-dotfiles-feedback.md` にある。

plan-5 の残り（6 点）:

- **flush が同時に走るときの表示**: 同時実行での「（送り出し中）」の表示が未確認である。未送が 0 件だと flush がすぐ終わって重ならないので、未送がある機会に確かめる。
- **macOS での golden image の作り直し**: macOS で `agent-vm golden rm` を実行し、golden image を作り直す。利用者が行う。
- **VM の中からの送信**: 実際の VM の中から `dotfiles-feedback send` を打ち、ホストの spool に入るかを確かめる。利用者が行う。
- **plan-5 のレビュアーの delegation record**: plan-5 のレビュアー 16 回分の `delegation record` が未記録である。pending の id を見つける手段が無い（dotfiles-feedback 20261029T091133Z-1a330c8ce949）。
- **unit テストの実時間**: unit の実時間が、中央値 42.6 秒で、target の 10 秒を超えている。超過は別のタスクとして報告し、直す。
- **委譲の brief の書き方**: 委譲の brief で全チェックを頼むときは、CI が流すテストを並べて渡す。plan-5 では `run-templates.sh` が抜けた。

plan-6 のレビューで出た点（4 点）:

- **`repoKey` の扱い**: `repoKey` は、送る人が書かなくても自動で付く。berlysia 以外のリポジトリで null にするかを決める。送り先は private repo なので、今は受け入れている。
- **Codex から本文つきの `send` を承認なしで通す**: heredoc の本文つきの `send` は、Codex の allow の rule に一致せず、承認を求める見込みである。承認なしで通すには、本文をファイルで受ける引数などの CLI の変更が要る。
- **パイプでの持ち出しを機構で止めるか**: `cat <ファイル> | dotfiles-feedback send …` が承認なしで動きうる件を、機構で止めるかを決める。`send` を allow から外すかどうかを含むので、設計の見直しになる。
- **未知の flag を拒否するテスト**: `--repo` のような未知の flag を `parseArgs` の `strict` が拒否することを確かめるテストが無い。テストを足す。
