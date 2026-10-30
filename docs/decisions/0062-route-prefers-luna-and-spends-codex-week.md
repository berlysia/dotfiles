# ADR-0062: Luna max を優先し Codex の週枠の余りを使う

## Status

accepted (2026-10-30)

## Context

2026-10-30、利用者は Luna max を先に使い、sonnet の推奨を Codex の枠を使う方向に調整したいと述べた。

ADR-0056 は、research・impl・review・draft の委譲先を Terra、Luna max、OpenCode、Sarashina の順にしていた。
mechanical・triage の順は OpenCode、Luna max、Terra、Sarashina のままである。
規則 2 は `externalOrder` の順に外部委譲先を調べ、5 時間枠と週枠が under の最初の候補を選ぶ。
Terra と Luna max は Codex の同じ枠を使う。
Terra が先の kind では、規則 2 も Terra を選ぶ。
同じ順序は規則 1 の同率判定、試す候補の同数判定、週枠の余りを表示する委譲先にも使われる。

規則 2 は Claude の週枠が ahead または exhausted のときに動く。
両方の枠が under の外部候補を選べないと、sonnet を推奨した。
Codex は 5 時間枠が under でも、週枠が ahead の場合は選ばなかった。
ADR-0057 K1 は外部の週枠が under の場合に限って委譲を許していた。

ADR-0057 K3 は週枠の余りを「試す候補」にだけ表示し、推奨先は変えないと決めた。
同 ADR K6 は既存の出力行を保ち、新しい行を追加すると決めた。
`model-offloading.md` は route の推奨に従うよう定めている。

## Decision

この ADR は ADR-0056 の委譲先の順序と、ADR-0057 K1、K3、K6 の決定を次のとおりに上書きする。
ADR-0056 と ADR-0057 の本文は変更しない。

- **K1: 推奨先を変える。**
  文言だけを変えず、route が推奨する委譲先を実際に変える。
- **K2: Luna max を先にする。**
  research・impl・review・draft の委譲先を Luna max、Terra、OpenCode、Sarashina の順にする。
  mechanical・triage の順は OpenCode、Luna max、Terra、Sarashina のままにする。
  Sarashina の size S 条件と `usable` による絞り込みは変えない。
  同じ順序は規則 1 の同率判定、試す候補の同数判定、週枠の余りに表示する委譲先にも使う。
- **K3: 規則 2 の最初の探索を保つ。**
  Claude の週枠が ahead または exhausted で、規則 0 と規則 1 が候補を返さないとき、従来の順序で外部候補を調べる。
  両方の枠が under の最初の使える委譲先を選ぶ。
  1 周目で OpenCode や Sarashina が選ばれる条件は変えない。
- **K4: 規則 2 に Codex だけの 2 周目を設ける。**
  1 周目に候補が無いとき、使える Codex 委譲先を `externalOrder` の順に調べる。
  Codex の 5 時間枠が under で週枠は ahead のとき、最初の Codex 委譲先を選ぶ。
  Codex の 5 時間枠が ahead、exhausted、unknown のとき、または週枠が exhausted、unknown のときは選ばない。
  OpenCode と Sarashina はこの 2 周目の候補にしない。
- **K5: 規則 2 の行に実際の枠の状態を出す。**
  規則 2 の理由には Claude の週枠の状態として ahead または exhausted を出す。
  2 周目で Codex を選んだ行には `codex 5h=under week=ahead` を加える。
  sonnet に戻る行には、使える外部 provider ごとに一度ずつ 5 時間枠と週枠の状態を出す。
  `usable` で外れた委譲先の状態は行に含めない。
  `delegation route v1` の先頭行と、1 周目の理由の形は保つ。
- **K6: Claude の週枠の余りで Codex を推奨する。**
  規則 0、規則 1、規則 2 が候補を返さず、Codex の両方の枠が under の場合に適用する。
  Codex の週枠の余りが 25pt 以上なら、最初の使える Codex 委譲先を推奨する。
  この規則はすべての kind に適用し、余りの値は切り捨てた整数で行に出す。
  余りが null のとき、または Codex のどちらかの枠が under でないときは適用しない。
  `surplusPoints` と `SURPLUS_MIN_POINTS` を使い、新しい閾値は設けない。
  余りは `(100 − 使用率) × (1 − リセットまでの残り時間 ÷ 週の長さ)` で算出する。
  週の長さには ai-usage が返す値を使う。
  余りの規則は規則 3 の sonnet の直前に置き、規則 3 の表示は変えない。
  この決定は ADR-0063 により上書きされた。
- **K7: 週枠 under の回答と unknown の扱いを分ける。**
  利用者は Claude の週枠が under の場合について「週枠の余りがあれば Codex」と答えた。
  Claude の週枠が unknown の場合も同じ条件を適用する判断は、この回答からの推論である。
  unknown で Codex を勧めるのは、規則 2 が ahead と exhausted の場合だけ動くためである。
  それ以外の場合、Claude の週枠は under または unknown である。
- **K8: 出力と計測の扱いを保つ。**
  `推奨:` 行を読むプログラムは無いため、規則 2 の行だけ形を変える。
  試す候補の週枠の余りは、推奨と同じ Codex provider を指す行を重ねて出さない。
  探索の行は推奨と同じ委譲先を指す場合だけ抑制し、同じ provider の別の委譲先は残す。
  「先読み」と「記録では劣る」の条件は規則 2 と同じにするが、余りの規則には付けない。
  `model-offloading.md` は変更せず、枠の減り方の計測を待たずに順序を変える。

## 却下した代替案

- 推奨先を sonnet のままにして文言だけ Codex を使うよう促す案は採らない。
  route の利用者は推奨先を実行するため、sonnet のままでは Codex の枠を使わない。
- provider ごとの枠の減り方や週末の残量を比べて、最も早く枠が尽きる provider を選ぶ白紙案は採らない。
  provider 間で比べる数値を用意する変更が必要になり、今回の希望を満たすまでの変更が広がる。
- 余りの規則で規則 3 を置き換える案は採らない。
  余りが無い場合や Codex の枠が under でない場合にも、既定の sonnet 推奨を残す。
- 2 周目にすべての外部 provider を入れる案は採らない。
  mechanical と triage では OpenCode の週枠が ahead のとき、Codex より先に OpenCode が選ばれる。
- Claude の週枠が under のときに、余りの条件を設けず常に Codex を先にする案は採らない。
  利用者は週枠の余りを条件にする案を選んだ。

## Consequences

- K1 により、外部の週枠が under のときだけ委譲する ADR-0057 K1 の条件を、Codex に限り 5 時間枠が under なら週枠 ahead でも委譲する条件に広げる。
- K6 により、週枠の余りは試す候補だけに使い推奨先を変えない ADR-0057 K3 の決定を変える。
- K5 により、行を追加するだけで既存行の形は変えない ADR-0057 K6 の決定を、規則 2 の行に限って変える。
- Terra より Luna max が先に選ばれ、Terra の記録が増える速さは落ちる。
- Luna max と Terra の 1 回あたりの Codex 枠の消費量は測っていない。
  Luna max の出力が長い場合、Luna max を先にすることで枠を早く使う可能性がある。
- 週枠が ahead の Codex を選ぶため、リセット前に Codex の週枠を使い切る可能性がある。
- Claude の週枠が exhausted で、使える外部候補が無ければ、sonnet の推奨に戻る。
- 週枠の余りは週の前半に小さく算出される。
  Codex の両方の枠が under でも、余りが 25pt 未満なら sonnet が推奨される。
- Claude の週枠が unknown のときも余りの規則を適用する判断は、利用者の回答から広げた計画上の推論である。
- route の変更は配布後から有効となる。
- 今回の実装範囲では配布と実機確認を行わない。

## References

- `docs/decisions/0056-codex-delegation-destinations.md`
- `docs/decisions/0057-route-lookahead-and-surplus.md`
- `docs/plans/delegation-ledger-followups.md`
- `home/dot_local/share/delegation/route.ts`
- `home/dot_local/share/delegation/pace.ts`
- `home/dot_local/share/delegation/constants.ts`
