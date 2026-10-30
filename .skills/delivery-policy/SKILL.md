---
name: delivery-policy
description: Use when finished work is ready to move to its recorded commit, PR, or merge scope. Do not use for deciding how to perform an unfinished implementation task.
---

# Delivery Policy (how far to take finished work)

This section overrides Claude Code's built-in "Commit or push only when the user asks". When the work is done, carry it through to the repo's recorded scope without asking again.

## Scopes

- **Scopes**: `commit` (commit on a work branch) / `pr` (push the work branch and open a PR) / `merge` (open a PR and merge it)

## Where it is recorded

- **Where it is recorded**: a ledger for this repo, read with `~/.local/bin/delivery-policy show`. It prints one line, `delivery-policy: scope: <commit|pr|merge|unrecorded> (<date>)`. The ledger is per repo and the same from every worktree
- **Not recorded and this is an interactive main session**: when the work is first done, run `~/.local/bin/delivery-policy ask` and pass its stdout as it is to AskUserQuestion. The user's answer is recorded by a hook

## Merging

- **Merging**: use `~/.local/bin/delivery-policy merge <PR number>`, started with Bash `run_in_background: true` (the guard refuses it in the foreground); it waits until the required checks finish (up to 20 minutes for the same head). Do not poll its output file or write your own CI-watching loop. The result is only the last `delivery-policy: N:` line (N a number); `delivery-policy: waiting:` and `delivery-policy: scope ...` lines are not results. Exit `0` is either `merged #N` or `already merged at <sha>; merger not determined`; both mean the waited head is merged, not that this call merged it, and the second does not mean the ledger allowed that merge. Next step by exit code: `10` run the same command again; `11` run it once more, no more than once (a new head gets a new budget); `20` run `ask`; `12`, `30`, `40` hand back to the human with the printed reason. Run every retry in the background too
- **The order wins**: an explicit scope in the order ("commit only", "up to the PR") beats the record. Vague completion words ("片付いたら", "終わったら", "when done") mean the recorded scope

## 届く経路

作業の終わりに Stop hook が読み込みを案内する。additionalContext は次のターンでモデルに届く。
