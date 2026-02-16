---
name: adr-session
description: "Start or resume an ADR session. Without number: show status overview and recommend next actionable ADR. With number: provide phase-specific guidance. Trigger: /adr-session, /adr-session NNN, /adr-session new"
context: inherit
---

# ADR Session

ADR（Architecture Decision Record）の状態管理とセッションガイダンスを提供する。

## Argument Parsing

引数に応じてモードを分岐:

- **引数なし** → Status Overview Mode
- **`NNN`** (number) → Session Mode for ADR-NNN
- **`new`** → New ADR Creation Mode

---

## Mode 1: Status Overview (no arguments)

### Step 1: Scan ADR files

```
Glob: docs/decisions/adr-*.md
```

If no files found AND `docs/decisions/` does not exist:
- Report: "ADR ディレクトリが見つかりません"
- Suggest: "`docs/decisions/` と `docs/plans/` を作成しますか？"
- If user agrees, create both directories
- Then suggest: "`/adr-session new` で最初の ADR を作成できます"
- Stop here

If directory exists but no ADR files:
- Report: "ADR ファイルがまだありません"
- Suggest: "`/adr-session new` で最初の ADR を作成できます"
- Stop here

### Step 2: Parse frontmatter

For each `adr-*.md` file, read the file and extract YAML frontmatter (content between `---` delimiters at the start).

Refer to [adr-schema.md](references/adr-schema.md) for valid field definitions.

**Error handling:**
- YAML parse error → warn with filename and error, skip file
- Invalid `status` value (not in Proposed/Accepted/InProgress/Complete) → warn and skip
- No frontmatter → report as "frontmatter なし" in the table

### Step 3: Determine phase for each ADR

Apply phase logic from [adr-schema.md](references/adr-schema.md#phase-determination-logic):

```
Complete           → done
Proposed           → investigation
Accepted + no plan → planning
Accepted + plan without <!-- validated --> → validation
Accepted + plan with <!-- validated -->    → implementation
InProgress         → implementation
```

For ADRs with a `plan` field, check if `docs/plans/{plan}` exists and contains `<!-- validated -->`.

### Step 4: Display status table

Format:

```
## ADR Status Overview

| # | Title | Status | Plan | Phase |
|---|-------|--------|------|-------|
| 001 | Auth System | Accepted | plan-auth.md | planning |
| 002 | API Design | Proposed | - | investigation |
| 003 | DB Migration | Complete | plan-db.md | done |
```

### Step 5: Find actionable ADRs

An ADR is actionable when (see [adr-schema.md](references/adr-schema.md#actionable-adr-determination)):

1. Status is NOT `Complete`
2. All `deps` reference ADRs with `status: Complete` (or no deps)
3. Not involved in a circular dependency

**Circular dependency detection:**
Build a directed graph from all `deps` fields. If a cycle is found:
- Warn: "循環依存を検出: ADR-X → ADR-Y → ADR-X"
- List all ADR numbers involved
- Exclude them from actionable list

### Step 6: Recommend next ADR

From the actionable list, recommend the ADR with the earliest phase in priority order: `investigation` > `planning` > `validation` > `implementation`.

If multiple ADRs are in the same phase, recommend the one with the lowest number.

```
### 推奨: 次に着手すべき ADR

**ADR-002: API Design** (phase: investigation)
→ `/adr-session 2` で調査セッションを開始できます
```

---

## Mode 2: Session Mode (NNN specified)

### Step 1: Load target ADR

Read `docs/decisions/adr-NNN-*.md` (glob to find the file matching the number).

If not found: "ADR-NNN が見つかりません。`/adr-session` でステータス概要を確認してください。"

### Step 2: Display ADR summary

Show:
- Title, status, phase
- deps status (each dep's current status)
- Plan link if exists

### Step 3: Check dependencies

If ADR has `deps`, check each referenced ADR's status:
- All Complete → proceed normally
- Some not Complete → warn: "依存 ADR-X がまだ Complete ではありません（現在: {status}）。先にそちらを完了することを推奨します。"

### Step 4: Phase-specific guidance

#### investigation (status: Proposed)

```
### Investigation Session

このADRはまだ調査段階です。以下のアクションを推奨します:

1. ADR の「コンテキスト」「決定」「影響」セクションを充実させる
2. 必要な調査・PoC を実施
3. 完了したら logic-validator で ADR の論理的整合性を検証:
   - Task(subagent_type: "logic-validator") で ADR 内容を検証
4. 検証後、status を `Accepted` に更新
```

#### planning (status: Accepted, no plan)

```
### Planning Session

ADR は承認済みです。実装計画を作成しましょう。

**Plan Mode の使用が必須です。** EnterPlanMode を実行してください。

1. Plan Mode で実装計画を作成
2. テンプレート: この skill の [plan-template.md](references/plan-template.md) を参照
3. 計画ファイルを `docs/plans/plan-{slug}.md` に保存
4. ADR の frontmatter に `plan: plan-{slug}.md` を追加
5. ExitPlanMode → validate-plan-guard hook が検証を強制
```

#### validation (status: Accepted, plan exists, not validated)

```
### Validation Session

実装計画が作成済みですが、まだ検証されていません。

1. `/validate-plan` を実行して計画の論理的整合性を検証
2. 検証が通ったら `<!-- validated -->` マーカーが追加されます
3. その後、実装に進めます
```

#### implementation (plan validated or status: InProgress)

```
### Implementation Session

計画は検証済みです。実装を進めましょう。

1. 計画ファイル `docs/plans/{plan}` に従って実装
2. 便利なスキル:
   - `/decompose` — タスクを細分化
   - `/execute-plan` — 計画に沿って順次実行
   - `/scope-guard` — スコープが大きすぎる場合
3. テストが通ることを確認
4. 完了したら ADR の status を `Complete` に更新
```

#### done (status: Complete)

```
### Complete

この ADR は完了済みです。変更や再検討が必要な場合は status を更新してください。
```

### Step 5: Check for session memos

Search for related memos:

```
Glob: .tmp/session-memos/*.md
```

Read each file and check if it contains `ADR-{NNN}` (the target ADR number). If found, list them:

```
### 関連セッションメモ
- `.tmp/session-memos/abc12345.md` — [問題意識の冒頭]
```

### Step 6: Session closing reminder

At the end of the guidance, remind:

```
セッション終了時には `/session-memo` で作業内容を記録することを推奨します。
```

---

## Mode 3: New ADR Creation (argument: `new`)

### Step 1: Determine next number

Scan existing `docs/decisions/adr-*.md` files, extract numbers, and compute `max + 1`.
If no files exist, start from `001`.
Zero-pad to 3 digits.

### Step 2: Ask for title

Use AskUserQuestion to ask: "新しい ADR のタイトルを入力してください"

Provide no predefined options (user will select "Other" and type the title).

### Step 3: Create directories if needed

If `docs/decisions/` or `docs/plans/` don't exist, create them.

### Step 4: Create ADR file

Read [adr-template.md](references/adr-template.md) for the template structure.

Generate the slug from the title (lowercase, spaces to hyphens, remove special chars).

Write the file to `docs/decisions/adr-{NNN}-{slug}.md` with:
- `status: Proposed` in frontmatter
- NNN and title filled in

### Step 5: Guide next steps

```
ADR-{NNN} を作成しました: `docs/decisions/adr-{NNN}-{slug}.md`

### 次のステップ
1. 「コンテキスト」「決定」「影響」セクションを記入してください
2. 調査が完了したら logic-validator で検証:
   Task(subagent_type: "logic-validator") で ADR の論理的整合性を検証
3. 検証後、status を `Accepted` に更新
4. `/adr-session {NNN}` でセッションガイダンスを確認できます
```

---

## Related Skills

| Skill | When to Use |
|-------|-------------|
| logic-validator (Task subagent) | ADR 作成・更新後の論理検証（investigation phase 完了時） |
| `/validate-plan` | Plan の検証（validation phase） |
| `/session-memo` | セッション終了時の記録 |
| `/decompose` | 実装タスクの細分化（implementation phase） |
| `/execute-plan` | 計画に沿った順次実行（implementation phase） |
| `/scope-guard` | ADR のスコープが大きすぎる場合 |
