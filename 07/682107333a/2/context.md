# Session Context

## User Prompts

### Prompt 1

optimize-claude-md がデフォルトでユーザーレベルのものまで手をつけてしまうのをやめさせたい。内容は参照していいが変更はchezmoi管理なので。

### Prompt 2

commit

### Prompt 3

# /commit

Commits current changes with semantic commit messages. Automatically handles simple and complex scenarios.

## Workflow

```
/commit
    │
    ├─ Check for changes (staged + unstaged)
    │
    ├─ Analyze change complexity
    │   │
    │   ├─ Simple (single purpose) → Direct commit
    │   │   - Generate semantic commit message
    │   │   - Stage and commit
    │   │
    │   └─ Complex (multiple types mixed) → Delegate to /semantic-commit
...

