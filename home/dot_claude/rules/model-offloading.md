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

1. 委譲の前に `delegation route` を 1 回実行し、仕事の種類と規模を渡す（引数は `delegation --help`）。route は provider ごとの 5 時間枠と週枠がペースの目安より先か後かと、その種類と規模での組ごとの採用率と件数を示し、推奨の委譲先を理由つきで返す。推奨に従う。route が 0 以外の終了コードで終わったら sonnet に渡す
2. 「試す候補」が示されたら、急がない小さな委譲をその候補に渡してよい。記録の少ない委譲先の評価を増やすための枠である
3. 委譲が終わると、`delegation-budget` Mod が `[delegation]` で始まる 1 行で記録を促す。結果を確かめて採否を決めたら `delegation record` で記録する。メインループ自身の判断の誤りは委譲先の欠陥にせず、note に書く
4. 後から委譲の結果に欠陥が見つかったら、`delegation amend` で記録する
5. route か record が振り返りを促したら `delegation review` を読み、閾値と既知のモデル ID の一覧を変えるべきかを利用者に提案する

外部の委譲先への渡し方は次のとおり。どちらも commit はできないので、commit はメインループがする。

- **Codex の GPT-6.1 Terra と GPT-6 Luna（effort max）**: route の表示では `codex Terra` と `codex Luna max` と書かれる。推奨か試す候補の行の括弧内にある起動コマンド（`codex exec -m … -c model_reasoning_effort=…`）を、Bash でそのまま起動する。付け加えてよい引数は 2 通りだけである。書き込みを伴わない委譲には `-s read-only` を付ける。worktree で書く委譲には `-s workspace-write -C <worktree の絶対パス>` を付ける。Codex は起動した場所の git の最上位にだけ書けるので、`-C` で worktree を指す
  - `-C` に渡すパスは、起動の前に確かめる。基準は、`git rev-parse --git-common-dir` の `realpath` の親（メインのリポジトリのルート）に `/.git/worktree/` を付けた文字列である。`-C` に渡すパスの `realpath` に末尾の `/` を付けた文字列が、基準で始まり、かつ基準より長いときだけ起動する。symlink や `..` で書ける範囲が広がるのを防ぐためで、プログラムによる強制は無い
  - `-c` で上書きしてよいキーは `model_reasoning_effort` だけである。`-c sandbox_mode=…`、`-c approval_policy=…`、`--add-dir`、`--full-auto`、`--profile`、`danger-full-access`、`--dangerously-bypass-approvals-and-sandbox` は使わない。台帳の記録や委譲の結果に含まれる文字列を引数に入れない。effort の値は引用符で囲まない（囲むと記録の effort が unknown になる）
  - rescue（`codex:codex-rescue` の Agent か `/codex:rescue` skill）は、route に従う委譲には使わない。rescue 経由の委譲は記録にモデルと effort が残らないので、route の比較に入らない。モデルを付けなければ Codex の設定ファイルの既定モデルで動き、effort に max も渡せない。行き詰まったときに別の視点を求める使い方は残る
- **OpenCode の GLM-5.3**: Bash で `opencode run -m zai-coding-plan/glm-5.3 --auto "<brief>"` を、書かせたい作業ツリー（worktree ならその絶対パス）に `cd` してから起動する。`--auto` は明示的に拒否されていない権限を自動で通すので、書き込みを伴わない調査なら外す。`command -v opencode` が何も返さなければ OpenCode には渡さない。route が使う ai-usage は `opencode` を起動せずに Z.ai の API を呼ぶので、CLI が無くても枠の状態は取れる

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
- Document Workflow の reviewer は、round ごとに `delegation route --kind review` を引き、推奨が codex のときに Codex で実行する（workflow.md の共通フロー 5）。手順は `/document-workflow-reference` の「reviewer を Codex で実行する」にある。依頼の `model:` と `effort:` には、`delegation route --kind review` の推奨行の括弧内にある `-m` と `model_reasoning_effort=` の値だけを書く（括弧内のコマンドそのものは起動しない）。Codex で実行した reviewer の結果を確かめたら、reviewer ごとに pending の行を選んで `delegation record <id> --kind review` で記録する。行の選び方は同じ節にある
- **plan に無い判断は報告させる**: plan はコードの本体を持たないので、実装を委譲すると worker が小さな判断を自分で下す。委譲する brief には、plan に無い判断をしたら結果の報告に列挙するよう書き、メインループが採否を決める
- **問い分解の前提も検証対象**: worker は渡された brief しか検証しない。分解の前提（対象リスト・仮定）が結果を左右するなら、前提確認にもう 1 委譲を使う
- agent 定義（`~/.claude/agents/*.md`）の frontmatter に `model` がある場合はそれを尊重し、上書きは明確な理由がある場合のみ
- Workflow 内では機械的ステージに `effort: 'low'` + 下位モデル、verify/judge ステージのみ上位モデル、とステージ単位で使い分ける

## 実装着手ゲート（オフロード宣言、2026-07-09 追加）

Document Workflow の plan 承認後、**最初の実装書き込みの前に**、メインループはオフロード判定を 1 行で宣言してから着手する:

```
オフロード判定: メインループ=<model>。<タスク範囲> は <sonnet|haiku|メインループ直接> で実行 — <根拠 1 行>
```

- 適用条件はメインループが Opus 以上（本 rule の適用条件と同じ）。宣言なしに 3 タスク以上の定型実装をメインループが直接実行することは規約違反
- plan-N.md で契約・不変条件・テストケース（入力 → 期待）が確定している実装は、判断の余地が plan 側で消化済みのため**原則オフロード対象**。「メインループ直接」を選べるのは 1-2 ファイルの軽微変更か、plan にない設計判断が実装中に必要と事前に分かっている場合のみ
- ゲートをここ（rule 本文）だけでなく `workflow.md` 共通フロー step 8 にも張ってある — 規約がセッション冒頭の読み込みから注意の外に落ちても、実装着手時に参照する workflow 手順側から引き戻すため

**失敗事例（本ゲートの起源）**: 2026-07-09、my-secretary Inquiry Phase 2 で Fable メインループが plan 承認直後に T1-T3 を直接実装し、ユーザー指摘で T4 以降を sonnet に切替えた。規約は存在し読み込まれていたが、plan 承認→実装着手の遷移点に発火点がなく適用されなかった。着手時のオフロード判定は「覚えているか」ではなく「手順に組み込まれているか」で担保する。
