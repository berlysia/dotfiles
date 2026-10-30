#!/usr/bin/env node --test

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { guardedHomeDenyRules } from "../../lib/delivery-policy.ts";

const PERMISSIONS = JSON.parse(
  readFileSync(
    join(import.meta.dirname, "..", "..", "..", ".settings.permissions.json"),
    "utf-8",
  ),
) as { allow: string[]; deny: string[]; ask: string[] };

describe("settings permissions for delivery-policy", () => {
  it("allows the wrapper by its absolute path form", () => {
    assert.ok(
      PERMISSIONS.allow.includes("Bash(~/.local/bin/delivery-policy *)"),
    );
  });

  it("allows no gh pr merge: the wrapper is the only way in", () => {
    assert.deepEqual(
      PERMISSIONS.allow.filter((rule) => rule.includes("gh pr merge")),
      [],
    );
  });

  const ASK_RULES = [
    "Bash(gh pr merge *)",
    "Bash(gh api */merge*)",
    "Bash(gh api *mutation*)",
    "Bash(gh api *--input*)",
    "Bash(gh api *=@*)",
  ];

  // Claude Code matches a Bash rule's `*` against any characters. The
  // `:*` / ` *` forms differ only by the word boundary, which these
  // patterns do not rely on.
  const matches = (rule: string, command: string): boolean => {
    const body = /^Bash\((.*)\)$/.exec(rule)?.[1] ?? "";
    const source = body
      .split("*")
      .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
      .join(".*");
    return new RegExp(`^${source}$`, "s").test(command);
  };
  const asked = (command: string) =>
    PERMISSIONS.ask.some((rule) => matches(rule, command));
  const allowed = (command: string) =>
    PERMISSIONS.allow.some((rule) => matches(rule, command));

  it("asks before gh pr merge and the merge shapes of gh api", () => {
    const missing = ASK_RULES.filter((rule) => !PERMISSIONS.ask.includes(rule));
    assert.deepEqual(missing, []);
  });

  it("no allow rule matches gh pr merge", () => {
    assert.equal(allowed("gh pr merge 5"), false);
    assert.equal(asked("gh pr merge 5 -R o/r --merge"), true);
  });

  it("asks for the merge shapes of gh api, and not for reads", () => {
    for (const command of [
      "gh api -X PUT repos/o/r/pulls/5/merge",
      "gh api graphql -f query='mutation{mergePullRequest(input:{pullRequestId:\"x\"}){clientMutationId}}'",
      "gh api graphql -f query='mutation{enablePullRequestAutoMerge(input:{pullRequestId:\"x\"}){clientMutationId}}'",
      "gh api graphql -f query='mutation{enqueuePullRequest(input:{pullRequestId:\"x\"}){clientMutationId}}'",
      "gh api graphql --input p.json",
      "gh api graphql -F query=@q.graphql",
    ]) {
      assert.equal(asked(command), true, command);
    }
    for (const command of [
      "gh api repos/o/r/pulls/5 --jq .mergeStateStatus",
      "gh api 'repos/o/r/pulls?state=merged'",
    ]) {
      assert.equal(asked(command), false, command);
    }
  });

  it("denies Edit for every guarded home path the guard refuses", () => {
    const missing = guardedHomeDenyRules().filter(
      (rule) => !PERMISSIONS.deny.includes(rule),
    );
    assert.deepEqual(missing, []);
  });
});
