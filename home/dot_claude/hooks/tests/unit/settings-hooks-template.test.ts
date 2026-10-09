#!/usr/bin/env node --test

import { deepStrictEqual, ok, strictEqual } from "node:assert";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

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
