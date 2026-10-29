# ADR-0060: dotfiles へのフィードバックを専用 CLI で送り、private repo の Issues に集める

## Status

accepted (2026-10-29)

## Context

2026-10-29、利用者は「各所から dotfiles へのフィードバックを出し、受け取る方法を用意して展開したい。専門 CLI になるのかな」と求めた。

目的は、どのリポジトリ、エージェント、マシンからでも、dotfiles へのフィードバックを 1 つの CLI で送れるようにすることである。対象は dotfiles の rule、skill、hook、CLI である。フィードバックには、対象、起きたこと、再現の手順、直し方の案を書く。dotfiles のセッションを開くと未処理の件数が知らされ、人が 1 件ずつ、issue、`docs/plans`、却下のどれかに振り分ける。

これまでは、他のリポジトリで dotfiles の不具合に気づいても、その場で話題にするか、利用者が覚えておいて dotfiles のセッションへ手で持ち込むしかなかった。Codex、OpenCode、agent-vm の VM、別のマシンからは、送る経路が無かった。

既存の部品を調べると、次のことが分かった。

- agent-learnings の store に新しい種類を足す案は、寿命と、誰が読むかが合わない。学びは次のセッションに注入する知識で、エージェントが読む。フィードバックは dotfiles 側で人が片付ける作業で、片付いたら閉じる
- 学びの本文の前処理は、改行を空白に置き換え、コードフェンスと URL を拒否し、400 字で切る。フィードバックの本文には合わない
- agent-learnings の store にはリモートが無く、別のマシンから使えない
- VM には store と CLI のどちらも置かれていない
- VM の中は `gh` の認証が無く、信頼もできない。オフラインでも、送る側が `gh issue create` を直接呼ぶと、その場で失敗してフィードバックが失われる

## Decision

### 全体の構成

専用の CLI `dotfiles-feedback` を作る。サブコマンドは `send`、`flush`、`status`、`list`、`show`、`triage`、`drop`、`refresh`、`ingest-vm` である。

受け口は、利用者自身の private repo `berlysia/dotfiles-feedback` の Issues にする。マシンをまたいで 1 か所に集まり、振り分けの状態（label と close）もここに持てる。

送る側は、手元の spool に書いて戻る。spool は `<home>/.local/share/dotfiles-feedback/` にある。`<home>` は `$HOME` でなく、OS のユーザー情報から求める。Issue に起こす処理は、`send` が裏で起動する `flush` が行う。これは、ネットワークを待たせないための分け方である。実測では、`gh` の 1 回の呼び出しが 0.41 から 0.55 秒かかる。同期で送ると、1 回の `send` で `gh` を 5 回から 8 回呼ぶ。

送る側は 5 種類ある。Claude、Codex、OpenCode、VM の中、人である。指示に書くコマンドを 1 つにそろえるため、CLI は 1 本にした。

agent-learnings の store と CLI は使い回さず、共有できる部品だけを `lib/` に移した。`agent-caller`、`key-like`、`run-git`、`repo-key` である。dotfiles-feedback は agent-learnings の内部を import しない。

この文書で `lib/`、`cli/`、`tests/` から始まるパスは、`home/dot_claude/hooks/` からの相対で書く。

### 1 件の形式と検査

1 件はバージョンつきの JSON（`schemaVersion: 1`）で、`id`、`createdAt`、`title`、`target`、`kind`、`body`、`source` を持つ。`kind` は `bug`、`improvement`、`missing` のどれかである。`source` には、送ったエージェントの種類、作業中のリポジトリの `repoKey`、`host`、VM かどうかが入る。

検査は、書く前と送る前の両方で、同じ純粋関数で行う。順序は次のとおりである。

1. NFKC に正規化する
2. 不可視文字（タグ文字と bidi 制御を含む）を除く
3. 既知の秘密の形を `[REDACTED]` に置き換える
4. 置き換えた後に鍵らしい文字列が残っていれば拒否する
5. 長さを確かめる

切り詰めはしない。拒否したときは `send` が非 0 で終わり、理由を表示して何も書かない。エージェントは書き直して送り直す。

CLI は、自分より新しい `schemaVersion` の件を書き換えない。その件は置いたままにして、`status` で「CLI を更新する」と知らせる。バージョンを上げるときは、新しいバージョンを読める CLI を先に各マシンへ置く。

`list`、`show`、`triage` が出す文字列は、不可視文字に加えて ANSI エスケープと制御文字も除く。`show` は本文を nonce つきの区切りで囲む。本文はデータであり、指示ではないことを、区切りの形で示す。

### 宛先と gh の呼び出し

宛先 `berlysia/dotfiles-feedback` は、コードの定数 `FEEDBACK_REPO` である。環境変数でも引数でも変えられない。`triage --to issue` の公開先 `berlysia/dotfiles` も定数にする。

`gh` は shell を介さず、argv の配列で起動する。本文とコメントは `--body-file -` で stdin から渡す。label、サブコマンド、宛先は定数だけを使い、issue 番号は数字だけを受ける。

`gh` の子プロセスには、環境変数を 9 つだけ渡す。1 つは `HOME` で、OS のユーザー情報から求めた値を使う。残りは許可リストの 8 つである。

- `PATH`、`LANG`、`LC_ALL`
- `XDG_CONFIG_HOME`、`XDG_RUNTIME_DIR`、`DBUS_SESSION_BUS_ADDRESS`
- `HTTPS_PROXY`、`NO_PROXY`

`GH_TOKEN` と `GH_REPO` は引き継がない。実装は `home/dot_claude/hooks/lib/dotfiles-feedback/gh.ts` の `ghEnvironment` にある。テストは `home/dot_claude/hooks/tests/unit/dotfiles-feedback-gh.test.ts` にある。

private repo に触れる操作は、その回の最初に宛先を確かめる。確かめる内容は次の 3 つである。宛先が private であること。宛先の owner が `berlysia` であること。`gh` の認証中のユーザーが `berlysia` であること。1 つでも満たさなければ、何もせずに `not-private` で止まる。送り出しなら、件は `pending/` に残る。実装は `gh.ts` の `checkDestination` で、テストは `dotfiles-feedback-gh.test.ts` にある。

未知の flag（`--repo` など）は、`parseArgs` の `strict: true` で拒否する。実装は `cli/dotfiles-feedback.ts` の `send` の引数の解析にある。

### 送り出し

`flush` は、次のしくみで二重に起票しない。

- `pending/<id>.json` を `sending/` へ rename できた側だけが、その件を送る
- 起こす前に、REST の一覧 API で `dotfiles-feedback` の label を持つ issue を `state=all` でたどる。Issue 本文の先頭 1 行のマーカーに同じ id があれば、起こさない
- 一時的な失敗（ネットワーク、認証、レート制限）は `pending/` へ戻し、2 の試行回数乗の分だけ待って再試行する。20 回失敗したら `failed/` に移す
- 検査の失敗と、GitHub が本文を拒んだ失敗は、すぐ `failed/` に移す

手元の `pending/` は 50 件まで、1 回の送り出しで起こすのは 10 件までである（`MAX_PENDING_PER_ORIGIN`、`MAX_FLUSH_ITEMS`）。

全リポジトリの SessionStart では送らない。全セッションの開始にネットワーク呼び出しを増やさないためである。送り出しの契機は次の 4 つである。`send` が起動する `flush`。dotfiles の SessionStart が起動する `refresh`。人かエージェントが打つ `flush`。VM からの取り込み。

### 受け取りと振り分け

対象にする issue は、`dotfiles-feedback` の label があり、作成者が `gh` の認証中のユーザーで、先頭 1 行のマーカーを読めるものだけである。未処理は、対象のうち open のものを指す。振り分けの完了は close で表す。

`triage` は「コメント、label、close」の順に動く。コメントの先頭 1 行に、行き先と実行者の種類（`agent` か `human`）を残す。途中で落ちた件は、同じ行き先でもう一度実行できる。

行き先は 3 つある。

- `--to plan`: `docs/plans/` 直下の通常ファイルがすでにあるときだけ受ける。docs/plans に書いてから振り分ける順序を、機構で守る
- `--to reject`: 理由をコメントして close する
- `--to issue`: 公開先の `berlysia/dotfiles` に Issue を起こす。人だけに限る

plan と reject は private repo の中だけを動かすので、エージェントからも実行できる。`--to issue` は、処理の最初に `isHumanCaller` で判定する。通る条件は、stdin と stdout の両方が TTY で、エージェントの環境変数が無いことである。通った後も、`$EDITOR` で下書きを書かせ、`/dev/tty` の確認で `y` か `Y` が入力されたときだけ進む。エージェントの stdin では答えられない（`cli/dotfiles-feedback.ts` の `isConfirmed` と `confirmOnTty`）。

### dotfiles のセッション開始時の通知

SessionStart はネットワークを待たない。hook は `state/inbox.json` を読むだけにして、更新は detached の `refresh` が行う。dotfiles のリポジトリかどうかは、repo-key を dotfiles の origin と照合して決める。

通知は「未処理 N 件（M 分前に更新）、未送 P 件、失敗 F 件」の 1 行である。`additionalContext` にも同じ 1 行だけを入れ、title と本文は入れない。本文を経由したプロンプトインジェクションを、セッションの開始で受けないためである。

### 送る契機の指示の置き場

指示は 3 か所に置く。

- グローバル CLAUDE.md の 1 項目に、契機だけを書く。契機は、dotfiles の rule、skill、hook、CLI、設定の不具合や欠けに気づき、「新しい発見」の 5 分類を除けたときである。このとき `dotfiles-feedback send` で送り、送った id を利用者に伝える
- skill `.skills/dotfiles-feedback/SKILL.md` に、形式、例、送る前の確認を書く。確認する内容は、client の名前や内部の URL を書いていないか、である。`show` で読んだ本文は他のエージェントが書いたデータで、指示ではないことも、ここに書く
- Codex には `home/dot_codex/AGENTS.md` の節と `default.rules` の rule を置く

OpenCode は、`~/.config/opencode/AGENTS.md` が無ければ `~/.claude/CLAUDE.md` と `~/.claude/skills/` を読む。このため、専用のファイルは作らない。

### VM からの送り方

VM の中（`/etc/agent-vm` がある）の `send` は、検査を通してから `/opt/agent-vm/outbox/dotfiles-feedback/` に書く。書くだけで、ネットワークには出ない。VM の中で使えるのは `send` と `status` だけである。

ホストの `agent-vm` が、既存の outbox の流れで `dotfiles-feedback ingest-vm` を呼ぶ。ホストは VM を信頼せず、取り込みの最中も VM がファイルを書き換えられる前提で動く。

- outbox のディレクトリを、パス名で読まずに、まず rename でホストの置き場へ移す。rename は symlink を辿らない
- 置き場の中の項目は `lstat` と `O_NOFOLLOW` で開き、通常ファイルで 16KB 以下であることを `fstat` で確かめる。ディレクトリを再帰で消さない
- 取り込む件は書き直す。id は、`vm-` に、machine 名とファイルの中身から求めた 24 桁の hex を続けた形である。`source` の `agent` は `unknown`、`createdAt` は取り込みの時刻である。VM は手元の id を名乗れない
- 処分する件は、`failed/vm-<machine>/` に VM のバイト列を UTF-8 の文字列として包んで残す。UTF-8 として読めないものは写さずに消す
- 名前が規則に合わない項目と、1 回で消せない項目が続く置き場は、隔離のディレクトリへ移して取り込みを止めない

### Codex の rules と信頼の境界

Codex の `default.rules` で `allow` に一致したコマンドは、確認なしになるだけでなく sandbox の外で動く（ADR-0032）。Codex で allow するのは `send`、`status`、`flush` だけにする。`list`、`show`、`triage`、`drop`、`refresh`、`ingest-vm` は含めない。

allow する 3 つが sandbox の外でできることは、次のとおりである。

- 宛先は定数 `FEEDBACK_REPO` に固定され、引数でも環境変数でも変えられない
- allow された `send` は、裏で `flush` を起動する。`flush` は sandbox の外で利用者の `gh` の認証を使い、private repo に Issue を起こす
- `status` が出すのは、件数と最後の flush の理由だけである。本文と見出しは出さない。テストは `home/dot_claude/hooks/tests/unit/dotfiles-feedback-cli.test.ts` にある
- `flush` が送るのは spool の未送の件だけで、宛先は `FEEDBACK_REPO` に限られる
- したがって `status` と `flush` を allow しても、正規の送り先への投稿にしかならない

公開先に出す操作は `triage --to issue` だけである。この操作は `/dev/tty` の確認を通るので、エージェントは承認できない。

入力の扱いには、既存のテストがある。`flush --retry ../x` は exit 1 で終わる（`dotfiles-feedback-cli.test.ts`）。`show` は本文を nonce つきの区切りで囲み、ESC を落とす（`dotfiles-feedback-collect.test.ts`）。bidi などの制御文字は `sanitizeForDisplay` が中和する（`dotfiles-feedback-display.test.ts`）。

### パイプでの持ち出しを受け入れる

`cat <ファイル> | dotfiles-feedback send …` の形は、承認なしで動きうる。Codex は `bash -lc` の中身を単語だけのコマンドに分け、`|`、`&&`、`;` で区切って照合する。各部分が別々に照合され、`cat` が安全なコマンドとして扱われると、全体が sandbox の外で動く。これは Codex のソースと説明の読みで、実際のセッションでは試していない。試すと実際の spool に書き、private repo に Issue が立つためである。

読めるファイルの中身が、承認なしで private repo の Issue に載りうる。それでも受け入れる理由は次の 3 つである。

1. 宛先が `FEEDBACK_REPO` に固定され、flush は送る前に、private で所有者が期待どおりかを確かめ、満たさなければ `not-private` で止まる
2. 鍵らしい文字列は `normalizeField` が拒否する
3. `send` を allow に含めることは、設計の段階で決めている。外すかどうかは設計の見直しになる

## 却下した代替案

- **agent-learnings の store に新しい種類を足す**。検査、lock、git commit、Codex の inbox、SessionStart の注入をそのまま使える。ただし、前節の Context で挙げた理由で合わない。寿命と、誰が読むかが違い、本文の前処理が合わず、別のマシンから使えず、VM に置かれていない
- **送る側がそれぞれ `gh issue create` で private repo に直接起票する（白紙設計案）**。受け口、マシン間の共有、振り分けの画面を GitHub がすでに持つので、自作するのは「誰がいつ送るか」の指示だけになる。ゼロから設計するなら最初に浮かぶ案である。採らなかった理由は 2 つある。VM の中とオフラインでは `gh issue create` が失敗し、その場でフィードバックが失われる。検査が送る側ごとに分かれ、手元で 1 か所にまとめて外へ出せない。そこで白紙案を基にして、手元の spool を前段に置いた
- **`send` の中で同期して送る**。1 回の `send` で `gh` を 5 回から 8 回呼び、エージェントが送るたびに 3 秒から 4 秒待つ。裏で起動する `flush` に分けた
- **全リポジトリの SessionStart で送り出す**。全セッションの開始にネットワーク呼び出しが足される。dotfiles のセッションの `refresh` と、`send` が起動する `flush` に限った
- **`list` と `show` を `gh issue list` で済ませる**。自分が起こした issue だけに絞れず、制御文字を除いた表示にもできない
- **ホストが VM の中で書き出しのコマンドを実行し、標準出力を上限つきで読む**。mount を共有しないので差し替えの競争が無い。ただし、VM が動いていないと取り込めず、agent-vm に VM の中でコマンドを実行する新しい経路が要る。会話のログと同じ outbox の経路にそろえた
- **`send` を Codex の allow から外す**。パイプでの持ち出しは止まる。ただし、Codex から送れなくなる。外すかどうかは設計の見直しになるので、今回は変えない

## Consequences

- 送る側は、手元の spool に書いたらすぐ戻る。送り出しの結果は `status` と次の `send` の出力で分かる
- dotfiles のセッションを開くと、未処理の件数が出る。振り分けは 1 件ずつ、利用者が判断してから行う
- 次の体験は、意図して提供しない
  - リポジトリごとの送信禁止の設定。送るかどうかは指示で決まり、client のリポジトリでは利用者がその場で止められる。実際に client のリポジトリから送られて困った時点で検討する
  - 振り分けの自動化。LLM による分類と、公開先への自動転記は、恒久的に提供しない。公開を人の判断から外さないためである
  - 送った人への結果の返却。結果は private repo の issue に残り、`gh` で見られる
- 秘密の検査の限界が、受け入れて残る害である。`normalizeField` が拒否するのは鍵らしい文字列だけで、伏せ字にするのは既知の形式だけである。`.env` の平文の値、`~/.config/gh/hosts.yml`、`~/.claude.json` のような形の定まらない秘密は通りうる。プロンプトインジェクションを受けたエージェントがファイルを読んで流すと、承認なしで Issue に載りうる。
- Issue を読むのは利用者だけではない。private repo の共同作業者、通知を受け取る人、repo に入れた GitHub App、将来の振り分けのエージェントも読む。skill はファイルの中身を貼ることと、パイプで流すことを禁じる。ただしこれは指示で、機構として止めるものではない
- 承認なしの `send` を繰り返しても、量には上限がある。`pending/` は手元の分で 50 件まで、1 回の送り出しは 10 件までである。フィールドの長さにも上限がある。定数は `lib/dotfiles-feedback/constants.ts` にある。名前は `MAX_PENDING_PER_ORIGIN`、`MAX_FLUSH_ITEMS`、`FIELD_LIMITS` である
- private の Issue から公開先の `berlysia/dotfiles` に移すのは、`triage --to issue` だけである。この操作の確認では、公開してよいかを確かめる警告、見出し、本文の全文が端末に表示される。利用者は公開の前に読める（`lib/dotfiles-feedback/triage.ts` の `draftPublicIssue`）
- Codex の rule は、argv の先頭の名前 `dotfiles-feedback` にだけ一致し、実体の検証はしない。既存の `agent-learnings` の rule と同じ性質である
- 未知の flag（`--repo` など）を拒否するのは `parseArgs` の `strict` によるが、それを確かめるテストが無い。テストを足す件は `docs/plans/dotfiles-feedback-followups.md` に残した
- `normalizeField` が扱うのは秘密と鍵らしい文字列だけである。home のパス、内部の URL、client の名前は伏せない。`repoKey` と `host` は、送る人が書かなくても自動で付く。送り先は private repo なので、今は受け入れる。`repoKey` を berlysia 以外のリポジトリで null にするかは、`docs/plans/dotfiles-feedback-followups.md` に残した
- Codex で heredoc の本文つきの `send` は、allow の rule に一致せず、利用者の承認を求める見込みである。実際のセッションでは試していない。本文つきの `send` を承認なしで通すには、本文をファイルで受ける引数などを CLI に足す必要がある。この件も followups に残した
- `prefix_rule` は後ろの引数を問わず一致する。将来 `send`、`status`、`flush` に引数を足すと、その引数も sandbox の外で動く。rule の直前のコメントにこの注意を書いた
- マシンごとに CLI のバージョンがずれる。新しいバージョンの件は、古い CLI の手元で止まる。`status` と通知に件数が出て、`chezmoi apply` で CLI を新しくすれば送られる
- グローバル CLAUDE.md、Codex の rules、settings、agent-vm は保護パスなので、plan ごとに承認を受け、PR の merge は利用者が行う

### 実機で分かったこと

bun では、`readdir` に `encoding: "buffer"` を渡すと、UTF-8 でない名前の項目も一覧に出る。VM の取り込み（`ingest-vm`）を書いたときに確かめた。`opendir` に `encoding: "buffer"` を渡すと、bun 1.4.4 で `Dirent.name` が `undefined` になるので使わず、`readdir` を使う。

名前が規則に合わない項目は、中身が UTF-8 として読めれば `failed/` に写り、読めなければ捨てられる。2026-10-29 に、偽の state ディレクトリで観察した。

未対応の課題は `docs/plans/dotfiles-feedback-followups.md` にある。
