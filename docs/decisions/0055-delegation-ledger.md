# ADR-0055: 委譲の結果を台帳に記録し、枠のペースと記録から委譲先を勧める

## Status

accepted (2026-10-29)

## Context

メインループ（Opus 以上）は、定型の実装や調査を下位のモデルに委譲する。委譲先は Claude の sonnet のほか、Codex（GPT-6.1 Terra）と OpenCode（GLM-5.3）がある。それまでの規約は、次の 3 点を決めていた。

- 委譲の前に `ai-usage codex opencode --summary` を実行し、使い切った委譲先には渡さない
- 重要な委譲は Codex に、単純な実装は GLM-5.3 に渡す
- Claude の週枠が 80% を超えたら外部を優先する。この判定は delegation-budget Mod が Agent の呼び出しの後に知らせる

この形には問題が 3 つあった。

- 使い切ったかどうかしか確かめないので、週の初日に週枠を使い切る事態を防げなかった
- 委譲の結果の良し悪しが、どこにも記録されなかった
- 委譲先が固定で、記録から判断を変える手段が無かった

2026-10-27 の session で、利用者は、ハーネス・モデル・effort の組ごとに委譲の結果を記録する案を出した。その session の提案は、委譲 1 回ごとに 1 行の台帳と集計の CLI を作り、レビュアーに指摘の Tier を付けさせる、というものだった。最初の記録の材料として、Codex の振り分け 1,230 件（欠け 1、形の誤り 0、5 時間枠の約 30%）、行の要約と重なりの判定 93 行（形の誤り 0）、行き先の提案（存在しないスキルを 30 本超挙げた）、レビュー 4 round（指摘 20 件）がある。どれも多くの仕事の集計で、1 回の委譲には対応しないので、台帳には入れていない。

2026-10-29、利用者は次を求めた。

- 委譲先は、基本は sonnet とし、Codex と OpenCode も選べるようにする
- 任せ方を評価する仕組みを作り、その結果で判断を変えていく
- 委譲先の枠を見て、1 週間分を 1 日で使い切らないようにする
- learnings は件数の上限で古い学びが消えるので、その点に注意し、思い出す時機を決める
- ハーネス × モデル × effort の評価の話と連動させる

Tier の案は、この ADR の対象外とし、`docs/plans/reviewer-finding-tier.md` に残した。

## Decision

- **K1: 委譲の結果は、追記だけの JSONL の台帳に記録する。learnings は使わない。**
  - 置き場は `$XDG_DATA_HOME/delegation-ledger/ledger.jsonl`（`XDG_DATA_HOME` が絶対パスでなければ `~/.local/share` の下）で、リポジトリの外にある。
  - 行の種類は、delegation（1 回の委譲）、amend（後から分かった欠陥ややり直し）、lapse（記録されずに閉じた委譲）、review（振り返りをした時刻）の 4 つ。
  - learnings を使わないのは、1 ファイル 40 件を超えると古い学びが知らせなく消え（`home/dot_claude/hooks/lib/agent-learnings/core/ops.ts` の `MAX_ENTRIES`）、件数を並べた集計ができないため。
- **K2: 委譲の識別は、ハーネス・モデル・effort・仕事の種類・規模で表す。**
  - 種類は research、impl、mechanical、review、triage、draft の 6 つ、規模は S、M、L の 3 つ。採否は adopted、patched、redone、discarded の 4 つ。
  - 採用率は (adopted + patched) / 件数 とし、adopted だけの率も並べる。
- **K3: delegation-budget Mod が委譲を見つけて識別を取り、終わったら記録を促す。ファイルは CLI だけが扱う。**
  - Mod が見つけるのは、`model: "sonnet"` を指定した Agent、`codex:codex-rescue` の Agent、`opencode run`・`codex exec`・`reviewer-codex-run.ts` で始まる Bash。
  - Mod は `delegation open` に識別を渡し、委譲が終われば `delegation close` を呼ぶ。そのうえで `[delegation] <id> (<harness>/<model>/<effort>) 完了。採否を delegation record で記録` の 1 行をモデルの context に加える。foreground の委譲ではツールの結果に、background の Agent では次の task-notification の prompt に加える。
  - Claude の週枠 80% の知らせは廃止した。委譲先の判断は K6 の route にまとめた。
- **K4: 集計は、種類 × 規模の中で、ハーネス × モデル × effort の組ごとに件数と並べて出す。**
  - 件数が 5 未満の組は、率を出さず `n<5` と書く。
  - 組ごとに lapse の割合を出す。30% を超える組は、記録されない委譲が多いので K6 の規則 1 の対象から外す。
  - メインループ自身の判断の誤りは、委譲先の欠陥に含めない。
- **K5: ペースは provider × 枠ごとに判定する。**
  - 週枠の線は 100 × (経過日数 + 1) / 7 %。使用率がこの線以下なら under、超えたら ahead。初日の線は 14.3〜28.6% で、1 日で週枠を使い切る委譲は勧めない。
  - 5 時間枠は 90% 以上で ahead。数時間で戻る枠なので、作業の途中で使い切らないことだけを確かめる。
  - 枠の長さは ai-usage の `summary.ts` から import し、同じ値を 2 か所に持たない。
- **K6: `delegation route` は次の順で委譲先を勧める。**
  1. 記録: その種類と規模で、外部の組の採用率が sonnet の組より 15pt 以上高く、両方 5 件以上あり、外部の枠が under なら、外部を勧める。
  2. Claude の週枠が ahead か exhausted なら、枠が under の外部を勧める。impl・research・review・draft は Codex を、mechanical・triage は OpenCode を先に選ぶ。
  3. それ以外は sonnet。
  4. 推奨とは別に、規模 S で記録が 60 日に 5 件未満の外部があれば「試す候補」として示す。これが無いと外部の記録が増えず、sonnet を基本とする前提を確かめられない。
- **K7: 思い出す時機は 3 つに決め、台帳と pending のほかに状態を持たない。**
  - 委譲の前: 規約が route の実行を求め、route がその種類の記録と記録待ちの数を示す。
  - 委譲の後: K3 の Mod の 1 行。
  - 振り返り: 最後の review から 10 件か 14 日を超えたら、route と record が `delegation review` を促す。
- **K8: CLI と Mod がモデルに見せる文字列は、enum、数値、決まった形の語だけにする。**
  - 既知の一覧に無いモデル ID は、保存した値のハッシュから作った `m-` と 6 桁の 16 進で示す。
  - note は review でだけ、制御文字と bidi の文字を除き、80 字に切って `note(data):「…」` の形で示す。
  - Bash の command そのもの、Agent の prompt と description は保存しない。
- **K9: 規約 `model-offloading.md` は、route・record・review の手順と、外部の委譲先への渡し方だけを書く。**
  - 固定の委譲先（重要な委譲は Codex、単純な実装は GLM-5.3）、80% の切り替え、`ai-usage --summary` の確認を消した。
  - 共通の learning L-692261d168e8（週制限が近いときは Terra を優先）は、利用者の確認を得て消した。
- **K10: pending は open → bind → close を経て、record か lapse で台帳に移る。**
  - bind は background の Agent の agentId を記録する。close は完了の時刻と理由を記録する。
  - Mod と CLI の間の入出力と終了コードは v1 として固定した。Mod と CLI は別々に配備されるため。
  - pending ごとに mkdir のロックを取り、読み直してから rename で更新する。rename だけでは、同じ古い内容を読んだ 2 つの更新の一方が消えるため。
  - 7 日を超えた pending は、route か review を実行したときに lapse にする。

## 却下した代替案

- **ai-usage の summary に pace の欄を加え、評価は learnings に書く。** 変更は最小になる。しかし、status line（usage-line）が読む事実の層に、方針の定数が入る。また learnings では件数を集計できない。
- **委譲先を多腕バンディットとして扱い、Mod が Agent の model を自動で書き換える。** 採否を判定できるのは、結果を読んだメインループだけである。標本は種類ごとに週に数件で、自動の切り替えは雑音で揺れる。組の件数が 20 を超え、規則 1 の推奨が 1 か月変わらなくなったら、再検討する。
- **委譲 1 回あたりの枠の消費量を測り、推奨に使う。** 前後で ai-usage を取ると 1 回に 1 秒前後かかり、Codex は毎回 app-server を起動する。並行する session の消費も差分に含まれる。外部への委譲が週 10 件を超えたら、再検討する。
- **bind より先に届いた background の完了を、Mod が保持して後から close する。** 対象外の子の完了と区別できず、仕組みの複雑さに見合わない。先に届いた分は、所要時間を空欄のまま記録する。

## Consequences

- pending の遷移と Mod の取得は、識別の欄を手で書かせないための投資である。委譲先の判断に使う欄は、kind、size、verdict と、ハーネス・モデル・effort。所要時間と終了の理由は参考の欄で、判断には使わない。
- 受け入れた制約:
  - route に渡した種類と規模は pending に入らない。route の推奨に従ったかは、台帳に残らない。
  - `codex:codex-rescue` 経由の委譲は、model と effort を取れず unknown の組に入る。
  - sonnet の組と外部の組の比較では、effort の違う組を、件数の多い組に寄せて比べる。
  - 閾値（日数 + 1、90%、15pt、5 件、30%、10 件・14 日）は計測から決めた値ではない。review が今の値を示すので、件数がそろったら見直す。
  - 記録はメインループの自己申告で、促しを無視すれば記録されない。記録されなかった委譲は lapse の割合に表れる。最初の振り返りで lapse の割合が高ければ、Mod の促し方を見直す。
  - Mod の対象の判定（Bash の先頭の語）に合わない呼び方は記録されない。`delegation record --manual` で補う。
  - route は委譲のたびに ai-usage を起動する。usage-line の 5 分ごとの取得（ADR-0041）とは別の取得が増える。重くなったら、ADR-0041 にある `_external.json` を読む案と比べる。
  - Mod は委譲 1 回に最大 600 ms の待ちを加えうる。実際に測ると `delegation` の起動は 1 回約 100 ms だった。
  - Agent で model を省いた委譲は、spec の inherit ではなく unknown になる。Mod は sonnet を指定した Agent だけを扱うので、この場合は今は起きない。
  - background の完了の後に促しの行を取り出してから、prompt の処理が例外で終わると、その行は表示されない。
  - 台帳の行を v2 に変えるときは、読む CLI を先に v1 と v2 の両方に対応させる。台帳は書き換えない。v1 の中では欄と enum の値を加えるだけにする。
- 実機の probe（2026-10-29）:
  - background の Agent の完了の後、task-notification の prompt で加えた context は、モデルに読まれた。
  - foreground と background の Agent の結果には、どちらも agentId があった。background は status が `async_launched` で区別できる。
  - foreground の Bash の結果に数値の終了コードは無く、失敗のときは `isError` が付く。Mod は `isError` を error に写す。
  - background の Bash の完了は、tool_use_id と対応付けられなかった。background の Bash は open だけで close しない。
  - Agent の結果には `resolvedModel` と `totalDurationMs` があった。model を `sonnet` という呼び名でなく正確な ID で記録する案は、K2 を変えることになるので次の課題とした。
- 実機の確認では、別の session が master から apply した後に、配備された `summary.ts` が古くなり、route の枠がすべて unknown になった。route は原因と直し方を 1 行で示す。

## References

- 2026-10-27 の提案: `.tmp/sessions/6d65229b/followups/delegation-eval-ledger.md`（workflow dir の GC で消える。要点は Context に書いた）
- ADR-0041: usage-line の取得と、ai-usage のキャッシュを再検討する条件
- `docs/plans/reviewer-finding-tier.md`
