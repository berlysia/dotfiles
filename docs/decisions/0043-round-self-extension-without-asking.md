# ADR-0043: round 予算の自己延長段では人間に延長を聞かず、理由の種類を記録する

## Status

accepted (2026-10-23)

## Context

ADR-0015 の Decision 9 は、周のラウンド数 3〜5 を「モデルの判断で延長してよい段」にした。ただし着地の 3 条件（直近に blocker が無い、Key Decisions を変えずに直せる、指摘が狭まっている）を満たさないときは、案内文が人間に延長を聞くよう指示していた。

この質問は答えが決まっている。承認の gate は `verdict=pass` を要求するので、pass しない限り承認に進めず、延長しない選択肢は取り下げだけになる。取り下げは reframer の (d) として人間に回る経路が別にある。記録の残る human 延長 7 件は、すべて「続ける」だった。ただし人間が止めた周は記録に残らないので、止めた周の数は分からない。

質問が減らない原因は、条件が延長の可否を決めているところにある。さらに `--self-extend` は `--full` と併用できなかったので、Key Decisions を変えた後の full round は、周の途中でも `--extend` の質問として残った。記録の残る human 延長 7 件のうち少なくとも 2 件がこの型だった。

人間が Round 3 の時点で blocker を見る機会が無くなることは、この変更の代償になる。延長の理由が記録に残らないままでは、承認の質問を見る人間が周の様子を知る手段が無い。

## Decision

- **K1: 周のラウンド数 3〜5 では人間に延長を聞かない。** 着地の 3 条件は延長の可否ではなく、記録する理由の種類（cause）の値になる。6 で reframer、9 で人間に回る上限と、reframer の (b)(c)(d) を人間に回す経路は変えない。
- **K2: 設計の節の hash を、承認の hash とは別に取って記録する。** 設計の節は、どの文書でも Key Decisions と Alternative Approaches (Greenfield View) の 2 節で、本文の空白の連続を 1 つに畳んでから hash を取る。成功した `round` ごとに、wfDir の `.design-baseline` へ doc・round・hash の 1 行を追記し、次の `round` が最後の行と比べる。plan-N.md は 2 節を持たないので行を書かず、`--self-extend --full` は常に拒否する。承認の hash と `.round-baseline`（reviewer の時間窓）は変えない。
- **K3: `--self-extend` に `--cause` を必須とし、値は 4 つに限る。** `blocker`（直近の verdict が blocker）と `kd-changed`（設計の節が前 round から変わった）は、CLI が verdict と hash で確かめ、合わなければ拒否する。blocker が先に判定される。`landing` と `not-narrowing` は、どちらも延長を許す値なので自己申告として受理する。`--self-extend --full` は設計の節が変わったときだけ受理する。`--extend` と `--reframer-extend` は `--cause` を受け付けない。`--cause` が無い呼び出しの拒否文は、4 つの値と書き方を示し、`--reason` とほかの引数が変わらないことを添える。
- **K4: 延長の記録に cause を足し、承認の質問を出すときに回数を見せる。** `round-extensions.log` の末尾に cause 列を足し（self 以外は `-`）、旧形式は列数で読む。`ask-approval`（stderr）と `status`（stdout）が、今の周の延長の回数を承認者別、self は cause 別に 1 行で出す。警告は出さない。blocker を直すための延長は通常の経路で、毎回の警告は読まれなくなるからである。`ask-approval` の stdout は変えない。承認の質問の完全一致が保たれる。
- **K5: 2 つの記録は承認と gate の入力にしない。** `.design-baseline` と `round-extensions.log` は、model が自分の CLI 呼び出しで書ける認証されない記録で、cause のラベルと承認時の回数だけに使う。

## 却下した代替案

- **案内文の文言だけ直し、`--full` との併用拒否を残す。** Key Decisions を変えた後の full round が、`--extend` の質問として残る。cause の記録が無いので、人間が承認時に周の様子を知る手段も増えない。
- **質問を残し、cause だけを足す。** 質問の答えは決まっているので、聞く手間が残るだけである。
- **自己申告の 4 値をすべて CLI が確かめる。** 「残る指摘が狭まっているか」「設計を変えずに直せるか」は機械では判定できない。確かめられない 2 値は、延長を許す値にしぼって自己申告にする。
- **設計の節の hash を `.round-baseline` の列に足す。** reviewer の時間窓を読む既存の読み手と、フォーマットを共有することになる。

## Consequences

### 受け入れたリスク

- **`landing` と `not-narrowing` は自己申告である。** どちらも延長を許す値なので、取り違えても延長の可否は変わらない。落ちるのはラベルの正確さだけである。
- **baseline の行が無い周は、ラベルの取り違えを検知できない。** この変更より前から途中にある文書、`reset` の後、行を消した後がこれに当たる。その周は `kd-changed` と `--full` を自己申告として受理し、次の成功した `round` から行を書く。設計の節を変えたのに `landing` と申告した取り違えは、その周では見つからない。行はあるが読めないときは、hash の比較が要る `kd-changed` と `--full` だけを拒否し、拒否文が行を直すか消す手順を示す。
- **blocker の周で設計の節も変えると、cause は `blocker` だけが残る。** 設計の変更は回数に現れない。
- **見出しの綴りを変えると節が抽出されない。** その文書は設計の節が無いものとして扱われ、`kd-changed` のラベルの精度が落ちる。
- **人間が止めた周は記録に残らない。** 「記録の残る 7 件がすべて続けるだった」は、止めた周を含めた比率ではない。

### 拡張点

- `not-narrowing` が続く周は、reframer を待たずに範囲を見直す材料として、承認時に人間が読む。回数の行に閾値は設けていない。
- 追記の失敗は round を止めない。`.design-baseline` の失敗は stderr に回復の手順を出し、`round-extensions.log` の失敗は承認時の回数が 1 回少なくなることを出す。

## References

- ADR-0015: Document Workflow の operator ergonomics（Decision 9）
- ADR-0040: ADR が記録するもの
