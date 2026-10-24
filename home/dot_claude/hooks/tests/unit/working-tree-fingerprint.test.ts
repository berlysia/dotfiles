#!/usr/bin/env node --test

// Working-tree fingerprint decides whether completion-gate may skip its
// checks for a turn (see plan K1-K3). Every case runs against a throwaway git
// repository and a throwaway stateDir; HOME is never touched.

import { deepStrictEqual } from "node:assert";
import {
  chmodSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
  realpathSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { pruneStaleBaselines } from "../../lib/working-tree-fingerprint.ts";

const tempDirs: string[] = [];
after(() => {
  for (const dir of tempDirs) {
    // 0500 dirs from the read-only case must be removable.
    try {
      chmodSync(dir, 0o700);
    } catch {
      // already gone
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempDir(): string {
  const dir = realpathSync(
    mkdtempSync(join(tmpdir(), "working-tree-fingerprint-test-")),
  );
  tempDirs.push(dir);
  return dir;
}

describe("state file handling", () => {
  it("19: prunes baselines older than the max age only", () => {
    const stateDir = makeTempDir();
    const oldFile = join(stateDir, "old.txt");
    const freshFile = join(stateDir, "fresh.txt");
    writeFileSync(oldFile, "a");
    writeFileSync(freshFile, "b");
    const day = 24 * 60 * 60 * 1000;
    const eightDaysAgo = new Date(Date.now() - 8 * day);
    const oneDayAgo = new Date(Date.now() - day);
    utimesSync(oldFile, eightDaysAgo, eightDaysAgo);
    utimesSync(freshFile, oneDayAgo, oneDayAgo);
    pruneStaleBaselines(stateDir, 7 * day);
    deepStrictEqual(readdirSync(stateDir), ["fresh.txt"]);
  });
});
