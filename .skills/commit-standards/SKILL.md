---
name: commit-standards
description: Use when creating a Git commit to choose its boundaries, staged files, and message. Do not use for PR descriptions or Git operations that do not create a commit.
read-before: ["Bash(git commit)"]
---

# Git Commit & PR Standards

## Commit body and comments

- **コミットの本文に Why**: なぜこの変更をしたか（意図・決定・制約）は commit の本文に書く（Contextual Commits の action lines。下の Contextual Commits の行）

## Git Commit & PR Standards

- Keep moves separate from behavior changes so each commit passes checks and its description stands alone. Stage the next group only after the preceding commit succeeds; do not bypass signing without permission.
- Check document formatting even when hooks omit it.

- Conventional Commit format: `<type>(<scope>): <description>`
- Types: feat, fix, refactor, test, docs, chore, perf, style, build, ci
- Present tense imperative, lowercase, no trailing period
- Commit body follows [Contextual Commits](https://github.com/berserkdisruptors/contextual-commits) — use action lines (`intent`, `decision`, `rejected`, `constraint`, `learned`) to capture reasoning the diff cannot show
- Use `/commit` for complex multi-type changes
- PR titles and descriptions: follow the `pr-description` skill

## 届く経路

`git commit` の前に、未読なら gate がこのスキルの読み込みを求める。
