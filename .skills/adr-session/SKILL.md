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
5. plan-review-automation が自動レビューを実行
6. 人間が `Approval Status: approved` を設定
```

#### implementation (plan approved or status: InProgress)

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

## Writing Conventions

ADR を書き足すとき、書き直すときに守る慣習である。消える作業ファイルから恒久文書へ記録を移す規則は `~/.claude/rules/workflow.md` に、作業ツリーに無い記録の引用の規則は `~/.claude/rules/developer-experience.md` にある。ここには、その規則が触れていない書き方の詳細を置く。

1. 後の ADR が前の ADR の一部を覆すとき、覆される側の Status の直下に「ADR-NNNN が覆した」の 1 行を足す。前の ADR だけを読んだ人が、現行の規則と食い違う理由をたどれるようにするためである。
2. 消える資料を参照しない。`.tmp/sessions/` は数日で GC され、spec の ID（K5、U8 など）はその文書がある間だけ意味を持つ。参照する計画が消える見込みなら、決定、却下した案、リスクを ADR の本文に移してから参照を切る。
3. 参照の種類ごとに、成り立つ条件が違う。PR の中の commit の hash は、commit の列を保つ取り込み方（merge commit か fast-forward）が前提で、squash か rebase で切れる。PR 番号は取り込み方に前提を持たない。既定のブランチに存在する commit の hash は、履歴を書き換えなければ残る。パスと行番号は参照先のファイルが変わるたびにずれ、部分文字列は文面を直せば切れる。ずれないのは commit に固定した参照だけである。rebase や amend の前に、commit の本文や残件の記録が作業ブランチの中の hash を指していないか確かめる。
4. 「戻し方」に書く commit の指定は SHA でなく題にする。SHA は push の前の rebase や amend で変わる。題なら `git log --grep` で見つかる。
5. 決定番号（K、R など）と節の見出しは振り直さない。テストや hook のコメントが ADR の文言や番号を機械的に検査していることがある。中身を削るときも番号は保つ。編集するファイルの名前で grep し、節名への参照（`README.md "Hook telemetry"` の書き方のもの）が見つかったら、その見出しを同じ名前で残す。ファイル名だけを追っていると見落とす参照で、参照元を全件付け替えるより壊れにくい。
6. `~/.claude` に配置される文書に ADR の番号を書かない。配置先の別のプロジェクトではその ADR を読めない。基準の本文は配置される文書のほうに置き、ADR には決定と理由だけを書く。
7. 更新が続く表を accepted の ADR に置くときは、「決定ではなく運用の表」と明記する。決定は書き換えず、表だけを取り込みの PR で直せる。表の行は番号でなく名前で指す（「表の 4 行目」ではなく「表の『範囲の外として次に回した課題』の行」）。行の増減で、番号による参照が複数の箇所でずれる。
8. 見出しの種類を制限する検査を入れるときは、例外一覧にも「違反が直ったのに一覧に残っている」ことを落とす条件を入れる。一覧の長さが、修正の進み具合をそのまま示す。
9. ADR の執筆は会話の経緯に依存するので、main loop で行う。何を残し何を落とすかの判断そのものが成果物で、下位のモデルに渡した brief に入っていない利用者の決定や解釈が本文に入る。

---

## Related Skills

| Skill                           | When to Use                                              |
| ------------------------------- | -------------------------------------------------------- |
| logic-validator (Task subagent) | ADR 作成・更新後の論理検証（investigation phase 完了時） |
| `/session-memo`                 | セッション終了時の記録                                   |
| `/decompose`                    | 実装タスクの細分化（implementation phase）               |
| `/execute-plan`                 | 計画に沿った順次実行（implementation phase）             |
| `/scope-guard`                  | ADR のスコープが大きすぎる場合                           |
