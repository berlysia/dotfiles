import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import test from "node:test";
import {
  chezmoiTargetPaths,
  externalTargets,
  findLiveRemovals,
  findMissingRemovals,
  formatLiveMessage,
  formatMissingMessage,
  isShallowRepository,
  loadRepoInputs,
  repoRoot,
  sourceToTarget,
} from "../lib/chezmoiremove-coverage.mjs";

// The tests below read the real repository through git (history, ls-files,
// diff), so they live in the heavy suite. The pure-function tests stay in
// tests/chezmoiremove-coverage.test.mjs.

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
