// Builders for a runtime dir and a `java` that stands in for the real ones, so
// the availability and process-handling tests need neither a JDK nor a network.
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeTempDir } from "./helpers.mjs";

export const TLC_VERSION_LINE = "TLC2 Version 2.19 of 08 August 2024 (rev: x)";

// state: "ok" (install-state matches), "stale" (differs by one byte) or
// "missing". lock: whether a bun.lock exists, and whether its copy matches.
export function makeFakeRuntime({
  z3 = true,
  jar = true,
  state = "ok",
  lock = null,
  lockState = "ok",
  z3Version = null,
} = {}) {
  const dir = makeTempDir("runtime");
  const packageJson = '{"private":true,"dependencies":{"z3-solver":"5.3.1"}}';
  writeFileSync(join(dir, "package.json"), packageJson);
  if (state === "ok") writeFileSync(join(dir, ".install-state"), packageJson);
  if (state === "stale")
    writeFileSync(join(dir, ".install-state"), `${packageJson} `);
  if (lock !== null) {
    writeFileSync(join(dir, "bun.lock"), lock);
    if (lockState === "ok")
      writeFileSync(join(dir, ".install-state.lock"), lock);
    if (lockState === "stale")
      writeFileSync(join(dir, ".install-state.lock"), `${lock}#`);
  }
  if (z3) {
    mkdirSync(join(dir, "node_modules/z3-solver"), { recursive: true });
    writeFileSync(
      join(dir, "node_modules/z3-solver/package.json"),
      JSON.stringify(z3Version === null ? {} : { version: z3Version }),
    );
  }
  if (jar) writeFileSync(join(dir, "tla2tools.jar"), "not a real jar");
  return dir;
}

// Writes an executable `java` shell script into a fresh dir and returns the
// dir (to be put on PATH). `body` is sh; the version probe (no -workers) and a
// real run (-workers) are told apart by the caller's `case "$*"`.
export function makeFakeJava(body) {
  const bin = makeTempDir("bin");
  const path = join(bin, "java");
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
  return bin;
}

// A java that answers the version probe with `lines` and, for a run, prints
// `runOutput` and exits with `runExit`. Every call appends "version" or "run"
// to `counter`.
export function versionJava({
  lines = [TLC_VERSION_LINE],
  counter = null,
  runOutput = "",
  runExit = 0,
  runPrefix = "",
} = {}) {
  const count = (word) => (counter ? `echo ${word} >> '${counter}'` : ":");
  const quote = (text) => `'${text.replaceAll("'", "'\\''")}'`;
  return makeFakeJava(
    `case "$*" in
  *-workers*)
    ${count("run")}
    ${runPrefix}
    printf '%s' ${quote(runOutput)}
    exit ${runExit} ;;
  *)
    ${count("version")}
    printf '%s\\n' ${lines.map(quote).join(" ")}
    exit 255 ;;
esac`,
  );
}

// A stand-in for the z3-solver module. `results` are the check() answers in
// call order; `delaysMs[i]` makes the i-th check slow. Every Solver is kept in
// `solvers` so a test can see what was added to it and which timeout it got.
export function makeFakeZ3({
  results = [],
  isBool = () => true,
  delaysMs = [],
} = {}) {
  const solvers = [];
  const queue = [...results];
  let checks = 0;
  class Solver {
    constructor() {
      this.added = [];
      this.settings = {};
      this.checked = false;
      solvers.push(this);
    }
    set(key, value) {
      this.settings[key] = value;
    }
    add(...expressions) {
      this.added.push(...expressions);
    }
    async check() {
      const index = checks++;
      if (delaysMs[index])
        await new Promise((r) => setTimeout(r, delaysMs[index]));
      this.checked = true;
      return queue.shift() ?? "unknown";
    }
    model() {
      return { sexpr: () => "(model-sexpr)" };
    }
  }
  const ctx = { Solver, Not: (e) => ({ not: e }), isBool };
  return {
    z3: { init: async () => ({ Context: () => ctx }) },
    solvers,
    ctx,
  };
}
