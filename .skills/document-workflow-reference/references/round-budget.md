# ラウンド予算の詳細

レビューが Round 3 を超えて延長するとき、`review-reframer` を呼ぶとき、延長の記録や再評価の基準を確かめるときに読む。周の数え方と段階の境界は SKILL.md「ラウンド予算」にある。

予算は `workflow-cli round` の拒否として機構化してある。着地見込みがあればモデルの判断で、Round 6 で詰まれば `review-reframer` の判断で延長でき、延長のたびに誰の判断かが log に残る。

## 段階と許可

段階の判定と許可は `getRoundBudgetPhase` / `isExtensionAllowed`（`~/.claude/hooks/lib/workflow-review-core.ts`）で、CLI の拒否と推奨テキストの通知は同じ関数を使う。

| 周のラウンド数 | phase           | 素の `round` | `--self-extend` | `--reframer-extend`            | `--extend`（人間） |
| -------------- | --------------- | ------------ | --------------- | ------------------------------ | ------------------ |
| 0〜2           | open            | 可           | 可（記録なし）  | 可（記録なし・裏付け検査なし） | 可（記録なし）     |
| 3〜5           | self-extendable | 拒否         | 可（`self`）    | 拒否                           | 可（`human`）      |
| 6〜8           | reframer-review | 拒否         | 拒否            | 裏付けがあれば可（`reframer`） | 可（`human`）      |
| 9 以上         | human-only      | 拒否         | 拒否            | 拒否                           | 可（`human`）      |

上限の 6 と 9 は予算 3 の刻みに揃えた設計値で、収束分析に基づく値ではない。人間の `--extend` に上限は無い。

## 引数検査の順序

先に当たったものを返す。

1. 文書名が wfDir 直下の `.md` でない
2. 延長フラグが 2 つ以上
3. `--self-extend` / `--reframer-extend` と `--full` の併用（Key Decisions を変える修正はモデル / reframer の判断の範囲外。人間の `--extend` は `--full` と併用できる）
4. reason がサニタイズ後に空
5. phase
6. （reframer-review での `--reframer-extend` のみ）記録ファイル、次に起動記録

## 自己延長（`--self-extend`）

条件は機械判定しない。

- 直近 round の reviewer verdict に `blocker` が無い
- 残る指摘が Key Decisions・白紙案を変えずに直せる
- 残る指摘が前 round より狭まっている（非 pass 数は目安。同数でも中身が局所化していればよい。同じ指摘の再発は不可）

reason は `non-pass N→M; remaining: <残る指摘の要約>`。満たさなければ Round 6 を待たずに Executive Summary で人間に仰ぐ。

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

- 延長した周は、Review Status に承認者別の延長回数を書く（例: `pass / Round 8（self-extended 3, reframer-extended 2）`）。
- reframer を使った周は、記録ファイルのパスと要約を書く。人間が reframer の判断に気づける唯一の経路なので必須。
- Round 7 以降に進んだことは Risks に書く。

## log

予算を超えた延長は `<wfDir>/round-extensions.log` に `<ISO8601>\t<doc>\t<round>\t<human|self|reframer>\t<reason>` で 1 行残る。reason は制御文字・行区切りを空白にし、前後の空白を除き、500 文字で切り詰める。この形式より前の 4 列の行は承認者列が無く、`human` として読む。

## 受容した限界

重要度順。

1. `--reframer-extend` で人間抜きに Round 7〜9 を進める根拠は記録ファイルと台帳の起動記録で、記録ファイルはメインループが書く。推奨の書き換え、空に近い入力での起動、別文書向けの起動、既存の節の書き直し、台帳ファイルの偽造は検知できない。
2. `human` 行は人間の承認を証明しない（`--extend` はモデルも打てる）。
3. 着地見込みの判定は機械検証しない。
4. reason 形式の確認は目視。
5. Round 7〜9 は「上位モデルのサブエージェントが判断するならさらに延長してよい」というユーザー指示を、続行の判断に限って reframer に委ねると解釈したもの。
6. reframer に上位モデルを当てる効果は未検証。

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
