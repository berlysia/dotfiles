# ADR-0056: Codex の委譲先を Terra と Luna max に分け、どちらも明示のモデルで起動する

## Status

accepted (2026-10-29)

## Context

ADR-0055 で、委譲の結果を台帳に記録し、`delegation route` が枠のペースと記録から委譲先を勧める仕組みを作った。そこでの Codex は 1 つの委譲先で、規約は GPT-6.1 Terra を `codex:codex-rescue`（rescue）で渡すと定めていた。

2026-10-29、利用者は次を求めた。

- 「GPT 6.1 TerraだけじゃなくてLunaのエフォートMaxも使うようにして。」
- 使い分けは、規約だけでなく route でも区別する
- rescue 経由の委譲が Terra でなく Sol で動いている可能性の件も含める
- 「reviewer経由の起動が一番性能を知りたいだろうに」として、Document Workflow の reviewer を Codex で実行した分も比べられるようにする

調べると、次の 4 点が分かった。

- route は委譲先を provider（codex / opencode）の単位でしか持たず、規則 1 は件数が最も多い 1 グループだけを比べていた。Luna max の記録が Terra より少ない間は、Luna max は規則 1 にも試す候補にも出ない
- rescue は effort に `max` を渡せない（plugin の companion が受け付ける effort は `xhigh` まで）。rescue 経由の委譲は、台帳に model・effort とも `unknown` で記録される
- reviewer を Codex で動かす `reviewer-codex-run` はモデルを付けずに `codex exec` を起動しており、記録は `unknown` だった
- 2026-10-29 に codex-cli 0.164.0 で起動して確かめた結果は次のとおり
  - `codex exec -m gpt-6-luna -c model_reasoning_effort=max` は、ヘッダに `model: gpt-6-luna` と `reasoning effort: max` を出して応答した
  - `-m` も `-c` も付けない `codex exec` は `gpt-6.1-sol` の effort `low` で動いた。設定ファイルに書かれたモデルを読むためで、モデルを付けない rescue も同じ設定を読む
  - subagent が Bash の `run_in_background` で起動した `codex exec` は、delegation-budget Mod が pending の行を作った。行の sessionId はメインループのセッションと同じで、背景の起動なので close も `[delegation]` の行も無かった

## Decision

### 委譲先の表

- route の委譲先を、{ 名前, provider（どの枠を使うかを決めるキー）, 記録の条件, 表示 } の表で持つ。委譲先は `codex Terra`、`codex Luna max`、`opencode` の 3 つで、sonnet は今までどおり、規則 1 と規則 2 のどちらも成り立たないときに勧める委譲先（規則 3）とする
- ai-usage の枠は provider の単位で読み取る。Terra と Luna max は codex の 5 時間枠と週枠を共有する
- 規則 1、規則 2 の「記録では劣る」の注記、試す候補は、委譲先の条件に合う全グループ（harness・model・effort 別）を合算した集計で判定する。sonnet 側は今までどおり件数最大のグループを使う
- 記録の条件は次のとおり。照合は台帳に保存された値との完全一致とする
  - `codex Terra`: harness `codex-cli`、model `gpt-6.1-terra`。effort は問わない
  - `codex Luna max`: harness `codex-cli`、model `gpt-6-luna`、effort `max`。`xhigh` や `unknown` で渡した記録は含めない
  - `opencode`: harness `opencode`
- Terra は effort を問わず、Luna max は `max` に限る。利用者の指定が「Luna のエフォート Max」で、Terra には effort の指定が無かったためである
- 委譲先の順序は、mechanical と triage では opencode → Luna max → Terra、それ以外では Terra → Luna max → opencode とする。この順序は規則 2 と試す候補で使う。Luna を Terra より下の段のモデルとみなし、max の effort で補う位置にした。モデルの段も枠の消費も確かめていない推測である
- 試す候補は、枠が両方 under で、記録が 5 件未満の委譲先のうち、記録が最も少ないものとする。同数なら上の順序で前のものを選ぶ
- 「推奨:」「試す候補:」の行の委譲先の表示は、表に書いた固定の文字列だけにする。記録の値は埋め込まない

### 起動の仕方

- Terra と Luna max は、どちらも推奨行の括弧内の `codex exec -m … -c model_reasoning_effort=…` で起動する。Terra の effort は `high` とした。chezmoi の source の設定ファイルの既定値に合わせた値で、記録が無い時点の推測である
- 書き込みを伴わない委譲は `-s read-only`、書く委譲は `-s workspace-write -C <worktree>` とする。`-C` のパスは、`realpath` がメインのリポジトリの `.git/worktree/` の下にあるときだけ渡す。この確かめ方は規約の手順で、プログラムによる強制は無い
- rescue は route に従う委譲には使わない

### reviewer の起動と記録

- `reviewer-codex-run` は `-m <model> -c model_reasoning_effort=<effort> <reviewer> <brief> <root>` の 7 引数を受け、検証した値を `codex exec` に渡す。model は `^gpt-[0-9a-z.-]{1,32}$`、effort は `low` から `max` の 5 つに限る。正規表現と一覧は schema.ts・reviewer-codex-run.ts・agent 定義の 3 か所にあり、一致はテストで確かめる。配布先が別で import できないためである
- reviewer への依頼は、`executor: codex`・`brief:`・`root:` に `model:`・`effort:` を加えた 5 行にする。値は `delegation route --kind review` の推奨行から取る
- 記録の手順は次のとおり。subagent の背景の起動は pending の行を作るが、その id はメインループに届かない
  - メインループが reviewer の結果を確かめた後、pending から行を選ぶ。条件は、sessionId が自分のセッション、closedAt が無い、harness が `codex-cli`、invocation の先頭が `reviewer-codex-run`、model と effort が依頼と一致、openedAt が今回の起動以降、の 6 つである
  - reviewer 1 名につき 1 行を `delegation record <id> --kind review` で記録し、同じ round の reviewer には同じ size を書く
  - 合う行が足りなければ、`delegation record --manual` で記録する。`bad-arguments` で終わった起動の行は、委譲先の結果ではないので lapse で閉じる

## 却下した代替案

- **route は変えず、規約に Luna max を 1 行加える**: 利用者が選んだ「route でも区別する」を満たさない。Luna max は記録が Terra を超えるまで規則 1 に出ない
- **委譲先でも件数最大の 1 グループを比べる**: Terra の記録が effort 別に割れると一部しか数えず、試す候補（全グループを合算）とずれる
- **provider を `codex-terra` と `codex-luna` に分ける**: ai-usage の枠は契約の単位で 1 つしか無く、同じ値を 2 回取得するだけになる
- **rescue に `--model gpt-6.1-terra` を付けさせる**: 起動するモデルは Terra になるが、記録は `unknown` のままで route の比較に入らない。Agent のプロンプトから `--model` を読み取る解析は、書き方で記録が揺れる
- **Codex の設定ファイルの model を Terra にする**: 対話で使うときの利用者の選択を上書きする（ADR-0019）
- **reviewer-codex-run に省略時のモデルを持たせる**: どのモデルで動かしたかが依頼から読めず、省略時のモデルを変えると記録の意味が、利用者の気付かないまま変わる
- **10 個の agent 定義の同じ 1 行を 1 か所にまとめる**: 今回の目的の外なので、複製は残してテストで同期を確かめる

## Consequences

- Terra と Luna max の採用率が、委譲と review の両方で別々に記録され、route の規則 1 で比べられる
- rescue 経由の codex の記録（model `unknown`）は、どの委譲先にも数えない。2026-10-29 時点の台帳に codex-cli の記録は 0 件で、過去の記録は直さない
- reviewer 経由の比較は、この変更の後の記録からしかできない
- Terra の集計には high 以外の effort の記録も含まれうる。Terra の条件を後で effort 付きに絞ると、過去の記録の数え方が変わる。`delegation review` で effort 別の採用率を確かめ、Terra の effort と委譲先の順序を見直す
- record されずに残った pending の行は 7 日で lapse になり、委譲先の lapse 比（規則 1 の上限）を押し上げる。reviewer の行を record で閉じる手順は、この押し上げを防ぐためでもある
- 「推奨:」行の委譲先の表示が `codex` から `codex Terra` と `codex Luna max` に変わる。この行を読むのはメインループとテストだけである
- `-s workspace-write` で書く委譲は、worktree の `.git` ファイルを通じてメインのリポジトリの git ディレクトリにも書ける。今までの Terra の書く委譲と同じ条件で、この ADR では変えない
- 古い 3 行の依頼で `executor: codex` を出すと、agent 定義が失敗を返し、Claude で実行し直す

## Amendments

### Sarashina を委譲先に加える (2026-10-29)

利用者の依頼は、ai-usage を Sarashina に対応させ、オフロード先としても選べるようにすることだった。利用者の回答は、枠が無いものは under として扱い、公開リポジトリだけに許す、だった。

#### 決めたこと

- Sarashina は使用量・残枠・残高を返す API を持たない。制限はチャットの RPM だけで、どの API もそれを返さない。ai-usage の `sarashina` provider は、鍵があり `/v1/models` が対象のモデルを返すかだけを見る。窓は常に null で、窓が無いことは `unmetered: true` で表す。この印は「窓を持たない」ことだけを表す
- route は `unmetered` が `true` のときだけ、5 時間枠と週枠を under と読む。`exhausted` は `/v1/models` の 429 だけを表し、チャットの RPM は表さない。鍵が無い、モデルが一覧に無い、通信に失敗したときは窓が null なので unknown になり、推奨にも候補にも出ない。週枠の余りは null で、余りの候補にも出ない
- 鍵が無いことは失敗にしない。引数なしの ai-usage が鍵の無い環境で終了コード 1 になるのを避けるためである
- 鍵の送り先は定数の URL だけにする。環境変数で差し替えられると、環境だけで鍵の送り先を変えられるためである。テストは URL を関数の引数で渡す
- 保留に理由を持たせた。opencode（GLM）は今までどおり常に保留する。Sarashina は、route を起動した場所の origin が github.com で、GitHub が `public` と答えたときだけ保留を外す。判定できないときは保留のままで、理由を保留の行に出す。判定は、Sarashina が規則か試す候補で勝った後にだけ呼び、1 回の route で多くて 1 回にする
- 公開かどうかの判定は代理指標である。見るのは route を起動した場所のリポジトリで、brief の中身でも、opencode を起動する作業ツリーでもない。`git remote get-url` は `insteadOf` を適用するので、信頼できないリポジトリの設定で origin を公開リポジトリに見せかけられる。送る内容を絞るのは委譲する側で、規約に書いた。送る内容ごとの区分（exposure）ができたら、この判定を差し替える
- Sarashina は規模 S にだけ出す。出力の上限が 8000 トークンで 30 RPM の小さいモデルなので、M 以上は向かない。規則 1、規則 2、試す候補のどれでも、S 以外では並びから外す
- opencode の記録の条件に model `zai-coding-plan/glm-5.3` を足した。Sarashina の記録（harness は同じ opencode）が GLM に混ざらないようにするためである。台帳にある opencode の記録 3 件は、3 件とも model が `unknown` で、GLM の件数に数えられなくなる。opencode は保留中で採用率を使っていない。保留を外すときは、この 3 件の扱いを決める
- ai-usage が終了コード 1 で終わっても、route は標準出力を読む。Sarashina の通信障害で claude と codex の窓まで unknown になるのを防ぐためである。ai-usage の終了コードの契約（1 つでも失敗すれば 1）は、usage-line が読むので変えない

#### 却下した案

- Z.ai の枠に Sarashina を相乗りさせる: Z.ai の枠で Sarashina の可否を判断することになり、鍵の有無も見えない
- 送る内容ごとの区分を先に作る: 区分の定義と記録の形を決める作業が要り、「DW は軽量に」という指定を超える

#### 結果

- 引数なしの `chezmoi apply` が ai-usage と route を同時に `~/.local/share/` へ置く。route だけが新しいと、古い ai-usage は `sarashina` を不明な引数として終了コード 2 を返し、全 provider が unknown になる
- Sarashina の記録は 0 件から始まるので、規模 S の試す候補に出続ける。記録を増やすための枠なので意図どおりである
- 入力が学習に使われうる、という点はプレスリリースによる。規約の本文は読めていない
- 判定から起動までの間に可視性が変わる余地がある。間は短いので受け入れる

## References

- ADR-0055: 委譲の結果を台帳に記録し、枠のペースと記録から委譲先を勧める
- ADR-0019: Codex の設定ファイルの管理
- `home/dot_local/share/delegation/route.ts`
- `home/dot_local/share/delegation/repo-visibility.ts`
- `home/dot_local/share/ai-usage/providers/sarashina.ts`
- `home/dot_claude/scripts/reviewer-codex-run.ts`
- `home/dot_claude/rules/model-offloading.md`
