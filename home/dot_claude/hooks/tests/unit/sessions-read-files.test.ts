#!/usr/bin/env node --test

import { deepStrictEqual, strictEqual } from "node:assert";
import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { after, before, describe, it } from "node:test";
import {
  defaultDeps,
  readSessionFiles,
  type ReadSessionFilesDeps,
  type SessionFileStat,
} from "../../lib/sessions/read-session-files.ts";

const libUrl = pathToFileURL(
  join(import.meta.dirname, "../../lib/sessions/read-session-files.ts"),
).href;

type Spy = {
  deps: ReadSessionFilesDeps;
  opened: string[];
  closed: number[];
  fstatted: number[];
};

// A deps double over in-memory files. `chunk` limits bytes per read call.
function fakeDeps(options: {
  names: string[];
  stat?: (fd: number) => SessionFileStat;
  readSize?: (fd: number) => number; // total bytes the file yields
  chunk?: number;
}): Spy {
  const opened: string[] = [];
  const closed: number[] = [];
  const fstatted: number[] = [];
  const served = new Map<number, number>();
  let nextFd = 100;
  const uid = 1000;
  const deps: ReadSessionFilesDeps = {
    readdir: () => options.names,
    open: (path) => {
      opened.push(path);
      return nextFd++;
    },
    fstat: (fd) => {
      fstatted.push(fd);
      return options.stat?.(fd) ?? { isFile: () => true, size: 10, uid };
    },
    read: (fd, buffer, offset, length) => {
      const total = options.readSize?.(fd) ?? 10;
      const done = served.get(fd) ?? 0;
      const n = Math.min(options.chunk ?? length, length, total - done);
      buffer.fill(0x61, offset, offset + n);
      served.set(fd, done + n);
      return n;
    },
    close: (fd) => {
      closed.push(fd);
    },
    getuid: () => uid,
  };
  return { deps, opened, closed, fstatted };
}

describe("readSessionFiles with real files", () => {
  let dir: string;
  before(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), "sessions-read-")));
  });
  after(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("reads an ordinary file and adds the pid from its name", () => {
    const sub = join(dir, "plain");
    mkdirSync(sub);
    writeFileSync(join(sub, "201.json"), "x".repeat(1024));
    const result = readSessionFiles(sub);
    if (!result.ok) throw new Error("expected ok");
    strictEqual(result.value.files.length, 1);
    strictEqual(result.value.files[0]?.pid, 201);
    strictEqual(result.value.files[0]?.text.length, 1024);
    strictEqual(result.value.scanned, 1);
    strictEqual(result.value.skippedBeforeContent, 0);
  });

  it("skips a symlink (O_NOFOLLOW) and counts it", () => {
    const sub = join(dir, "symlink");
    mkdirSync(sub);
    writeFileSync(join(sub, "target.txt"), "{}");
    symlinkSync(join(sub, "target.txt"), join(sub, "202.json"));
    const result = readSessionFiles(sub);
    if (!result.ok) throw new Error("expected ok");
    strictEqual(result.value.scanned, 1);
    strictEqual(result.value.skippedBeforeContent, 1);
    strictEqual(result.value.files.length, 0);
  });

  it("returns promptly on a FIFO with no writer (O_NONBLOCK)", () => {
    const sub = join(dir, "fifo");
    mkdirSync(sub);
    execFileSync("mkfifo", [join(sub, "203.json")]);
    // Without O_NONBLOCK, open(2) blocks forever and would hang this process,
    // so the call runs in a child with a kill timeout; a hang then fails
    // the assertion instead of the whole test run.
    const script = `
      import { readSessionFiles } from ${JSON.stringify(libUrl)};
      const started = Date.now();
      const result = readSessionFiles(${JSON.stringify(sub)});
      console.log(JSON.stringify({ result, elapsed: Date.now() - started }));
    `;
    const child = spawnSync(
      process.execPath,
      ["--input-type=module", "-e", script],
      { encoding: "utf8", timeout: 3000, killSignal: "SIGKILL" },
    );
    strictEqual(child.status, 0, `child did not finish: ${child.error}`);
    const out = JSON.parse(child.stdout) as {
      result: { ok: true; value: { skippedBeforeContent: number } };
      elapsed: number;
    };
    strictEqual(out.result.value.skippedBeforeContent, 1);
    strictEqual(out.elapsed < 500, true, `took ${out.elapsed} ms`);
  });

  it("skips a 65537-byte file and keeps a 65536-byte one", () => {
    const sub = join(dir, "sizes");
    mkdirSync(sub);
    writeFileSync(join(sub, "204.json"), "a".repeat(65537));
    writeFileSync(join(sub, "205.json"), "a".repeat(65536));
    const result = readSessionFiles(sub);
    if (!result.ok) throw new Error("expected ok");
    deepStrictEqual(
      result.value.files.map((file) => file.pid),
      [205],
    );
    strictEqual(result.value.scanned, 2);
    strictEqual(result.value.skippedBeforeContent, 1);
  });

  it("reports an unreadable directory", () => {
    const result = readSessionFiles(join(dir, "does-not-exist"));
    strictEqual(result.ok, false);
    if (result.ok) return;
    strictEqual(result.error.kind, "sessions-dir-unreadable");
  });

  it("uses the real getuid by default", () => {
    strictEqual(defaultDeps.getuid(), process.getuid?.() ?? -1);
  });
});

describe("readSessionFiles name filter", () => {
  it("does not open a .key file", () => {
    const spy = fakeDeps({ names: ["201.0123abcd.key"] });
    const result = readSessionFiles("/d", spy.deps);
    if (!result.ok) throw new Error("expected ok");
    strictEqual(result.value.scanned, 0);
    strictEqual(spy.opened.length, 0);
    strictEqual(spy.fstatted.length, 0);
  });

  it("ignores names that are not <digits>.json", () => {
    const spy = fakeDeps({
      names: ["abc.json", "201.json.bak", "-1.json", ".json", "1.JSON"],
    });
    const result = readSessionFiles("/d", spy.deps);
    if (!result.ok) throw new Error("expected ok");
    strictEqual(result.value.scanned, 0);
    strictEqual(spy.opened.length, 0);
  });

  it("orders by number, not by string", () => {
    const spy = fakeDeps({ names: ["1000.json", "999.json", "20.json"] });
    const result = readSessionFiles("/d", spy.deps);
    if (!result.ok) throw new Error("expected ok");
    deepStrictEqual(
      result.value.files.map((file) => file.pid),
      [20, 999, 1000],
    );
  });
});

describe("readSessionFiles fstat and read limits", () => {
  it("skips a file owned by another uid", () => {
    const spy = fakeDeps({
      names: ["1.json"],
      stat: () => ({ isFile: () => true, size: 10, uid: 1001 }),
    });
    const result = readSessionFiles("/d", spy.deps);
    if (!result.ok) throw new Error("expected ok");
    strictEqual(result.value.skippedBeforeContent, 1);
    strictEqual(result.value.files.length, 0);
    deepStrictEqual(spy.closed, [100]);
  });

  it("skips a non-regular file", () => {
    const spy = fakeDeps({
      names: ["1.json"],
      stat: () => ({ isFile: () => false, size: 0, uid: 1000 }),
    });
    const result = readSessionFiles("/d", spy.deps);
    if (!result.ok) throw new Error("expected ok");
    strictEqual(result.value.skippedBeforeContent, 1);
    deepStrictEqual(spy.closed, [100]);
  });

  it("skips a file whose fstat size is over the limit", () => {
    const spy = fakeDeps({
      names: ["1.json"],
      stat: () => ({ isFile: () => true, size: 65537, uid: 1000 }),
    });
    const result = readSessionFiles("/d", spy.deps);
    if (!result.ok) throw new Error("expected ok");
    strictEqual(result.value.skippedBeforeContent, 1);
    deepStrictEqual(spy.closed, [100]);
  });

  it("skips a file that grows past the limit while being read", () => {
    const spy = fakeDeps({
      names: ["1.json"],
      readSize: () => 65537,
      chunk: 40000, // two reads reach 65537 bytes
    });
    const result = readSessionFiles("/d", spy.deps);
    if (!result.ok) throw new Error("expected ok");
    strictEqual(result.value.skippedBeforeContent, 1);
    strictEqual(result.value.files.length, 0);
    deepStrictEqual(spy.closed, [100]);
  });

  it("assembles a file delivered one byte per read", () => {
    const spy = fakeDeps({
      names: ["1.json"],
      readSize: () => 100,
      chunk: 1,
    });
    const result = readSessionFiles("/d", spy.deps);
    if (!result.ok) throw new Error("expected ok");
    strictEqual(result.value.files[0]?.text.length, 100);
    deepStrictEqual(spy.closed, [100]);
  });

  it("closes once on a successful read", () => {
    const spy = fakeDeps({ names: ["1.json"] });
    readSessionFiles("/d", spy.deps);
    deepStrictEqual(spy.closed, [100]);
  });

  it("closes once and skips when read throws", () => {
    const spy = fakeDeps({ names: ["1.json"] });
    const deps: ReadSessionFilesDeps = {
      ...spy.deps,
      read: () => {
        throw new Error("EIO");
      },
    };
    const result = readSessionFiles("/d", deps);
    if (!result.ok) throw new Error("expected ok");
    strictEqual(result.value.skippedBeforeContent, 1);
    deepStrictEqual(spy.closed, [100]);
  });

  it("counts an open failure as scanned and skipped, without close", () => {
    const spy = fakeDeps({ names: ["1.json"] });
    const deps: ReadSessionFilesDeps = {
      ...spy.deps,
      open: () => {
        throw Object.assign(new Error("ELOOP"), { code: "ELOOP" });
      },
    };
    const result = readSessionFiles("/d", deps);
    if (!result.ok) throw new Error("expected ok");
    strictEqual(result.value.scanned, 1);
    strictEqual(result.value.skippedBeforeContent, 1);
    strictEqual(spy.closed.length, 0);
  });
});

describe("readSessionFiles file count cap", () => {
  it("opens 1024 files and counts the rest as skipped", () => {
    const names = Array.from({ length: 1030 }, (_, i) => `${i + 1}.json`);
    const spy = fakeDeps({ names: names.reverse() });
    const result = readSessionFiles("/d", spy.deps);
    if (!result.ok) throw new Error("expected ok");
    strictEqual(spy.opened.length, 1024);
    strictEqual(result.value.scanned, 1030);
    strictEqual(result.value.skippedBeforeContent, 6);
    strictEqual(result.value.files.length, 1024);
    const openedNames = new Set(
      spy.opened.map((p) => p.slice(p.lastIndexOf("/") + 1)),
    );
    const unread = names.filter((n) => !openedNames.has(n)).sort();
    deepStrictEqual(unread, [
      "1025.json",
      "1026.json",
      "1027.json",
      "1028.json",
      "1029.json",
      "1030.json",
    ]);
    strictEqual(spy.closed.length, 1024);
  });

  it("keeps scanned = files + skippedBeforeContent", () => {
    const spy = fakeDeps({
      names: ["1.json", "2.json", "3.json"],
      stat: (fd) => ({
        isFile: () => true,
        size: 10,
        uid: fd === 101 ? 7 : 1000,
      }),
    });
    const result = readSessionFiles("/d", spy.deps);
    if (!result.ok) throw new Error("expected ok");
    strictEqual(
      result.value.scanned,
      result.value.files.length + result.value.skippedBeforeContent,
    );
  });
});
