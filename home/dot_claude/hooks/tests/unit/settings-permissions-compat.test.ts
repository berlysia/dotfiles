import { strictEqual } from "node:assert";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  assessAutoApprovalHold,
  buildHoldContext,
} from "../../lib/auto-approval-hold.ts";
import { checkPattern, type RuleList } from "../../lib/pattern-matcher.ts";
import { coreDecision } from "../support/core-match.ts";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../../../..");
const userSettings = JSON.parse(
  readFileSync(
    resolve(repoRoot, "home/dot_claude/.settings.permissions.json"),
    "utf-8",
  ),
) as { allow: string[]; deny: string[]; ask?: string[] };
const projectSettings = JSON.parse(
  readFileSync(resolve(repoRoot, ".claude/settings.json"), "utf-8"),
) as { permissions: { allow: string[]; deny: string[] } };

const allow = [...userSettings.allow, ...projectSettings.permissions.allow];
const deny = [...userSettings.deny, ...projectSettings.permissions.deny];
const ctx = {
  cwd: "/home/u/.local/share/chezmoi",
  home: "/home/u",
  settingsRoot: "/home/u/.local/share/chezmoi",
};

async function matchedIn(
  list: RuleList,
  tool: string,
  filePath: string,
  context: typeof ctx,
): Promise<string[]> {
  const hits: string[] = [];
  for (const rule of list === "allow" ? allow : deny) {
    if (await checkPattern(rule, tool, { file_path: filePath }, context, list))
      hits.push(rule);
  }
  return hits;
}

function matched(
  list: RuleList,
  tool: string,
  filePath: string,
): Promise<string[]> {
  return matchedIn(list, tool, filePath, ctx);
}

describe("settings entries after the matcher change", () => {
  it("has no negated or wildcard-free home Edit allow left", () => {
    strictEqual(allow.filter((r) => r.startsWith("Edit(!")).length, 0);
    for (const gone of [
      "Edit(~/.bashrc)",
      "Edit(~/.gitconfig)",
      "Edit(~/.gitignore_global)",
      "Edit(~/.zshrc)",
    ]) {
      strictEqual(allow.includes(gone), false, gone);
    }
    strictEqual(allow.includes("Edit(.tmp/sessions/*/*.md)"), true);
    strictEqual(allow.includes("Read(home/dot_claude/hooks/**)"), true);
    strictEqual(allow.includes("Read(dot_claude/hooks/**)"), false);
    strictEqual(
      allow.some((r) => r.startsWith("Write(")),
      false,
    );
  });

  // Claude Code itself reads these deny rules with gitignore semantics, where a
  // pattern that names a directory also covers everything under it. This hook's
  // matcher does not, so the table below cannot catch it: a deny on .git (or on
  // .git/worktree or one worktree) silently blocks every edit in worktrees.
  it("denies no directory that holds worktrees", () => {
    strictEqual(
      deny
        .filter((r) => /^Edit\(.*\/\.git(\/worktree(\/\*)?)?\)$/.test(r))
        // a worktree's own .git is a file (the gitdir pointer), not a directory
        .filter((r) => !/\/\.git\/worktree\/\*\/\.git\)$/.test(r))
        .join("\n"),
      "",
    );
  });

  it("writes every deny path rule as an absolute or home path", () => {
    const pathRule =
      /^(Read|Edit|Write|MultiEdit|NotebookEdit|NotebookRead|Grep|Glob|LS|Search)\(/;
    strictEqual(
      deny.some((r) => /^[A-Za-z]+\((?![/~])/.test(r) && pathRule.test(r)),
      false,
    );
  });

  it("matches Grep by its own rules, anchored at cwd", async () => {
    const grep = (path: string) =>
      checkPattern("Grep(./**)", "Grep", { path, pattern: "x" }, ctx, "allow");
    strictEqual(await grep("/home/u/.local/share/chezmoi/home"), true);
    strictEqual(await grep("/etc"), false);
    strictEqual(
      await checkPattern(
        "Read(./**)",
        "Grep",
        { path: "/home/u/.local/share/chezmoi/home", pattern: "x" },
        ctx,
        "allow",
      ),
      false,
    );
  });

  // [list, tool, path, expected number of matching rules is > 0, was before the change]
  const rows: Array<[RuleList, string, string, boolean, boolean]> = [
    // unchanged
    ["allow", "Edit", "/tmp/a/b", true, true],
    ["allow", "Edit", "/home/u/.config/x/y", true, true],
    ["allow", "Edit", "/home/u/workspace/p/src/a.ts", true, true],
    ["deny", "Edit", "/etc/hosts", true, true],
    ["deny", "Read", "/home/u/p/.env", true, true],
    ["deny", "Read", "/home/u/.ssh/id_rsa", true, true],
    // Edit is no longer allowed everywhere
    ["allow", "Edit", "/etc/hosts", false, true],
    ["allow", "Edit", "/mnt/c/Users/u/a.txt", false, true],
    ["allow", "Edit", "/home/u/.zshrc", false, true],
    // Write follows Edit rules
    ["allow", "Write", "/home/u/workspace/p/src/a.ts", true, false],
    [
      "allow",
      "Write",
      "/home/u/.local/share/chezmoi/.tmp/sessions/abcd1234/research.md",
      true,
      false,
    ],
    ["allow", "Write", "/mnt/c/Users/u/a.txt", false, false],
    ["deny", "Write", "/etc/hosts", true, false],
    // the workflow document rule, from a project outside the allowed roots
    // (covered by a separate case below with its own cwd)
    // wildcard-free deny entries now match
    ["deny", "Edit", "/etc/passwd", true, true],
    ["deny", "Edit", "/home/u/.claude/CLAUDE.md", true, false],
    ["deny", "Edit", "/home/u/.claude/.credentials.json", true, false],
    // project rules anchored at cwd
    [
      "allow",
      "Edit",
      "/home/u/.local/share/chezmoi/home/x/a.test.ts",
      true,
      true,
    ],
    [
      "allow",
      "Read",
      "/home/u/.local/share/chezmoi/home/dot_claude/hooks/lib/a.ts",
      true,
      true,
    ],
    ["allow", "Read", "/home/u/.local/share/chezmoi/src/a.ts", true, true],
    // ~/.local is allowed only for the chezmoi source, not deployed files or tools
    [
      "allow",
      "Edit",
      "/home/u/.local/share/chezmoi/home/dot_zshrc",
      true,
      true,
    ],
    ["allow", "Edit", "/home/u/.local/bin/agent-vm", false, true],
    [
      "allow",
      "Edit",
      "/home/u/.local/share/mise/installs/x/bin/y",
      false,
      true,
    ],
    // git config and hooks can run commands, so no repo's are editable
    ["deny", "Edit", "/home/u/.local/share/chezmoi/.git/config", true, false],
    ["deny", "Edit", "/home/u/workspace/p/.git/hooks/pre-commit", true, false],
    ["deny", "Edit", "/home/u/workspace/p/.git/config.worktree", true, false],
    [
      "deny",
      "Edit",
      "/home/u/workspace/p/.git/worktrees/feature-x/config.worktree",
      true,
      false,
    ],
    [
      "deny",
      "Edit",
      "/home/u/workspace/p/.git/modules/sub/config",
      true,
      false,
    ],
    [
      "deny",
      "Edit",
      "/home/u/workspace/p/.git/modules/sub/hooks/post-checkout",
      true,
      false,
    ],
    // a .git file is a gitdir pointer; retargeting it brings another config and
    // hooks. Only worktree pointers are named: a submodule's .git file has the
    // same name as a .git directory, and Claude Code's gitignore-style Edit
    // rules would then deny everything inside every .git directory.
    [
      "deny",
      "Edit",
      "/home/u/.local/share/chezmoi/.git/worktree/feature-x/.git",
      true,
      false,
    ],
    [
      "deny",
      "Edit",
      "/home/u/.local/share/chezmoi/.git/worktree/feature-x/src/a.ts",
      false,
      false,
    ],
  ];
  for (const [list, tool, path, expected] of rows) {
    it(`${list} ${tool} ${path} -> ${expected ? "matches" : "no match"}`, async () => {
      strictEqual((await matched(list, tool, path)).length > 0, expected);
    });
  }

  it("allows workflow documents by the cwd-relative rule alone", async () => {
    const elsewhere = {
      cwd: "/mnt/c/proj",
      home: "/home/u",
      settingsRoot: "/mnt/c/proj",
    };
    const rule = "Edit(.tmp/sessions/*/*.md)";
    const hit = (path: string) =>
      checkPattern(rule, "Write", { file_path: path }, elsewhere, "allow");
    strictEqual(await hit("/mnt/c/proj/.tmp/sessions/abcd1234/plan.md"), true);
    strictEqual(
      await hit("/mnt/c/proj/.tmp/sessions/abcd1234/reviewer-runs.log"),
      false,
    );
    strictEqual(
      await hit("/mnt/c/other/.tmp/sessions/abcd1234/plan.md"),
      false,
    );
  });

  // git-worktree-create puts worktrees in <repo>/.git/worktree/<branch>, so a
  // session started at the repo root edits them through this rule. The cwd is
  // outside every other allowed root so only this rule can match.
  // Relative patterns follow the tool cwd, and a subagent working in a worktree
  // has the worktree as its cwd, so the rule is written from the filesystem root
  // to match from the repo root and from inside the worktree alike.
  for (const cwd of ["/mnt/c/proj", "/mnt/c/proj/.git/worktree/feature-x"]) {
    it(`allows edits in a worktree under the repo root from ${cwd}`, async () => {
      const elsewhere = { cwd, home: "/home/u", settingsRoot: cwd };
      strictEqual(
        (
          await matchedIn(
            "allow",
            "Edit",
            "/mnt/c/proj/.git/worktree/feature-x/src/a.ts",
            elsewhere,
          )
        ).join(),
        "Edit(//**/.git/worktree/**)",
      );
    });
  }

  it("allows nothing else in .git, and denies nothing in a worktree's files", async () => {
    const elsewhere = {
      cwd: "/mnt/c/proj",
      home: "/home/u",
      settingsRoot: "/mnt/c/proj",
    };
    const hit = (path: string) => matchedIn("allow", "Edit", path, elsewhere);
    strictEqual((await hit("/mnt/c/proj/.git/config")).length, 0);
    strictEqual(
      (
        await matchedIn(
          "deny",
          "Edit",
          "/mnt/c/proj/.git/worktree/feature-x/src/a.ts",
          elsewhere,
        )
      ).length,
      0,
    );
  });
});

const coreEnv = {
  home: "/home/u",
  cwd: "/home/u/workspace/p",
  settingsDir: "/home/u/.claude",
};
const coreRules = {
  deny: userSettings.deny ?? [],
  ask: userSettings.ask ?? [],
  allow: userSettings.allow ?? [],
};
const chezmoi = "/home/u/.local/share/chezmoi";

describe("settings evaluated as Claude Code would (spec K6, K7)", () => {
  const table: Array<[string, "deny" | "ask" | "allow" | "none"]> = [
    // deny floor
    [`${chezmoi}/.git/config`, "deny"],
    [`${chezmoi}/.git/config.worktree`, "deny"],
    [`${chezmoi}/.git/commondir`, "deny"],
    [`${chezmoi}/.git/hooks/pre-commit`, "deny"],
    [`${chezmoi}/.git/info/attributes`, "deny"],
    [`${chezmoi}/.git/worktrees/x/commondir`, "deny"],
    [`${chezmoi}/.git/worktrees/x/config.worktree`, "deny"],
    [`${chezmoi}/.git/modules/sub/config`, "deny"],
    [`${chezmoi}/.git/modules/sub/hooks/post-checkout`, "deny"],
    [`${chezmoi}/.git/worktree/feat/.git`, "deny"],
    // A gitfile under a branch name with "/" is not in the deny floor; plan-1 holds it (K3, 2b).
    [`${chezmoi}/.git/worktree/feat/x/.git`, "allow"],
    // ask
    ["/home/u/.gitconfig", "ask"],
    ["/home/u/.gitconfig_gpg_ssh", "ask"],
    ["/home/u/.config/git/config", "ask"],
    ["/home/u/.config/git/attributes", "ask"],
    [`${chezmoi}/home/dot_gitconfig.tmpl`, "ask"],
    [`${chezmoi}/home/private_dot_config/git/config`, "ask"],
    // allow stays
    [`${chezmoi}/.git/worktree/feat/src/a.ts`, "allow"],
    [`${chezmoi}/home/dot_zshrc`, "allow"],
    ["/home/u/.config/mise/config.toml", "allow"],
  ];
  for (const [path, expected] of table) {
    it(`${path} -> ${expected}`, () => {
      strictEqual(coreDecision("Edit", path, coreRules, coreEnv), expected);
    });
  }
  it("does not let .git/worktrees/** cover .git/worktree/", () => {
    strictEqual(
      coreRules.deny.some((r) => r === "Edit(//**/.git/worktrees/**)"),
      true,
    );
    strictEqual(
      coreDecision(
        "Edit",
        `${chezmoi}/.git/worktree/feat/src/a.ts`,
        coreRules,
        coreEnv,
      ),
      "allow",
    );
  });
  it("keeps every path the old deny rules covered (inclusion)", () => {
    const oldDeny = [
      "Edit(//**/.git/config)",
      "Edit(//**/.git/config.worktree)",
      "Edit(//**/.git/worktrees/*/config.worktree)",
      "Edit(//**/.git/hooks/**)",
      "Edit(//**/.git/modules/**/config)",
      "Edit(//**/.git/modules/**/hooks/**)",
      "Edit(//**/.git/worktree/*/.git)",
    ];
    for (const [path] of table) {
      const old = coreDecision(
        "Edit",
        path,
        { deny: oldDeny, ask: [], allow: [] },
        coreEnv,
      );
      if (old === "deny") {
        strictEqual(
          coreDecision("Edit", path, coreRules, coreEnv),
          "deny",
          path,
        );
      }
    }
  });
  it("holds in the hooks every path the ask rules cover (ask ⊆ hold)", async () => {
    // home "/home/u" has no .chezmoiroot here, so buildHoldContext falls back to the ask-rule
    // path; this pins that chezmoiSource string. The ask paths themselves hold on their dot
    // segments (.gitconfig, .config, .local), so the chezmoi-source rule is tested in plan-1 T1
    // with a dot-free chezmoiSource, not here.
    const holdCtx = buildHoldContext({
      cwd: "/home/u/workspace/p",
      home: "/home/u",
    });
    strictEqual(holdCtx.chezmoiSource, `${chezmoi}/home`);
    for (const [path, expected] of table) {
      if (expected !== "ask") continue;
      strictEqual(
        (await assessAutoApprovalHold("Edit", { file_path: path }, holdCtx))
          .hold,
        true,
        path,
      );
    }
  });
  it("holds in the hooks the nested gitfile that the deny floor does not cover", async () => {
    // Any hold reason will do: this pins the outcome, not the worktree check (plan-1 T2 tests that).
    const holdCtx = buildHoldContext({
      cwd: "/home/u/workspace/p",
      home: "/home/u",
    });
    strictEqual(
      (
        await assessAutoApprovalHold(
          "Edit",
          { file_path: `${chezmoi}/.git/worktree/feat/x/.git` },
          holdCtx,
        )
      ).hold,
      true,
    );
  });
  it("no longer allows Bash(git -c *)", () => {
    strictEqual(coreRules.allow.includes("Bash(git -c *)"), false);
  });
});
