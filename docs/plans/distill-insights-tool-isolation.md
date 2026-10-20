# distill-insights stage B の LLM 呼び出しがツールを無効にしていない

出どころ: agent-learnings spec の Round 1、security-vulnerability-analyzer の指摘。

## 観察した事実

- `home/dot_claude/scripts/distill-insights.ts` の `runLlmDistillation` は `allowedTools: []`、`disallowedTools: STAGE_B_DISALLOWED_TOOLS`（10 件）、`permissionMode: "bypassPermissions"` で `query` を呼ぶ
- `allowedTools` は自動承認の一覧で、ツールを取り除かない。denylist に無いツール（Glob、Grep、MCP ツールなど）は `bypassPermissions` の下で確認なしに動く
- 入力は transcript 中の ★ Insight ブロックで、外部の文章を引用している可能性がある

## やること

- agent-learnings の worker と同じ隔離（`tools: []`、`settingSources: []`、`strictMcpConfig: true`、常に拒否する `canUseTool`、`bypassPermissions` を使わない）に揃える
- ツール一覧が空であることを確かめるテストを足す

## 未確認

- 実際にツールが呼ばれた記録があるか（`distill-run.log` を見ていない）
