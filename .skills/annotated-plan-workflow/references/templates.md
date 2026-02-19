# Annotated Plan Workflow Templates

## 1. Research Directive

```text
対象領域を深く調査し、仕様・依存関係・境界条件・既存実装パターン・潜在バグを整理してください。
表面的な要約ではなく詳細に分析し、結果を .tmp/research.md に保存してください。
まだ実装はしないでください。
```

## 2. Planning Directive

```text
.tmp/research.md を前提に、実装計画を .tmp/plan.md に作成してください。
変更方針、対象ファイル、トレードオフ、差分イメージ、検証方法を含めてください。
まだ実装はしないでください。
```

## 3. Annotation Update Directive

```text
.tmp/plan.md に注釈を追加しました。注釈をすべて反映して計画を更新してください。
矛盾点があれば具体的に指摘し、修正案を提示してください。
don’t implement yet
```

## 4. Todo Expansion Directive

```text
.tmp/plan.md に、フェーズと依存関係が明確な詳細 TODO を追加してください。
各TODOに What/Where/How/Why/Verify を含めてください。
don’t implement yet
```

## 5. Implementation Directive

```text
.tmp/plan.md の承認済みタスクをすべて実装してください。
タスクまたはフェーズが完了するたびに .tmp/plan.md のチェックを更新してください。
不要なコメントや JSDoc は追加しないでください。
不明な型は使わないでください。
typecheck と test を継続的に実行し、新しい問題があればその場で修正してください。
```

