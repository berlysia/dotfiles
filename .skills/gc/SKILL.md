# GC (Garbage Collection)

Detect and report stale files, unused code, and documentation drift in the dotfiles repository.
All checks are non-destructive: report findings and let the user decide what to delete.

## Trigger

- "gc", "garbage collection", "cleanup", "stale files"
- "古いセッション", "不要ファイル", "クリーンアップ"

## Checks

Run all checks by default, or specify individual checks by name.

### 1. Session GC

Detect old session directories under `.tmp/sessions/`.

```bash
cd "$(git rev-parse --show-toplevel)"
find .tmp/sessions/ -maxdepth 1 -mindepth 1 -type d -mtime +7 2>/dev/null
```

Report each directory with its last modified date. Ask the user before deleting.

### 2. Tmp File GC

Detect old files and directories directly under `.tmp/` (excluding `sessions` and `.completion-gate-retries`).

```bash
cd "$(git rev-parse --show-toplevel)"
find .tmp/ -maxdepth 1 -mindepth 1 -not -name sessions -not -name .completion-gate-retries -mtime +7 2>/dev/null
```

This includes stale subdirectories like `docs/`, `plans/`, and leftover test/patch files.
Report each item with its last modified date. Ask the user before deleting.

### 3. CLAUDE.md Integrity

Check that file paths referenced in CLAUDE.md actually exist.

1. Read `CLAUDE.md` at the project root
2. Extract paths from backtick-enclosed text (`` `path/to/file` `` patterns)
3. Skip paths containing `${` (variable expansion — cannot verify)
4. Skip URLs (starting with `http`)
5. For each remaining path, check existence relative to the project root
6. Report missing files

Note: Some paths use chezmoi naming (`dot_*` → `.*`). Check the source path as-is — these are references to the source state, not the target.

### 4. Knip (Unused Code Detection)

Run knip to detect unused exports, dependencies, and files.

```bash
cd "$(git rev-parse --show-toplevel)"
pnpm exec knip 2>&1 | head -100
```

Report the knip output as-is. Let the user decide which items to address.

## Output Format

```
## GC Report

### Session GC
- [count] stale session(s) found (older than 7 days)
  [list with dates]

### Tmp File GC
- [count] stale item(s) found
  [list with dates]

### CLAUDE.md Integrity
- [count] missing path(s) found
  [list]
- [count] path(s) skipped (variable expansion)

### Knip
[knip output summary]

## Actions
Which items would you like to clean up?
```
