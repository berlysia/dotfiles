// Guards .github/actions/install-chezmoi/action.yml: the install script verifies the tarball
// against the release's checksums.txt before anything is written to install-dir, and the
// version line is wired to Renovate. The script is extracted from action.yml and run with
// stub curl/uname, so what is tested is the text that CI executes.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const ACTION_PATH = ".github/actions/install-chezmoi/action.yml";
const STEP_NAME = "Install chezmoi";
const VERSION_RE = /CHEZMOI_VERSION: "(?<version>[0-9]+\.[0-9]+\.[0-9]+)"/;

const readRepoFile = (relativePath) =>
  readFileSync(join(repoRoot, relativePath), "utf8");

// ---- action.yml helpers (take contents, so RED can be shown with modified copies) ----

/** Body of the `run: |` block of the "Install chezmoi" step, dedented. */
export function extractInstallScript(actionText) {
  const lines = actionText.split("\n");
  const stepStart = lines.findIndex((line) =>
    new RegExp(`^\\s*- name: ${STEP_NAME}\\s*$`).test(line),
  );
  assert.notEqual(
    stepStart,
    -1,
    `step "${STEP_NAME}" not found in ${ACTION_PATH}`,
  );
  const stepIndent = lines[stepStart].search(/\S/);
  let runLine = -1;
  for (let i = stepStart + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.trim() !== "" && line.search(/\S/) <= stepIndent) break;
    if (/^\s*run: \|\s*$/.test(line)) {
      runLine = i;
      break;
    }
  }
  assert.notEqual(
    runLine,
    -1,
    `\`run: |\` of step "${STEP_NAME}" not found in ${ACTION_PATH}`,
  );
  const runIndent = lines[runLine].search(/\S/);
  const body = [];
  for (let i = runLine + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.trim() !== "" && line.search(/\S/) <= runIndent) break;
    body.push(line);
  }
  const bodyIndent = Math.min(
    ...body.filter((l) => l.trim() !== "").map((l) => l.search(/\S/)),
  );
  return body.map((l) => l.slice(bodyIndent)).join("\n");
}

export function readPinnedVersion(actionText) {
  const match = VERSION_RE.exec(actionText);
  assert.ok(match, `CHEZMOI_VERSION: "x.y.z" line not found in ${ACTION_PATH}`);
  return match.groups.version;
}

// ---- Renovate wiring checks: return a list of problems, empty when wired ----

const toTriple = (version) => version.split(".").map(Number);

function compareTriples(a, b) {
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

/** Pinned version must not be older than the floor chezmoi apply demands. */
export function checkVersionFloor(actionText, chezmoiVersionText) {
  const pinned = readPinnedVersion(actionText);
  const floor = chezmoiVersionText.trim();
  if (!/^[0-9]+\.[0-9]+\.[0-9]+$/.test(floor)) {
    return [`.chezmoiversion is not x.y.z: ${JSON.stringify(floor)}`];
  }
  return compareTriples(toTriple(pinned), toTriple(floor)) >= 0
    ? []
    : [`pinned ${pinned} is older than .chezmoiversion ${floor}`];
}

const LOOKAROUND_OR_BACKREF = /\(\?<?[=!]|\\[1-9]|\\k</;

function toRegExp(pattern) {
  const slashed = /^\/(.*)\/$/s.exec(pattern);
  return slashed ? new RegExp(slashed[1]) : null;
}

export function checkRenovateWiring(renovateConfig, actionText) {
  const problems = [];

  const managers = (renovateConfig.customManagers ?? []).filter(
    (m) => m.depNameTemplate === "chezmoi",
  );
  if (managers.length !== 1) {
    problems.push(
      `expected exactly 1 customManager with depNameTemplate "chezmoi", found ${managers.length}`,
    );
  } else {
    const [manager] = managers;
    if (manager.customType !== "regex") {
      problems.push(`customType is ${manager.customType}, expected regex`);
    }
    if (manager.packageNameTemplate !== "twpayne/chezmoi") {
      problems.push(
        `packageNameTemplate is ${manager.packageNameTemplate}, expected twpayne/chezmoi`,
      );
    }
    if (manager.datasourceTemplate !== "github-releases") {
      problems.push(
        `datasourceTemplate is ${manager.datasourceTemplate}, expected github-releases`,
      );
    }
    if (manager.extractVersionTemplate !== "^v(?<version>.+)$") {
      problems.push(
        `extractVersionTemplate is ${manager.extractVersionTemplate}, expected ^v(?<version>.+)$`,
      );
    }
    const patterns = (manager.managerFilePatterns ?? []).map(toRegExp);
    if (patterns.length === 0 || patterns.includes(null)) {
      problems.push("managerFilePatterns must be non-empty /regex/ entries");
    } else if (!patterns.some((re) => re.test(ACTION_PATH))) {
      problems.push(`managerFilePatterns does not match ${ACTION_PATH}`);
    }
    if ((manager.matchStrings ?? []).length !== 1) {
      problems.push(
        `expected exactly 1 matchString, found ${(manager.matchStrings ?? []).length}`,
      );
    } else {
      const [matchString] = manager.matchStrings;
      if (LOOKAROUND_OR_BACKREF.test(matchString)) {
        problems.push("matchString uses lookaround or a backreference");
      } else {
        const matches = [...actionText.matchAll(new RegExp(matchString, "g"))];
        if (matches.length !== 1) {
          problems.push(
            `matchString matches ${ACTION_PATH} ${matches.length} times, expected 1`,
          );
        } else if (
          !/^[0-9]+\.[0-9]+\.[0-9]+$/.test(
            matches[0].groups?.currentValue ?? "",
          )
        ) {
          problems.push(
            `currentValue is ${JSON.stringify(matches[0].groups?.currentValue)}, expected x.y.z`,
          );
        }
      }
    }
  }

  const rules = renovateConfig.packageRules ?? [];
  const chezmoiRules = rules.filter((r) =>
    (r.matchDepNames ?? []).includes("chezmoi"),
  );
  if (chezmoiRules.length !== 1) {
    problems.push(
      `expected exactly 1 packageRule with matchDepNames including "chezmoi", found ${chezmoiRules.length}`,
    );
  } else {
    const [rule] = chezmoiRules;
    if (JSON.stringify(rule.matchManagers) !== '["custom.regex"]') {
      problems.push(
        `matchManagers is ${JSON.stringify(rule.matchManagers)}, expected ["custom.regex"]`,
      );
    }
    if (rule.minimumReleaseAge !== "7 days") {
      problems.push(
        `minimumReleaseAge is ${rule.minimumReleaseAge}, expected "7 days"`,
      );
    }
    if (rule.groupName !== "chezmoi") {
      problems.push(`groupName is ${rule.groupName}, expected "chezmoi"`);
    }
    if (rule.automerge !== false) {
      problems.push(`automerge is ${rule.automerge}, expected false`);
    }
    if (rules.at(-1) !== rule) {
      problems.push(
        "chezmoi rule must be last in packageRules (later rules win over :automergeMinor)",
      );
    }
  }
  return problems;
}

// ---- running the install script against stub curl / uname ----

const sha256 = (buffer) => createHash("sha256").update(buffer).digest("hex");

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", ...options });
  assert.equal(result.error, undefined, `${command} failed to start`);
  return result;
}

function writeExecutable(path, content) {
  writeFileSync(path, content);
  chmodSync(path, 0o755);
}

const CURL_STUB = `#!/usr/bin/env bash
set -u
( IFS=$'\\037'; printf '%s\\n' "$*" ) >> "$STUB_CURL_LOG"
out=""
prev=""
for arg in "$@"; do
  if [ "$prev" = "-o" ]; then out="$arg"; fi
  prev="$arg"
  url="$arg"
done
src="$STUB_FIXTURES/\${url##*/}"
[ -f "$src" ] || exit 22
cp "$src" "$out"
`;

const UNAME_STUB = `#!/usr/bin/env bash
case "$1" in
  -s) echo "$STUB_UNAME_S" ;;
  -m) echo "$STUB_UNAME_M" ;;
  *) echo "unexpected uname args: $*" >&2; exit 2 ;;
esac
`;

/**
 * Builds a scratch world: stub bin dir, fixture dir with a tarball and checksums.txt,
 * and an install dir path. `mutate` can tamper with fixtures before the script runs.
 */
function makeWorld({
  version = readPinnedVersion(readRepoFile(ACTION_PATH)),
} = {}) {
  const root = mkdtempSync(join(tmpdir(), "install-chezmoi-test-"));
  const bin = join(root, "bin");
  const fixtures = join(root, "fixtures");
  const pack = join(root, "pack");
  mkdirSync(bin);
  mkdirSync(fixtures);
  mkdirSync(pack);
  writeExecutable(join(bin, "curl"), CURL_STUB);
  writeExecutable(join(bin, "uname"), UNAME_STUB);

  writeExecutable(
    join(pack, "chezmoi"),
    `#!/bin/sh\necho "chezmoi version v${version}"\n`,
  );
  writeFileSync(join(pack, "README.md"), "readme\n");
  const tarball = `chezmoi_${version}_linux_amd64.tar.gz`;
  run("tar", [
    "-czf",
    join(fixtures, tarball),
    "-C",
    pack,
    "chezmoi",
    "README.md",
  ]);
  const digest = sha256(readFileSync(join(fixtures, tarball)));
  const checksumsName = `chezmoi_${version}_checksums.txt`;
  writeFileSync(
    join(fixtures, checksumsName),
    [
      `${"a".repeat(64)}  chezmoi_${version}_darwin_amd64.tar.gz`,
      `${digest}  ${tarball}`,
      `${"b".repeat(64)}  ${tarball}.sbom.json`,
      "",
    ].join("\n"),
  );

  return {
    root,
    bin,
    fixtures,
    tarball,
    digest,
    checksumsName,
    checksumsPath: join(fixtures, checksumsName),
    tarballPath: join(fixtures, tarball),
    installDir: join(root, "nested", "install-dir"),
    curlLog: join(root, "curl.log"),
    version,
  };
}

function runInstall(world, script, env = {}) {
  writeFileSync(world.curlLog, "");
  const result = run("bash", ["-c", script], {
    env: {
      ...process.env,
      PATH: `${world.bin}:${process.env.PATH}`,
      HOME: world.root,
      INSTALL_DIR: world.installDir,
      CHEZMOI_VERSION: world.version,
      STUB_FIXTURES: world.fixtures,
      STUB_CURL_LOG: world.curlLog,
      STUB_UNAME_S: "Linux",
      STUB_UNAME_M: "x86_64",
      ...env,
    },
  });
  const curlCalls = readFileSync(world.curlLog, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => line.split("\u001f"));
  return { ...result, output: `${result.stdout}${result.stderr}`, curlCalls };
}

const loadInstallScript = () => extractInstallScript(readRepoFile(ACTION_PATH));

/** Runs `scenario(world)`; always removes the scratch dir. */
function withWorld(options, scenario) {
  const world = makeWorld(options);
  try {
    return scenario(world);
  } finally {
    rmSync(world.root, { recursive: true, force: true });
  }
}

function assertRefused(result, world, { stage } = {}) {
  assert.notEqual(result.status, 0, `expected failure, got:\n${result.output}`);
  assert.match(result.output, /::error::/);
  if (stage) assert.match(result.output, new RegExp(stage));
  assert.equal(
    existsSync(join(world.installDir, "chezmoi")),
    false,
    "chezmoi must not be installed after a failed check",
  );
}

function replaceChecksumsLine(world, transform) {
  const lines = readFileSync(world.checksumsPath, "utf8").split("\n");
  writeFileSync(world.checksumsPath, lines.map(transform).join("\n"));
}

const isTarballLine = (world) => (line) => line.endsWith(`  ${world.tarball}`);

test("success: installs a verified binary into a new install-dir with hardened curl calls", () => {
  withWorld({}, (world) => {
    const result = runInstall(world, loadInstallScript());
    assert.equal(result.status, 0, result.output);
    assert.match(
      result.stdout,
      new RegExp(`chezmoi version v${world.version}`),
    );
    const installed = join(world.installDir, "chezmoi");
    assert.equal(
      run(installed, ["--version"]).stdout.trim(),
      `chezmoi version v${world.version}`,
    );
    assert.equal(result.curlCalls.length, 2);
    for (const args of result.curlCalls) {
      const pairs = args.map((arg, i) => [arg, args[i + 1]]);
      assert.ok(
        pairs.some(([a, b]) => a === "--proto" && b === "=https"),
        args.join(" "),
      );
      assert.ok(
        pairs.some(([a, b]) => a === "--proto-redir" && b === "=https"),
        args.join(" "),
      );
      assert.ok(
        args.some((a) => a === "--fail" || /^-[a-zA-Z]*f[a-zA-Z]*$/.test(a)),
        args.join(" "),
      );
      assert.ok(
        args
          .at(-1)
          .startsWith(
            `https://github.com/twpayne/chezmoi/releases/download/v${world.version}/`,
          ),
        args.at(-1),
      );
    }
    const fetched = result.curlCalls.map((args) =>
      args.at(-1).split("/").at(-1),
    );
    assert.deepEqual(
      fetched.sort(),
      [world.checksumsName, world.tarball].sort(),
    );
  });
});

test("success: expands a leading $HOME in install-dir", () => {
  withWorld({}, (world) => {
    const result = runInstall(world, loadInstallScript(), {
      INSTALL_DIR: "$HOME/.local/bin",
    });
    assert.equal(result.status, 0, result.output);
    assert.equal(
      existsSync(join(world.root, ".local", "bin", "chezmoi")),
      true,
    );
  });
});

test("refuses a checksums line whose hex differs by one character", () => {
  withWorld({}, (world) => {
    replaceChecksumsLine(world, (line) =>
      isTarballLine(world)(line)
        ? `${line[0] === "0" ? "1" : "0"}${line.slice(1)}`
        : line,
    );
    assertRefused(runInstall(world, loadInstallScript()), world, {
      stage: "checksum",
    });
  });
});

test("refuses a 63-digit hex", () => {
  withWorld({}, (world) => {
    replaceChecksumsLine(world, (line) =>
      isTarballLine(world)(line) ? line.slice(1) : line,
    );
    assertRefused(runInstall(world, loadInstallScript()), world, {
      stage: "checksum",
    });
  });
});

test("refuses a tarball whose content changed after the checksum was taken", () => {
  withWorld({}, (world) => {
    const bytes = readFileSync(world.tarballPath);
    bytes[bytes.length - 5] ^= 0xff;
    writeFileSync(world.tarballPath, bytes);
    assertRefused(runInstall(world, loadInstallScript()), world);
  });
});

test("refuses when checksums.txt has no line for the tarball", () => {
  withWorld({}, (world) => {
    replaceChecksumsLine(world, (line) =>
      isTarballLine(world)(line) ? "" : line,
    );
    assertRefused(runInstall(world, loadInstallScript()), world, {
      stage: "checksum line",
    });
  });
});

test("refuses when only a `<tarball>.sbom.json` line exists", () => {
  withWorld({}, (world) => {
    writeFileSync(
      world.checksumsPath,
      `${"b".repeat(64)}  ${world.tarball}.sbom.json\n`,
    );
    assertRefused(runInstall(world, loadInstallScript()), world, {
      stage: "checksum line",
    });
  });
});

test("refuses when checksums.txt has the tarball line twice", () => {
  withWorld({}, (world) => {
    const original = readFileSync(world.checksumsPath, "utf8");
    writeFileSync(
      world.checksumsPath,
      `${original}${world.digest}  ${world.tarball}\n`,
    );
    assertRefused(runInstall(world, loadInstallScript()), world, {
      stage: "checksum line",
    });
  });
});

test("refuses an empty checksums.txt", () => {
  withWorld({}, (world) => {
    writeFileSync(world.checksumsPath, "");
    assertRefused(runInstall(world, loadInstallScript()), world, {
      stage: "checksum line",
    });
  });
});

test("refuses when the tarball download fails (404)", () => {
  withWorld({}, (world) => {
    rmSync(world.tarballPath);
    assertRefused(runInstall(world, loadInstallScript()), world, {
      stage: "download",
    });
  });
});

test("refuses when the checksums.txt download fails (404)", () => {
  withWorld({}, (world) => {
    rmSync(world.checksumsPath);
    assertRefused(runInstall(world, loadInstallScript()), world, {
      stage: "download",
    });
  });
});

test("a failed check does not create a missing install-dir", () => {
  withWorld({}, (world) => {
    writeFileSync(world.checksumsPath, "");
    const result = runInstall(world, loadInstallScript());
    assert.notEqual(result.status, 0);
    assert.equal(existsSync(world.installDir), false);
    assert.equal(existsSync(join(world.root, "nested")), false);
  });
});

test("a failed check leaves an existing chezmoi untouched", () => {
  withWorld({}, (world) => {
    mkdirSync(world.installDir, { recursive: true });
    const existing = join(world.installDir, "chezmoi");
    writeExecutable(existing, "#!/bin/sh\necho old\n");
    replaceChecksumsLine(world, (line) =>
      isTarballLine(world)(line)
        ? `${line[0] === "0" ? "1" : "0"}${line.slice(1)}`
        : line,
    );
    const result = runInstall(world, loadInstallScript());
    assert.notEqual(result.status, 0);
    assert.equal(readFileSync(existing, "utf8"), "#!/bin/sh\necho old\n");
  });
});

test("refuses an unsupported OS before any download", () => {
  withWorld({}, (world) => {
    const result = runInstall(world, loadInstallScript(), {
      STUB_UNAME_S: "FreeBSD",
    });
    assertRefused(result, world, { stage: "platform" });
    assert.equal(result.curlCalls.length, 0);
  });
});

test("refuses an unsupported architecture before any download", () => {
  withWorld({}, (world) => {
    const result = runInstall(world, loadInstallScript(), {
      STUB_UNAME_M: "riscv64",
    });
    assertRefused(result, world, { stage: "platform" });
    assert.equal(result.curlCalls.length, 0);
  });
});

test("refuses a version that is not x.y.z before any download", () => {
  withWorld({}, (world) => {
    const result = runInstall(world, loadInstallScript(), {
      CHEZMOI_VERSION: "2.73",
    });
    assertRefused(result, world, { stage: "version" });
    assert.equal(result.curlCalls.length, 0);
  });
});

test("extractInstallScript fails clearly when the step is missing", () => {
  assert.throws(
    () => extractInstallScript("runs:\n  steps:\n    - name: Other\n"),
    /step "Install chezmoi" not found/,
  );
});

// ---- Renovate wiring ----

const renovateConfig = () => JSON.parse(readRepoFile("renovate.json"));

test("renovate wiring: customManager and packageRule are in place", () => {
  assert.deepEqual(
    checkRenovateWiring(renovateConfig(), readRepoFile(ACTION_PATH)),
    [],
  );
});

test("renovate wiring: pinned version is not older than home/.chezmoiversion", () => {
  assert.deepEqual(
    checkVersionFloor(
      readRepoFile(ACTION_PATH),
      readRepoFile("home/.chezmoiversion"),
    ),
    [],
  );
});

test("RED: an unquoted version line is reported as not matching exactly once", () => {
  const unquoted = readRepoFile(ACTION_PATH).replace(
    /CHEZMOI_VERSION: "([0-9.]+)"/,
    "CHEZMOI_VERSION: $1",
  );
  const problems = checkRenovateWiring(renovateConfig(), unquoted);
  assert.ok(
    problems.some((p) => /matches .* 0 times, expected 1/.test(p)),
    problems.join("\n"),
  );
});

test("RED: a .chezmoiversion above the pinned version is reported", () => {
  const problems = checkVersionFloor(readRepoFile(ACTION_PATH), "99.0.0\n");
  assert.equal(problems.length, 1);
  assert.match(problems[0], /older than \.chezmoiversion 99\.0\.0/);
});

test("RED: a packageRule without minimumReleaseAge or placed before another rule is reported", () => {
  const config = renovateConfig();
  const rule = config.packageRules.find((r) =>
    (r.matchDepNames ?? []).includes("chezmoi"),
  );
  const stripped = structuredClone(config);
  delete stripped.packageRules.find((r) =>
    (r.matchDepNames ?? []).includes("chezmoi"),
  ).minimumReleaseAge;
  assert.ok(
    checkRenovateWiring(stripped, readRepoFile(ACTION_PATH)).some((p) =>
      /minimumReleaseAge/.test(p),
    ),
  );
  const reordered = structuredClone(config);
  reordered.packageRules = [
    structuredClone(rule),
    ...config.packageRules.filter((r) => r !== rule),
  ];
  assert.ok(
    checkRenovateWiring(reordered, readRepoFile(ACTION_PATH)).some((p) =>
      /must be last/.test(p),
    ),
  );
});
