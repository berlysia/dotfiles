import { deepStrictEqual, ok, strictEqual } from "node:assert";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  LOG_HARD_MAX_BYTES,
  appendLogLines,
  feedbackLogPathFor,
  injectionLogPaths,
  readLogTail,
  rotateLogs,
  storePaths,
} from "../../lib/agent-learnings/core/store.ts";
import { fullLogs } from "../../lib/agent-learnings/core/metrics-log.ts";
import {
  formatInjectionLine,
  parseInjectionLines,
} from "../../lib/agent-learnings/core/metrics.ts";

const withStore = (fn: (store: string) => void): void => {
  const root = mkdtempSync(join(tmpdir(), "al-store-"));
  try {
    const store = join(root, "store");
    mkdirSync(join(store, ".state", "codex"), { recursive: true });
    fn(store);
  } finally {
    chmodSync(join(root, "store", ".state"), 0o700);
    rmSync(root, { recursive: true, force: true });
  }
};
const line = (n: number): string =>
  formatInjectionLine({
    v: 1,
    at: "2026-10-22T00:00:00.000Z",
    repoKey: "github.com/a/b",
    id: `L-${n.toString(16).padStart(12, "0")}`,
    kind: "pre",
    trigger: "cmd:git",
  });
const mkfifo = (path: string): void => {
  execFileSync("mkfifo", [path]);
};

describe("log paths", () => {
  it("decides write and read targets in one place", () => {
    withStore((store) => {
      const p = storePaths(store);
      strictEqual(feedbackLogPathFor(store, "codex"), p.codexFeedbackLog);
      strictEqual(feedbackLogPathFor(store, "claude"), p.feedbackLog);
      strictEqual(feedbackLogPathFor(store, "unknown"), p.feedbackLog);
      ok(p.codexFeedbackLog.endsWith(".state/codex/feedback.log"));
      deepStrictEqual(injectionLogPaths(store), [p.injectionsLog]);
    });
  });
});

describe("appendLogLines", () => {
  it("writes lines with mode 0600 that parse back", () => {
    withStore((store) => {
      const path = storePaths(store).injectionsLog;
      strictEqual(appendLogLines(path, line(1) + line(2)), true);
      strictEqual(statSync(path).mode & 0o777, 0o600);
      strictEqual(
        parseInjectionLines(readFileSync(path, "utf8")).lines.length,
        2,
      );
    });
  });
  it("returns false for a short write or a thrown ENOSPC", () => {
    withStore((store) => {
      const path = storePaths(store).injectionsLog;
      strictEqual(
        appendLogLines(path, line(1), () => 3),
        false,
      );
      strictEqual(
        appendLogLines(path, line(1), () => {
          throw Object.assign(new Error("full"), { code: "ENOSPC" });
        }),
        false,
      );
    });
  });
  it("does not follow a symlink", () => {
    withStore((store) => {
      const target = join(store, "target");
      writeFileSync(target, "keep");
      const path = storePaths(store).injectionsLog;
      symlinkSync(target, path);
      strictEqual(appendLogLines(path, line(1)), false);
      strictEqual(readFileSync(target, "utf8"), "keep");
    });
  });
  it("does not merge a new line into a truncated previous one", () => {
    withStore((store) => {
      const path = storePaths(store).injectionsLog;
      writeFileSync(path, '{"v":1,"at":');
      strictEqual(appendLogLines(path, line(1)), true);
      deepStrictEqual(
        parseInjectionLines(readFileSync(path, "utf8")).lines.length,
        1,
      );
    });
  });
  it("refuses at exactly 4MB and above, and fullLogs names it", () => {
    withStore((store) => {
      const path = storePaths(store).injectionsLog;
      writeFileSync(path, "");
      truncateSync(path, LOG_HARD_MAX_BYTES);
      strictEqual(appendLogLines(path, line(1)), false);
      strictEqual(statSync(path).size, LOG_HARD_MAX_BYTES);
      deepStrictEqual(fullLogs(store), ["injections.log"]);
      truncateSync(path, LOG_HARD_MAX_BYTES + 100);
      strictEqual(appendLogLines(path, line(1)), false);
      strictEqual(statSync(path).size, LOG_HARD_MAX_BYTES + 100);
    });
  });
  it("returns false when the parent is missing or read-only", () => {
    withStore((store) => {
      strictEqual(
        appendLogLines(join(store, "nodir", "x.log"), line(1)),
        false,
      );
      if (process.getuid?.() !== 0) {
        chmodSync(join(store, ".state"), 0o500);
        strictEqual(
          appendLogLines(storePaths(store).injectionsLog, line(1)),
          false,
        );
      }
    });
  });
  it("returns immediately for a FIFO", { timeout: 1000 }, () => {
    withStore((store) => {
      const path = storePaths(store).injectionsLog;
      mkfifo(path);
      strictEqual(appendLogLines(path, line(1)), false);
    });
  });
});

describe("readLogTail", () => {
  it("returns null at once for a FIFO or symlink", { timeout: 1000 }, () => {
    withStore((store) => {
      const fifo = join(store, "fifo");
      mkfifo(fifo);
      strictEqual(readLogTail(fifo, 1024), null);
      writeFileSync(join(store, "real"), "x");
      symlinkSync(join(store, "real"), join(store, "link"));
      strictEqual(readLogTail(join(store, "link"), 1024), null);
    });
  });
  it("reads only the tail", () => {
    withStore((store) => {
      const path = join(store, "t");
      writeFileSync(path, "abcdef");
      strictEqual(readLogTail(path, 3), "def");
    });
  });
});

describe("rotateLogs for the metrics logs", () => {
  it("rotates an oversized injections.log only", () => {
    withStore((store) => {
      const p = storePaths(store);
      writeFileSync(p.injectionsLog, "");
      truncateSync(p.injectionsLog, 1024 * 1024 + 1);
      writeFileSync(p.feedbackLog, "x\n");
      rotateLogs(store);
      ok(existsSync(`${p.injectionsLog}.1`));
      ok(!existsSync(p.injectionsLog));
      ok(existsSync(p.feedbackLog));
      ok(!existsSync(`${p.feedbackLog}.1`));
    });
  });
  it("returns immediately and leaves a FIFO alone", { timeout: 1000 }, () => {
    withStore((store) => {
      const p = storePaths(store);
      mkfifo(p.feedbackLog);
      rotateLogs(store);
      ok(!existsSync(`${p.feedbackLog}.1`));
    });
  });
});
