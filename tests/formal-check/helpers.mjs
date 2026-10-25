import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export const SCRIPTS_DIR = new URL(
  "../../.skills/formal-check/scripts/",
  import.meta.url,
).pathname;

const created = [];

// Every temp dir is recorded so the test file can remove them at the end.
export function makeTempDir(label = "tmp") {
  const dir = realpathSync(
    mkdtempSync(join(tmpdir(), `formal-check-${label}-`)),
  );
  created.push(dir);
  return dir;
}

export function removeTempDirs() {
  for (const dir of created.splice(0)) {
    // Only what makeTempDir made: the prefix check keeps a bad entry from
    // ever pointing the recursive delete elsewhere.
    if (dir.startsWith(join(realpathSync(tmpdir()), "formal-check-"))) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
}

// The repository root marker is an empty `.git` directory: the harness only
// checks for existence, and the test suite forbids starting a git binary.
export function makeRepo() {
  const root = makeTempDir("repo");
  mkdirSync(join(root, ".git"));
  return root;
}

export function writeFiles(base, files) {
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(base, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
}

export function writeManifest(dir, manifest, name = "formal.json") {
  mkdirSync(dir, { recursive: true });
  const abs = join(dir, name);
  writeFileSync(
    abs,
    typeof manifest === "string" ? manifest : JSON.stringify(manifest, null, 2),
  );
  return abs;
}

export function readFixture(name) {
  return readFileSync(
    new URL(`./fixtures/${name}`, import.meta.url).pathname,
    "utf8",
  );
}

// A well-formed enumerate model; `body` replaces the property body.
export function enumerateModel({
  domain = "[0, 1, 2]",
  property = "true",
} = {}) {
  return `export const domain = () => ${domain};\nexport const property = (x) => ${property};\n`;
}

// Runs run.mjs as a process. Resolves with {code, signal, stdout, stderr}.
export function runCli(args, { env = {}, cwd, scriptsDir = SCRIPTS_DIR } = {}) {
  const handle = startCli(args, { env, cwd, scriptsDir });
  return handle.exited.then((r) => ({
    ...r,
    stdout: handle.stdout,
    stderr: handle.stderr,
  }));
}

// Process tests must not depend on the developer's real ~/.config/formal-check,
// so every run gets an empty runtime dir unless a test names its own.
let emptyRuntime = null;
export function emptyRuntimeDir() {
  emptyRuntime ??= makeTempDir("empty-runtime");
  return emptyRuntime;
}

export function startCli(
  args,
  { env = {}, cwd, scriptsDir = SCRIPTS_DIR } = {},
) {
  const child = spawn(
    process.execPath,
    [join(scriptsDir, "run.mjs"), ...args],
    {
      cwd,
      env: {
        PATH: process.env.PATH,
        FORMAL_CHECK_HOME: emptyRuntimeDir(),
        ...env,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const handle = { child, stdout: "", stderr: "" };
  handle.exited = new Promise((resolve) =>
    child.once("close", (code, signal) => resolve({ code, signal })),
  );
  child.stdout.on("data", (c) => (handle.stdout += c));
  child.stderr.on("data", (c) => (handle.stderr += c));
  return handle;
}

export const HAS_PROC = existsSync("/proc/self/stat");

// A process counts as stopped when kill(pid, 0) gives ESRCH or when it is a
// zombie: without an init process in the sandbox a killed grandchild is not
// always reaped.
export function isGone(pid) {
  try {
    process.kill(pid, 0);
  } catch (error) {
    if (error.code === "ESRCH") return true;
  }
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return (
      stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3) === "Z"
    );
  } catch {
    return true;
  }
}

export async function waitFor(check, label, timeoutMs = 15_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const value = check();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`timed out waiting for ${label}`);
}

export function readPid(file) {
  if (!existsSync(file)) return null;
  const n = Number.parseInt(readFileSync(file, "utf8"), 10);
  return Number.isInteger(n) ? n : null;
}

export function killQuietly(pid) {
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // already gone
  }
}
