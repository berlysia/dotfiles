#!/usr/bin/env -S bun test

import { ok, strictEqual } from "node:assert";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { describe, it } from "node:test";

import {
  ACK_PATH,
  DIGEST_PATH,
  getUnreadDigestNotice,
  LOGS_DIR,
  readAckMs,
  writeAckMs,
} from "../../lib/insight-digest.ts";

function backup(): { digest?: Buffer; ack?: Buffer } {
  // Save current state by reading raw bytes when present.
  const result: { digest?: Buffer; ack?: Buffer } = {};
  try {
    if (existsSync(DIGEST_PATH))
      result.digest = require("node:fs").readFileSync(DIGEST_PATH);
  } catch {}
  try {
    if (existsSync(ACK_PATH))
      result.ack = require("node:fs").readFileSync(ACK_PATH);
  } catch {}
  return result;
}

function restore(saved: { digest?: Buffer; ack?: Buffer }): void {
  if (saved.digest) writeFileSync(DIGEST_PATH, saved.digest);
  else if (existsSync(DIGEST_PATH)) rmSync(DIGEST_PATH);
  if (saved.ack) writeFileSync(ACK_PATH, saved.ack);
  else if (existsSync(ACK_PATH)) rmSync(ACK_PATH);
}

describe("getUnreadDigestNotice", () => {
  it("returns null when digest does not exist", () => {
    const saved = backup();
    try {
      if (existsSync(DIGEST_PATH)) rmSync(DIGEST_PATH);
      strictEqual(getUnreadDigestNotice(), null);
    } finally {
      restore(saved);
    }
  });

  it("returns notice when digest is newer than ack", () => {
    const saved = backup();
    try {
      mkdirSync(LOGS_DIR, { recursive: true, mode: 0o700 });
      writeFileSync(DIGEST_PATH, "fresh");
      writeAckMs(0);
      const notice = getUnreadDigestNotice();
      ok(notice !== null, "expected notice");
      ok(notice?.includes("Insight digest"));
    } finally {
      restore(saved);
    }
  });

  it("returns null after ack matches digest mtime", () => {
    const saved = backup();
    try {
      mkdirSync(LOGS_DIR, { recursive: true, mode: 0o700 });
      writeFileSync(DIGEST_PATH, "marked-read");
      writeAckMs(Date.now() + 1000);
      strictEqual(getUnreadDigestNotice(), null);
    } finally {
      restore(saved);
    }
  });

  it("readAckMs returns 0 when ack file missing or invalid", () => {
    const saved = backup();
    try {
      if (existsSync(ACK_PATH)) rmSync(ACK_PATH);
      strictEqual(readAckMs(), 0);
      writeFileSync(ACK_PATH, "not-a-number");
      strictEqual(readAckMs(), 0);
    } finally {
      restore(saved);
    }
  });
});
