import assert from "node:assert/strict";
import test from "node:test";
import {
  KEEP,
  externalTargets,
  findLiveRemovals,
  findMissingRemovals,
  formatLiveMessage,
  formatMissingMessage,
  matchesChezmoiGlob,
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
