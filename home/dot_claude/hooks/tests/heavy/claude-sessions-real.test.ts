#!/usr/bin/env node --test

// Contract test against the real sessions directory. It runs only when
// CLAUDE_SESSIONS_REAL_DIR holds an absolute path (CI skips it), reads the
// directory and never writes. Run it after every Claude Code update:
//
//   CLAUDE_SESSIONS_REAL_DIR=$HOME/.claude/sessions bun run test:heavy
//
// Failure messages and output carry counts, field names and types only: never a
// real name, cwd or sessionId.
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { ok, strictEqual } from "node:assert";
import { readSessionFiles } from "../../lib/sessions/read-session-files.ts";
import { validateSession } from "../../lib/sessions/validate-session.ts";
import {
  SCHEMA_VERSION,
  VERIFIED_WITH,
  type SessionList,
} from "../../lib/sessions/types.ts";

const CLI = fileURLToPath(
  new URL("../../cli/claude-sessions.ts", import.meta.url),
);
const FIXTURE_DIR = fileURLToPath(
  new URL("../fixtures/sessions/dir-basic/", import.meta.url),
);
const realDir = process.env.CLAUDE_SESSIONS_REAL_DIR;

/** field name -> sorted list of JSON types seen, over the object files in `texts`. */
function fieldTypes(texts: string[]): Map<string, string> {
  const seen = new Map<string, Set<string>>();
  for (const text of texts) {
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      continue;
    }
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      continue;
    }
    for (const [key, field] of Object.entries(value)) {
      const type =
        field === null ? "null" : Array.isArray(field) ? "array" : typeof field;
      const set = seen.get(key) ?? new Set<string>();
      set.add(type);
      seen.set(key, set);
    }
  }
  return new Map(
    [...seen].map(([key, set]) => [key, [...set].sort().join("|")]),
  );
}

describe("claude-sessions against the real sessions directory", () => {
  if (realDir === undefined || realDir === "") {
    it("skips without CLAUDE_SESSIONS_REAL_DIR", { skip: true }, () => {});
    return;
  }
  const dir = realDir;

  it("needs an absolute CLAUDE_SESSIONS_REAL_DIR", () => {
    ok(
      dir.startsWith("/"),
      "CLAUDE_SESSIONS_REAL_DIR must be an absolute path",
    );
  });

  it("keeps the --json contract on real files", () => {
    ok(
      dir.startsWith("/"),
      "CLAUDE_SESSIONS_REAL_DIR must be an absolute path",
    );

    const startedAt = Date.now();
    const run = spawnSync(
      "bun",
      ["--config=/dev/null", "run", "--silent", CLI, "--json"],
      {
        encoding: "utf8",
        timeout: 30_000,
        env: { ...process.env, CLAUDE_SESSIONS_DIR: dir },
      },
    );
    const elapsedMs = Date.now() - startedAt;
    strictEqual(
      run.status,
      0,
      `CLI exit status ${run.status} (stderr omitted)`,
    );
    const list = JSON.parse(run.stdout) as SessionList;
    strictEqual(list.schemaVersion, SCHEMA_VERSION);
    ok(list.skipped <= list.scanned, "skipped <= scanned");
    ok(list.invalid <= list.skipped, "invalid <= skipped");

    // Files that fail validation while their process still exists are the first
    // sign of a changed shape. Files whose pid is gone are old leftovers.
    const read = readSessionFiles(dir);
    ok(read.ok, "sessions directory is readable");
    let invalidAlive = 0;
    let invalidNoPid = 0;
    const texts: string[] = [];
    for (const file of read.value.files) {
      texts.push(file.text);
      if (validateSession(file.text, file.pid).ok) continue;
      if (existsSync(`/proc/${file.pid}`)) invalidAlive += 1;
      else invalidNoPid += 1;
    }
    const statusCounts: Record<string, number> = {};
    let aliveRows = 0;
    for (const row of list.sessions) {
      statusCounts[row.status] = (statusCounts[row.status] ?? 0) + 1;
      if (row.liveness === "alive") aliveRows += 1;
    }

    const real = fieldTypes(texts);
    const fixture = fieldTypes(
      readdirSync(FIXTURE_DIR)
        .filter((name) => /^[0-9]+\.json$/.test(name))
        .map((name) => readFileSync(join(FIXTURE_DIR, name), "utf8")),
    );
    const onlyReal = [...real.keys()].filter((key) => !fixture.has(key));
    const onlyFixture = [...fixture.keys()].filter((key) => !real.has(key));
    const typeDiffs = [...real.keys()]
      .filter((key) => fixture.has(key) && fixture.get(key) !== real.get(key))
      .map(
        (key) => `${key}: real ${real.get(key)} / fixture ${fixture.get(key)}`,
      );

    console.error(
      [
        `real: scanned=${list.scanned} skipped=${list.skipped} invalid=${list.invalid}`,
        `real: invalid with live pid=${invalidAlive}, invalid without pid=${invalidNoPid}`,
        `real: rows=${list.sessions.length} alive rows=${aliveRows}`,
        `real: status ${JSON.stringify(statusCounts)}`,
        `real: fields only in real files: [${onlyReal.join(", ")}]`,
        `real: fields only in fixture: [${onlyFixture.join(", ")}]`,
        `real: type differences: [${typeDiffs.join("; ")}]`,
        `real: CLI wall time ${elapsedMs} ms`,
        `real: runningVersion=${list.runningVersion ?? "null"}`,
      ].join("\n"),
    );

    strictEqual(invalidAlive, 0, "files of live processes failed validation");
    ok(aliveRows >= 1, "no row has liveness alive");
    // Last, so a version difference alone is not mistaken for a shape change.
    if (list.runningVersion !== null && list.runningVersion !== VERIFIED_WITH) {
      throw new Error(
        `Everything else passed. Change VERIFIED_WITH in lib/sessions/types.ts to ${list.runningVersion} and add one line to ADR-0059 (docs/decisions/0059-cross-session-mods.md).`,
      );
    }
  });
});
