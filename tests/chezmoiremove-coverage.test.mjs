import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import test from "node:test";
import {
  KEEP,
  chezmoiTargetPaths,
  externalTargets,
  findLiveRemovals,
  findMissingRemovals,
  formatLiveMessage,
  formatMissingMessage,
  isShallowRepository,
  loadRepoInputs,
  matchesChezmoiGlob,
  repoRoot,
  sourceToTarget,
  unconditionalLines,
} from "./lib/chezmoiremove-coverage.mjs";

const NO_INPUTS = {
  deletedSources: [],
  currentSources: [],
  removeLines: [],
  ignoreLines: [],
  externals: [],
  keep: [],
};
const missing = (overrides) =>
  findMissingRemovals({ ...NO_INPUTS, ...overrides });
const live = (overrides) => findLiveRemovals({ ...NO_INPUTS, ...overrides });

test("sourceToTarget: strips attributes and converts dot_", () => {
  const cases = [
    [
      "home/dot_claude/hooks/implementations/foo.ts",
      ".claude/hooks/implementations/foo.ts",
    ],
    ["home/dot_local/bin/executable_add-skill.tmpl", ".local/bin/add-skill"],
    ["home/dot_codex/private_config.toml.tmpl", ".codex/config.toml"],
    ["home/dot_codex/modify_private_config.toml", ".codex/config.toml"],
    ["home/modify_private_dot_npmrc", ".npmrc"],
    ["home/private_executable_dot_x", ".x"],
    ["home/dot_config/agent-vm/create_config", ".config/agent-vm/config"],
    ["home/private_dot_ssh/config", ".ssh/config"],
    ["home/dot_config/exact_foo/bar", ".config/foo/bar"],
    ["home/literal_dot_x", "dot_x"],
    ["home/dot_literal_dot_x", ".literal_dot_x"],
    ["home/dot_x.literal.tmpl", ".x"],
    ["home/foo_bar", "foo_bar"],
  ];
  for (const [source, target] of cases) {
    assert.equal(sourceToTarget(source), target, source);
  }
});

test("sourceToTarget: returns null for paths that are not targets", () => {
  const nonTargets = [
    "README.md",
    "home/.chezmoiscripts/run_after_x.sh.tmpl",
    "home/.chezmoiremove",
    "home/dot_claude/.settings.plugins.json",
    "home/dot_claude/hooks/sounds/.gitkeep",
    "home/run_once_x.sh",
    "home/remove_dot_x",
    "home/remove_dir/y",
    "home/dot_x/secret.age",
    "home/dot_x/secret.asc",
  ];
  for (const source of nonTargets) {
    assert.equal(sourceToTarget(source), null, source);
  }
});

test("unconditionalLines: drops template blocks, comments, blanks and negations", () => {
  assert.deepEqual(
    unconditionalLines("**/*.test.ts\n{{ if x }}\n.a\n{{ end }}\n# c\n!b\n"),
    ["**/*.test.ts"],
  );
  assert.deepEqual(
    unconditionalLines(
      '{{- if dig "agent_vm" false . }}\n**\n{{- end }}\n.z\n',
    ),
    [".z"],
  );
  assert.deepEqual(
    unconditionalLines(
      "{{ if a }}\n.in1\n{{ range b }}\n.in2\n{{ end }}\n.in3\n{{ end }}\n.out\n",
    ),
    [".out"],
  );
  assert.deepEqual(unconditionalLines("{{ if x }}.a{{ end }}\n.b\n"), [".b"]);
});

test("matchesChezmoiGlob: follows doublestar semantics", () => {
  assert.equal(
    matchesChezmoiGlob("**/*.test.ts", ".claude/hooks/tests/unit/a.test.ts"),
    true,
  );
  assert.equal(matchesChezmoiGlob("**/*.test.ts", "a.test.ts"), true);
  assert.equal(matchesChezmoiGlob(".claude/*.ts", ".claude/x.ts"), true);
  assert.equal(matchesChezmoiGlob(".claude/*.ts", ".claude/a/x.ts"), false);
  assert.equal(matchesChezmoiGlob(".claude/**", ".claude/a/b.ts"), true);
  assert.equal(matchesChezmoiGlob(".claude/x?.ts", ".claude/x1.ts"), true);
  assert.equal(matchesChezmoiGlob(".claude/x?.ts", ".claude/x/.ts"), false);
  assert.equal(
    matchesChezmoiGlob(".claude/bun.lock", ".claude/bun.lock"),
    true,
  );
  assert.equal(
    matchesChezmoiGlob(".claude/bun.lock", ".claude/bunXlock"),
    false,
  );
});

test("externalTargets: lists table names and skips sub-tables", () => {
  const toml = [
    '{{ if ne .chezmoi.os "windows" }}',
    '[".zsh/ni.zsh"]',
    'type = "file"',
    "{{ end }}",
    '[".claude/skills/claude-recall"]',
    '[".local/share/private-skills"]',
    '[".local/share/private-skills".pull]',
    'args = ["--ff-only"]',
  ].join("\n");
  assert.deepEqual(externalTargets(toml), [
    ".zsh/ni.zsh",
    ".claude/skills/claude-recall",
    ".local/share/private-skills",
  ]);
});

test("externalTargets: reads the real .chezmoiexternal.toml.tmpl", () => {
  const { externalText } = loadRepoInputs(repoRoot());
  const targets = externalTargets(externalText);
  for (const expected of [
    ".zsh/ni.zsh",
    ".claude/skills/ui-skills/SKILL.md",
    ".claude/skills/claude-recall",
    ".local/share/private-skills",
    ".local/bin/wsl2-ssh-agent",
  ]) {
    assert.ok(targets.includes(expected), expected);
  }
  assert.ok(!targets.some((target) => target.endsWith(".pull")));
});

test("findMissingRemovals: deleted source needs a removal line", () => {
  const deleted = ["home/dot_claude/foo.ts"];
  assert.deepEqual(missing({ deletedSources: deleted }), [".claude/foo.ts"]);
  assert.deepEqual(
    missing({ deletedSources: deleted, removeLines: [".claude/foo.ts"] }),
    [],
  );
  assert.deepEqual(
    missing({ deletedSources: deleted, removeLines: [".claude/*.ts"] }),
    [],
  );
});

test("findMissingRemovals: targets that are still managed are not leftovers", () => {
  assert.deepEqual(
    missing({
      deletedSources: ["home/dot_codex/private_config.toml.tmpl"],
      currentSources: ["home/dot_codex/modify_private_config.toml"],
    }),
    [],
  );
  assert.deepEqual(
    missing({
      deletedSources: ["home/dot_claude/bun.lock"],
      keep: [".claude/bun.lock"],
    }),
    [],
  );
  assert.deepEqual(
    missing({
      deletedSources: ["home/dot_zsh/ni.zsh"],
      externals: [".zsh/ni.zsh"],
    }),
    [],
  );
  assert.deepEqual(
    missing({
      deletedSources: ["home/dot_claude/a.test.ts"],
      ignoreLines: ["**/*.test.ts"],
    }),
    [],
  );
});

test("findMissingRemovals: conditional ignore lines do not hide leftovers", () => {
  assert.deepEqual(
    missing({
      deletedSources: ["home/dot_local/bin/executable_claude-zai"],
      ignoreLines: [],
    }),
    [".local/bin/claude-zai"],
  );
});

test("findMissingRemovals: sorted, deduplicated, skips non-targets", () => {
  assert.deepEqual(
    missing({
      deletedSources: [
        "home/dot_b",
        "home/dot_a",
        "home/dot_a.tmpl",
        "home/.chezmoiscripts/run_after_x.sh",
      ],
    }),
    [".a", ".b"],
  );
});

test("findLiveRemovals: flags lines that hit managed targets", () => {
  assert.deepEqual(
    live({
      removeLines: [".claude/x.ts"],
      currentSources: ["home/dot_claude/x.ts"],
    }),
    [".claude/x.ts"],
  );
  assert.deepEqual(
    live({
      removeLines: [".claude/*"],
      currentSources: ["home/dot_claude/x.ts"],
    }),
    [".claude/*"],
  );
  assert.deepEqual(
    live({ removeLines: [".claude/bun.lock"], keep: [".claude/bun.lock"] }),
    [".claude/bun.lock"],
  );
  assert.deepEqual(live({ removeLines: [".gone"] }), []);
});

test("findLiveRemovals: directory lines remove everything underneath", () => {
  assert.deepEqual(
    live({
      removeLines: [".claude/hooks"],
      currentSources: ["home/dot_claude/hooks/a.ts"],
    }),
    [".claude/hooks"],
  );
  assert.deepEqual(
    live({
      removeLines: [".claude/skills/claude-recall/x"],
      externals: [".claude/skills/claude-recall"],
    }),
    [".claude/skills/claude-recall/x"],
  );
  assert.deepEqual(
    live({
      removeLines: [".claude/skills/foo"],
      keep: [".claude/skills/**"],
    }),
    [".claude/skills/foo"],
  );
  assert.deepEqual(
    live({ removeLines: [".claude"], keep: [".claude/skills/**"] }),
    [".claude"],
  );
});

test("findLiveRemovals: the real KEEP constant covers run-script outputs", () => {
  const removeLines = [
    ".claude/settings.json",
    ".config/textlint/node_modules/x",
    ".claude/.last-gc",
  ];
  assert.deepEqual(live({ removeLines, keep: KEEP }), removeLines);
});

test("KEEP does not cover arbitrary dotfiles under .claude", () => {
  assert.deepEqual(
    missing({ deletedSources: ["home/dot_claude/dot_foo"], keep: KEEP }),
    [".claude/.foo"],
  );
});

test("restoring a deleted file: the stale removal line is the failure", () => {
  const base = {
    deletedSources: ["home/dot_claude/foo.ts"],
    currentSources: ["home/dot_claude/foo.ts"],
  };
  assert.deepEqual(live({ ...base, removeLines: [".claude/foo.ts"] }), [
    ".claude/foo.ts",
  ]);
  assert.deepEqual(missing({ ...base }), []);
  assert.deepEqual(live({ ...base }), []);
});

test("failure messages list one path per line with the remedy", () => {
  const missingMessage = formatMissingMessage([".a", ".b"]);
  assert.match(missingMessage, /^\.a$/m);
  assert.match(missingMessage, /^\.b$/m);
  assert.match(missingMessage, /home\/\.chezmoiremove/);
  const liveMessage = formatLiveMessage([
    { line: ".claude/x.ts", origin: "source" },
  ]);
  assert.match(liveMessage, /\.claude\/x\.ts/);
  assert.match(liveMessage, /source/);
  assert.match(liveMessage, /home\/\.chezmoiremove/);
});

// --- Real repository ---------------------------------------------------

const root = repoRoot();
const shallow = isShallowRepository(root);
const inCi = process.env.CI === "true";
const SHALLOW_ADVICE =
  "history is truncated (shallow clone); run `git fetch --unshallow` (CI: set fetch-depth: 0 on checkout)";
const repoOptions = shallow && !inCi ? { skip: SHALLOW_ADVICE } : {};

test("real repo: history is complete", (t) => {
  if (!shallow) return;
  if (inCi) assert.fail(SHALLOW_ADVICE);
  t.skip(SHALLOW_ADVICE);
});

test("real repo: HEAD findMissingRemovals is []", repoOptions, () => {
  const inputs = loadRepoInputs(root);
  assert.deepEqual(
    findMissingRemovals(inputs),
    [],
    formatMissingMessage(findMissingRemovals(inputs)),
  );
});

test("real repo: HEAD findLiveRemovals is []", repoOptions, () => {
  const inputs = loadRepoInputs(root);
  const offenders = findLiveRemovals(inputs);
  assert.deepEqual(offenders, [], formatLiveMessage(offenders));
});

test(
  "real repo: pre-1aa8e366 .chezmoiremove misses the 11 lines it added",
  repoOptions,
  () => {
    try {
      execFileSync("git", ["cat-file", "-e", "1aa8e366"], {
        cwd: root,
        stdio: "ignore",
      });
    } catch {
      assert.fail(
        "commit 1aa8e366 is not reachable (history rewritten?): update or remove this case",
      );
    }
    const show = (rev) =>
      execFileSync("git", ["show", `${rev}:home/.chezmoiremove`], {
        cwd: root,
        encoding: "utf8",
      })
        .split("\n")
        .filter(Boolean);
    const before = show("1aa8e366^");
    const added = show("1aa8e366").filter((line) => !before.includes(line));
    assert.equal(added.length, 11);
    const inputs = loadRepoInputs(root);
    const result = findMissingRemovals({ ...inputs, removeLines: before });
    for (const line of added) {
      assert.ok(result.includes(line), `${line} should be reported missing`);
    }
  },
);

test("real repo: home/.chezmoiremove has no template syntax", () => {
  const { removeLines } = loadRepoInputs(root);
  assert.ok(
    removeLines.every((line) => !line.includes("{{")),
    "the coverage check does not evaluate templates; keep .chezmoiremove plain",
  );
});

test(
  "real repo: sourceToTarget agrees with chezmoi target-path",
  {
    skip: (() => {
      try {
        execFileSync("chezmoi", ["--version"], { stdio: "ignore" });
        return false;
      } catch {
        return "chezmoi is not on PATH";
      }
    })(),
  },
  () => {
    const { currentSources } = loadRepoInputs(root);
    const sources = currentSources.filter(
      (source) => sourceToTarget(source) !== null,
    );
    const actual = chezmoiTargetPaths(root, sources).map((path) =>
      path.startsWith(`${homedir()}/`)
        ? path.slice(homedir().length + 1)
        : path,
    );
    const expected = sources.map((source) => sourceToTarget(source));
    assert.equal(actual.length, expected.length);
    const mismatches = expected
      .map((target, index) => ({
        source: sources[index],
        target,
        chezmoi: actual[index],
      }))
      .filter((row) => row.target !== row.chezmoi);
    assert.deepEqual(mismatches, []);
  },
);
