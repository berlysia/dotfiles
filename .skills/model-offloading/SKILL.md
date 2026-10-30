---
name: model-offloading
description: Opus 以上のメインループで、大量の読み取りや定型実装を委譲するときに使う。設計判断や少量の確認だけの作業には使わない。
read-before: ["Bash(delegation offload)", "Bash(codex exec)"]
---

# Model Offloading Rules (plan big, execute small)

参考: [claude-cookbooks: Coordinator pattern — big models for planning, small models for execution](https://github.com/anthropics/claude-cookbooks/blob/main/managed_agents/CMA_plan_big_execute_small.ipynb)

## 原則

エージェント作業の大半は「少量の計画・判断」と「大量の機械的な読み・実行」に分解できる。高位モデル（メインループ）は計画・判断・統合に専念し、**トークン量の多い生データ（大量のファイル・ログ・web ページ・テスト出力）を自分のコンテキストに直接通さない**。下位モデルの並列 subagent に読ませ、蒸留した結果だけを受け取る。コスト削減の本質はモデル単価の差 × 読みの排除であり、cookbook の計測では同一の検証水準で約 2.5x 安く 3x 速い（入力トークンの 84-98% がワーカー料金）。

## 適用条件

メインループが **Opus 以上**（Opus / Fable / Mythos-class）のセッションで適用する。判定はシステムプロンプトの model 表記による。subagent はデフォルトでメインループのモデルを継承するため、**model 指定を省略すると全 subagent が高位モデルで走る**。オフロード時は明示指定する。

## オフロード先の選択

Agent tool の `model` パラメータ / Workflow `agent()` の `opts.model` で、原則 1 tier 以上下を指定する:

| メインループ | 探索・定型実装・ドキュメント | 軽量スイープ・列挙 | 高難度の委譲（深いデバッグ・レビュー fan-out） |
| ------------ | ---------------------------- | ------------------ | ---------------------------------------------- |
| Fable        | sonnet                       | haiku              | opus                                           |
| Opus         | sonnet                       | haiku              | メインループで直接                             |
| Sonnet       | （対象外、必要なら haiku）   | haiku              | メインループで直接                             |

迷ったら sonnet。sonnet の結果が明らかに力不足だった場合のみ 1 tier 上げ直す（最初から高位モデルに逃げない）。

### 委譲先の決め方と記録（delegation CLI）

表の「探索・定型実装・ドキュメント」列の既定の委譲先は sonnet である。Codex と OpenCode には、`delegation route` が勧めたとき、または試す候補として挙げたときに渡す。

1. 委譲の前に `delegation route` を 1 回実行し、仕事の種類と規模を渡す（引数は `delegation --help`）。route は、その種類と規模での組ごとの採用率と件数を示し、推奨の委譲先を理由つきで返す。推奨に従う。route が 0 以外の終了コードで終わったら sonnet に渡す
   - 無料モデル（規則 0）と、記録で明らかに勝つ委譲先（規則 1）で推奨が決まらないとき、route は規則 2 で選ぶ。規則 2 は、記録で劣る委譲先と、5 時間枠が under でない provider を外す。週枠が exhausted・unknown・unmetered の provider も外す。残りから、週枠の遅れが最も大きい委譲先を勧める
   - 遅れは、週の経過の割合から使った割合を引いた値（pt）である。遅れの差が 5pt 以内なら、外部の委譲先を sonnet より先にする
   - 実績のない委譲先を勧めるときは、`失敗時:` の行に実績のある次点を示す
2. 推奨が `待機` なら委譲しない。行に出たリセット時刻を利用者に伝え、待つか、メインループで続けるかを利用者に決めてもらう
3. 委譲が失敗したら、route を引き直して次点へ 1 回だけ渡す。失敗は次の 3 つである。起動できない（入口の拒否、起動エラー）。結果を返さずに終わる（異常終了、時間切れ）。結果を採用しない（`delegation record` で redone か discarded にするもの）
   - レート制限か provider の拒否で失敗したら、`delegation route --exclude <provider>` で引き直す。たとえば Luna max が Codex に拒否されたら、`--exclude codex` を付ける。無料モデルの拒否では、opencode を丸ごと外さず、委譲先名で外す
   - それ以外の失敗では、失敗した委譲先名（`codex-luna-max`、`codex-terra` など）を `--exclude` に渡して引き直す
   - 最初の推奨に付いていた `失敗時:` の行は使わない。引き直す前の枠の状態で選んだ次点だからである
   - 引き直した `推奨:` に渡す。その推奨に `失敗時:` の行が付いていれば（実績のない推奨）、推奨の委譲先は起動せず、`失敗時:` の委譲先に渡す
   - 引き直した `推奨:` か、渡す先の `失敗時:` が `待機` なら、委譲せずに手順 2 に従う
   - 次点も失敗したら、メインループが自分で行う
   - 例外: 手順 4 の試す effort で起動して Codex が effort の値を拒んだら、`--exclude` も route の引き直しもしない。拒否されたのは effort の値で、委譲先ではないからである。同じ委譲先を、`推奨:` の行の起動コマンドで起動し直す。拒否された起動の行は `delegation lapse <id>` で閉じる。lapse の行は kind と size を持たないので、試す effort の件数に入らない。同じ作業のうちに、`destinations.ts` の `effortTrials` からその値を消す変更を、作業とは別の小さな PR で出す。PR が merge されて apply されるまでは、別のセッションが同じ値を試して拒否されうる。その費用は起動 1 回分と lapse 1 行なので受け入れる
4. 「試す候補」が示されたら、急がない小さな委譲をその候補に渡してよい。記録の少ない委譲先の評価を増やすための枠である
   - `試す effort:` の行が示されたら、その委譲に行の起動コマンドを使ってよい。起動コマンドは、推奨の委譲先の effort だけを下げたものである。今より低い effort の記録を集め、手順 7 で利用者が effort を下げるかを決めるための枠である
   - kind が review のときは、使う条件を次の 2 つとする。Document Workflow の round でその回に起動する reviewer が 2 名以上いること。`scope-justification-reviewer` がその中にいること。使うのはその 1 名にだけである
   - 前の round で pass して引き継がれた reviewer は数えない。reviewer が 1 名だけの review では、見落としを拾う人がいないので使わない
   - 依頼の `model:` は `推奨:` の行から、`effort:` は `試す effort:` の行から取る。残りの reviewer は `推奨:` の行の effort で起動する
5. 委譲が終わると、`delegation-budget` Mod が `[delegation]` で始まる 1 行で記録を促す。結果を確かめて採否を決めたら `delegation record` で記録する。メインループ自身の判断の誤りは委譲先の欠陥にせず、note に書く
6. 後から委譲の結果に欠陥が見つかったら、`delegation amend` で記録する
7. route か record が振り返りを促したら `delegation review` を読み、閾値と既知のモデル ID の一覧を変えるべきかを利用者に提案する
   - `effort の見直しの条件に当たる` の行は、今の effort と試した effort の記録がどちらも 5 件以上そろったことだけを示す。良し悪しは示さない。比べ方は cell の kind で分ける
   - kind が review の cell: review の記録は reviewer の役割を分けない。試す effort を使うのは `scope-justification-reviewer` だけなので、cell の数値は同じ reviewer どうしの比較にならない。そこで、試した effort の reviewer の出力を、同じ round に同じ文書を見た他の reviewer の出力と比べる。他の reviewer だけが挙げた指摘を落としていたら、その委譲の記録を `delegation amend` で patched にする
   - それ以外の kind の cell（impl×S など）: 比べる reviewer がいない。`delegation review` は同じ cell に、今の effort と試した effort の組の行を出す。その行の数値（adopted 率、委譲先の欠陥、所要時間）を比べる
   - 比べた結果、effort を下げてよいと判断したら、`destinations.ts` の effort を書き換える変更を利用者に提案する。route は effort を自動で選ばない

外部の委譲先への渡し方は次のとおり。どちらも commit はできないので、commit はメインループがする。

- **Codex の GPT-6.1 Terra と GPT-6 Luna（effort max）**: route の表示では `codex Terra` と `codex Luna max` と書かれる。推奨か試す候補の行の括弧内にある起動コマンド（`codex exec -m … -c model_reasoning_effort=…`）を、Bash でそのまま起動する。付け加えてよい引数は 2 通りだけである。書き込みを伴わない委譲には `-s read-only` を付ける。worktree で書く委譲には `-s workspace-write -C <worktree の絶対パス>` を付ける。Codex は起動した場所の git の最上位にだけ書けるので、`-C` で worktree を指す
  - `-C` に渡すパスは、起動の前に確かめる。旧置き場の基準は、`git rev-parse --git-common-dir` の `realpath`（メインのリポジトリの `.git`）に `/worktree/` を付けた文字列。
  - 新置き場の基準は、その `realpath` の親の basename を使った `$HOME/worktrees/<repo>/`。
  - `-C` に渡すパスの `realpath` に末尾の `/` を付けた文字列が、どちらかの基準で始まり、基準より長いときだけ起動する。symlink や `..` で書ける範囲が広がるのを防ぐためで、プログラムによる強制は無い
  - rescue（`codex:codex-rescue` の Agent か `/codex:rescue` skill）は、route に従う委譲には使わない。rescue 経由の委譲は記録にモデルと effort が残らないので、route の比較に入らない。モデルを付けなければ Codex の設定ファイルの既定モデルで動き、effort に max も渡せない。行き詰まったときに別の視点を求める使い方は残る
- **OpenCode の GLM-5.3 と Sarashina**: どちらも `delegation offload` から起動する。Claude Code の Bash から `opencode` を直接起動すると、hook が拒否する。拒否されないのは読み取りだけの `opencode --version`・`opencode models`・`opencode debug config|agents|paths` である。手順は次のとおり
  1. brief を、作業ツリーの外（`mktemp -d` が出力したディレクトリ）にファイルで書く。自分が所有する通常のファイルにする。symlink は拒否される。秘密に見える文字列と、添付に見える `@` も拒否される
     入口は、秘密を含みうるファイル（`.env`、鍵、credentials など）がある作業ツリーも拒否する。委譲は `git-worktree-create` で作った worktree から行う
  2. `delegation offload --exposure external-ok --model <model> --brief-file <brief の絶対パス>` を Bash で起動する。作業ツリーを指すときは `--dir <絶対パス>` を、plan を渡すときは `--plan <絶対パス>` を足す。GLM-5.3 の model は `zai-coding-plan/glm-5.3` である。Sarashina の model は `sarashina/sarashina3.2-mini-thinking` である。`--dir` を省くと cwd が起動ディレクトリになる。起動ディレクトリは git の作業ツリーの最上位でなければならない。書き込ませるときだけ `--write` を付ける
  3. 入口が起動を拒否すると、終了コード 1 で理由が stderr に出る。opencode の設定と保存済み認証を確かめた記録（`verified.json`）がまだ無いうちは、どの委譲も拒否される
  4. `--write` を付けた委譲が終わると、変わったファイルのパスが stderr に出る。メインループが差分を全部読んでから、テストや hook を起動する
  - GLM-5.3 は、route の推奨か試す候補として出たら使う。route が使う ai-usage は `opencode` を起動せずに Z.ai の API を呼ぶので、CLI が無くても枠の状態は取れる
  - Sarashina は、route の推奨か試す候補に出たときだけ使う。出るのは規模 S の委譲で、route を起動した場所のリポジトリが github.com の公開リポジトリのときに限る。鍵は `opencode auth login` で保存しておく（opencode.db に入る）。環境変数の `SARASHINA_API_KEY` は読まれない。brief に入れてよいのは、push 済みの tracked ファイルと公開の情報だけである。`.tmp/`、`.env`、未 commit の差分、他のリポジトリと会話の非公開の内容は入れない。入力は学習に使われうる。route が判定するのは起動した場所のリポジトリだけなので、brief の中身はメインループが絞る

#### 外部へ送ってよいかの判断

OpenCode への委譲では、brief に加えて、agent が起動ディレクトリで読める範囲の全体が提供側へ送られる。未 push の差分と未追跡のファイルも含む。送った内容は提供側に学習され、保持されるものとして判断する。

Document Workflow の外で `--exposure external-ok` を渡してよいのは、送られる範囲の全体と brief が、公開済みか公開してよいものだけのときである。範囲は次の 3 段で判断する。

| 段       | 例                                               | 送ってよいか |
| -------- | ------------------------------------------------ | ------------ |
| 公開済み | push 済みの公開リポジトリの tracked ファイル     | よい         |
| 公開予定 | 公開リポジトリでこれから push する差分           | よい         |
| 非公開   | private リポジトリ、他人のリポジトリ、顧客の作業 | よくない     |
| 非公開   | `.tmp/`、記憶と学び、`.env`                      | よくない     |

brief は、承認された Task の本文と、作業ツリーの中の内容だけで組む。research.md、ほかの workflow dir の文書、記憶と学び、`.env` の値は貼らない。これは規約で、仕組みでは防げない。

Document Workflow では、承認済み plan-N の Task の `**外部送信**:` 行を見る。
その値が `可` のときだけ、`--exposure external-ok` を渡せる。
値はその行だけから読み、「ただし Task 2 は可」のような別の行や文は許可として扱わない。
`可` の Task を含む plan-N は委任で通らず、人間の承認が要る。
送る範囲を公開済み・公開予定・非公開のどの段とするかは、Document Workflow の外と同じ表で判断する。

委譲先の agent は、シェルと grep を使えない。テストの実行と、ファイルをまたぐ検索はメインループが行う。戻ってきた出力と差分は信頼できない入力として扱う。メインループが差分を読んでから、テストや hook を起動する。

複数の委譲を並行実行するときは、Bash の `run_in_background` で個別に起動する。単一シェルの `&` と `wait` では、UI に実行数と個別の完了通知が出ない。進捗は各ジョブが書く完了マーカーで数える。`pgrep` は子シェルや起動用プロセスも数えるため使わない。

## メインループに残すもの — オフロード禁止

- 設計判断、Document Workflow 成果物（spec/plan）の作成・改訂の判断
- ユーザー意図の解釈、intent alignment triage、最終レスポンスの統合
- 会話コンテキスト全体を前提とする判断（subagent には会話履歴が渡らない）
- **生素材そのものに高位モデルの判断が必要な作業**（微妙な文書解釈・設計の匂いの検知など）。安い reader は「何が重要か」の判断ごと要約で落とすリスクがある
- subagent 結果の採否判断（結果を鵜呑みにせず整合確認してから採用する）

## オフロードが割に合わないケース

- **狭いタスク**: 読む量が少なければ裁定する差額がない。1-2 ファイルの確認はメインループで直接読む
- **brief の割りすぎ**: 委譲には thread ごとの固定床コストがある。同じ作業をより細かい brief に割ると逆に高くなる。粒度には最適点があり、独立したサブ質問 1 つにつき worker 1 つが目安
- **委譲したのに自分でも読む**: 委譲後にメインループが同じ探索をなぞるのは二重払い。委譲したら結果を待つ

## 運用ルール

- 大量の結果はファイルへ出力させ、メインループは形式と網羅性を検査した集計を読む。採否や行き先などの判断は下書きとして受け取り、メインループが確かめる。
- 文書の追記を委譲する brief には、目標量と読者が理解できる文の基準に加え、既存文を変更してよい範囲を書く。完了後は変更ファイルの範囲と削除行を別々に確認する。
- 担当は変更ファイルと依存順で分け、共通の入出力と期待値、禁止事項の理由を渡す。計画と実物が食い違えば止めて報告させ、承認済みの設計からのずれを防ぐ。
- 前段の成果を検証してから後段を渡す。途中の検査失敗に競合編集を加えず、完了後は結果を検証する。

- 3+ ファイルの読み込みが必要な調査は原則 subagent 化する（コンテキスト温存とコスト削減の両取り）
- 独立サブタスクは単一メッセージで並列 subagent 起動する
- Document Workflow の reviewer は、round ごとに `delegation route --kind review` を引き、推奨が codex のときに Codex で実行する（`document-workflow-operator` の共通フロー 5）。手順は `/document-workflow-reference` の「reviewer を Codex で実行する」にある。依頼の `model:` と `effort:` には、`delegation route --kind review` の推奨行の括弧内にある `-m` と `model_reasoning_effort=` の値だけを書く（括弧内のコマンドそのものは起動しない）。Codex で実行した reviewer の結果を確かめたら、reviewer ごとに pending の行を選んで `delegation record <id> --kind review` で記録する。行の選び方は同じ節にある
- **plan に無い判断は報告させる**: plan はコードの本体を持たないので、実装を委譲すると worker が小さな判断を自分で下す。委譲する brief には、plan に無い判断をしたら結果の報告に列挙するよう書き、メインループが採否を決める
- **問い分解の前提も検証対象**: worker は渡された brief しか検証しない。分解の前提（対象リスト・仮定）が結果を左右するなら、前提確認にもう 1 委譲を使う
- agent 定義（`~/.claude/agents/*.md`）の frontmatter に `model` がある場合はそれを尊重し、上書きは明確な理由がある場合のみ
- Workflow 内では機械的ステージに `effort: 'low'` + 下位モデル、verify/judge ステージのみ上位モデル、とステージ単位で使い分ける

## 実装着手ゲート（オフロード宣言、2026-07-09 追加）

Document Workflow の plan 承認後、**最初の実装書き込みの前に**、メインループはオフロード判定を 1 行で宣言してから着手する:

```
オフロード判定: メインループ=<model>。<タスク範囲> は <sonnet|haiku|メインループ直接> で実行 — <根拠 1 行>
```

- 適用条件はメインループが Opus 以上（本 skill の適用条件と同じ）。宣言なしに 3 タスク以上の定型実装をメインループが直接実行することは規約違反
- plan-N.md で契約・不変条件・テストケース（入力 → 期待）が確定している実装は、判断の余地が plan 側で消化済みのため**原則オフロード対象**。「メインループ直接」を選べるのは 1-2 ファイルの軽微変更か、plan にない設計判断が実装中に必要と事前に分かっている場合のみ
- ゲートをここ（skill 本文）だけでなく `document-workflow-operator` 共通フロー step 8 にも張ってある — 規約がセッション冒頭の読み込みから注意の外に落ちても、実装着手時に参照する workflow 手順側から引き戻すため

## 届く経路

`delegation offload` と `codex exec` の前は、この skill が未読なら hook が止めて読むよう求める。`model` を省いた Agent の起動の後にも、hook が 1 行で案内する。
