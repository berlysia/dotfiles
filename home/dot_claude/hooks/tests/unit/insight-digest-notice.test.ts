#!/usr/bin/env -S bun test

import { ok, strictEqual } from "node:assert";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  DIGEST_PREVIEW_MAX_LINES,
  getUnreadDigestNotice,
  getUnreadDigestPreview,
  readAckMs,
  writeAckMs,
} from "../../lib/insight-digest.ts";

function withTempPaths(
  fn: (paths: { digestPath: string; ackPath: string }) => void,
): void {
  const dir = mkdtempSync(join(tmpdir(), "insight-notice-test-"));
  try {
    fn({
      digestPath: join(dir, "insight-digest.md"),
      ackPath: join(dir, "ack"),
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("getUnreadDigestNotice", () => {
  it("returns null when digest does not exist", () => {
    withTempPaths(({ digestPath, ackPath }) => {
      strictEqual(getUnreadDigestNotice({ digestPath, ackPath }), null);
    });
  });

  it("returns notice when digest is newer than ack", () => {
    withTempPaths(({ digestPath, ackPath }) => {
      writeFileSync(digestPath, "fresh");
      writeAckMs(0, ackPath);
      const notice = getUnreadDigestNotice({ digestPath, ackPath });
      ok(notice !== null, "expected notice");
      ok(notice?.includes("Insight digest"));
      ok(notice?.includes(digestPath));
    });
  });

  it("returns null after ack matches digest mtime", () => {
    withTempPaths(({ digestPath, ackPath }) => {
      writeFileSync(digestPath, "marked-read");
      writeAckMs(Date.now() + 1000, ackPath);
      strictEqual(getUnreadDigestNotice({ digestPath, ackPath }), null);
    });
  });

  it("readAckMs returns 0 when ack file missing or invalid", () => {
    withTempPaths(({ ackPath }) => {
      strictEqual(readAckMs(ackPath), 0);
      writeFileSync(ackPath, "not-a-number");
      strictEqual(readAckMs(ackPath), 0);
    });
  });
});

describe("getUnreadDigestPreview", () => {
  it("returns null when digest is absent", () => {
    withTempPaths(({ digestPath, ackPath }) => {
      strictEqual(
        getUnreadDigestPreview(undefined, { digestPath, ackPath }),
        null,
      );
    });
  });

  it("returns preview body when digest is newer than ack", () => {
    withTempPaths(({ digestPath, ackPath }) => {
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
      writeFileSync(digestPath, body);
      writeAckMs(0, ackPath);
      const preview = getUnreadDigestPreview(undefined, {
        digestPath,
        ackPath,
      });
      ok(preview !== null, "expected preview");
      ok(preview?.includes("Total cumulative insights"));
      ok(preview?.includes("Run /insight-digest"));
    });
  });

  it("returns null after ack catches up to digest mtime", () => {
    withTempPaths(({ digestPath, ackPath }) => {
      writeFileSync(digestPath, "marked-read body");
      writeAckMs(Date.now() + 1000, ackPath);
      strictEqual(
        getUnreadDigestPreview(undefined, { digestPath, ackPath }),
        null,
      );
    });
  });

  it("respects maxLines argument", () => {
    withTempPaths(({ digestPath, ackPath }) => {
      const lines = Array.from({ length: 50 }, (_, i) => `line-${i}`);
      writeFileSync(digestPath, lines.join("\n"));
      writeAckMs(0, ackPath);
      const preview = getUnreadDigestPreview(3, { digestPath, ackPath });
      ok(preview !== null);
      ok(preview?.includes("line-0"));
      ok(preview?.includes("line-2"));
      ok(!preview?.includes("line-3"));
    });
  });

  it("default maxLines constant is reasonable", () => {
    ok(DIGEST_PREVIEW_MAX_LINES >= 6 && DIGEST_PREVIEW_MAX_LINES <= 30);
  });
});
