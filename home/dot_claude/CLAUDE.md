# Development Guidelines

## Language

- Japanese for discussion, English for code

## Workflow

1. Explore → 2. Research (`$DOCUMENT_WORKFLOW_DIR/research.md`) → 3. Plan (`$DOCUMENT_WORKFLOW_DIR/plan.md`) → 4. Review (auto) → 5. Intent Triage (`/intent-alignment-triage`) → 6. Approve (human only) → 7. Implement → 8. Commit

Design decisions (API/architecture/data model changes) or 3+ step tasks **require Document Workflow**. See `@~/.claude/rules/workflow.md`.

## Key Commands

- **Test**: `bun run test`
- **Typecheck**: `bun run typecheck`
- **Lint**: `bun run lint`
- **Worktree**: `git-worktree-create <branch>`, `git-worktree-cleanup`
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

## Prohibitions

- Never implement before plan approval (enforced by `document-workflow-guard` hook)
- Never hardcode secrets or suppress errors
- Never lower user expectations or disable steering unilaterally
- Never change approach mid-task without logic-validator verification
