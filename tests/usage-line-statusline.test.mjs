import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";

const script = new URL("../mods/usage-line/statusline.ts", import.meta.url)
  .pathname;
const root = mkdtempSync(join(tmpdir(), "usage-line-statusline-"));
after(() => rmSync(root, { recursive: true, force: true }));

let counter = 0;
function freshRuntimeDir() {
  const dir = join(root, `run-${counter++}`);
  mkdirSync(join(dir, "usage-line"), { recursive: true });
  return dir;
}

const nowSec = () => Math.trunc(Date.now() / 1000);
function stdinJson(extra = {}) {
  return JSON.stringify({
    session_id: "s-1",
    context_window: { used_percentage: 9 },
    rate_limits: {
      five_hour: { used_percentage: 3, resets_at: nowSec() + 2 * 3600 },
      seven_day: { used_percentage: 13, resets_at: nowSec() + 3 * 86400 },
    },
    ...extra,
  });
}
const sevenDayResets = () => JSON.parse(stdinJson()).rate_limits.seven_day;

function forecastFile(resetsAt, over = {}) {
  return JSON.stringify({
    v: 1,
    at: Date.now(),
    windows: {
      seven_day: {
        resetsAt,
        forecast: {
          status: "spare",
          reason: null,
          averagePeriodMs: 86_400_000,
          observedMs: 3_600_000,
          ratePerHour: 0.1,
          projectedUsedPercent: 20.5,
          exhaustionAt: null,
        },
      },
    },
    ...over,
  });
}

function run(input, env = {}, scriptPath = script) {
  const base = { ...process.env };
  delete base.XDG_RUNTIME_DIR;
  delete base.TMPDIR;
  const result = spawnSync("bun", [scriptPath], {
    input,
    env: { ...base, ...env },
    encoding: "utf8",
  });
  assert.equal(result.error, undefined);
  return result;
}

// The seven-day window's resets_at must equal what the stdin carries.
function withSeven(runtime, content) {
  const input = stdinJson();
  const resets = JSON.parse(input).rate_limits.seven_day.resets_at;
  writeFileSync(join(runtime, "usage-line", "s-1.json"), content(resets));
  return input;
}

const LINE =
  /^ctx 9\.0% │ 5h 3\.0% \(reset \d{2}:\d{2}\) │ 週 13\.0% \(reset . \d{2}:\d{2}\)\n$/u;

test("stdin only: usage and context, exit 0, quiet stderr", () => {
  const runtime = freshRuntimeDir();
  const result = run(stdinJson(), { XDG_RUNTIME_DIR: runtime });
  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
  assert.match(result.stdout, LINE);
});

test("a fresh forecast file adds the forecast", () => {
  const runtime = freshRuntimeDir();
  const input = withSeven(runtime, (resets) => forecastFile(resets));
  const result = run(input, { XDG_RUNTIME_DIR: runtime });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /予想 20\.5%/);
});

test("nothing to show (not json, {}, before the first response) prints the placeholder", () => {
  const runtime = freshRuntimeDir();
  for (const input of ["not json", "{}", "", '{"session_id":"s-1"}']) {
    const result = run(input, { XDG_RUNTIME_DIR: runtime });
    assert.equal(result.status, 0);
    assert.equal(result.stdout, "ctx -- │ 5h -- │ 週 --\n");
    assert.equal(result.stderr, "");
  }
});

test("a path-like session_id still shows usage, without forecast", () => {
  const runtime = freshRuntimeDir();
  const result = run(stdinJson({ session_id: "../s-1" }), {
    XDG_RUNTIME_DIR: runtime,
  });
  assert.equal(result.status, 0);
  assert.match(result.stdout, LINE);
});

test("a symlinked forecast file is not read", () => {
  const runtime = freshRuntimeDir();
  const input = stdinJson();
  const resets = sevenDayResets().resets_at;
  const real = join(root, `real-${counter++}.json`);
  writeFileSync(real, forecastFile(resets));
  symlinkSync(real, join(runtime, "usage-line", "s-1.json"));
  const result = run(input, { XDG_RUNTIME_DIR: runtime });
  assert.equal(result.status, 0);
  assert.match(result.stdout, LINE);
});

test("directory, oversized, garbage and v2 files are not used", () => {
  const cases = {
    directory: null,
    oversized: (resets) => forecastFile(resets, { pad: "x".repeat(70 * 1024) }),
    garbage: () => "not json",
    v2: (resets) => forecastFile(resets, { v: 2 }),
  };
  for (const [name, content] of Object.entries(cases)) {
    const runtime = freshRuntimeDir();
    const input = stdinJson();
    const target = join(runtime, "usage-line", "s-1.json");
    if (content === null) mkdirSync(target);
    else
      writeFileSync(
        target,
        content(JSON.parse(input).rate_limits.seven_day.resets_at),
      );
    const result = run(input, { XDG_RUNTIME_DIR: runtime });
    assert.equal(result.status, 0, name);
    assert.equal(result.stderr, "", name);
    assert.match(result.stdout, LINE, name);
  }
});

test("without XDG_RUNTIME_DIR and TMPDIR only usage is shown", () => {
  const result = run(stdinJson(), { TMPDIR: "" });
  assert.equal(result.status, 0);
  assert.match(result.stdout, LINE);
});

test("statusline.ts alone (hooks missing) prints nothing and exits 0", () => {
  const dir = mkdtempSync(join(root, "alone-"));
  const copy = join(dir, "statusline.ts");
  copyFileSync(script, copy);
  const result = run(stdinJson(), {}, copy);
  assert.equal(result.status, 0);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");
});
