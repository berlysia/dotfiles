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
