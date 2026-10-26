# ラウンド予算の詳細

レビューが Round 3 を超えて延長するとき、`review-reframer` を呼ぶとき、延長の記録や再評価の基準を確かめるときに読む。周の数え方と段階の境界は SKILL.md「ラウンド予算」にある。

予算は `workflow-cli round` の拒否として機構化してある。Round 3〜5 の延長は人間に聞かずモデルが理由の種類（cause）を記録して進め、Round 6 で詰まれば `review-reframer` の判断で延長でき、延長のたびに誰の判断かが log に残る。人間に回るのは Round 9 以降と、reframer が (b)(c)(d) を推奨したときである。

## 段階と許可

段階の判定と許可は `getRoundBudgetPhase` / `isExtensionAllowed`（`~/.claude/hooks/lib/workflow-review-core.ts`）で、CLI の拒否と推奨テキストの通知は同じ関数を使う。

| 周のラウンド数 | phase           | 素の `round` | `--self-extend`                        | `--reframer-extend`            | `--extend`（人間） |
| -------------- | --------------- | ------------ | -------------------------------------- | ------------------------------ | ------------------ |
| 0〜2           | open            | 可           | 可（`--cause` の値だけ検査、記録なし） | 可（記録なし・裏付け検査なし） | 可（記録なし）     |
| 3〜5           | self-extendable | 拒否         | 可（`self`、`--cause` 必須）           | 拒否                           | 可（`human`）      |
| 6〜8           | reframer-review | 拒否         | 拒否                                   | 裏付けがあれば可（`reframer`） | 可（`human`）      |
| 9 以上         | human-only      | 拒否         | 拒否                                   | 拒否                           | 可（`human`）      |

上限の 6 と 9 は予算 3 の刻みに揃えた設計値で、収束分析に基づく値ではない。人間の `--extend` に上限は無い。

## 引数検査の順序

先に該当したものを返す。

1. 文書名が wfDir 直下の `.md` でない
2. 延長フラグが 2 つ以上
3. `--reframer-extend` と `--full` の併用（reframer の判断の範囲外。人間の `--extend` は `--full` と併用できる）
4. `--cause` と `--full` の検査（下記「自己延長」。`--cause` は `--self-extend` にだけ付けられ、どの段でも値が 4 つのどれかであることを確かめる）
5. reason がサニタイズ後に空
6. phase
7. （reframer-review での `--reframer-extend` のみ）記録ファイル、次に起動記録

## 自己延長（`--self-extend --cause <値>`）

Round 3〜5 の延長は、人間に聞かずモデルが進める。条件は延長の可否ではなく、記録する cause の値になる。`--cause` は必須で、値は次の 4 つに限る。

| cause           | 意味                                                          | 確かめ方                           |
| --------------- | ------------------------------------------------------------- | ---------------------------------- |
| `blocker`       | 直近の verdict が blocker                                     | CLI が確かめる                     |
| `kd-changed`    | Key Decisions か Alternative Approaches を前 round から変えた | CLI が確かめる                     |
| `landing`       | 残る指摘は Key Decisions・白紙案を変えずに直せる              | 自己申告（延長の可否は変わらない） |
| `not-narrowing` | 残る指摘が前 round より狭まっていない（同じ指摘の再発を含む） | 自己申告（延長の可否は変わらない） |

自己延長の段（周のラウンド数 3〜5）の判定は次の順。

1. 直近の verdict が blocker なら、cause は `blocker` でなければ拒否する。「直近」は最後の `verdict=pass` marker より後にある最新の auto-review marker で、周の外の blocker は数えない。marker が無ければ `blocker` は拒否する
2. そうでなく、設計の節（Key Decisions と Alternative Approaches）が前 round から変わっていれば、cause は `kd-changed` でなければ拒否する
3. どちらでもなければ `landing` か `not-narrowing`。`kd-changed` と `blocker` は拒否する

`--self-extend --full` は、どの段でも設計の節が変わったときだけ受理する。cause が `blocker` でも、節が変わっていれば `--full` を付けられる。plan-N.md は設計の節を持たないので、`--full` は常に拒否する。

blocker の周で設計の節も変えた場合、cause は `blocker` だけが残り、設計の変更は回数に現れない。

reason は `non-pass N→M; remaining: <残る指摘の要約>`。`--cause` が無い、または未知の値の呼び出しは終了コード 1 で拒否され、拒否文が 4 つの値と書き方を示す（`--reason` とほかの引数は変わらない）。

## 設計の節の hash と `.design-baseline`

設計の節は、どの文書でも Key Decisions と Alternative Approaches (Greenfield View) の 2 節とする。hash は 2 節の本文の空白の連続を 1 つに畳んでから取るので、整形だけの変更は変更に数えない。承認の hash とは別物で、承認には使わない。2 節とも無い文書の hash は「節なし」で、変わったものとして扱わない。

`<wfDir>/.design-baseline` は追記ファイルで、成功した `round` ごとに 1 行 `<doc>\t<round>\t<hash>` を足す。doc は `spec.md`、`plan.md`、`plan-<数字>.md` に限る。plan-N.md の行は書かない。`round` は、今の hash を同じ doc の最後の行と比べ、cause と `--full` を確かめて受理してから、今の hash を書く。拒否された `round` は何も書かない。`--extend` と `--reframer-extend` を受理したときも書く。

- 行が無い（途中にある既存の文書、`reset` の後、行を消した後）: 変わったかを確かめられないので、`kd-changed` と `--full` は自己申告として受理し、その周から行を書き始める。この周では、設計の節を変えたのに `landing` と申告した取り違えを検知できない
- 行はあるが読めない（列数や hash の形が崩れている）: hash の比較が要る `kd-changed` と `--full` は拒否し、拒否文が行を直すか消す手順を示す。消すと行が無い扱いに戻る。`landing`、`not-narrowing`、`blocker` は行が無いときと同じく自己申告として扱う
- 追記に失敗したとき: round は受理したまま、stderr に回復の手順を出して終了コード 0 にする

`.design-baseline` は model が書ける認証されない記録で、cause のラベルにだけ使い、承認と gate の入力にしない。

## reframer

`~/.claude/agents/review-reframer.md` で定義する。

- Round 6 の結果が stamp 済みで pass でなければ、Agent tool で `subagent_type: review-reframer` を周内で 1 回だけ起動する。`model` 引数は書かない（モデルはエージェント定義の frontmatter で決まる）。
- 起動できなければ、他のエージェントやモデルで代替せず人間に仰ぐ。
- 入力は文書のパスと、全 round の非 pass 指摘の要約。
- 出力は、収束しない原因の仮説と、次の 4 択それぞれの利点・欠点と推奨 1 つ。
  - (a) 現枠組みで続行
  - (b) 問題の変形（文書固有の変形案を 1 つ以上。推奨時は新 Key Decisions の骨子）
  - (c) 既知の未解決を明記して承認に回す
  - (d) 取り下げ

## 記録ファイル `<wfDir>/reframer-review.<doc>`

推奨にかかわらず、末尾に次の節を足す。無ければ Write で作成し、あれば Edit で追記する。各フィールドは 1 行で、本文に `## ` 行を書かない。`- agent:` / `- recommendation:` は節内で 1 回だけ書く。N は相談時点の最新 stamp 済み round。文書外にあるので文書の hash は変わらない。

```
## Reframer Review (Round N)
- agent: review-reframer
- recommendation: <(a)|(b)|(c)|(d)>
- rejected: <推奨以外の 3 択を退けた理由>
- hypothesis: <収束しない原因の仮説>
- plan: <(a) なら Round 9 までの修正方針 / (b) なら変形案と新 Key Decisions の骨子>
```

## `--reframer-extend` の裏付け検査

記録ファイルの最後の節について、次をすべて満たす。

- N が周の入り口（最後の pass marker の `round=` + 6）と等しい
- `agent` が `review-reframer` と完全一致
- `recommendation` が `(a)` と完全一致
- `.round-baseline` の Round N の時刻以降に、`reviewer-runs.log` に `review-reframer` の起動記録がある（`reviewer-run-recorder` が記録する）

reason は `reframer: (a) <着地見込みの要約>; rejected: <(b)〜(d) を退けた理由の要約>`。

## 推奨が (b)(c)(d) のとき

Executive Summary の Open Questions に載せて人間の判断を待つ。(b) の採否は人間が決める設計である旨を 1 行添える。Round 9 でも着地しなければ、記録ファイルの要約と Round 7〜9 の経過を載せて人間に仰ぐ。reframer は再起動しない。

## Executive Summary への記載

- 延長した周は、`ask-approval` の stderr と `status` の stdout に出る延長の行（承認者別、self は cause 別の回数。1 行）を写す。回数は CLI が `round-extensions.log` から数えるので、手で数えない。`not-narrowing` が続く周は範囲の見直しの材料として読む。
- reframer を使った周は、記録ファイルのパスと要約を書く。人間が reframer の判断に気づける唯一の経路なので必須。
- Round 7 以降に進んだことは Risks に書く。

## log

予算を超えた延長は `<wfDir>/round-extensions.log` に 1 行残る。reason は制御文字・行区切りを空白にし、前後の空白を除き、500 文字で切り詰める。行は `\n` だけで分け、列は `\t` だけで分ける。読み手（`status`、`ask-approval`）は、その doc の最後の pass の round より大きい round の行だけを数える（pass が無ければ全行）。

| 列数 | 形                                                | 承認者                       | cause                                   |
| ---- | ------------------------------------------------- | ---------------------------- | --------------------------------------- |
| 4    | 旧形式（承認者列より前）                          | `human`                      | 数えない                                |
| 5    | `<ISO8601>\t<doc>\t<round>\t<approver>\t<reason>` | 4 列目（3 値以外は数えない） | 不明（self の行のみ。末尾は検査しない） |
| 6    | 5 列の末尾に `\t<cause>`                          | 4 列目                       | self は 4 値のどれか、self 以外は `-`   |

空行、3 列以下、7 列以上、6 列で cause が承認者と合わない行（self なのに `-`、self 以外なのに cause がある）は数えない。延長が 0 回の doc は行を出さない。回数の行に警告は付けない（blocker を直すための延長は通常の経路で、毎回の警告は読まれなくなる）。

## 受容した限界

重要度順。

1. `--reframer-extend` で人間抜きに Round 7〜9 を進める根拠は記録ファイルと台帳の起動記録で、記録ファイルはメインループが書く。推奨の書き換え、空に近い入力での起動、別文書向けの起動、既存の節の書き直し、台帳ファイルの偽造は検知できない。
2. `human` 行は人間の承認を証明しない（`--extend` はモデルも打てる）。
3. `landing` と `not-narrowing` は自己申告で、機械検証しない。どちらも延長を許す値なので、取り違えても延長の可否は変わらない。
4. reason 形式の確認は目視。
5. `.design-baseline` の行が無い周は、設計の節を変えたのに `landing` と申告した取り違えを検知できない。blocker の周の設計変更は回数に現れない。
6. 見出しの綴りを変える（Key Decisions、Alternative Approaches (Greenfield View)）と節が抽出されず、`kd-changed` のラベルの精度が落ちる。
7. `.design-baseline` と `round-extensions.log` は model が書ける認証されない記録で、承認と gate の入力にしない。人間が Round 3 で止めた周は log に残らないので、止めた周の数は記録から分からない。
8. Round 7〜9 は「上位モデルのサブエージェントが判断するならさらに延長してよい」というユーザー指示を、続行の判断に限って reframer に委ねると解釈したもの。
9. reframer に上位モデルを当てる効果は未検証。

加えて、周の起点になる `stamp --verdict pass` は verdict 行と突き合わせない自己申告である。

## 観測と再評価トリガー

周は到達した最大 phase で 1 つに分類し、`round-extensions.log` の承認者列・auto-review marker・記録ファイルで結果を見る。次のいずれかで見直す。

- self-extendable 止まりの周が Round 6 までに pass せず reframer-review に入った例が 2 件
- reframer-review 以上の周が Round 9 までに pass しなかった例が 2 件
- reason 形式（`non-pass N→M`、`reframer: (a)`）を外れた例が 1 件
- reframer を起動できず人間に回った例が 2 件（エージェント定義のモデル指定を見直す）
- 記録ファイルと reframer の出力が食い違った例が 1 件（`--reframer-extend` を廃止する）
- 正当な記録があるのに `--reframer-extend` が拒否された例が 2 件（検査を減らす）
- log に人間の指示に対応しない `human` 行が 1 件
- 非 pass が残るのに pass marker が付いた例が 1 件
