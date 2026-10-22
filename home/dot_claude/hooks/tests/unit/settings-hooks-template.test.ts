#!/usr/bin/env node --test

import { deepStrictEqual, ok, strictEqual } from "node:assert";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { DEADLINE_MS } from "../../lib/claude-worktree-git.ts";

const TMPL = fileURLToPath(
  new URL("../../../.settings.hooks.json.tmpl", import.meta.url),
);
const hasChezmoi = spawnSync("chezmoi", ["--version"]).status === 0;

type Flag = true | false | "missing";
const setOrUnset = (key: string, value: string, flag: Flag): string =>
  flag === "missing"
    ? `{{ $_ := unset . "${key}" }}`
    : `{{ $_ := set . "${key}" ${value} }}`;

// execute-template has no data override, so the data is rewritten in the template itself.
function render(
  autoApproval: Flag,
  onlyPrivate: boolean,
): Record<string, { matcher?: string; hooks: { command: string }[] }[]> {
  const prefix =
    setOrUnset(
      "claude_hooks",
      `(dict "auto_approval" ${autoApproval})`,
      autoApproval,
    ) + setOrUnset("only_private", "true", onlyPrivate ? true : "missing");
  const result = spawnSync("chezmoi", ["execute-template", "--with-stdin"], {
    input: prefix + readFileSync(TMPL, "utf8"),
    encoding: "utf8",
  });
  strictEqual(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

const names = (
  groups: { hooks: { command: string }[] }[] | undefined,
): string[] =>
  (groups ?? [])
    .flatMap((group) => group.hooks.map((hook) => hook.command))
    .flatMap((command) =>
      [...command.matchAll(/implementations\/([a-z-]+)\.ts/g)].map(
        (m) => m[1] as string,
      ),
    );

describe(
  "settings hooks template",
  { skip: !hasChezmoi && "chezmoi is not on PATH" },
  () => {
    for (const autoApproval of [true, false, "missing"] as const) {
      for (const onlyPrivate of [true, false]) {
        it(`auto_approval=${autoApproval} only_private=${onlyPrivate}`, () => {
          const hooks = render(autoApproval, onlyPrivate);
          const pre = names(hooks["PreToolUse"]);
          const perm = names(hooks["PermissionRequest"]);
          const on = autoApproval !== false;

          strictEqual(pre.includes("auto-approve"), on);
          strictEqual(pre.includes("home-destruction-guard"), !on);
          deepStrictEqual(
            perm.filter((n) => n.startsWith("permission-")),
            on ? ["permission-auto-approve", "permission-llm-evaluator"] : [],
          );
          deepStrictEqual(
            perm.filter((n) => n.endsWith("-notification")),
            onlyPrivate ? ["discord-notification", "slack-notification"] : [],
          );
          strictEqual("PermissionRequest" in hooks, on || onlyPrivate);

          const timeGroup = hooks["PreToolUse"]?.find((g) =>
            g.hooks[0]?.command.startsWith("echo "),
          );
          ok(timeGroup, "the Current time hook stays registered");
          strictEqual(timeGroup.hooks.length, on ? 2 : 1);

          // 常に登録する（only_private / auto_approval の条件の外）。終了を待たせない
          const sessionEnd = hooks["SessionEnd"] ?? [];
          deepStrictEqual(names(sessionEnd), ["learnings-session-end"]);
          strictEqual(
            (sessionEnd[0]?.hooks[0] as { async?: boolean }).async,
            true,
          );

          // compaction-testament は同期で compact を待たせ、learnings は待たせない
          const preCompact = hooks["PreCompact"] ?? [];
          deepStrictEqual(names(preCompact), [
            "compaction-testament",
            "learnings-session-end",
          ]);
          strictEqual(
            (preCompact[0]?.hooks[1] as { async?: boolean }).async,
            true,
          );
          // ほかのイベント（PostToolUse など毎回走るもの）には登録しない
          deepStrictEqual(
            Object.keys(hooks).filter((event) =>
              names(hooks[event] ?? []).includes("learnings-session-end"),
            ),
            ["SessionEnd", "PreCompact"],
          );

          const guardGroup = hooks["PreToolUse"]?.find((g) =>
            names([g]).includes("home-destruction-guard"),
          );
          strictEqual(guardGroup?.matcher, on ? undefined : "Bash");
          if (guardGroup)
            ok(guardGroup.hooks[0]?.command.endsWith("|| exit 2"));
        });
      }
    }
  },
);

describe(
  "settings hooks template: worktree hooks",
  { skip: !hasChezmoi && "chezmoi is not on PATH" },
  () => {
    it("E04: worktree events map to their entries with timeout 240 and the canonical command", () => {
      const hooks = render(true, false) as unknown as Record<
        string,
        { hooks: { command: string; timeout?: number }[] }[]
      >;
      const expected: Record<string, string> = {
        WorktreeCreate: "worktree-create",
        WorktreeRemove: "worktree-cleanup",
        SubagentStop: "worktree-cleanup",
      };
      for (const [event, entry] of Object.entries(expected)) {
        const registered = (hooks[event] ?? []).flatMap((g) => g.hooks);
        strictEqual(registered.length, 1, event);
        const hook = registered[0];
        ok(hook, event);
        ok(
          new RegExp(
            `^bun /\\S+/\\.claude/hooks/implementations/${entry}\\.ts$`,
          ).test(hook.command),
          `${event}: ${hook.command}`,
        );
        strictEqual(hook.timeout, 240, event);
      }
      // The lib's own deadline must leave room inside the hook timeout.
      ok(DEADLINE_MS < 240 * 1000, `DEADLINE_MS=${DEADLINE_MS}`);
    });
  },
);

describe(
  "settings hooks template: StopFailure",
  { skip: !hasChezmoi && "chezmoi is not on PATH" },
  () => {
    for (const onlyPrivate of [true, false]) {
      it(`StopFailure notifies through speak-notification only (only_private=${onlyPrivate})`, () => {
        const hooks = render(true, onlyPrivate) as unknown as Record<
          string,
          { matcher?: string; hooks: { command: string; async?: boolean }[] }[]
        >;
        const groups = hooks["StopFailure"] ?? [];
        strictEqual(groups.length, 1);
        strictEqual(groups[0]?.matcher, "");
        strictEqual(groups[0]?.hooks.length, 1);
        const entry = groups[0]?.hooks[0];
        ok(
          /^bun \/\S+\/\.claude\/hooks\/implementations\/speak-notification\.ts StopFailure$/.test(
            entry?.command ?? "",
          ),
          entry?.command,
        );
        strictEqual(entry?.async, true);
      });
    }
  },
);
