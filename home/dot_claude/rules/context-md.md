# CONTEXT.md Rules

per-project ドメイン語彙を AI が事前読込できる単一エントリ機構の仕様 SSoT。

## 目的

- 各プロジェクトの新規概念・用語・cardinality・ステータス遷移を AI が session 開始時に取得し、毎回 grep / 質問で再構築する負荷を減らす
- プロジェクトのファイル構造に侵入せず、`.tmp/` gitignore 配下で完結させる
- aihero.dev grill-with-docs 思想 (Socratic 質問で語彙を確定する) を将来のスキルとして接続する基盤を提供する

## 配置

- ルート: `${projectRoot}/.tmp/docs/CONTEXT.md` (固定)
- 既存 `.tmp/` gitignore と `home/dot_claude/rules/developer-experience.md` の WIP docs 規約に乗る (新規 gitignore ルールを各プロジェクトに要求しない)
- GC 対象外: `home/dot_claude/rules/workflow.md` Session Artifact Retention 節「`.tmp/docs/` は永続扱い」を参照。GC スクリプト (`home/.chezmoiscripts/run_after_gc.sh.tmpl`) は `.tmp/sessions/` の path-prefix のみを対象とする SAFE pattern

## 構造 (3 区分)

CONTEXT.md は以下の 3 区分で構成する。template (`home/dot_claude/templates/context.md.tmpl`) がこの構造を提供する。

1. **Authoritative references** — `@path` で project-side SSoT (`docs/decisions/`, `CONTRIBUTING.md`, `README.md` 等) を index する。各エントリは 1 行要約のみ (要約と本体の drift を最小化、本体は SSoT として参照側を保つ)
2. **Personal observations** — 個人理解をインライン記述する。grill で得た語彙定義、ステータス遷移、暗黙ルール、自分の暫定理解等。チーム合意化したい内容は `docs/` 配下や ADR へ昇格する
3. **Open questions** — チーム確認用 TODO。確認後は Authoritative references (合意済の場合) または Personal observations (自分の解釈の場合) に移動する

## 参照解決規約 (`@path`)

- **syntax は CLAUDE.md の `@~/.claude/rules/*.md` 自動ロードと見た目同型**: `@` プレフィックス + path 表記
- **解決メカニズムは異なる**:
  - CLAUDE.md 内の `@path` は Claude Code が読み込み時に自動展開する system 機構
  - CONTEXT.md 内の `@path` は system 機構の対象外。「人間と AI が共有する表記規約」として AI は session 開始時に CONTEXT.md を Read した後、必要時に明示的に該当 path を Read する
- **path 種別**: `${projectRoot}` 相対 (例: `@docs/decisions/0001-foo.md`) を基本とする。home 相対 (`@~/`) は機密引き込みリスクのため非推奨

## degraded mode

- **CONTEXT.md 不在時**: 事前読込せず、Document Workflow と他機能は通常動作。AI 指示文 (CLAUDE.md の Per-Project Context セクション) で「ファイルが存在すれば読む、なければ無視」と明示する
- **MVP 段階の同値性**: 本 MVP では grill skill (Socratic 質問発火) が未実装のため、CONTEXT.md 不在時の degraded mode と grill 未実装の常時状態は事実上同値。grill skill が subsequent ADR で実装された段階で初めて挙動差 (grill 発火 vs 発火しない) が観測可能になる

## grill 発火条件 (将来の skill 実装前提)

将来 `/grill` skill を実装する際、以下のいずれかが成立した場合のみ発火する設計とする (本 rule で予約):

- 新規ドメイン概念がオーダーに含まれる (例: 新機能の名前空間、新しい entity タイプ)
- 既存用語と衝突する用語がオーダーに含まれる (例: 既存「Order」と新規「Order」が別物として登場)
- ユーザーが多義語を意識せず使用 (例: 「セッション」がブラウザセッション / Claude セッション / ユーザーセッションのいずれを指すか不明瞭)

**非該当 (発火させない)**:

- bug fix / rename / mechanical refactor (決定論的変換、新規概念導入なし)
- 設定変更 / 依存追加 (ドメイン語彙が動かない)
- 既存概念への小規模追加 (語彙は安定)
- mechanical-lane criteria 全 4 条件 AND 成立タスク (`workflow.md` mechanical-lane 参照)

## Canonical location (solo projects)

solo project (team-shared / OSS / client work でない、自分のリポジトリ) では personal / team-shared の区別が collapse するため、canonical CONTEXT.md を root or `docs/` に置く運用パターンが有効。デフォルトの Read 経路 (`.tmp/docs/CONTEXT.md`) を保ちつつ canonical を symlink ターゲットにすることで:

- LLM コストゼロ (1 ファイル Read で symlink 解決、二重 Read 不要)
- commit による drift 追跡 (canonical は git 履歴で「常に最新」が保証される)
- 別環境 clone 時の復旧性 (symlink 消失しても canonical が残り、再 symlink で復旧可能)

### Discovery + Suggestion (session 開始時)

AI は session 開始時に以下の検出ロジックを実行する:

1. `.tmp/docs/CONTEXT.md` 存在 → Read (通常経路)
2. `.tmp/docs/CONTEXT.md` 不在 + `./CONTEXT.md` 存在 → symlink 提案 (`ln -s ../../CONTEXT.md .tmp/docs/CONTEXT.md`)
3. `.tmp/docs/CONTEXT.md` 不在 + `./docs/CONTEXT.md` 存在 → symlink 提案 (`ln -s ../../docs/CONTEXT.md .tmp/docs/CONTEXT.md`)
4. いずれも不在 → degraded mode (本機構の機能オフ、Document Workflow と他機能は通常動作)

AI による symlink 自動作成はしない (人間判断を保留する)。canonical を直接 Read 対象にしないことで、他プロジェクト (team / OSS / client) で適用された際の非侵入性を維持する。

### dog-food 事例

本 dotfiles リポジトリ自体がこのパターンの最初の利用者 (eat-your-own-dog-food)。root `CONTEXT.md` が canonical、`.tmp/docs/CONTEXT.md` が `../../CONTEXT.md` への symlink。詳細は `docs/decisions/0010-context-md-mechanism.md` の Consequences 節および本リポジトリ root の `CONTEXT.md` を参照。

## template

- **場所**: `home/dot_claude/templates/context.md.tmpl` (デプロイ先は `~/.claude/templates/context.md`、chezmoi が `.tmpl` を strip)
- **初期化**: 開発者が必要なプロジェクトで手動コピーする。自動生成しない (不要プロジェクトへの増殖を回避)
- **template ヘッダ規約**:
  - commit 禁止: 個人スコープのため `.tmp/` gitignore + template ヘッダ注意書きで二重防御
  - 機密 path 非参照: `@.env*`, `@secrets/`, `@~/.ssh/` 等は CONTEXT.md に書かない (AI が follow して機密を context に取り込むリスク回避)
  - 要約 1 行最小: Authoritative references の要約は 1 行に絞る (本体との drift surface を最小化)

## 関連 ADR

- `docs/decisions/0010-context-md-mechanism.md`: 本機構の判断記録、Defer to subsequent ADR 節で grill skill / context-audit / session-start hook / allowlist 規約 / `.tmpl` 規約棚卸しを列挙
