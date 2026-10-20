import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Targets that stay deployed although no source file maps to them: a run
// script under home/.chezmoiscripts creates or refreshes them on every apply.
// A .chezmoiremove line for one of these would delete it on every apply, so
// findLiveRemovals treats them like managed targets. Entries are glob patterns
// but deliberately specific (no `.claude/.*`): a broad glob would also hide a
// leftover from a deleted `home/dot_claude/dot_foo`. Delete an entry together
// with its reason. This list is maintained by hand, so a new run script that
// writes somewhere needs a new entry here.
export const KEEP = [
  // run_after_10-install-hook-deps.sh.tmpl: `bun install` in ~/.claude
  ".claude/bun.lock",
  ".claude/node_modules/**",
  // run_after_sync-skills.sh.tmpl: rsync from .skills/ (and private-skills)
  ".claude/skills/**",
  ".codex/skills/**",
  // run_after_sync-mods.sh.tmpl: rsync from mods/
  ".claude/mods/**",
  // run_onchange_update-settings-json.sh.tmpl: assembled with jq from the .settings.*.json parts
  ".claude/settings.json",
  // run_onchange_update-settings-json.sh.tmpl: records when the auto-mode experiment was deployed
  ".claude/logs/auto-mode-experiment/deployed-at",
  // run_after_gc.sh.tmpl: timestamp of the last garbage collection
  ".claude/.last-gc",
  // run_after_10-install-apm-skills.sh.tmpl: records the installed external skill set
  ".claude/.external-skills-installed",
  // run_onchange_install-claude-plugins-8.sh.tmpl: records the installed plugin set
  ".claude/.managed-plugins-installed",
  // run_after_register-distill-insights-schedule.sh.tmpl: hash of the registered launchd plist
  ".claude/.distill-insights-plist.sha256",
  // run_after_10-install-apm-skills.sh.tmpl: failure marker read by zz-verify-provisioning
  ".claude/.apm-skills-install-failed",
  // run_after_10-install-hook-deps.sh.tmpl: failure marker read by zz-verify-provisioning
  ".claude/.hook-deps-install-failed",
  // run_after_10-install-root-deps.sh.tmpl: failure marker read by zz-verify-provisioning
  ".claude/.root-deps-install-failed",
  // run_after_update-skill-approvals.sh.tmpl: failure marker read by zz-verify-provisioning
  ".claude/.skill-allow-failed",
  // run_after_update-skill-approvals.sh.tmpl: failure marker read by zz-verify-provisioning
  ".claude/.skill-approvals-sync-failed",
  // run_after_10-install-textlint-deps.sh.tmpl: `bun install` in ~/.config/textlint
  ".config/textlint/node_modules/**",
];

// Attribute prefixes chezmoi strips, from the documented attribute list.
const DIR_PREFIXES = [
  "exact_",
  "external_",
  "private_",
  "readonly_",
  "remove_",
];
const FILE_PREFIXES = [
  "create_",
  "empty_",
  "encrypted_",
  "executable_",
  "modify_",
  "private_",
  "readonly_",
  "symlink_",
];

// Strips attribute prefixes from one path element until none is left, then
// converts dot_. `literal_` ends attribute parsing, so what follows is kept
// verbatim (that is how a file can really be named `dot_x`).
function convertElement(element, prefixes) {
  let rest = element;
  let literal = false;
  for (;;) {
    if (rest.startsWith("literal_")) {
      rest = rest.slice("literal_".length);
      literal = true;
      break;
    }
    const prefix = prefixes.find((candidate) => rest.startsWith(candidate));
    if (prefix === undefined) break;
    rest = rest.slice(prefix.length);
  }
  if (!literal && rest.startsWith("dot_"))
    rest = `.${rest.slice("dot_".length)}`;
  return rest;
}

// A deleted source cannot be passed to `chezmoi target-path` (it fails on
// missing files), so the target name is derived from the source name.
export function sourceToTarget(sourcePath) {
  if (!sourcePath.startsWith("home/")) return null;
  const elements = sourcePath.slice("home/".length).split("/");
  // chezmoi ignores dot-prefixed source entries (.chezmoiscripts, .chezmoiremove, ...).
  if (elements.some((element) => element.startsWith("."))) return null;
  const fileName = elements[elements.length - 1];
  const dirs = elements.slice(0, -1);
  if (dirs.some((dir) => dir.startsWith("remove_"))) return null;
  if (fileName.startsWith("run_") || fileName.startsWith("remove_"))
    return null;
  if (fileName.endsWith(".age") || fileName.endsWith(".asc")) return null;

  let convertedName = convertElement(fileName, FILE_PREFIXES);
  if (convertedName.endsWith(".tmpl"))
    convertedName = convertedName.slice(0, -".tmpl".length);
  if (convertedName.endsWith(".literal"))
    convertedName = convertedName.slice(0, -".literal".length);
  return [
    ...dirs.map((dir) => convertElement(dir, DIR_PREFIXES)),
    convertedName,
  ].join("/");
}

const BLOCK_OPEN = /\{\{-?\s*(?:if|range|with|define|block)\b/g;
const BLOCK_CLOSE = /\{\{-?\s*end\b/g;

// Only lines outside every template block are in effect on every machine;
// lines inside a block depend on the machine, so they are not relied on.
export function unconditionalLines(templateText) {
  const lines = [];
  let depth = 0;
  for (const rawLine of templateText.split("\n")) {
    const depthBefore = depth;
    depth += (rawLine.match(BLOCK_OPEN) ?? []).length;
    depth -= (rawLine.match(BLOCK_CLOSE) ?? []).length;
    if (depth < 0) depth = 0;
    const line = rawLine.trim();
    if (depthBefore !== 0 || line === "" || line.includes("{{")) continue;
    if (line.startsWith("#") || line.startsWith("!")) continue;
    lines.push(line);
  }
  return lines;
}

// node's path.matchesGlob skips dot-prefixed elements for `*` and `**`, but
// chezmoi's doublestar matches them, so the translation is done by hand:
// `*` stays inside one element, `**` crosses `/`, `?` is one non-`/` char.
export function matchesChezmoiGlob(pattern, target) {
  let source = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === "*" && pattern[index + 1] === "*") {
      if (pattern[index + 2] === "/") {
        source += "(?:.*/)?";
        index += 2;
      } else {
        source += ".*";
        index += 1;
      }
    } else if (char === "*") {
      source += "[^/]*";
    } else if (char === "?") {
      source += "[^/]";
    } else {
      source += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${source}$`).test(target);
}

// External table names look like `[".zsh/ni.zsh"]`; sub-tables such as
// `[".x".pull]` have text after the closing quote and are not matched.
export function externalTargets(externalToml) {
  return [...externalToml.matchAll(/^\["([^"]+)"\]\s*$/gm)].map(
    (match) => match[1],
  );
}

function targetsOf(sources) {
  return new Set(
    sources.map(sourceToTarget).filter((target) => target !== null),
  );
}

export function findMissingRemovals({
  deletedSources,
  currentSources,
  removeLines,
  ignoreLines,
  externals,
  keep,
}) {
  const current = targetsOf(currentSources);
  const externalSet = new Set(externals);
  const covered = (target) =>
    current.has(target) ||
    externalSet.has(target) ||
    keep.some((pattern) => matchesChezmoiGlob(pattern, target)) ||
    ignoreLines.some((pattern) => matchesChezmoiGlob(pattern, target)) ||
    removeLines.some(
      (line) => line === target || matchesChezmoiGlob(line, target),
    );
  const leftovers = new Set();
  for (const source of deletedSources) {
    const target = sourceToTarget(source);
    if (target !== null && !covered(target)) leftovers.add(target);
  }
  return [...leftovers].sort();
}

// Fixed leading directory of a glob: ".claude/skills/**" -> ".claude/skills".
function globBaseDir(pattern) {
  const wildcard = pattern.search(/[*?]/);
  if (wildcard === -1) return pattern;
  return pattern.slice(0, Math.max(pattern.lastIndexOf("/", wildcard), 0));
}

// Where a removal line hits something still deployed, or null. chezmoi removes
// a directory line with everything under it, so ancestors count as hits.
function liveOrigin(line, { currentTargets, externals, keep }) {
  const hits = (target) => line === target || matchesChezmoiGlob(line, target);
  const above = (target) => target.startsWith(`${line}/`);
  if ([...currentTargets].some((target) => hits(target) || above(target)))
    return "source";
  if (
    externals.some(
      (target) =>
        hits(target) || above(target) || line.startsWith(`${target}/`),
    )
  ) {
    return "external";
  }
  for (const pattern of keep) {
    const baseDir = globBaseDir(pattern);
    if (
      hits(pattern) ||
      matchesChezmoiGlob(pattern, line) ||
      baseDir === line ||
      baseDir.startsWith(`${line}/`)
    ) {
      return "keep";
    }
  }
  return null;
}

export function liveRemovalOrigins({
  removeLines,
  currentSources,
  externals,
  keep,
}) {
  const context = {
    currentTargets: targetsOf(currentSources),
    externals,
    keep,
  };
  const offenders = [];
  for (const line of removeLines) {
    const origin = liveOrigin(line, context);
    if (origin !== null) offenders.push({ line, origin });
  }
  return offenders;
}

export function findLiveRemovals(inputs) {
  return liveRemovalOrigins(inputs).map((offender) => offender.line);
}

export function formatMissingMessage(targets) {
  return [
    "Deleted source files whose target is not covered by home/.chezmoiremove:",
    ...targets,
    "Add these lines to home/.chezmoiremove. Do not remove a line unless you restore the deleted file.",
  ].join("\n");
}

export function formatLiveMessage(offenders) {
  return [
    "home/.chezmoiremove lines that hit a target chezmoi still deploys:",
    ...offenders.map(({ line, origin }) => `${line}  (${origin})`),
    "If you restored the deleted file, remove these lines from home/.chezmoiremove.",
  ].join("\n");
}

// --- Loading real-repository inputs (git and chezmoi, never through a shell) ---

function git(root, args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" });
}

export function repoRoot() {
  return execFileSync("git", ["rev-parse", "--show-toplevel"], {
    cwd: import.meta.dirname,
    encoding: "utf8",
  }).trim();
}

export function isShallowRepository(root) {
  return git(root, ["rev-parse", "--is-shallow-repository"]).trim() === "true";
}

const lines = (text) => text.split("\n").filter((line) => line !== "");

export function loadRepoInputs(root) {
  // --no-renames: git otherwise reports a rename as R, which --diff-filter=D
  // skips, hiding the old path of a moved file. The cached diff adds deletions
  // staged but not committed yet, so pre-commit sees them.
  const deletedSources = [
    ...new Set([
      ...lines(
        git(root, [
          "log",
          "--no-renames",
          "--diff-filter=D",
          "--name-only",
          "--format=",
          "--",
          "home/",
        ]),
      ),
      ...lines(
        git(root, [
          "diff",
          "--cached",
          "--no-renames",
          "--diff-filter=D",
          "--name-only",
          "--",
          "home/",
        ]),
      ),
    ]),
  ];
  const currentSources = lines(git(root, ["ls-files", "--", "home/"]));
  const read = (name) => readFileSync(join(root, "home", name), "utf8");
  const externalText = read(".chezmoiexternal.toml.tmpl");
  return {
    deletedSources,
    currentSources,
    removeLines: lines(read(".chezmoiremove"))
      .map((line) => line.trim())
      .filter((line) => line !== ""),
    ignoreLines: unconditionalLines(read(".chezmoiignore")),
    externals: externalTargets(externalText),
    externalText,
    keep: KEEP,
  };
}

// One call for all sources: `chezmoi target-path` fails on missing files and
// is slow to start. Absolute paths make the result independent of cwd.
export function chezmoiTargetPaths(root, sourcePaths) {
  const output = execFileSync(
    "chezmoi",
    ["target-path", ...sourcePaths.map((source) => join(root, source))],
    { cwd: root, encoding: "utf8" },
  );
  return lines(output);
}
