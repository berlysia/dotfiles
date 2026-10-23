# Development Guidelines

## Language

- Japanese for discussion, English for code
- 人が読むことを目的にする日本語の文書を作成・改稿するときは、公開範囲・保存形式・スキル指定の有無を問わず、`~/.claude/skills/ja-check/references/human-documents.md` に従い、提出する本文に japanese-check を必ず実行する。社内資料、下書き、PR・Issue・commit の本文、チャットで納品する文書も含む。通常の会話・作業報告と、機械だけが読むコード・設定は除く。実行できない場合は未検証の草稿として返し、送信・公開しない。
- 日本語の成果物（リポジトリに残る Markdown、PR・commit・Issue の本文）を書くときは、直訳語の一覧 `~/.claude/skills/ja-notation/references/translationese-words.json` を読み、当たる語を使わない。読み方と直し方は ja-notation の SKILL.md に従う。Document Workflow の文書とチャットの返答は対象外。hook が直訳語を警告したら直す。利用者が新しく直訳語を名指ししたら、一覧に足すよう提案する

## Workflow

1. Explore → 2. Research (`<wfDir>/research.md`) → 3. Plan (`<wfDir>/plan.md`) → 4. Review (auto) → 5. Intent Triage (`/intent-alignment-triage`) → 6. Approve (human only) → 7. Implement → 8. Commit

Design decisions (API/architecture/data model changes) or 3+ step tasks **require Document Workflow**. See `@~/.claude/rules/workflow.md`.

## Key Commands

package manager はプロジェクトの設定（lockfile / `packageManager` フィールド）に従う。以下は `pnpm` / `bun` 併記。

- **Test**: `pnpm run test` / `bun run test`
- **Typecheck**: `pnpm run typecheck` / `bun run typecheck`
- **Lint**: `pnpm run lint` / `bun run lint`
- **Worktree**: `git-worktree-create <branch>`, `git-worktree-cleanup`
- **Dev server**: `PORTLESS_PORT` が設定されているとき（agent-vm）は `portless run <dev コマンド>` で起動し、表示された URL を使う。ポートを自分で選ばない。`portless` が失敗するときは、ほかのポートで起動し直さずに報告する
- **Temp files**: `${projectRoot}/.tmp` (gitignored)

## Rules (auto-loaded by path match)

- `@~/.claude/rules/workflow.md` — Task routing, Document Workflow, Scope Guard, completion protocol
- `@~/.claude/rules/code-quality.md` — Naming, comments, error handling, testing, security, architecture
- `@~/.claude/rules/developer-experience.md` — Tool selection, decisions, knowledge management, commit standards
- `@~/.claude/rules/debugging.md` — Emergency checklist, root cause analysis, 5 Whys
- `@~/.claude/rules/typescript-new-project.md` — New TS project tooling standards
- `@~/.claude/rules/external-review.md` — Logic validation, external review, claude-code-guide usage
- `@~/.claude/rules/context-md.md` — Per-project CONTEXT.md mechanism (`.tmp/docs/CONTEXT.md` 位置規約、@path lazy 解決、degraded mode)
- `@~/.claude/rules/autonomous-lane.md` — Autonomous push lane charter（CI/cron 専用、C1 型ホワイトリスト / C2 出力=PR / C3 設計面非接触）
- `@~/.claude/rules/model-offloading.md` — plan big, execute small: Opus 以上のセッションで下位モデル subagent へオフロードする指針

## Per-Project Context

Session 開始時、現在のプロジェクトルートに `.tmp/docs/CONTEXT.md` が存在する場合は事前に Read する。CONTEXT.md 内の `@path` 表記は「人間と AI が共有する参照規約」であり、AI は必要時にその path を明示的に Read する (CLAUDE.md の `@~/` 自動ロードとは異なる解決メカニズム)。詳細は `@~/.claude/rules/context-md.md` を参照。

`.tmp/docs/CONTEXT.md` が不在で root `./CONTEXT.md` または `./docs/CONTEXT.md` が存在する場合、canonical CONTEXT.md が solo project / dog-food パターンで配置されている可能性が高い。AI はユーザーに symlink 作成を提案する (作成は人間判断):

- `ln -s ../../CONTEXT.md .tmp/docs/CONTEXT.md` (canonical が root の場合)
- `ln -s ../../docs/CONTEXT.md .tmp/docs/CONTEXT.md` (canonical が `docs/` の場合)

canonical を Read 対象として直接読むことはしない (他プロジェクト team / OSS / client での非侵入性維持のため、Read 権限は `.tmp/docs/CONTEXT.md` 経由のみ)。

## 「新しい発見」の扱い

あなたやサブエージェントが「新しい発見」をしたとき、その多くは次のいずれかであることを肝に銘じる。

- **意図された実装**: 設計意図がコメントや別レイヤーに書かれている
- **計測・計算ミス**: 標本が小さい、単位や順序が違う
- **錯覚**: ノイズを傾向として読む、相関を因果と読む
- **局所のみで判断**: 関数単体で正しさを論じ、呼び出し側を見ていない
- **計器の側の誤り**: 測っている量が、その名前が指す量と違う

これら 5 つを排除できた場合にのみ、有用な可能性があるものとして扱う。排除できていない段階で報告・実装・計画へ持ち込まない。

## 利用者の提案の扱い

利用者が示す原因の見立て・直し方・使う道具は仮説として扱う。目的は仮説ではない。提案はもっともらしくても問題に合っていないことがある（XY 問題）。言い方の確信度は問わない。

1. 手を動かす前に、問題そのものを確かめる。症状を再現する、指された箇所のコードを読む、今の状態を観察する。1 回の実行や数行の読みで足りるなら、それで済ませる
2. 提案が問題に合っていれば、そのまま進める。異を唱えるための異論は挟まない
3. 合っていなければ、編集の前に止まる。観察した事実と推測を分け、元の問題が何か、提案がなぜそれを解かないか、代わりの案を示して判断を返す。黙って自分の案に差し替えない
4. 説明を求められたら、根拠（実行結果・該当行）を示して答える。押し返されたことだけを理由に、確かめた事実を引っ込めない

この確認は着手時の確認であり、方針変更（logic-validator を要する）にも利用者の指示の無視にも当たらない。

## Prohibitions

- Never implement before plan approval (enforced by `document-workflow-guard` hook)
- Never hardcode secrets or suppress errors
- Never lower user expectations or disable steering unilaterally
- Never change approach mid-task without logic-validator verification
