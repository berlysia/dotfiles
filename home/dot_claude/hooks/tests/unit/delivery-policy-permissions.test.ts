#!/usr/bin/env node --test

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { guardedHomeDenyRules } from "../../lib/delivery-policy.ts";

const PERMISSIONS = JSON.parse(
  readFileSync(
    join(import.meta.dirname, "..", "..", "..", ".settings.permissions.json"),
    "utf-8",
  ),
) as { allow: string[]; deny: string[] };

describe("settings permissions for delivery-policy", () => {
  it("allows the wrapper by its absolute path form", () => {
    assert.ok(
      PERMISSIONS.allow.includes("Bash(~/.local/bin/delivery-policy *)"),
    );
  });

  it("allows no gh pr merge: the wrapper is the only way in", () => {
    assert.deepEqual(
      PERMISSIONS.allow.filter((rule) => rule.includes("gh pr merge")),
      [],
    );
  });

  it("denies Edit for every guarded home path the guard refuses", () => {
    const missing = guardedHomeDenyRules().filter(
      (rule) => !PERMISSIONS.deny.includes(rule),
    );
    assert.deepEqual(missing, []);
  });
});
