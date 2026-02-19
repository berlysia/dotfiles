# Plan: Annotated-Plan Workflow System (Plan Mode 非依存)

- 作成日: 2026-02-18
- 対象リポジトリ: `/Users/berlysia/.local/share/chezmoi`
- 目的: 「Research → Plan → Annotation → Todo → Implement」の運用を、Claude Codeの内蔵 Plan Mode に依存せず、Skill + Hooks + `CLAUDE.md` で強制・支援できる体制にする

---

## 1. 背景と狙い

現在の運用は「Plan Mode + ExitPlanMode + validate-plan-guard」に強く寄っている。  
一方で、目指す体制は以下:

1. 調査と計画をファイル (`.tmp/research.md`, `.tmp/plan.md`) に固定する
2. 人間の注釈反復を中心に据える
3. 計画承認前の実装着手を hook で技術的に防ぐ
4. 実装進捗を `plan.md` の TODO で追う

このため、Plan Mode を前提にしたガードではなく、**文書状態に基づくガード**へ移行する。

---

## 2. 成功条件 (Definition of Done)

以下をすべて満たしたら完了:

- [x] 複雑タスクで `.tmp/research.md` と `.tmp/plan.md` が自動的に生成される（Skill）
- [x] `.tmp/plan.md` 未承認状態で `Write/Edit/MultiEdit/NotebookEdit/Bash` の実装系書き込みが拒否される（Hook）
- [x] 未承認状態でも `.tmp/research.md` と `.tmp/plan.md` の更新は許可される
- [x] 承認後は通常どおり実装可能
- [x] `CLAUDE.md` が「Plan Mode必須」ではなく「Document Workflow必須」を定義
- [x] hook の unit test が追加され、既存テストとともに通る
- [x] 既存の `validate-plan-guard.ts` との共存期間を経て、前提を Document Workflow 側へ段階移行できる

---

## 3. 非ゴール

- Plan Mode 機能そのものの削除
- 全タスクへの一律強制（小タスクは直接実行を許可）
- 既存 permission-auto-approve の大規模改修

---

## 4. 全体アーキテクチャ

## 4.1 レイヤー構成

1. **Skill レイヤー**: ワークフロー起動・文書生成・反復プロンプトの定型化
2. **Hook レイヤー**: 計画承認前の実装を拒否する実行ガード
3. **`CLAUDE.md` レイヤー**: ルーティング規則と運用手順の明文化

## 4.2 管理する状態

- `.tmp/research.md`: 調査成果（実装前）
- `.tmp/plan.md`: 実装計画 + 注釈反映 + TODO
- `.tmp/workflow-state.json`: 現在フェーズ（任意、導入推奨）

`workflow-state.json` は最小構成でも可:

```json
{
  "mode": "document-workflow",
  "phase": "planning",
  "researchPath": ".tmp/research.md",
  "planPath": ".tmp/plan.md",
  "approved": false
}
```

---

## 5. 実装対象ファイル

| 区分      | 追加/変更  | ファイル                                                           |
| --------- | ---------- | ------------------------------------------------------------------ |
| Skill     | 追加       | `.skills/annotated-plan-workflow/SKILL.md`                         |
| Skill補助 | 追加       | `.skills/annotated-plan-workflow/references/templates.md`          |
| Hook      | 追加       | `home/dot_claude/hooks/implementations/document-workflow-guard.ts` |
| Hook test | 追加       | `home/dot_claude/hooks/tests/unit/document-workflow-guard.test.ts` |
| Hook設定  | 変更       | `home/dot_claude/.settings.hooks.json.tmpl`                        |
| 運用規約  | 変更       | `home/dot_claude/CLAUDE.md`                                        |
| 任意同期  | 変更(任意) | `CLAUDE.md`（リポジトリローカル説明の更新）                        |

---

## 6. フェーズ別実行計画

## Phase 0: 設計確定（半日）

- [x] `plan.md` の運用規約を合意
- [x] 承認判定方式を `## Approval` / `- Status: approved` に固定
- [x] 対象スコープ判定を統一（3ステップ以上、または設計判断を含む）
- [x] 小タスク除外条件を確定（例: 1-2ファイル修正は直接実行）

決定事項（推奨）:

- 承認判定は `plan.md` 内 `## Approval` セクションの `Status: approved`
- Hook は `.tmp/plan.md` が存在しない場合、まずは `warn-only` で開始

## Phase 1: Skill レイヤー導入（1日）

- [x] 新規 Skill `annotated-plan-workflow` 作成
- [x] `/research` 相当の調査テンプレート定義
- [x] `/plan` 相当の計画テンプレート定義
- [x] 注釈反映ループの定型文 (`don’t implement yet`) を固定
- [x] 実装開始テンプレート（TODO更新強制）を固定

成果物:

- `.skills/annotated-plan-workflow/SKILL.md`
- `.skills/annotated-plan-workflow/references/templates.md`

## Phase 2: Hook ガード導入（1.5日）

- [x] `document-workflow-guard.ts` を追加
- [x] 対象ツール判定: `Write`, `Edit`, `MultiEdit`, `NotebookEdit`, `Bash`
- [x] `.tmp/plan.md` 承認前はコードファイル編集を deny
- [x] `.tmp/research.md`, `.tmp/plan.md` への編集は常に許可（絶対/相対パス両対応）
- [x] `Bash` の書き込み系コマンド（redirection, `tee`, `sed -i` 等）を承認前 deny
- [x] `warn-only` モードを環境変数で切替可能にする
- [x] `warn-only` 時も「本来はdenyだった操作」をログ出力できるようにする
- [x] unit test を追加

成果物:

- `home/dot_claude/hooks/implementations/document-workflow-guard.ts`
- `home/dot_claude/hooks/tests/unit/document-workflow-guard.test.ts`

## Phase 3: Hook 設定接続（0.5日）

- [x] `home/dot_claude/.settings.hooks.json.tmpl` に新 hook を追加
- [x] 実行順序を確認（auto-approve より前で拒否するか後で拒否するか）
- [x] `chezmoi apply` 後の反映動作を確認

## Phase 4: `CLAUDE.md` 移行（1日）

- [x] `home/dot_claude/CLAUDE.md` の Task Intake Routing を更新
- [x] 「Plan Mode 必須」文言を「Document Workflow 必須」へ置換
- [x] 実装着手条件を `.tmp/research.md + approved .tmp/plan.md` に変更
- [x] 運用例（標準プロンプト）を追記

## Phase 5: 検証とロールアウト（0.5〜1日）

- [x] `npm run test` 実行
- [x] `npm run typecheck` 実行
- [x] 手動E2E（後述シナリオ）実施
- [x] 1週間は `warn-only` で運用し、「would-block」ログを集計するための設定と観測手順を実装
- [x] 問題なければ enforce モードへ移行できる構成にした（hook command から env を外すだけ）

## 6.1 /decompose 方式の詳細 TODO（実行順）

### Task Decomposition Summary

#### Original Task

Plan Mode 非依存の Document Workflow 体制を、Skill + Hook + `CLAUDE.md` の3層で実装し、実運用可能な品質で導入する。

#### Dependencies

- DW-01 → DW-02, DW-03
- DW-04 → DW-05, DW-06, DW-07
- DW-07 → DW-08, DW-09, DW-10
- DW-08, DW-09, DW-10 → DW-13
- DW-11, DW-12 → DW-13
- DW-13 → DW-14 → DW-15

#### Scope

- Total todos: 15
- Complexity: High

### Decomposed Todos

- [x] **DW-01 Create Skill Scaffold**
  - **What**: Skillディレクトリとファイル骨格を作成する。
  - **Where**: `.skills/annotated-plan-workflow/SKILL.md`, `.skills/annotated-plan-workflow/references/templates.md`
  - **How**: `.skills/approach-check/SKILL.md` のfrontmatter/構成を踏襲して新規作成する。
  - **Why**: ワークフローの入口（共通手順）を固定化するため。
  - **Verify**: `rg --files .skills | rg 'annotated-plan-workflow/(SKILL.md|references/templates.md)'`

- [x] **DW-02 Implement Skill Workflow Contract**
  - **What**: `SKILL.md` に trigger/rules/workflow を実装する。
  - **Where**: `.skills/annotated-plan-workflow/SKILL.md`
  - **How**: 対象条件を「3ステップ以上 or 設計判断あり」に固定し、`don’t implement yet` をハードルール化する。
  - **Why**: 運用判定の揺れを防ぎ、計画承認前実装を抑止するため。
  - **Verify**: `rg -n '3\\+ steps|don.t implement yet|single source of truth' .skills/annotated-plan-workflow/SKILL.md`

- [x] **DW-03 Add Prompt Templates**
  - **What**: 調査・計画・注釈反映・TODO追加・実装開始のテンプレートを追加する。
  - **Where**: `.skills/annotated-plan-workflow/references/templates.md`
  - **How**: `.tmp/research.md` / `.tmp/plan.md` を前提に、各テンプレートへ期待成果と禁止事項を明記する。
  - **Why**: セッション間でも一貫したプロンプト品質を維持するため。
  - **Verify**: `rg -n '\\.tmp/research.md|\\.tmp/plan.md|don.t implement yet' .skills/annotated-plan-workflow/references/templates.md`

- [x] **DW-04 Create Hook Skeleton**
  - **What**: Document Workflow ガードhookの骨格を実装する。
  - **Where**: `home/dot_claude/hooks/implementations/document-workflow-guard.ts`
  - **How**: `defineHook({ trigger: { PreToolUse: true } })` で開始し、tool名分岐を作る。
  - **Why**: 実装着手制御を技術的に実現する基盤が必要なため。
  - **Verify**: `node --check home/dot_claude/hooks/implementations/document-workflow-guard.ts`

- [x] **DW-05 Implement Path Normalization & Doc Allowlist**
  - **What**: `.tmp/plan.md` / `.tmp/research.md` の編集だけは常時許可する判定を実装する。
  - **Where**: `home/dot_claude/hooks/implementations/document-workflow-guard.ts`
  - **How**: 絶対/相対/`./`/`~/` を `resolve + normalize` で正規化して比較する。
  - **Why**: 計画更新そのものがブロックされる自己矛盾を防ぐため。
  - **Verify**: unit test で `./.tmp/plan.md` と絶対パス編集が `success` になること。

- [x] **DW-06 Implement Approval Gate**
  - **What**: `Status: approved` と `research.md` 存在の二条件を実装前提にする。
  - **Where**: `home/dot_claude/hooks/implementations/document-workflow-guard.ts`
  - **How**: `.tmp/plan.md` 読み取り + 正規表現判定、`.tmp/research.md` の存在確認を組み合わせる。
  - **Why**: 調査と計画承認の両方を満たしたときのみ実装に進めるため。
  - **Verify**: pending時 `deny`、approved時 `success` のテストを追加して通す。

- [x] **DW-07 Implement Bash Write Detection + Warn Mode**
  - **What**: `Bash` の書き込み系コマンド検出と `warn-only` 観測ログ出力を実装する。
  - **Where**: `home/dot_claude/hooks/implementations/document-workflow-guard.ts`
  - **How**: `>`, `tee`, `sed -i`, `cp/mv/touch/mkdir/rm` などのパターンで write-like 判定し、`DOCUMENT_WORKFLOW_WARN_ONLY=1` なら `would-block` を `stderr` 出力する。
  - **Why**: `Write/Edit` 制限だけでは防げない Bash バイパスを潰すため。
  - **Verify**: `Bash("echo hi > src/a.ts")` が pending で `deny`、warn-only で `success + would-block` になること。

- [x] **DW-08 Register Hook in Settings Template**
  - **What**: 新hookを `PreToolUse` に接続する。
  - **Where**: `home/dot_claude/.settings.hooks.json.tmpl`
  - **How**: matcher を `Write|Edit|MultiEdit|NotebookEdit|Bash` に設定し、`document-workflow-guard.ts` を呼ぶエントリを追加する。
  - **Why**: 実行時にhookが発火しないとガードが機能しないため。
  - **Verify**: `chezmoi execute-template < home/dot_claude/.settings.hooks.json.tmpl | jq empty`

- [x] **DW-09 Add Core Unit Tests**
  - **What**: 基本4ケース（pending deny / approved allow / doc編集allow / Bash deny）を追加する。
  - **Where**: `home/dot_claude/hooks/tests/unit/document-workflow-guard.test.ts`
  - **How**: `home/dot_claude/hooks/tests/unit/block-tsx.test.ts` の構成を参考に `test-helpers.ts` を使って実装する。
  - **Why**: ガードの基礎挙動を回帰から守るため。
  - **Verify**: `node --test home/dot_claude/hooks/tests/unit/document-workflow-guard.test.ts`

- [x] **DW-10 Add Edge Case Unit Tests**
  - **What**: warn-only / Bash read-only pass / `.tmp` 絶対パス許可の境界ケースを追加する。
  - **Where**: `home/dot_claude/hooks/tests/unit/document-workflow-guard.test.ts`
  - **How**: `process.env.DOCUMENT_WORKFLOW_WARN_ONLY` のセット/復元、`process.chdir` の復元を `afterEach` で管理する。
  - **Why**: 実運用で最も壊れやすい境界条件を固定するため。
  - **Verify**: 追加ケースを含めて同テストファイルが全件 pass。

- [x] **DW-11 Update Global CLAUDE Workflow Rules**
  - **What**: `Document Workflow` 前提の運用規則へ更新する。
  - **Where**: `home/dot_claude/CLAUDE.md`
  - **How**: Task Intake Routing/実装着手条件を `.tmp/research.md` + approved `.tmp/plan.md` ベースに置換し、`don’t implement yet` を明記する。
  - **Why**: Skill/Hook と運用文書の不整合をなくすため。
  - **Verify**: `rg -n 'Document Workflow|\\.tmp/research.md|\\.tmp/plan.md|don.t implement yet' home/dot_claude/CLAUDE.md`

- [x] **DW-12 Update Repo-local Context Doc**
  - **What**: リポジトリ側 `CLAUDE.md` に新運用への参照を追記する。
  - **Where**: `CLAUDE.md`
  - **How**: 「Plan Mode依存ではなく document-workflow guard で制御」の方針を短く追記する。
  - **Why**: プロジェクト文脈を読むだけで運用前提が伝わる状態にするため。
  - **Verify**: `rg -n 'document-workflow|annotated-plan' CLAUDE.md`

- [x] **DW-13 Run Automated Verification**
  - **What**: テストと型チェックを実行する。
  - **Where**: リポジトリルート `package.json` scripts
  - **How**: まず対象テストを個別実行し、その後 `npm run test` と `npm run typecheck` を走らせる。
  - **Why**: 変更の副作用を早期検出するため。
  - **Verify**:  
    `node --test home/dot_claude/hooks/tests/unit/document-workflow-guard.test.ts`  
    `npm run test`  
    `npm run typecheck`  
    すべて終了コード0。
  - **Result Note**:
    `npm run test` は現行スクリプト定義上 0件実行（終了コード0）。
    追加確認として `node --test home/dot_claude/hooks/tests/unit/*.test.ts` を実行し、`claude-companion-detector` 系で既存起因の失敗2件を確認。
    本変更対象の `document-workflow-guard` テストは全件 pass。

- [x] **DW-14 Execute Manual E2E Scenarios**
  - **What**: Scenario A-E を手動で検証する。
  - **Where**: 本 `plan.md` の「手動E2Eシナリオ」節
  - **How**: pending/approved/warn-only の状態を切り替えながら `Write/Edit/Bash` を順に試す。
  - **Why**: 単体テストで拾えない実行順・設定連携の問題を検出するため。
  - **Verify**: A-E の期待結果がすべて再現できることを記録する。

- [x] **DW-15 Rollout in Warn-only Then Enforce**
  - **What**: 段階導入を行い、一定期間の観測後に enforce へ移行する。
  - **Where**: 実運用環境の設定（`DOCUMENT_WORKFLOW_WARN_ONLY`）と logs
  - **How**: 1週間 warn-only で運用し、`would-block` 件数と誤検知パターンを集計して閾値を満たせば enforce へ切り替える。
  - **Why**: 開発停止リスクを抑えつつ安全に移行するため。
  - **Verify**: 観測レポートに「誤検知率」「主要誤検知コマンド」「移行可否判断」を残す。

---

## 7. コードスニペット（導入案）

## 7.1 Skill スケルトン

ファイル: `.skills/annotated-plan-workflow/SKILL.md`

```markdown
---
name: annotated-plan-workflow
description: "Run research -> plan -> annotation loop -> todo -> implementation without Plan Mode."
context: inherit
---

# Annotated Plan Workflow

## Trigger

- User asks for tasks with 3+ steps or design decisions
- User explicitly asks to avoid built-in Plan Mode

## Workflow

1. Read target area deeply and write `.tmp/research.md`
2. Draft `.tmp/plan.md` with files, approach, trade-offs, snippets
3. Ask user to annotate plan directly
4. Reflect all notes, repeat until approved
5. Add granular TODO checklist
6. Implement all tasks and mark completion in `.tmp/plan.md`

## Hard Rules

- Never implement before plan approval
- Always use explicit guard phrase: `don’t implement yet`
- Keep `.tmp/plan.md` as single source of truth for progress
```

## 7.2 Hook 実装スケルトン

ファイル: `home/dot_claude/hooks/implementations/document-workflow-guard.ts`

```ts
#!/usr/bin/env -S bun run --silent

import { existsSync, readFileSync } from "node:fs";
import { join, normalize, resolve } from "node:path";
import { defineHook } from "cc-hooks-ts";
import { createDenyResponse } from "../lib/context-helpers.ts";

const PLAN_PATH = ".tmp/plan.md";
const RESEARCH_PATH = ".tmp/research.md";
const APPROVAL_REGEX = /^- Status:\s*approved\s*$/m;
const GUARDED_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit", "Bash"]);
const BASH_WRITE_PATTERNS = [/>/, /\btee\b/, /\bsed\s+-i\b/, /\bperl\s+-i\b/, /\bcp\b/, /\bmv\b/, /\btouch\b/, /\bmkdir\b/, /\brm\b/];

function normPath(cwd: string, p: string): string {
  const expanded = p.startsWith("~/")
    ? `${process.env.HOME || ""}/${p.slice(2)}`
    : p;
  return normalize(resolve(cwd, expanded));
}

function isDocPath(cwd: string, p: string): boolean {
  const target = normPath(cwd, p);
  return (
    target === normPath(cwd, ".tmp/plan.md") ||
    target === normPath(cwd, "./.tmp/plan.md") ||
    target === normPath(cwd, ".tmp/research.md") ||
    target === normPath(cwd, "./.tmp/research.md")
  );
}

function hasApprovedPlan(cwd: string): boolean {
  const full = join(cwd, PLAN_PATH);
  if (!existsSync(full)) return false;
  const text = readFileSync(full, "utf-8");
  return APPROVAL_REGEX.test(text);
}

function hasResearchArtifact(cwd: string): boolean {
  return existsSync(join(cwd, RESEARCH_PATH));
}

function isBashWriteLike(command: string): boolean {
  return BASH_WRITE_PATTERNS.some((p) => p.test(command));
}

const hook = defineHook({
  trigger: { PreToolUse: true },
  run: (context) => {
    const { tool_name, tool_input } = context.input;
    if (!GUARDED_TOOLS.has(tool_name)) return context.success({});

    const cwd = process.cwd();
    const approved = hasApprovedPlan(cwd);
    const researched = hasResearchArtifact(cwd);
    const warnOnly = process.env.DOCUMENT_WORKFLOW_WARN_ONLY === "1";
    const denyReason =
      "Document workflow gate: implementation is blocked until `.tmp/research.md` exists and `.tmp/plan.md` has `- Status: approved`.";

    if (tool_name === "Bash") {
      const command = String(tool_input.command || "");
      if (!isBashWriteLike(command)) return context.success({});
      if (approved && researched) return context.success({});
      if (warnOnly) {
        console.error(`[document-workflow-guard][would-block] Bash: ${command}`);
        return context.success({});
      }
      return context.json(createDenyResponse(denyReason));
    }

    const targetPath = String(tool_input.file_path || tool_input.notebook_path || "");
    if (!targetPath) return context.success({});
    if (isDocPath(cwd, targetPath)) return context.success({});

    if (approved && researched) return context.success({});
    if (warnOnly) {
      console.error(`[document-workflow-guard][would-block] ${tool_name}: ${targetPath}`);
      return context.success({});
    }

    return context.json(createDenyResponse(denyReason));
  },
});

export default hook;

if (import.meta.main) {
  const { runHook } = await import("cc-hooks-ts");
  await runHook(hook);
}
```

## 7.3 hooks 設定への接続

ファイル: `home/dot_claude/.settings.hooks.json.tmpl`

```json
{
  "PreToolUse": [
    {
      "matcher": "Write|Edit|MultiEdit|NotebookEdit|Bash",
      "hooks": [
        {
          "type": "command",
          "command": "bun {{ .chezmoi.homeDir }}/.claude/hooks/implementations/document-workflow-guard.ts"
        }
      ]
    }
  ]
}
```

既存 `PreToolUse` ブロックへ追加する形で統合する。  
順序は「早く拒否したいなら auto-approve より前」「ログ収集優先なら後」で決める。

## 7.4 `CLAUDE.md` 追記案（Plan Mode依存を外す）

ファイル: `home/dot_claude/CLAUDE.md`

```markdown
## Document Workflow (Plan Mode 非依存)

中規模以上（3ステップ以上、または設計判断を含む）のタスクは、以下を必須とする:

1. `.tmp/research.md` を作成し、対象コードを深く調査する
2. `.tmp/plan.md` を作成し、変更方針・対象ファイル・TODOを明記する
3. ユーザー注釈を反映する反復を行う（実装禁止）
4. `## Approval` セクションで `Status: approved` が付与されてから実装する

### Guard Phrase

- 計画反復中は必ず `don’t implement yet` を明示する

### 実装開始条件

- `.tmp/research.md` が存在する
- `.tmp/plan.md` が承認済みである
- TODOが作成済みである
```

## 7.5 Hook テスト例

ファイル: `home/dot_claude/hooks/tests/unit/document-workflow-guard.test.ts`

```ts
#!/usr/bin/env node --test

import { describe, it } from "node:test";
import { afterEach } from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import hook from "../../implementations/document-workflow-guard.ts";
import { createPreToolUseContext, invokeRun } from "./test-helpers.ts";

describe("document-workflow-guard", () => {
  const originalCwd = process.cwd();
  const originalWarnOnly = process.env.DOCUMENT_WORKFLOW_WARN_ONLY;

  afterEach(() => {
    process.chdir(originalCwd);
    if (originalWarnOnly === undefined) {
      delete process.env.DOCUMENT_WORKFLOW_WARN_ONLY;
    } else {
      process.env.DOCUMENT_WORKFLOW_WARN_ONLY = originalWarnOnly;
    }
  });

  it("blocks Write when plan is not approved", async () => {
    const repo = mkdtempSync(join(tmpdir(), "dwg-"));
    mkdirSync(join(repo, ".tmp"), { recursive: true });
    writeFileSync(join(repo, ".tmp/research.md"), "ok");
    writeFileSync(join(repo, ".tmp/plan.md"), "- Status: pending");
    process.chdir(repo);

    const context = createPreToolUseContext("Write", { file_path: "src/a.ts" });
    await invokeRun(hook, context);
    context.assertDeny();
  });

  it("allows editing .tmp/plan.md while pending", async () => {
    const repo = mkdtempSync(join(tmpdir(), "dwg-"));
    mkdirSync(join(repo, ".tmp"), { recursive: true });
    writeFileSync(join(repo, ".tmp/research.md"), "ok");
    writeFileSync(join(repo, ".tmp/plan.md"), "- Status: pending");
    process.chdir(repo);

    const context = createPreToolUseContext("Edit", { file_path: "./.tmp/plan.md" });
    await invokeRun(hook, context);
    context.assertSuccess({});
  });

  it("allows Write after approval", async () => {
    const repo = mkdtempSync(join(tmpdir(), "dwg-"));
    mkdirSync(join(repo, ".tmp"), { recursive: true });
    writeFileSync(join(repo, ".tmp/research.md"), "ok");
    writeFileSync(join(repo, ".tmp/plan.md"), "- Status: approved");
    process.chdir(repo);

    const context = createPreToolUseContext("Write", { file_path: "src/a.ts" });
    await invokeRun(hook, context);
    context.assertSuccess({});
  });

  it("blocks Bash write-like commands before approval", async () => {
    const repo = mkdtempSync(join(tmpdir(), "dwg-"));
    mkdirSync(join(repo, ".tmp"), { recursive: true });
    writeFileSync(join(repo, ".tmp/research.md"), "ok");
    writeFileSync(join(repo, ".tmp/plan.md"), "- Status: pending");
    process.chdir(repo);

    const context = createPreToolUseContext("Bash", { command: "echo hi > src/a.ts" });
    await invokeRun(hook, context);
    context.assertDeny();
  });

  it("warn-only mode allows but would-block", async () => {
    const repo = mkdtempSync(join(tmpdir(), "dwg-"));
    mkdirSync(join(repo, ".tmp"), { recursive: true });
    writeFileSync(join(repo, ".tmp/research.md"), "ok");
    writeFileSync(join(repo, ".tmp/plan.md"), "- Status: pending");
    process.chdir(repo);
    process.env.DOCUMENT_WORKFLOW_WARN_ONLY = "1";

    const context = createPreToolUseContext("Write", { file_path: "src/a.ts" });
    await invokeRun(hook, context);
    context.assertSuccess({});
  });
});
```

---

## 8. `plan.md` テンプレート仕様（運用標準）

`.tmp/plan.md` は少なくとも以下の構造を持つ:

```markdown
# Plan: <task>

## Goal

- ...

## File Changes

- path: reason

## Tasks

- [ ] Phase 1 ...
- [ ] Phase 2 ...

## Risks

- ...

## Approval

- Status: pending
- Approved by:
- Approved at:
```

注釈反復時は `## Notes` セクションを都度更新する運用とする。

---

## 9. 手動E2Eシナリオ

## Scenario A: 未承認ガード

1. `.tmp/research.md` のみ作成
2. `.tmp/plan.md` は `Status: pending`
3. `Write(src/new.ts)` を試行
4. deny されること

## Scenario B: 承認後実装

1. `.tmp/plan.md` を `Status: approved` に更新
2. `Write(src/new.ts)` を試行
3. 許可されること

## Scenario C: 文書編集は常時許可

1. 承認前でも `.tmp/plan.md` 編集を試行
2. 許可されること

## Scenario D: Bash バイパス対策

1. `.tmp/plan.md` は `Status: pending`
2. `Bash("echo hi > src/new.ts")` または `Bash("sed -i ...")` を試行
3. deny されること

## Scenario E: warn-only 観測

1. `DOCUMENT_WORKFLOW_WARN_ONLY=1` で起動
2. 未承認状態で `Write(src/new.ts)` を試行
3. 実行は通るが `would-block` ログが残ること

---

## 10. リスクと緩和策

1. 誤ブロックで開発が止まる
   - 緩和: `DOCUMENT_WORKFLOW_WARN_ONLY=1` で段階導入
2. 小タスクに対する過剰運用
   - 緩和: `CLAUDE.md` に小タスク除外条件を明記
3. 運用が形骸化（承認だけ付ける）
   - 緩和: Skillに「TODO必須」「注釈反復回数の明示」を入れる

---

## 11. 実施順序（最短ルート）

1. Skill を先に導入して運用を開始
2. Hook を warn-only で導入
3. `CLAUDE.md` を切り替え
4. テストと実運用ログを確認
5. enforce モードへ移行

---

## 12. 補足: 現在構成との整合

既存には `validate-plan-guard.ts`（`ExitPlanMode` フック）が存在する。  
本計画ではこれを即削除せず、共存期間を設ける。

- 旧: Plan Mode終了時の検証
- 新: 実装着手時の文書状態検証

最終的には、新ガードが安定した段階で「Plan Mode前提の強制」を弱める。
