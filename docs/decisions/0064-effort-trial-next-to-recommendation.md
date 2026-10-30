# ADR-0064: route が推奨行に試す effort を添える

## Status

accepted (2026-10-30)

## Context

2026-10-30、利用者は effort の探索を求めた。

> 「エフォートの探索の仕組みもできるといいね。planにも置いてあると思うけど」

Codex の委譲先は、ADR-0056 で記録が無い時点の推測で effort を決めた。
Luna は max、Terra は high で起動する。
effort を下げると枠と時間を節約できるが、下げた effort の記録が無いので、下げてよいかを判断できない。

利用者は、選択肢から次の 2 つを選んだ。

- 探索の単位は「推奨行に添える」。委譲先の表に effort ごとの行を足さない。
- 決め方は「記録を集め、人が決める」。route は effort を自動で選ばない。

## Decision

この ADR は、Terra の記録を effort を問わず集計に含めるという ADR-0056 の決定を、K1 で置き換える。
ADR-0056 の本文は変更しない。

- **K1: Terra の記録を effort high だけで数える。**
  Terra の match に `effort: "high"` を足す。
  絞らないと、Terra medium で試した記録が Terra の採用率に混ざる。
  2026-10-30 時点の Terra の記録 13 件はすべて high なので、集計の値は変わらない。
- **K2: 試す effort を推奨行に添える。**
  各委譲先に `effortTrials` を持たせ、route は推奨の委譲先の一覧から 1 つを `試す effort:` の行に出す。
  行の起動コマンドは、表の固定の文字列から effort の値だけを差し替えて作る。
  記録の文字列からコマンドを組み立てないので、記録の内容が起動コマンドに入らない。
- **K3: 試すのは今より低い effort だけにする。**
  effort を下げる目的は枠と時間の節約なので、上げる方向は試さない。
  最初の一覧は、Luna max に `xhigh` と `high`、Terra high に `medium` である。
  テストは表の全行について、`effortTrials` の値が今の effort より低いことを確かめる。
- **K4: 行を出す場面を絞る。**
  推奨が Codex の委譲先で、kind×size の直近 60 日の記録が 5 件未満の effort があるときだけ出す。
  候補が複数あれば最も記録の少ない effort を選び、同数なら一覧の順にする。
  kind が review なら全規模で、ほかの kind は S だけで出す。
  推奨が sonnet、opencode、`待機` のときは出さない。
  この条件は仮の決定で、2026-11-13 ごろに記録が 5 件に届いたかを確かめて決め直す。
- **K5: route は effort を自動で選ばない。**
  `delegation review` は、cell の中で今の effort と試した effort がどちらも 5 件以上になったら、「effort の見直しの条件に当たる」の行を出す。
  件数は review の `--since`（既定 60 日）で数えるので、合図と根拠の数値が同じ出力に並ぶ。
  合図を見て、利用者が `destinations.ts` の effort を書き換えるかを決める。
- **K6: review では reviewer 1 名にだけ使う。**
  対象は scope-justification-reviewer である。
  その round で起動する reviewer が 2 名以上のときだけ使う。
  この reviewer は spec 層と plan 層の両方に常駐するので、どの round でも同じ名前で選べる。
  残りの reviewer が、低い effort の reviewer の見落としを拾える。
- **K7: 拒否された effort は起動し直して、値を消す。**
  Codex が試す effort を拒んだら、`--exclude` も route の引き直しもしない。
  同じ委譲先を、推奨の effort で起動し直す。
  拒否されたのは effort の値で、委譲先ではないためである。
  拒否された行は `delegation lapse` で閉じ、`effortTrials` からその値を消す PR を別に出す。
- **K8: route の出力の版を変えない。**
  `試す effort:` の行は、`試す候補:` の行と同じ位置に置く。
  route の出力を読むのはメインループと document-workflow-reference の手順で、どちらも行の頭の語で行を選び、知らない行を読み飛ばす。
  そのため `delegation route v1` の見出しは変えない。

## 却下した代替案

- **委譲先の表に effort ごとの行を足す案:**
  Luna xhigh や Terra medium を独立した委譲先にすると、規則 1 と規則 2 の比較に入る。
  推奨そのものが effort 違いの行に移りうる。
  利用者は探索の単位として「推奨行に添える」を選んだ。
- **route が自動で effort を下げる案:**
  (model, effort, kind, size) を腕とする多腕バンディットにし、採用と枠の消費量から effort を選ぶ案である。
  台帳の verdict はほぼ全件 adopted で、規則 1 は adopted と patched を同じ成功として扱うので、品質の差を報酬に出せない。
  委譲 1 回あたりの枠の消費量も記録されていない。
  報酬に差が出ないまま自動で選ぶと、最も低い effort に寄る。
  欠陥は後から `delegation amend` で記録されるので、品質が落ちたと気づくまで時間がかかる。
- **拒否された値を followups に書いて後のセッションに読ませる案:**
  文書は commit されるまで別の worktree のセッションから見えず、読む手順が守られる保証も無い。
  `effortTrials` から値を消す PR なら、apply の後はどのセッションの route にも出なくなる。

## Consequences

- **R1:** `試す effort:` の行が出ても、メインループが使わなければ記録は増えない。
  K6 で使う場面を決め、2026-11-13 ごろに `delegation review` で件数を確かめる。
  届かなければ、impl の M にも出すかを決め直す。
- **R2:** Codex がモデルによっては effort の値を拒む。
  値ごとに受け付けるかは確かめていないので、拒否されたら K7 に従う。
- **R3:** 低い effort の reviewer が指摘を落とし、round の判定が甘くなりうる。
  K6 で 1 名に限り、他の reviewer の出力と比べて落とした指摘を見つけたら、その委譲の記録を `delegation amend` で patched にする。
  review の記録は reviewer の役割を分けないので、cell の数値だけでは同じ reviewer どうしを比べられない。
- K7 で受け入れた残りの費用: 値を消す PR が merge されて apply されるまでは、別のセッションが同じ値を試して拒否されうる。
  費用は起動 1 回分の時間と lapse 1 行である。
  lapse は試した組（例: gpt-6-luna/high）に付くので、推奨の組の lapse 比には入らない。
- 比べ方は kind で分かれる。
  review の cell では、同じ round の他の reviewer の出力と比べる。
  ほかの kind の cell では、`delegation review` が出す今の effort と試した effort の組の数値を比べる。
  手順は `home/dot_claude/rules/model-offloading.md` の手順 7 にある。

## References

- `docs/decisions/0056-codex-delegation-destinations.md`
- `docs/decisions/0063-route-equalizes-weekly-lag.md`
- `home/dot_claude/rules/model-offloading.md`
- `.skills/document-workflow-reference/SKILL.md`
- `home/dot_local/share/delegation/destinations.ts`
- `home/dot_local/share/delegation/route.ts`
- `home/dot_local/share/delegation/review.ts`
- `tests/delegation-effort-trial.test.mjs`
- `tests/delegation-pace-route.test.mjs`
