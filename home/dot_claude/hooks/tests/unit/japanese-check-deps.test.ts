import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  realpathSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, it } from "node:test";
import {
  checkDependencies,
  DEPENDENCIES,
  findDependency,
} from "../../../japanese-check/deps.ts";
import { digest } from "../../../japanese-check/state.ts";
import { readFileBounded } from "../../../japanese-check/safe-read.ts";

const checkerSource = fileURLToPath(
  new URL("../../../japanese-check/", import.meta.url),
);

describe("bounded safe read", () => {
  const root = realpathSync(
    mkdtempSync(join(tmpdir(), "japanese-check-safe-read-")),
  );
  after(() => rmSync(root, { recursive: true, force: true }));

  it("returns the bytes of a regular file", () => {
    const file = join(root, "a.txt");
    writeFileSync(file, "中身");
    const result = readFileBounded(file, 100);
    assert.ok(result.ok);
    assert.equal(result.bytes.toString("utf8"), "中身");
  });

  it("reports a missing path as missing", () => {
    assert.deepEqual(readFileBounded(join(root, "none"), 100), {
      ok: false,
      reason: "missing",
    });
  });

  it("refuses a symlink, a directory and a FIFO without blocking", () => {
    const target = join(root, "target.txt");
    writeFileSync(target, "x");
    symlinkSync(target, join(root, "link.txt"));
    mkdirSync(join(root, "dir"));
    const fifo = join(root, "fifo");
    const made = spawnSync("mkfifo", [fifo]);
    assert.equal(made.status, 0);
    for (const path of [join(root, "link.txt"), join(root, "dir"), fifo]) {
      assert.deepEqual(readFileBounded(path, 100), {
        ok: false,
        reason: "not-file",
      });
    }
  });

  it("accepts exactly the limit and refuses one byte more", () => {
    const exact = join(root, "exact.txt");
    const over = join(root, "over.txt");
    writeFileSync(exact, "a".repeat(64));
    writeFileSync(over, "a".repeat(65));
    assert.equal(readFileBounded(exact, 64).ok, true);
    assert.deepEqual(readFileBounded(over, 64), {
      ok: false,
      reason: "too-large",
    });
  });
});

describe("dependency lookup", () => {
  const root = realpathSync(
    mkdtempSync(join(tmpdir(), "japanese-check-deps-")),
  );
  after(() => rmSync(root, { recursive: true, force: true }));
  let number = 0;

  // <case>/home/japanese-check is the checker directory; its parent is <case>/home.
  function layout() {
    const base = join(root, `case-${++number}`);
    const parent = join(base, "home");
    const dir = join(parent, "japanese-check");
    cpSync(checkerSource, dir, { recursive: true });
    return { base, parent, dir };
  }
  function fakePackage(
    nodeModules: string,
    name: string,
    manifest: Record<string, unknown> = {},
    entryBody = "export const TokenizeMode = { A: 0, B: 1, C: 2 };\nexport function tokenize() { return '[]'; }\n",
  ) {
    const packageDir = join(nodeModules, name);
    mkdirSync(packageDir, { recursive: true });
    writeFileSync(
      join(packageDir, "package.json"),
      JSON.stringify({
        name,
        version: "1.2.3",
        type: "module",
        main: "index.js",
        ...manifest,
      }),
    );
    writeFileSync(join(packageDir, "index.js"), entryBody);
    return packageDir;
  }

  it("finds the package in the checker directory and in its parent, but not higher", () => {
    const own = layout();
    fakePackage(join(own.dir, "node_modules"), "sudachi");
    const found = findDependency("sudachi", own.dir);
    assert.ok(found.ok);
    assert.equal(found.version, "1.2.3");
    assert.ok(found.entry.endsWith("index.js"));

    const parent = layout();
    fakePackage(join(parent.parent, "node_modules"), "sudachi");
    assert.equal(findDependency("sudachi", parent.dir).ok, true);

    const above = layout();
    fakePackage(join(above.base, "node_modules"), "sudachi");
    assert.equal(findDependency("sudachi", above.dir).ok, false);
  });

  it("refuses a manifest that is a symlink, has another name, an array version or an entry outside", () => {
    const cases: Array<(nodeModules: string) => void> = [
      (nm) => {
        const pkg = fakePackage(nm, "sudachi");
        const real = join(root, `manifest-${number}.json`);
        writeFileSync(
          real,
          JSON.stringify({
            name: "sudachi",
            version: "1.0.0",
            main: "index.js",
          }),
        );
        rmSync(join(pkg, "package.json"));
        symlinkSync(real, join(pkg, "package.json"));
      },
      (nm) => void fakePackage(nm, "sudachi", { name: "other" }),
      (nm) => void fakePackage(nm, "sudachi", { version: ["1"] }),
      (nm) => void fakePackage(nm, "sudachi", { main: "../x.js" }),
      (nm) => void fakePackage(nm, "sudachi", { version: "1 2" }),
      (nm) => void fakePackage(nm, "sudachi", { main: "." }),
    ];
    for (const [index, make] of cases.entries()) {
      const own = layout();
      make(join(own.dir, "node_modules"));
      assert.equal(findDependency("sudachi", own.dir).ok, false, String(index));
    }
  });

  it("accepts the entry shapes exports string, exports dot string and exports dot import/default", () => {
    const shapes: Array<Record<string, unknown>> = [
      { main: undefined, exports: "./index.js" },
      { main: undefined, exports: { ".": "./index.js" } },
      { main: undefined, exports: { ".": { import: "./index.js" } } },
      { main: undefined, exports: { ".": { default: "./index.js" } } },
    ];
    for (const shape of shapes) {
      const own = layout();
      fakePackage(join(own.dir, "node_modules"), "sudachi", shape);
      assert.equal(
        findDependency("sudachi", own.dir).ok,
        true,
        JSON.stringify(shape),
      );
    }
  });

  it("refuses nested conditions, arrays and a directory as the entry", () => {
    const shapes: Array<Record<string, unknown>> = [
      { exports: { ".": { node: { import: "./index.js" } } } },
      { exports: { ".": ["./index.js"] } },
      { exports: ["./index.js"] },
      { exports: { import: "./index.js" } },
    ];
    for (const shape of shapes) {
      const own = layout();
      fakePackage(join(own.dir, "node_modules"), "sudachi", shape);
      assert.equal(
        findDependency("sudachi", own.dir).ok,
        false,
        JSON.stringify(shape),
      );
    }
    const dirEntry = layout();
    const pkg = fakePackage(join(dirEntry.dir, "node_modules"), "sudachi", {
      main: "lib",
    });
    mkdirSync(join(pkg, "lib"));
    assert.equal(findDependency("sudachi", dirEntry.dir).ok, false);
  });

  it("follows a package directory symlink only when it stays inside node_modules", () => {
    const inside = layout();
    const nm = join(inside.dir, "node_modules");
    const store = fakePackage(join(nm, ".store"), "sudachi");
    symlinkSync(store, join(nm, "sudachi"));
    assert.equal(findDependency("sudachi", inside.dir).ok, true);

    for (const outsideName of ["elsewhere", "node_modules-evil", "hooks"]) {
      const outside = layout();
      const target = fakePackage(join(outside.base, outsideName), "sudachi");
      mkdirSync(join(outside.dir, "node_modules"), { recursive: true });
      symlinkSync(target, join(outside.dir, "node_modules", "sudachi"));
      assert.equal(
        findDependency("sudachi", outside.dir).ok,
        false,
        outsideName,
      );
    }
  });

  it("reports the group members that are missing, by the names in the list", () => {
    const own = layout();
    const result = checkDependencies(["analyzer"], own.dir);
    assert.equal(result.ok, false);
    assert.deepEqual(result.missing, ["sudachi"]);
    fakePackage(join(own.dir, "node_modules"), "sudachi");
    const again = checkDependencies(["analyzer"], own.dir);
    assert.equal(again.ok, true);
    assert.equal(again.found[0]?.group, "analyzer");
    assert.deepEqual(checkDependencies(["grammar"], own.dir).found, []);
  });

  it("lists only packages that package.json declares, and tokenizer.ts does not import one by name", () => {
    const manifest = JSON.parse(
      readFileSync(join(checkerSource, "..", "package.json"), "utf8"),
    ) as { dependencies: Record<string, string> };
    for (const dep of DEPENDENCIES)
      assert.ok(dep.name in manifest.dependencies, dep.name);
    const tokenizer = readFileSync(join(checkerSource, "tokenizer.ts"), "utf8");
    assert.ok(!/import\(\s*["']sudachi["']/u.test(tokenizer));
    const cli = readFileSync(join(checkerSource, "cli.ts"), "utf8");
    assert.ok(!/^import\s[^;]*from\s+["']\.\/tokenizer\.ts["']/mu.test(cli));
  });

  describe("through the process", () => {
    const body = "SECRETBODYのような本文です。\n";
    function run(
      copy: string,
      args: string[],
      cwd = copy,
      home = join(copy, "..", "state-home"),
    ) {
      mkdirSync(home, { recursive: true });
      return spawnSync(process.execPath, [join(copy, "cli.ts"), ...args], {
        encoding: "utf8",
        cwd,
        env: { ...process.env, HOME: home },
      });
    }
    function document(base: string) {
      mkdirSync(base, { recursive: true });
      const file = join(base, "doc.md");
      writeFileSync(file, body);
      return file;
    }

    it("lets defer and secrets work without any dependency, and stops the tokenizing commands", () => {
      const own = layout();
      const file = document(own.base);
      assert.equal(run(own.dir, ["secrets", file]).status, 0);
      const deferred = run(own.dir, [
        "defer",
        file,
        "--hash",
        digest(body),
        "--reason",
        "草稿",
      ]);
      assert.equal(deferred.status, 0, deferred.stderr);
      for (const args of [
        ["check", file],
        ["calques", file],
        ["terms", file],
        ["newfacts", file, "--source", join(own.base, "other.md")],
      ]) {
        writeFileSync(join(own.base, "other.md"), "別の原文。\n");
        const result = run(own.dir, args);
        assert.equal(result.status, 2, args[0]);
        assert.match(result.stderr, /sudachi/u);
        assert.match(result.stderr, /chezmoi apply/u);
        assert.ok(!(result.stdout + result.stderr).includes("SECRETBODY"));
      }
    });

    it("does not use a package placed next to the document or in the cwd", () => {
      const own = layout();
      const file = document(own.base);
      const marker = join(own.base, "used");
      for (const place of [own.base, join(own.base, "cwd")]) {
        fakePackage(
          join(place, "node_modules"),
          "sudachi",
          {},
          `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(marker)}, "used");\nexport const TokenizeMode = { C: 2 };\nexport function tokenize() { return "[]"; }\n`,
        );
      }
      mkdirSync(join(own.base, "cwd"), { recursive: true });
      const result = run(own.dir, ["check", file], join(own.base, "cwd"));
      assert.equal(result.status, 2);
      assert.throws(() => readFileSync(marker));
    });

    const throwing: Record<string, string> = {
      synchronous:
        "export function tokenize(text) { throw new Error('LEAK ' + text); }",
      rejection:
        "Promise.reject(new Error('LEAK ' + readFileSync(process.argv[3], 'utf8')));\nexport function tokenize(text) { throw new Error('LEAK ' + text); }",
      timer:
        "setTimeout(() => { throw new Error('LEAK ' + readFileSync(process.argv[3], 'utf8')); }, 0);\nexport function tokenize(text) { throw new Error('LEAK ' + text); }",
    };
    for (const [name, code] of Object.entries(throwing)) {
      it(`keeps the document out of the output when the tokenizer fails (${name})`, () => {
        const own = layout();
        const file = document(own.base);
        fakePackage(
          join(own.dir, "node_modules"),
          "sudachi",
          {},
          `import { readFileSync } from "node:fs";\nexport const TokenizeMode = { A: 0, B: 1, C: 2 };\n${code}\n`,
        );
        const result = run(own.dir, ["check", file]);
        assert.equal(result.status, 2);
        assert.ok(!(result.stdout + result.stderr).includes("SECRETBODY"));
        assert.ok(!(result.stdout + result.stderr).includes("LEAK"));
      });
    }

    it("prints only an allowed error name", () => {
      const own = layout();
      const file = document(own.base);
      fakePackage(
        join(own.dir, "node_modules"),
        "sudachi",
        {},
        `export const TokenizeMode = { C: 2 };\nexport function tokenize() { const e = new Error("x"); e.name = "\\u001b[31mX"; throw e; }\n`,
      );
      const result = run(own.dir, ["check", file]);
      assert.equal(result.status, 2);
      assert.ok(!result.stderr.includes("\u001b"));
      assert.match(result.stderr, /Error/u);
    });

    it("does not echo an unknown profile id", () => {
      const own = layout();
      const file = document(own.base);
      const result = run(own.dir, [
        "check",
        file,
        "--profile",
        "\u001b[31mevil",
      ]);
      assert.equal(result.status, 2);
      assert.ok(!(result.stdout + result.stderr).includes("evil"));
      assert.ok(!(result.stdout + result.stderr).includes("\u001b"));
    });

    it("reports broken profiles.json with a fixed message and no fragment", () => {
      const own = layout();
      const file = document(own.base);
      writeFileSync(
        join(own.dir, "data", "profiles.json"),
        '{"schema": FRAGMENT-ONE',
      );
      const result = run(own.dir, ["check", file, "--profile", "design"]);
      assert.equal(result.status, 2);
      assert.ok(!(result.stdout + result.stderr).includes("FRAGMENT"));
    });

    it("reports a broken package.json as a missing dependency without a fragment", () => {
      const own = layout();
      const file = document(own.base);
      const pkg = fakePackage(join(own.dir, "node_modules"), "sudachi");
      writeFileSync(join(pkg, "package.json"), '{"name": FRAGMENT-TWO');
      const result = run(own.dir, ["check", file]);
      assert.equal(result.status, 2);
      assert.ok(!(result.stdout + result.stderr).includes("FRAGMENT"));
      assert.match(result.stderr, /sudachi/u);
    });
  });
});
