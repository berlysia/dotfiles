# ADR-0031: PR の取り込みを merge commit に限る

## Status

accepted (2026-10-07)

## Context

ADR-0030 は実装をブランチ名で指していたが、リポジトリはマージしたブランチを自動で消すので、マージの時点で辿れなくなっていた（PR #279 で PR 番号に直した）。
その議論の中で、利用者が次を指摘した（2026-10-07）。

- commit の hash を参照に書くなら、commit の列を保つ必要がある。rebase と squash は使えない。
- merge commit の hash は、マージの前には存在しないので書けない。PR 番号は、PR を出した後にしか分からない。一度で実装への参照を示したいなら、同じブランチで先に積んだ commit の hash を使うしかない。
- 取り込み方の縛りは、参照に何を書くかから推移的に決まる。別々に選ぶものではない。
- 「merge commit で取り込む」はリポジトリの運用なので、グローバルの規則には書けない。
- PR 番号を後から書いてよいかは、これらと独立に考えられる。

### 参照の種類と、成り立つための性質

| 参照に書くもの                    | 成り立つための性質                |
| --------------------------------- | --------------------------------- |
| PR 番号                           | なし                              |
| 既に master にある commit の hash | master の履歴を書き換えない       |
| PR の中の commit の hash          | PR の commit の列が master に残る |

- グローバルの規則は、性質だけを書いている。`rules/developer-experience.md` の Knowledge Management は、作業ツリーに無い記録を `git show <commit>:<path>` で指してよいのは、その commit が既定のブランチから辿れるときだけ、と定める。取り込み方には触れていない。
- ADR-0029 は、PR の中の commit の hash を既に 4 つ書いており、それらは PR を merge commit で取り込んだのでいま辿れる。ADR-0029 の Context は、直近 40 件に squash merge が無いという観察を書くだけで、制約としては決めていない。
- グローバルの規則、テンプレート、skill の SKILL.md に、取り込み方を前提にした記述は無い。

### 取り込み方の現状（2026-10-07）

- リポジトリの設定は、merge commit と squash が許可、rebase が無効、auto-merge が有効だった。「既定の取り込み方」を表すキーは、API の応答に無かった。
- ruleset `master - freshness` は `pull_request` の規則を持ち、`allowed_merge_methods` は `["merge","squash"]` だった。この ruleset は、リポジトリの管理者の役割に常に迂回を許す。利用者は管理者で、モデルが `gh` で取り込むときも同じ権限で動く。
- Renovate の PR は、直近 8 件がすべて auto-merge で、方法は `SQUASH` だった。`renovate.json` にも共有の preset にも `automergeStrategy` は無く、既定の `auto` で動いていた。
- 人が出す PR は、merge commit で取り込んでいた。

### 1 回目の試し: ruleset で絞る

初めに承認した計画は、`renovate.json` に `"automergeStrategy": "merge-commit"` を足し、ruleset の `allowed_merge_methods` を `["merge"]` にする形だった。
絞った後、管理者の `gh pr merge --squash`（`--admin` も `--auto` も無し）は、警告も確認も無く通り、squash の commit ができた。規則の評価の記録は、この取り込みを `result=bypass` と返した。

- 取り込み方の制限は `pull_request` の規則のパラメータで、迂回は ruleset ごとに付く。迂回を外すと、「変更は PR を通す」という規則の本体も管理者に掛かり、master への直接の push が止まる。
- 利用者の回答（2026-10-07）: 取り込み方の制限だけ、迂回を外したい。形は、リポジトリの設定で squash を無効にし、ruleset は元に戻す。計画をこの形に改め、利用者が再び承認した。

### 確かめていないこと

- `auto` が、merge と squash の両方が許可されているときに squash を選ぶ理由。Renovate の文書には選び方が書かれていない。
- `pull_request` の規則を迂回なしで当てると、master への直接の push が止まること。規則の定義からの理解で、試していない。
- master への直接の push が、設定を変えた後も今までどおりできること。

## Decision

- **K1: ADR は、同じ PR の中で先に積んだ commit の hash を、実装への参照として書いてよい。** 利用者の決定（2026-10-07）である。
  - merge commit の hash はマージの前に存在せず、PR 番号は PR を出した後にしか分からない。一度で書けるのは、先に積んだ commit の hash だけである。
  - PR 番号を後から書くことは、これと独立に許す。取り込み方に依存しない。
  - ブランチ名は書かない。マージしたブランチは自動で消える。
  - PR の中の commit は、書く時点では master から辿れない。グローバルの規則の「既定のブランチから辿れるときだけ」は、取り込みの後に満たされる。書いた人は、取り込みの後に `git merge-base --is-ancestor <hash> origin/master` の終了コード 0 で確かめる。ADR-0029 K4 が定める確認と同じコマンドで、時点だけが取り込みの後になる。辿れなかったときは、PR 番号に書き換える PR を出す。

- **K2: PR の取り込みは merge commit に限る。** K1 から従う。PR の中の commit の hash は、PR の commit の列が master に残るときだけ成り立つ。
  - squash は、PR の commit を 1 つの新しい commit に置き換える。rebase での取り込みは、commit を作り直すので hash が変わる。どちらも、PR の中の hash を master に残さない。rebase は、リポジトリの設定で既に無効である。
  - この制約は、このリポジトリの層に置く。グローバルの規則（`~/.claude/rules/`）には書かない。取り込み方はリポジトリごとの運用で、グローバルの規則が書けるのは性質までである。性質は既に書かれている（K1）。

- **K3: 取り込み方の制約は、リポジトリの設定で持つ。`allow_squash_merge` を `false` にし、ruleset `master - freshness` は元の値に戻す。** 利用者の選択（2026-10-07）である。
  - この設定が止めるのは、PR 経由の squash による取り込みだけである。管理者は、設定を戻すことと、master へ直接 push することができる。
  - 設定は取り込み方そのものを無くすので、ruleset のような迂回の役割を持たない。管理者が `gh pr merge --squash` を実行しても通らない（Consequences の「設定の後の試し」）。
  - この決定が防ぐのは、誤操作と自動の処理（Renovate、モデルの `gh`）が squash を選ぶことである。管理者の意図した操作は防がない。
  - 迂回の無い ruleset で絞る形は採らない。取り込み方の制限は `pull_request` の規則のパラメータで、迂回を外すと master への直接の push も止まる。利用者は、取り込み方の制限だけ迂回を無くしたい。
  - ruleset の `allowed_merge_methods` は、1 回目の試しで `["merge"]` にした後、元の `["merge","squash"]` に戻した。残すと、設定を戻すコマンドだけでは squash が復活せず、戻し方が 2 段になる。順序は、設定を変えてから ruleset を戻した。逆にすると、制約がいったん緩む。
  - master 以外のブランチへ向けた PR でも squash が選べなくなる。変更の前に、open な PR は 0 件だった。
  - `CLAUDE.md` には書かない。リポジトリの設定が、選べる取り込み方を 1 つにする。
  - 設定の変更は git の履歴に残らない。値、変更した日、戻し方、現在の値を読むコマンドは、`docs/repository-settings.md` に書く。2026-10-07 に、`allow_squash_merge` を `true` から `false` にした。

- **K4: 機構が効くことを、設定を当てた直後に、害のない PR で試した。** 試しの対象は、残件のファイルを足すだけの PR である。どちらの結果でも、入る変更が望んだ変更で、その PR の中の commit を指す参照は無い。この ADR を足す PR を対象にしなかった。ADR を先に書くと、試しが通った場合に、「拒否された」と書いた ADR が誤ったまま master に入る。結果は Consequences に書く。

- **K5: `renovate.json` に `"automergeStrategy": "merge-commit"` を置く。**
  - 足さない場合、Renovate は既定の `auto` で取り込み方を選ぶ。直近 8 件は `SQUASH` だった。squash が無効になった後に `auto` が何を選ぶかは、文書に書かれていない。明示すれば、選び方に頼らない。
  - 共有の preset ではなく、このリポジトリの `renovate.json` に置く。取り込み方の制約を持つのは、このリポジトリの設定である。preset に置くと、squash を許すほかのリポジトリにも merge commit を強いる。
  - preset が後で同じキーを足しても、このリポジトリの値が勝つ。これは Renovate の文書（preset を先に展開し、リポジトリの設定を上に重ねる）に基づく記述で、このリポジトリでは実測していない。
  - `renovate.json` の指定と、リポジトリの設定は対である。片方だけ変えると食い違う。

## 却下した代替案

- **差分最小案: 設定は変えず、プロジェクトの `CLAUDE.md` に「PR は merge commit で取り込む」と書く。** 人とモデルが毎回 `--merge` を選ぶ形で、取り込み方の選択を文に任せる。依存の更新は squash のままになる。機構が選択肢を 1 つにすれば、その文は要らない（利用者の指摘、2026-10-07）。
- **ruleset の `allowed_merge_methods` で絞ること。** 1 回目の試しで、管理者の迂回で squash が通った。K3 のとおり、リポジトリの設定に改めた。
- **迂回の無い ruleset を別に作ること。** master への直接の push も止まる（K3）。
- **ruleset の `allowed_merge_methods` を `["merge"]` のまま残すこと。** 戻し方が 2 段になる（K3）。
- **`bypass_actors` の変更。** 対象は管理者の役割 1 件で、外すと管理者も PR と必須の checks を通すことになり、master への直接の push ができなくなる。
- **`renovate.json` を CI で検証する step。** `renovate-config-validator` を CI に足すのは、取り込み方とは別の主題である。
- **グローバルの規則への追記。** K2 のとおり、性質は既に書かれている。
- **ADR-0023・0028・0029 が書いているブランチ名の書き換え。** 利用者が、ADR-0030 だけを直すと選んだ（PR #279）。
- **設定や ruleset の値を CI で監視すること、ruleset をリポジトリの JSON として管理すること。** 取り込み方を絞る、という範囲を超える。R5 の手当ては、`docs/repository-settings.md` の読むコマンドにとどめる。

## Consequences

- **設定の後の試し: 管理者の `gh pr merge --squash` は拒否された。** 対象の PR は、checks が通り、`mergeStateStatus` が `CLEAN` で、auto-merge が無効だった。`--admin` も `--auto` も付けない実行は、終了コード 1 で、`Squash merges are not allowed on this repository.` を返した。PR は `OPEN` のままだった。続けて `gh pr merge --merge` で取り込み、規則の評価の記録は `result=pass` だった（1 回目の試しは `result=bypass`）。確かめたのは、管理者の権限で実行した、PR 経由の squash が拒否されることである。
- **Renovate の auto-merge が止まる（R1）。** `automergeStrategy` が platform の auto-merge に効かない場合である。設定の後の Renovate の PR 3 件が merge commit で入り、効いていることを確かめた。止まった場合は、Renovate の PR が checks が通ったのに open のまま残る。費用は、依存の更新（セキュリティの修正を含む）が、気づくまで手動での取り込みになることで、履歴と参照は壊れない。止まったら、`gh pr merge <番号> --merge` で手動で取り込む。設定は戻さない。設定を戻すと squash が再び選べ、K2 を機構で保証しなくなる。原因をこの ADR に書いてから、`renovate.json` の指定を見直す。
- **Renovate の PR が merge commit で入ると、master の履歴に bot の commit と merge commit の 2 つが並ぶ（R2）。** 直近 8 件は 1 PR に 1 commit だった。`git log --first-parent` で読めば、PR ごとに 1 行になる。
- **設定を変えても squash が通る場合（R3）は、試しで起きなかった。** 管理者の権限で実行した PR 経由の squash は拒否された。
- **master 以外のブランチへ向けた PR でも、squash が選べなくなる（R4）。** 利用者が受け入れた（K3）。
- **設定が将来書き換えられても、気づく機構が無い（R5）。** `docs/repository-settings.md` の読むコマンドが、参照が辿れなくなったときに最初に確かめる場所になる。
- **過去に squash で入った取り込みは、そのままである（R6）。** 依存の更新と、1 回目の試しの PR である。それらの PR の中の commit を指す参照は無い。
- **master に直接 push した commit には、取り込み方の設定が掛からない（R7）。** 直接の push は commit の列をそのまま残すので、K1 の参照は壊れない。
- **ruleset を戻す操作で、ほかの保護が変わる（R8）。** 送る本文は、変更前に保存した内容で、戻した後の内容との diff に差が無いことを確かめた。

## References

- ADR-0029（K4 の commit 参照の決定。R3 の参照が辿れなくなる場合）
- ADR-0030（実装をブランチ名ではなく PR 番号で指した、直前の ADR）
- `docs/repository-settings.md`（取り込み方の設定の読み方と戻し方）
