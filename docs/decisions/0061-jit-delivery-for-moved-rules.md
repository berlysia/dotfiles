# ADR-0061: 移した規則は、場面の前の deny と場面の後の 1 行で知らせる

## Status

accepted (2026-10-30)

ADR-0026 の D1 に、MOVE（規則の文を skill などへ移す）の知らせ方を 3 つ加える。

## Context

毎セッション読み込む指示は、CLAUDE.md 2 本と rules 9 本である。多くの規則は、特定の場面（commit の前、委譲の前、Bash の失敗の後など）でしか使わない。こうした規則を skill へ移し、場面が来たときに読ませれば、常に読み込む量を減らせる。

ADR-0026 の D1 は、規則を削る根拠に「規則が当てはまる時点か直前に、hook・CLI の出力が同じ指示をモデルに知らせること」を求める。移した先の skill は、読まれなければ知らせにならない。そのため、場面の時点で skill を読ませる仕組みが要る。

2026-10-30 に Claude Code 2.1.314 で、各出口がモデルに着くかを使い捨ての repo で 2 回確かめた（plan-1 T2）。

- rule の `paths:` は、subagent の Read・Write・Edit でも、その subagent の transcript に本文が入る
- PreToolUse の deny の理由、PostToolUse と PostToolUseFailure の `additionalContext` は、メインでも subagent でも着く
- SessionStart の `additionalContext` は着く
- Stop の `additionalContext` は着く。ただし返すたびに次のターンが起きる。毎回返すと 15 回近く続き、1 回だけ返すとターンが 1 回増えて止まった
- subagent の操作で hook に渡る `transcript_path` は親の transcript である。親が読んだ skill の行がそこにあるので、subagent が読んだかどうかは判定できない

PreToolUse の `additionalContext` は、モデルが操作の後に読む（ADR-0044 の Context）。

## Decision

### 知らせ方

- **K1: MOVE の知らせ方に 3 つを加える。** rule の `paths:`、操作の前の deny（誘導（前））、場面の後の `additionalContext` の 1 行（誘導（後））である。どれも ADR-0026 D1 (a) の「当てはまる時点か直前」を満たす
- **K2: PreToolUse の `additionalContext` は、操作の前に要る内容の知らせ方として扱わない。** モデルが読むのは操作の後だからである
- **K3: 安全の床は常に読み込むファイルに残し、skill へ写さない。** 誘導は読むよう促すだけで、モデルは読まずに進める。床に入るのは、秘密と公開記録、外部送信の判断、Delivery Policy の Never の一覧、Codex の起動の制限、内容をデータとして扱うこと、chezmoi apply の確認、テストの子プロセスの隔離、Shell State である。移した skill に床の語が無いことは unit test で確かめる

### 誘導（前）: skill-guide-gate

- **K4: 止める skill は、lib の定数の一覧（`commit-standards`、`git-safety`、`model-offloading`）にあるものだけにする。** 宣言は各 SKILL.md の frontmatter の `read-before` に書く。APM などで入る第三者の skill の宣言は読み飛ばす。deny の理由で第三者の SKILL.md を読むよう誘導しないためである
- **K5: 「読んだ」は、Skill の読み込みの行か、SKILL.md の Read の tool_use で判定する。** Skill の行は、base directory を `realpath` でそろえた値が `~/.claude/skills/<skill>` と完全に一致するものだけを読んだとみなす。同じ名前の skill を別の置き場所から読んでも、中身が配布された版と同じとは限らないためである
- **K6: 止めるのは、セッションと skill の組ごとに 2 回までにする。** 回数は出した deny の数で、deny の前に目印を排他で作って数える。3 回目は通し、`decisions.jsonl` に `ignored` を 1 行書く。上限 2 回は仮の値で、plan-4 で transcript を走査して決め直す
- **K7: subagent では判定しない。** hook の入力に `agent_id` があれば何も出さずに通す。`transcript_path` が親のものなので、親が読んだ skill で subagent も読んだと判定されてしまう

### 誘導（後）: skill-guide-after

- **K8: 場面と skill の組を次の 5 つにする。** 各組はセッションごとに 1 回だけ出し、未読の skill にだけ出す
  - Bash の失敗（PostToolUseFailure）の後: debugging
  - reviewer の Agent の後: defect-triage
  - `model` を省いた Agent の後: model-offloading
  - Stop で、未 commit の変更か未 push の commit があるとき: delivery-policy
  - SessionStart で、CONTEXT.md があるとき: context-md
- **K9: Stop では `stop_hook_active` が真なら何も出さない。** 1 回の目印と合わせて、増えるターンを 1 回に抑える
- **K10: upstream の無いブランチは、どの remote-tracking ref にも含まれない commit があるかで未 push を判定する。** 作ったばかりの作業ブランチには `git status` の `branch.ab` 行が無いためである

### 共通

- **K11: 2 つの hook は 1 回の呼び出しで 1,700 ms の期限を共有する。** stdin の読み取り、transcript の走査、各 git の呼び出しはこの期限の残りで打ち切る。全体に 2,000 ms の watchdog を置き、settings の `"timeout": 5` を最後の網にする。どの失敗でも終了コード 0 で通す
- **K12: 判定を状態の dir の `decisions.jsonl` に 1 行ずつ追記する。** 1 MB を超えたら `decisions.<時刻>-<連番>.jsonl` へ押し出し、最新は常に `decisions.jsonl` にする。押し出し先は上書きも削除もしない。lock はしない

## 却下した代替案

- **PreToolUse の `additionalContext` で操作の前に知らせる**: 読まれるのは操作の後である（K2）
- **誘導（前）を全部の移した skill に付ける**: 止まる回数が増える。止めるのは、操作の前に読まないと取り返しにくい 3 つに絞った。ほかは場面の後の 1 行か description で足りる
- **subagent では自分の transcript を組み立てて読む**: `<親の session>/subagents/agent-<agent_id>.jsonl` という配置は公開されていない。配置が変わると、判定を誤っても気づけない
- **規則を rules に残し、`paths:` だけで知らせる（白紙設計案）**: `paths:` が rule を読み込ませるのは、ファイルの読み書きのときだけである。commit、委譲、Stop のような操作の場面を拾えない

## Consequences

### 見直しの条件

`decisions.jsonl` と押し出し先を、操作ごとに集計する。deny の後も読まれずに `ignored` になった割合が 5 割を超え、件数が 10 件以上ある操作は、誘導（前）から誘導（後）に下げるか外す（仮の条件）。集計では、同じ inode のファイルは 1 つにまとめて集計する。

### Risks（受け入れたもの）

- Stop の 1 行は、ターンを 1 回増やす
- 目印を作ってから印字するので、watchdog が印字の前に hook を終わらせると、deny の 1 回分か、その場面の 1 行が失われる
- deny がモデルに読まれずに飲まれても、出した 1 回として扱う。並列の Bash で 2 回分を一度に使い切ることがある。目印の競合や、目印が消されたときは数が外れる
- 目印は 1 日で sweep され、回数が戻る
- Read の失敗や一部だけの読みも、読んだとみなす
- Agent の後の 1 行は、その最初の起動を変えられない。変わるのは次の起動からである
- model-offloading の 1 行は、メインが Sonnet のセッションでも出る。hook からメインのモデルを判定できないためである
- 宣言は配布先の SKILL.md から読むので、配布先に skill が無ければ宣言も読まれない。そのため `missing` の記録は、宣言を読んでから判定するまでに SKILL.md が消えた場合にしか書かれない
- 並行の追記と押し出しが競合すると、`decisions.jsonl` の数行がずれる。記録は見直しの補助で、安全の床ではない
- autonomous-lane の CI のプロンプトにある既存の限界（C2・C3 は honor-system の指示で、機構では強制していない）は、この ADR では変わらない

## References

- 改訂の対象: `docs/decisions/0026-rule-removal-requires-delivery-and-backstop.md`
- PreToolUse の `additionalContext` が操作の後に読まれる: `docs/decisions/0044-ask-preflight-bounce.md`
- 共通の仕組みの元（deny の形、fail-open、watchdog）: `docs/decisions/0046-skill-requires-gate.md`
- 実装: `home/dot_claude/hooks/lib/skill-guide.ts`、`home/dot_claude/hooks/implementations/skill-guide-gate.ts`、`home/dot_claude/hooks/implementations/skill-guide-after.ts`
