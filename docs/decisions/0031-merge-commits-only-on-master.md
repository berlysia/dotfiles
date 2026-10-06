# ADR-0031: PR の取り込みを merge commit に限る

## Status

accepted (2026-10-07)

## Context

出発点は、ADR-0030 の実装の参照である。ADR-0030 は実装をブランチ名で指していた。リポジトリはマージしたブランチを自動で消すので、マージの時点で辿れなくなっていた。PR #279 で「PR #277」に直した。
その議論の中で、利用者が次を指摘した（2026-10-07）。

- commit の hash を参照に書くなら、commit の列を保つ必要がある。rebase と squash は使えない。
- merge commit の hash は、マージの前には存在しないので書けない。
- PR 番号は、PR を出した後にしか分からない。書くには commit をもう 1 つ積む必要がある。
- 一度で実装への参照を示したいなら、同じブランチで先に積んだ commit の hash を使うしかない。
- 取り込み方の縛りは、参照に何を書くかから推移的に決まる。別々に選ぶものではない。
- 「merge commit で取り込む」はリポジトリの運用なので、グローバルの規則には書けない。
- PR 番号を後から書いてよいかは、これらと独立に考えられる。

### 参照の種類と、成り立つための性質

| 参照に書くもの                    | 成り立つための性質                |
| --------------------------------- | --------------------------------- |
| PR 番号                           | なし                              |
| 既に master にある commit の hash | master の履歴を書き換えない       |
| PR の中の commit の hash          | PR の commit の列が master に残る |

- グローバルの規則は、性質だけを書いている。`home/dot_claude/rules/developer-experience.md:55` は、作業ツリーに無い記録を `git show <commit>:<path>` で指してよいのは、その commit が既定のブランチから辿れるときだけ、と定める。取り込み方には触れていない。
- ADR-0029 は、PR の中の commit の hash を既に 4 つ書いている。`43e1949`、`caaa4fa`、`79c446d`、`ae20bcf` は、どれも PR #275（ADR-0029 自身の PR）に属する（`gh api repos/berlysia/dotfiles/commits/<hash>/pulls`、2026-10-07）。`52dc6fd447` は PR に属さず、master に直接入った。PR #275 は merge commit で入ったので、4 つはいま辿れる。
- ADR-0029 の Context（`docs/decisions/0029-workflow-records-move-into-adr.md:28`）は、直近 40 件に squash merge が無いという観察を書くだけで、制約としては決めていない。
- グローバルの規則、テンプレート、skill の SKILL.md に、取り込み方を前提にした記述は無い（`squash`、`merge commit`、`--merge`、`rebase` の grep。当たったのは、一般的な助言と force push の説明だけである）。

### 取り込み方の現状（2026-10-07）

- リポジトリの設定は、`allow_merge_commit=true`、`allow_squash_merge=true`、`allow_rebase_merge=false`、`allow_auto_merge=true`、`delete_branch_on_merge=true` だった。「既定の取り込み方」を表すキーは、API の応答に無かった。
- ruleset は 3 つあり、どれも `refs/heads/master` が対象である。`master - block force pushes`（id `24459250`）、`master - deletion guard`（id `24459249`）、`master - freshness`（id `24459252`）である。
- `master - freshness` は `required_status_checks`（`status-check`）と `pull_request` を持つ。`pull_request` の `allowed_merge_methods` は `["merge","squash"]` だった。
- `master - freshness` の `bypass_actors` は、`RepositoryRole` の `actor_id: 5`、`bypass_mode: always` である。利用者について、ruleset は `current_user_can_bypass: always` を、リポジトリは `permissions.admin: true` を返した。モデルが `gh` で取り込むときも、同じ権限で動く。
- Renovate の PR は、直近 8 件（#257〜#278、2026-10-04〜10-06）がすべて auto-merge で、方法は `SQUASH` だった。`renovate.json` にも共有の preset（`github>berlysia/renovate-config`）の `default.json` にも `automergeStrategy` は無く、既定の `auto` で動いていた。
- 人が出す PR（#275、#276、#277、#279）は、merge commit で取り込んだ。

### 1 回目の試し: ruleset で絞る（2026-10-07）

初めに承認した計画は、ruleset で絞る形だった。

- `renovate.json` に `"automergeStrategy": "merge-commit"` を足し、PR #280 を出した。
- ruleset `master - freshness`（id `24459252`）の `allowed_merge_methods` を `["merge","squash"]` から `["merge"]` にした。全項目を現在の値のまま送る PUT で行った。前後の diff の差は `"squash"` が消えたことだけで、ほかの 2 つの ruleset の `updated_at` は変わらなかった。
- 試す前の PR #280 は、checks の終了コード 0、`mergeStateStatus` が `CLEAN`、`status-check` が `SUCCESS`、auto-merge が無効だった。
- `gh pr merge 280 --squash`（`--admin` も `--auto` も無し）を実行した。終了コードは 0 で、出力は無かった。
- PR #280 は `MERGED` になり、master の先頭は `ce88a04`（親は `4e3c028` の 1 つ）になった。squash の commit である。
- 規則の評価の記録は、この取り込みを `result=bypass`、actor を `berlysia` と返した。直前の 2 件（PR #279 と Renovate の #278）は `result=pass` だった。

```bash
gh api "repos/berlysia/dotfiles/rulesets/rule-suites?ref=refs/heads/master" --jq '.[] | "\(.pushed_at) \(.result) \(.actor_name) \(.after_sha[0:10])"'
```

上のコマンドは、この試しの結果を再現して読むためのものである。取り込み方の監視に使うものではない。

- 迂回は、`--admin` を付けなくても効いた。GitHub は警告も確認も出さなかった。
- 取り込み方の制限（`allowed_merge_methods`）は、`pull_request` の規則のパラメータである。迂回は ruleset ごとに付く。迂回を外すと、「変更は PR を通す」という規則の本体も管理者に掛かり、master への直接の push が止まる。
- 利用者の回答（2026-10-07）: 取り込み方の制限だけ、迂回を外したい。形は、リポジトリの設定で squash を無効にし、ruleset は元に戻す。計画をこの形に改め、利用者が再び承認した。

### 確かめていないこと

- `automergeStrategy: merge-commit` を足した後、Renovate が auto-merge を `MERGE` で有効にすること。次の Renovate の PR まで観察できない。open な Renovate の PR は 0 件で、`schedule` は週 1 回（月曜）である。
- `auto` が、merge と squash の両方が許可されているときに squash を選ぶ理由。Renovate の文書には選び方が書かれていない。
- `pull_request` の規則を迂回なしで当てると、master への直接の push が止まること。規則の定義からの理解で、試していない。
- master への直接の push が、設定を変えた後も今までどおりできること。この作業の中で直接の push は行っていない。

## Decision

- **K1: ADR は、同じ PR の中で先に積んだ commit の hash を、実装への参照として書いてよい。** 利用者の決定（2026-10-07）である。
  - merge commit の hash はマージの前に存在せず、PR 番号は PR を出した後にしか分からない。一度で書けるのは、先に積んだ commit の hash だけである。
  - PR 番号を後から書くことは、これと独立に許す。取り込み方に依存しない。
  - ブランチ名は書かない。マージしたブランチは自動で消える。
  - PR の中の commit は、書く時点では master から辿れない。`developer-experience.md:55` の「既定のブランチから辿れるときだけ」は、取り込みの後に満たされる。書いた人は、取り込みの後に `git merge-base --is-ancestor <hash> origin/master` の終了コード 0 で確かめる。ADR-0029 K4 が定める確認と同じコマンドで、時点だけが取り込みの後になる。辿れなかったときは、PR 番号に書き換える PR を出す。
  - 参照: `docs/decisions/0029-workflow-records-move-into-adr.md:66`（K4。作業ツリーに無い記録を commit で指す決定）

- **K2: PR の取り込みは merge commit に限る。** K1 から従う。PR の中の commit の hash は、PR の commit の列が master に残るときだけ成り立つ。
  - squash は、PR の commit を 1 つの新しい commit に置き換える。rebase での取り込みは、commit を作り直すので hash が変わる。どちらも、PR の中の hash を master に残さない。rebase は、リポジトリの設定で既に無効である（`allow_rebase_merge=false`）。
  - この制約は、このリポジトリの層に置く。グローバルの規則（`~/.claude/rules/`）には書かない。取り込み方はリポジトリごとの運用で、グローバルの規則が書けるのは性質までである。性質は既に書かれている（K1 の `developer-experience.md:55`）。

- **K3: 取り込み方の制約は、リポジトリの設定で持つ。`allow_squash_merge` を `false` にし、ruleset `master - freshness` は元の値に戻す。** 利用者の選択（2026-10-07）である。
  - この設定が止めるのは、PR 経由の squash による取り込みだけである。管理者は、設定を戻すことと、master へ直接 push することができる。
  - 設定は取り込み方そのものを無くすので、ruleset のような迂回の役割を持たない。管理者が `gh pr merge --squash` を実行しても通らないことは、試して確かめた（Consequences の「2 回目の試しの結果」）。
  - この決定が防ぐのは、誤操作と自動の処理（Renovate、モデルの `gh`）が squash を選ぶことである。管理者の意図した操作は防がない。
  - 迂回の無い ruleset で絞る形は採らない。取り込み方の制限は `pull_request` の規則のパラメータで、迂回を外すと master への直接の push も止まる。利用者は、取り込み方の制限だけ迂回を無くしたい。
  - rebase は、既にこの設定で止めてある。制約の置き場が揃う。
  - master 以外のブランチへ向けた PR でも squash が選べなくなる。変更の前に、open な PR は 0 件だった。
  - ruleset `master - freshness`（id `24459252`）の `allowed_merge_methods` は、1 回目の試しで `["merge"]` にした後、元の `["merge","squash"]` に戻した。残すと、設定を戻すコマンドだけでは squash が復活せず、戻し方が 2 段になる。
  - 順序は、設定を変えてから ruleset を戻した。逆にすると、制約がいったん緩む。
  - `CLAUDE.md` には書かない。リポジトリの設定が、選べる取り込み方を 1 つにする。
  - 設定の変更は git の履歴に残らない。値、変更した日、戻し方、現在の値を読むコマンドを、この ADR に書く（下の「取り込み方の設定の読み方と戻し方」）。
  - リポジトリの設定: 2026-10-07 に、`allow_squash_merge` を `true` から `false` にした。
  - 参照: `docs/decisions/0029-workflow-records-move-into-adr.md:28`（取り込み方を観察として書いているだけの現状）

- **K4: 機構が効くことを、当てた直後に、害のない PR で試した。**
  - 試しの対象は、残件のファイル（`docs/plans/merge-commit-only-followups.md`）を足すだけの PR である。どちらの結果でも、入る変更が望んだ変更で、この PR の中の commit を指す参照は無い。
  - この ADR を足す PR を対象にしなかった。ADR を先に書くと、試しが通った場合に、「拒否された」と書いた ADR が誤ったまま master に入る。
  - 結果は Consequences の「2 回目の試しの結果」に書く。

- **K5: `renovate.json` に `"automergeStrategy": "merge-commit"` を置く。**
  - 変更は取り込み済みである（`ce88a04`）。
  - 足さない場合、Renovate は既定の `auto` で取り込み方を選ぶ。直近 8 件は `SQUASH` だった。squash が無効になった後に `auto` が何を選ぶかは、文書に書かれていない。明示すれば、選び方に頼らない。
  - 共有の preset ではなく、このリポジトリの `renovate.json` に置く。取り込み方の制約を持つのは、このリポジトリの設定である。preset に置くと、squash を許すほかのリポジトリにも merge commit を強いる。
  - preset が後で同じキーを足しても、このリポジトリの値が勝つ。これは Renovate の文書（preset を先に展開し、リポジトリの設定を上に重ねる）に基づく記述で、このリポジトリでは実測していない。
  - `renovate.json` の指定と、リポジトリの設定は対である。片方だけ変えると食い違う。
  - 参照: `renovate.json:6`

## 却下した代替案

- **差分最小案: 設定は変えず、プロジェクトの `CLAUDE.md` に「PR は merge commit で取り込む」と書く。** 人とモデルが毎回 `--merge` を選ぶ形で、取り込み方の選択を文に任せる。依存の更新は squash のままになる。機構が選択肢を 1 つにすれば、その文は要らない（利用者の指摘、2026-10-07）。
- **ruleset の `allowed_merge_methods` で絞ること。** 1 回目の試しで、管理者の迂回で squash が通った。K3 のとおり、リポジトリの設定に改めた。
- **迂回の無い ruleset を別に作ること。** master への直接の push も止まる（K3）。
- **ruleset の `allowed_merge_methods` を `["merge"]` のまま残すこと。** 戻し方が 2 段になる（K3）。
- **`bypass_actors` の変更。** 対象は管理者の役割 1 件で、外すと管理者も PR と必須の checks を通すことになり、master への直接の push ができなくなる。
- **`renovate.json` を CI で検証する step。** `renovate-config-validator` を CI に足すのは、取り込み方とは別の主題である。
- **グローバルの規則への追記。** K2 のとおり、性質は既に書かれている。
- **ADR-0023・0028・0029 が書いているブランチ名の書き換え。** 利用者が、ADR-0030 だけを直すと選んだ（PR #279）。
- **設定や ruleset の値を CI で監視すること、ruleset をリポジトリの JSON として管理すること。** 取り込み方を絞る、という範囲を超える。R5 の手当ては、この ADR の 1 節にとどめる。

## Consequences

- **2 回目の試しの結果: 設定を変えた後、管理者の `gh pr merge --squash` は拒否された。**
  - 試した対象は PR #281（`docs/plans/merge-commit-only-followups.md` を足すだけの PR）である。
  - 試す前の確認は、checks の終了コード 0、`mergeStateStatus` が `CLEAN`、`status-check` が `SUCCESS`、auto-merge が無効、`allow_squash_merge` が `false` だった。
  - 実行したコマンドは `gh pr merge 281 --squash` である（`--admin` も `--auto` も無し）。終了コードは 1 で、出力の全文は次の 1 行だった。
    `GraphQL: Squash merges are not allowed on this repository. (mergePullRequest)`
  - PR #281 は `OPEN` のままで、取り込みの commit は無く、auto-merge は無効のままだった。
  - 続けて `gh pr merge 281 --merge` で取り込んだ。master の先頭は `fd70690`（親は `ce88a04` と `c61e0f6` の 2 つ）になった。規則の評価の記録は、この取り込みを `result=pass`、actor を `berlysia` と返した。1 回目の試しの `ce88a04` は `result=bypass` だった。
  - 確かめたのは、管理者の権限で実行した、PR 経由の squash が拒否されることである。
- **設定を変えた手順と、ruleset を戻した手順。**
  - 設定: `gh api -X PATCH repos/berlysia/dotfiles -F allow_squash_merge=false` を実行した。変更の前に、auto-merge を squash で有効にした open な PR が 0 件であることを確かめた。リポジトリの設定の応答の全体を前後で diff し、差は `allow_squash_merge` が `true` から `false` になった 1 行だけだった。
  - ruleset: `master - freshness`（id `24459252`）を、絞る前に保存した内容で PUT して戻した。戻した後の内容は、絞る前の内容と（`updated_at` を除いて）差が無かった。ほかの 2 つの ruleset の `updated_at` は変わらなかった。`allowed_merge_methods` は `["merge","squash"]` に戻っている。
- **Renovate の auto-merge が止まる（R1）。** `automergeStrategy` が platform の auto-merge に効かない場合である。文書は効くと書くが、このリポジトリでは確かめていない。
  - 止まると、Renovate の PR が、checks が通ったのに open のまま残る。気づく契機は、次の月曜（2026-10-12）の Renovate の実行の後である。確認の手順は `docs/plans/merge-commit-only-followups.md` にある。
  - 気づくのが遅れた場合の費用は、依存の更新（セキュリティの修正を含む）が、気づくまで手動での取り込みになることである。履歴と参照は壊れない。
  - 止まっていたら、止まった PR を `gh pr merge <番号> --merge` で手動で取り込む。設定は戻さない。設定を戻すと squash が再び選べ、K2 を機構で保証しなくなる。原因をこの ADR に書いてから、`renovate.json` の指定を見直す。
- **Renovate の PR が merge commit で入ると、master の履歴に bot の commit と merge commit の 2 つが並ぶ（R2）。** 直近 8 件は 1 PR に 1 commit だった。`git log --first-parent` で読めば、PR ごとに 1 行になる。
- **設定を変えても squash が通る場合（R3）は、2 回目の試しで起きなかった。** 管理者の権限で実行した PR 経由の squash は拒否された。
- **master 以外のブランチへ向けた PR でも、squash が選べなくなる（R4）。** 利用者が受け入れた（K3）。
- **設定が将来書き換えられても、気づく機構が無い（R5）。** 下の「取り込み方の設定の読み方と戻し方」の読むコマンドが、参照が辿れなくなったときに最初に確かめる場所になる。
- **過去に squash で入った取り込みは、そのままである（R6）。** 依存の更新と、PR #280（`ce88a04`）である。それらの PR の中の commit を指す参照は無い。
- **master に直接 push した commit には、取り込み方の設定が掛からない（R7）。** 直接の push は commit の列をそのまま残すので、K1 の参照は壊れない。
- **ruleset を戻す操作で、ほかの保護が変わる（R8）。** 送る本文は、変更前に保存した内容である。戻した後、変更前の内容との diff で差が無いことを確かめた。
- **元に戻す方法**: リポジトリの設定は、下の節のコマンドで戻す。`renovate.json` は、取り込み済みの commit `ce88a04` を revert する。ruleset は、変更前の内容に戻してある。
- **計画から外れた点は 1 つある。** 初めに承認した計画は、ruleset で絞る形だった。試した結果（管理者の迂回で squash が通った）を受けて、リポジトリの設定に改めた。改めた計画は、利用者が再び承認した。

## 取り込み方の設定の読み方と戻し方

現在の値を読む。

```bash
gh api repos/berlysia/dotfiles --jq '{allow_merge_commit, allow_squash_merge, allow_rebase_merge}'
```

戻す。

```bash
gh api -X PATCH repos/berlysia/dotfiles -F allow_squash_merge=true
```

戻すと squash が再び選べ、この決定を機構で保証しなくなる。

## References

- `docs/decisions/0029-workflow-records-move-into-adr.md`（K4 の commit 参照の決定。R3 の参照が辿れなくなる場合）
- `docs/decisions/0030-followups-written-when-raised.md`（実装をブランチ名ではなく PR 番号で指した、直前の ADR）
- `docs/plans/merge-commit-only-followups.md`（この作業が範囲の外に回した課題）
- 実装: `ce88a04`（`renovate.json` の `automergeStrategy`）、PR #280、PR #281
