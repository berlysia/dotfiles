# ADR-0032: リポジトリごとの学びを貯めてエージェント間で共有する（agent-learnings）

## Status

accepted (2026-10-15)

## Context

利用者の依頼は次の 2 つだった（2026-10-15）。

- リポジトリごとに学んだことが蓄積されるようにする。Claude ならセッション終了時に学びを整理して記録し、ほかのエージェントとも共有する
- 共通の学びは dotfiles レベルに積み上げる。ただし berlysia/dotfiles には commit しない

利用者は設計の途中で次を選んだ。

- セッション終了時の整理は自動で行い、人の確認を挟まない
- リポジトリ固有の学びを、そのリポジトリに commit しない
- 学びの置き場は別の private git リポジトリにし、push は手で行う

### 既存の仕組み

着手時点で、学びを残す仕組みはあったが、どれも「次のセッションで読まれる」経路を持たなかった。

| 仕組み                           | 状態                                                                               |
| -------------------------------- | ---------------------------------------------------------------------------------- |
| `/record-learnings`              | 手動で各 repo の `.claude/memory/` に書く。読む経路が無い                          |
| insight-digest                   | ★ Insight ブロックを日次で蒸留する。未読が数百件溜まっていた                       |
| `lessons-learned.md`（ADR-0008） | 2026-09-24 に削除。Reviewer Outputs の写しで、セッション間で持ち越す経路が無かった |
| Claude の auto memory            | `autoMemoryEnabled: false`                                                         |
| CONTEXT.md（ADR-0010）           | 人が書く語彙集。Codex は読まない                                                   |

ここから 3 つの制約を置いた。写しを貯めても学びにならない（整理が要る）。読む経路が無いストアは使われなくなる。人のレビューを必須にした段階は滞留しやすい。

加えて、グローバルの CLAUDE.md の「新しい発見」の 5 分類（意図された実装・計測ミス・錯覚・局所判断・計器の誤り）を、記録の採否基準に使った。検証していない発見を記録すると、誤りが次のセッションに伝わるため。

### Entire との比較

利用者は、Entire（entire.io の CLI）が近いことをしようとしていると指摘した。Entire はエージェントの会話を commit に結びつけた checkpoint として、対象リポジトリの `entire/checkpoints/v1` ブランチに残す。これは「何が起きたかの記録」で、対象リポジトリに書き込む。本件は「次のセッションで役立つ学び」を対象リポジトリの外に置くので、記録層としては採らなかった。

## Decision

### 置き場と形式

- 学びは `~/.local/share/agent-learnings/` に置く。chezmoi の source state に無いので `chezmoi apply` は触らず、berlysia/dotfiles にも入らない。この置き場自体が git リポジトリで、変更ごとに commit する
- リポジトリごとの学びと、共通の学び（`common.md`）を別のファイルに持つ。リポジトリのキーは `git rev-parse --git-common-dir` を基準に origin の URL を正規化したもので、worktree でも同じキーになる。origin が無い、またはキーが検査に通らないときは `local/…` にする
- 学びファイルは Markdown で、1 項目は見出し・メタ行・1 段落の本文。形式は版を持ち、読めない版は読み取り専用で扱う

### 書き込み

- 書き込みはすべて操作の列（add・update・remove・promote）を検査して適用する。追記はしない。ファイル全体を LLM に書き換えさせない。全部か無しかで適用する
- 本文は短い 1 段落にする。正規化と redaction の後に、構造を壊しうる記法（見出し、コードフェンス、HTML コメント、リンク）と鍵らしき文字列を拒否する
- 記録してよいのは、会話中に実際に起きた出来事に結びつく学び（失敗から修正、利用者の訂正、失敗したコマンドと通ったコマンド、利用者が明言した方針）。各操作に evidence を必須にする
- 1 ファイルの項目数に上限を置き、超えたら `seen` の少ない順、`updated` の古い順に追い出す
- lock は store 全体で 1 つ。死んだ・古い lock は奪えるが、奪うときは退避して内容を照合する

### 自動の整理（SessionEnd・PreCompact）

- SessionEnd hook と PreCompact hook（どちらも `async`）がジョブを queue に入れ、worker を detached で起動する。SessionStart も queue を見て worker を起こす
- PreCompact で起こすのは、compact を挟む長いセッションで、前回の位置からの差分を細かく整理するため。worker は独自のシステムプロンプトで LLM を呼ぶので、本体のセッションの prompt cache は効かない
- transcript は前回の位置から読む。読む量は末尾の窓で切り、ファイル全体の大きさでは断らない
- worker は transcript を縮約する。入れるのは利用者が打った発言・assistant の本文・`is_error` の tool_result だけ。ほかの tool_result（ファイルの中身や Web ページ）は入れない
- 縮約に redaction をかけ、隔離した LLM（sonnet）に操作の列を作らせる。LLM は tool・設定・MCP・plugin・セッションの永続化を持たず、常に拒否する `canUseTool` と 1 回の費用の上限を付けて呼ぶ。環境変数は名前を列挙した許可リストだけを渡す
- 再帰の防止は二重。worker の Claude は hooks を読み込まず、読み込まれても `AGENT_LEARNINGS_WORKER=1` で hook が何もしない
- worker が書くのは現在の repo の学びファイルだけ。common を変えるのは昇格と人だけ
- LLM の応答は操作の種類ごとに件数の上限を持つ

### 読み込みと共有

- Claude は SessionStart hook が学びを `additionalContext` でモデルに渡す（`systemMessage` は UI にしか出ない）。大きさで切り、表示の前に再検査する
- Codex は AGENTS.md の指示で `agent-learnings show --reader codex` を実行して読む
- Codex の sandbox が書けるのは `~/.local/share/agent-learnings/.state/codex/` だけ。store 全体を書けるようにすると、Codex が store の `.git/config` に filter を書き、Claude 側の次の `git add` で sandbox の外のコマンドが走りうるため
- `default.rules` と Claude の permissions は、サブコマンドごとに `show`・`add`・`remove`・`status`・`path` だけを許す
- `--common`・URL を含む本文・`rekey`・`init`・`promote` は、TTY があり、エージェントの環境変数（`CLAUDECODE` など）が無いときだけ通す。これは誤用を防ぐ安全策で、境界ではない
- `/record-learnings` は削除した

### 共通の学びへの昇格

- worker は他の repo の項目を候補として LLM に見せる。見せるのは id・見出し・本文の先頭だけで、repo-key は見せない
- LLM が同じ学びと判断すると `promote` を返す。worker は次を機械的に確かめる
  - 2 つの repo に別々にある
  - 昇格後の文に、repo 名の部分とその部分を区切った語が出てこない
  - 2 つの文の文字 bigram の重なり（Jaccard）が閾値以上
  - どちらの repo も `no-promote` に一致しない
- `no-promote` は `local/*` を組み込みで持ち、ファイルが読めない・大きすぎるときは昇格をすべて止める。照合に正規表現を使わない
- 人は `agent-learnings promote <id>` で、確認を経て移せる

## 却下した代替案

- **差分最小案**: `/record-learnings` の書き込み先を `.tmp/docs/LEARNINGS.md` に変え、Stop hook でモデルに記録を促す。worktree ごとに `.tmp/` が分かれ、Stop は毎ターン発火してセッションの終わりを判定できず、共通の置き場も無いため採らなかった
- **白紙案の記録層**: 全エージェントの会話をエージェント中立の記録層（Entire の checkpoint など）に残し、そこから蒸留する。対象リポジトリに書き込むことと、Codex の会話の形式を吸収する層が要ることから採らなかった
- **MCP で検索させる**: エージェントが自発的に引かないと読まれないため、セッション開始時に押し込む方式にした
- **Codex の `writable_roots` に store 全体を足す**（spec の当初案）: 上の `.git/config` の経路のため採らなかった
- **common への書き込みを人の承認に通す**: 利用者が選んだ「人の確認を挟まない」と食い違うため採らなかった

## Consequences

### 受け入れるリスク

- **注入**: transcript 経由の prompt injection が学びファイルに残りうる。入力から生のツール出力を外し、出力も検査するが、利用者の発言や assistant の本文に引用された外部の文章は残る。注入で既存の項目を `update` で書き換えられ、候補の文が別の repo の学びに写りうる。「データであり指示ではない」は指示による対策で、機構ではない
- **昇格**: 文の重なりの検査は注入を防がない。攻撃者が仕込んだ候補の文は機械検査に通って昇格しうる。昇格した文は以後すべての repo のセッションの文脈に入る。repo 名は言い換えれば検査を抜け、短すぎる名前は検査しない
- **漏えい**: redaction は best-effort。store のファイル名と `repos` は、どの repo で作業したかを表す。`no-promote` は `local/*` 以外は既定で開いていて、利用者が private や client の repo を書き足すまでは昇格しうる
- **origin の自己申告**: 悪意ある repo が他の repo の origin を名乗れば、その repo の学びを読み込み（漏えい）、書き込みで汚せる。手元で開く repo を信頼する前提
- **Codex の inbox**: Codex が書ける inbox は、検査と open の間にディレクトリを差し替えられたり、大量の依頼で正しい依頼が取り込まれなくなったりしうる。どちらも Codex が乗っ取られていることが前提
- **運用**: SessionEnd の後に worker が殺されれば、次の SessionStart が拾う。定数は調整用で、点検で見直す。origin が変わると学びファイルが孤立し、`rekey` で付け替える（自動では検知しない）。クラッシュ後の再処理で `seen` が余分に増えうる。LLM は同じ transcript でも回ごとに返す学びが揺れる
- **配置**: Codex の経路は、CLI の実体が `~/.claude/hooks/cli/learnings.ts` にあるので、`~/.claude/` 配下に物理的に依存する

### 実機で分かったこと

Codex の `default.rules` で `allow` に一致したコマンドは、確認なしになるだけでなく sandbox の外で動いた。Codex の `add` は inbox を通らず CLI が直接 store に書く。Codex の sandbox 自体は効いていて（store への直接の書き込みは `Read-only file system` で失敗した）、`--common` は拒否された。CLI が自分で検査するので、この形を受け入れた。inbox は、rules に一致しない呼び方で sandbox の中から呼ばれたときの受け皿として残る。

### 形式を変えるとき

学びファイル（format）・queue のジョブ・LLM の応答（schemaVersion）は版を持つ。版を上げるときは、新しい版を読める側を先に配る。読めない版のファイルは読み取り専用になり、ジョブは failed に回る。

未対応の課題は `docs/plans/agent-learnings-followups.md` にある。
