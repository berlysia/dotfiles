#!/usr/bin/env -S bun test

import { ok, strictEqual } from "node:assert";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { describe, it } from "node:test";

import {
  ACK_PATH,
  DIGEST_PATH,
  DIGEST_PREVIEW_MAX_LINES,
  getUnreadDigestNotice,
  getUnreadDigestPreview,
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

describe("getUnreadDigestPreview", () => {
  it("returns null when digest is absent", () => {
    const saved = backup();
    try {
      if (existsSync(DIGEST_PATH)) rmSync(DIGEST_PATH);
      strictEqual(getUnreadDigestPreview(), null);
    } finally {
      restore(saved);
    }
  });

  it("returns preview body when digest is newer than ack", () => {
    const saved = backup();
    try {
      mkdirSync(LOGS_DIR, { recursive: true, mode: 0o700 });
      const body = [
        "# Insight Digest",
        "",
        "- Generated: 2026-05-07T10:00:00Z",
        "- Total cumulative insights: 297",
        "- Since last ack: 12",
        "- Last sanitizer hits in this run: 0",
        "",
        "## Top Recurring Topics (heuristic)",
        "",
        "| count | sessions | last_seen | preview |",
        "|-------|----------|-----------|---------|",
        "| 8 | 5 | 2026-05-06 | chezmoi run_after stamp pattern |",
        "| 6 | 3 | 2026-05-05 | document workflow gating |",
        "| 5 | 4 | 2026-05-04 | bun shebang for scripts |",
        "",
        "## Distillation (LLM)",
        "",
      ].join("\n");
      writeFileSync(DIGEST_PATH, body);
      writeAckMs(0);
      const preview = getUnreadDigestPreview();
      ok(preview !== null, "expected preview");
      ok(preview?.includes("Total cumulative insights"));
      ok(preview?.includes("Run /insight-digest"));
    } finally {
      restore(saved);
    }
  });

  it("returns null after ack catches up to digest mtime", () => {
    const saved = backup();
    try {
      mkdirSync(LOGS_DIR, { recursive: true, mode: 0o700 });
      writeFileSync(DIGEST_PATH, "marked-read body");
      writeAckMs(Date.now() + 1000);
      strictEqual(getUnreadDigestPreview(), null);
    } finally {
      restore(saved);
    }
  });

  it("respects maxLines argument", () => {
    const saved = backup();
    try {
      mkdirSync(LOGS_DIR, { recursive: true, mode: 0o700 });
      const lines = Array.from({ length: 50 }, (_, i) => `line-${i}`);
      writeFileSync(DIGEST_PATH, lines.join("\n"));
      writeAckMs(0);
      const preview = getUnreadDigestPreview(3);
      ok(preview !== null);
      ok(preview?.includes("line-0"));
      ok(preview?.includes("line-2"));
      ok(!preview?.includes("line-3"));
    } finally {
      restore(saved);
    }
  });

  it("default maxLines constant is reasonable", () => {
    ok(DIGEST_PREVIEW_MAX_LINES >= 6 && DIGEST_PREVIEW_MAX_LINES <= 30);
  });
});
