import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
  realpathSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import {
  createMarker,
  readMarker,
  removeMarker,
} from "../../lib/session-marker.ts";

const HOUR = 60 * 60 * 1000;
const roots: string[] = [];

function freshRoot(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "session-marker-")));
  roots.push(root);
  return root;
}

after(() => {
  for (const root of roots) {
    rmSync(root, { recursive: true, force: true });
  }
});

/** Makes `path` look as if it was created `ageMs` before `now`. */
function backdate(path: string, now: Date, ageMs: number): void {
  const when = new Date(now.getTime() - ageMs);
  utimesSync(path, when, when);
}

describe("createMarker", () => {
  it("creates the marker with mode 0600 inside a 0700 dir", () => {
    const dir = join(freshRoot(), "state");
    assert.equal(createMarker({ dir, name: "s1", maxAgeMs: HOUR }), true);
    assert.equal(statSync(join(dir, "s1")).mode & 0o777, 0o600);
    assert.equal(statSync(dir).mode & 0o777, 0o700);
  });

  it("returns false while a marker younger than maxAge exists", () => {
    const dir = freshRoot();
    const now = new Date();
    assert.equal(createMarker({ dir, name: "s1", maxAgeMs: HOUR, now }), true);
    backdate(join(dir, "s1"), now, 59 * 60 * 1000);
    assert.equal(createMarker({ dir, name: "s1", maxAgeMs: HOUR, now }), false);
  });

  it("replaces a marker older than maxAge", () => {
    const dir = freshRoot();
    const now = new Date();
    createMarker({ dir, name: "s1", maxAgeMs: HOUR, now });
    backdate(join(dir, "s1"), now, 61 * 60 * 1000);
    assert.equal(createMarker({ dir, name: "s1", maxAgeMs: HOUR, now }), true);
    assert.ok(now.getTime() - statSync(join(dir, "s1")).mtimeMs < 60_000);
  });

  it("never expires a marker when maxAgeMs is null", () => {
    const dir = freshRoot();
    const now = new Date();
    createMarker({ dir, name: "done", maxAgeMs: null, now });
    backdate(join(dir, "done"), now, 25 * HOUR);
    assert.equal(
      createMarker({ dir, name: "done", maxAgeMs: null, now }),
      false,
    );
    assert.ok(existsSync(join(dir, "done")));
  });

  it("returns false without throwing when the dir is read-only", (t) => {
    if (process.getuid?.() === 0) {
      t.skip("root ignores directory modes");
      return;
    }
    const dir = freshRoot();
    chmodSync(dir, 0o500);
    try {
      assert.equal(createMarker({ dir, name: "s1", maxAgeMs: HOUR }), false);
    } finally {
      chmodSync(dir, 0o700);
    }
  });

  it("returns false when the dir cannot be created", () => {
    const root = freshRoot();
    writeFileSync(join(root, "file"), "");
    assert.equal(
      createMarker({
        dir: join(root, "file", "sub"),
        name: "s1",
        maxAgeMs: HOUR,
      }),
      false,
    );
  });

  it("returns false for a name that is not a safe name", () => {
    const root = freshRoot();
    const dir = join(root, "markers");
    for (const name of ["../x", "a/b", "", "a.b"]) {
      assert.equal(createMarker({ dir, name, maxAgeMs: HOUR }), false, name);
    }
    assert.equal(existsSync(join(root, "x")), false);
  });

  it("stores the given content", () => {
    const dir = freshRoot();
    createMarker({ dir, name: "s1", maxAgeMs: null, content: "abc" });
    assert.equal(readFileSync(join(dir, "s1"), "utf8"), "abc");
  });

  describe("sweep", () => {
    it("removes only old regular files with a marker-shaped name", () => {
      const dir = freshRoot();
      const outside = freshRoot();
      const now = new Date();
      const old = (name: string) => {
        writeFileSync(join(dir, name), "x");
        backdate(join(dir, name), now, 25 * HOUR);
      };
      old("old-session");
      old("with.dot");
      writeFileSync(join(dir, "young-session"), "x");
      mkdirSync(join(dir, "subdir"));
      backdate(join(dir, "subdir"), now, 25 * HOUR);
      const target = join(outside, "target");
      writeFileSync(target, "keep");
      symlinkSync(target, join(dir, "link"));

      assert.equal(
        createMarker({
          dir,
          name: "new",
          maxAgeMs: HOUR,
          sweepAfterMs: 24 * HOUR,
          now,
        }),
        true,
      );

      assert.equal(existsSync(join(dir, "old-session")), false);
      assert.equal(existsSync(join(dir, "with.dot")), true);
      assert.equal(existsSync(join(dir, "young-session")), true);
      assert.equal(statSync(join(dir, "subdir")).isDirectory(), true);
      assert.equal(readFileSync(target, "utf8"), "keep");
      assert.equal(lstatSync(join(dir, "link")).isSymbolicLink(), true);
    });

    it("removes nothing without sweepAfterMs", () => {
      const dir = freshRoot();
      const now = new Date();
      writeFileSync(join(dir, "old-session"), "x");
      backdate(join(dir, "old-session"), now, 25 * HOUR);
      createMarker({ dir, name: "new", maxAgeMs: HOUR, now });
      assert.equal(existsSync(join(dir, "old-session")), true);
    });
  });
});

describe("createMarker under contention", () => {
  const sessionMarkerUrl = new URL(
    "../../lib/session-marker.ts",
    import.meta.url,
  ).href;

  function runChild(dir: string, names: string[], startAt: number) {
    const code = `
      import { createMarker } from ${JSON.stringify(sessionMarkerUrl)};
      const [dir, startAt, ...names] = process.argv.slice(1);
      const out = [];
      for (const name of names) {
        while (Date.now() < Number(startAt)) {}
        out.push(createMarker({ dir, name, maxAgeMs: 60 * 60 * 1000 }));
      }
      process.stdout.write(JSON.stringify(out));
    `;
    return new Promise<boolean[]>((resolve, reject) => {
      const child = spawn(
        process.execPath,
        ["--input-type=module", "-e", code, dir, String(startAt), ...names],
        { stdio: ["ignore", "pipe", "inherit"] },
      );
      let stdout = "";
      child.stdout.on("data", (chunk) => (stdout += chunk));
      child.on("error", reject);
      child.on("close", (status) =>
        status === 0
          ? resolve(JSON.parse(stdout) as boolean[])
          : reject(new Error(`child exited ${status}`)),
      );
    });
  }

  for (const stale of [false, true]) {
    it(`lets exactly one of two processes create the marker (${stale ? "over a stale marker" : "from nothing"})`, async () => {
      const dir = freshRoot();
      const names = Array.from({ length: 25 }, (_, i) => `s${i}`);
      if (stale) {
        const now = new Date();
        for (const name of names) {
          writeFileSync(join(dir, name), "");
          backdate(join(dir, name), now, 2 * HOUR);
        }
      }
      const startAt = Date.now() + 1500;
      const [a, b] = await Promise.all([
        runChild(dir, names, startAt),
        runChild(dir, names, startAt),
      ]);
      names.forEach((name, i) => {
        assert.equal(
          Number(a[i]) + Number(b[i]),
          1,
          `${name}: ${a[i]} / ${b[i]}`,
        );
      });
    });
  }
});

describe("readMarker / removeMarker", () => {
  it("reads the content, and null when absent or unsafe", () => {
    const dir = freshRoot();
    createMarker({ dir, name: "s1", maxAgeMs: null, content: "abc" });
    assert.equal(readMarker(dir, "s1"), "abc");
    assert.equal(readMarker(dir, "nope"), null);
    assert.equal(readMarker(dir, "../x"), null);
  });

  it("removes a marker and succeeds when there is none", () => {
    const dir = freshRoot();
    createMarker({ dir, name: "s1", maxAgeMs: HOUR });
    assert.equal(removeMarker(dir, "s1"), true);
    assert.equal(existsSync(join(dir, "s1")), false);
    assert.equal(removeMarker(dir, "s1"), true);
    assert.equal(removeMarker(join(dir, "missing"), "s1"), true);
  });

  it("refuses an unsafe name", () => {
    assert.equal(removeMarker(freshRoot(), "../x"), false);
  });
});
