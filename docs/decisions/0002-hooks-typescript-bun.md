# ADR-0002: Hook TypeScript実装 (bun実行)

## Status

Accepted

## Date

2026-02-18

## Context

Claude Code hooksはshellコマンドとして実行される。シンプルなhookはbash one-linerで十分だが、複雑なロジック（permission evaluation, workflow guard, plan review automation等）にはプログラム言語が必要。

## Decision

- Hooksを TypeScript で実装し、`bun` で実行する
- `cc-hooks-ts` ライブラリで型安全なhook定義
- `~/.claude/hooks/implementations/` に配置
- `home/dot_claude/package.json` でhook依存パッケージを管理（pnpm workspace）
- deploy後は `~/.claude/` で `bun install` を実行

## Consequences

- 型安全性によりhookの不具合を事前に検出
- `cc-hooks-ts` の `defineHook` パターンでhook定義が統一される
- bun依存が増えるが、高速な起動時間によりhookのUXへの影響は最小限
- テストは `node:test` で実行（bun非依存）
