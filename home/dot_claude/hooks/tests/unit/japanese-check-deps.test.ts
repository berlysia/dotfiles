import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
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
  findDependencyInGroup,
  resolveRuntimeDir,
  runtimeDirState,
} from "../../../japanese-check/deps.ts";
import {
  ANALYZER_DEPENDENCIES,
  LINDERA_VERSION,
  platformPackageName,
} from "../../../japanese-check/adapter-lindera-unidic.ts";
import {
  needsRuntime,
  placeDictionary,
} from "../support/japanese-check-runtime.ts";
import { digest } from "../../../japanese-check/state.ts";
import { readFileBounded } from "../../../japanese-check/safe-read.ts";

const checkerSource = fileURLToPath(
  new URL("../../../japanese-check/", import.meta.url),
);
const repositoryRoot = fileURLToPath(
  new URL("../../../../../", import.meta.url),
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

  const ANALYZER = { name: "lindera", group: "analyzer" } as const;
  // The grammar group still looks in the checker directory and its parent.
  const GRAMMAR = { name: "fake-grammar", group: "grammar" } as const;

  // <case>/home/japanese-check is the checker directory; its parent is <case>/home.
  // <case>/runtime is the analyzer runtime directory (owner-only).
  function layout() {
    const base = join(root, `case-${++number}`);
    const parent = join(base, "home");
    const dir = join(parent, "japanese-check");
    cpSync(checkerSource, dir, { recursive: true });
    const runtime = join(base, "runtime");
    mkdirSync(runtime, { mode: 0o700 });
    chmodSync(runtime, 0o700);
    return { base, parent, dir, runtime };
  }
  const SHAPE_ENTRY = `export function loadDictionary() { return {}; }
export class Tokenizer {
  tokenize() { return []; }
}
`;
  function fakePackage(
    nodeModules: string,
    name: string,
    manifest: Record<string, unknown> = {},
    entryBody = SHAPE_ENTRY,
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
  const findAnalyzer = (own: ReturnType<typeof layout>) =>
    findDependencyInGroup(ANALYZER, own.dir, own.runtime);

  it("finds a grammar package in the checker directory and in its parent, but not higher", () => {
    const own = layout();
    fakePackage(join(own.dir, "node_modules"), GRAMMAR.name);
    const found = findDependencyInGroup(GRAMMAR, own.dir, own.runtime);
    assert.ok(found.ok);
    assert.equal(found.version, "1.2.3");
    assert.ok(found.entry.endsWith("index.js"));

    const parent = layout();
    fakePackage(join(parent.parent, "node_modules"), GRAMMAR.name);
    assert.equal(
      findDependencyInGroup(GRAMMAR, parent.dir, parent.runtime).ok,
      true,
    );

    const above = layout();
    fakePackage(join(above.base, "node_modules"), GRAMMAR.name);
    assert.equal(
      findDependencyInGroup(GRAMMAR, above.dir, above.runtime).ok,
      false,
    );
  });

  it("finds the analyzer in the runtime directory only, never in the checker directory or its parent", () => {
    const own = layout();
    fakePackage(join(own.runtime, "node_modules"), ANALYZER.name);
    const found = findAnalyzer(own);
    assert.ok(found.ok);
    assert.equal(found.version, "1.2.3");

    const elsewhere = layout();
    fakePackage(join(elsewhere.dir, "node_modules"), ANALYZER.name);
    fakePackage(join(elsewhere.parent, "node_modules"), ANALYZER.name);
    assert.equal(findAnalyzer(elsewhere).ok, false);
  });

  it("refuses a manifest that is a symlink, has another name, an array version or an entry outside", () => {
    const cases: Array<(nodeModules: string) => void> = [
      (nm) => {
        const pkg = fakePackage(nm, ANALYZER.name);
        const real = join(root, `manifest-${number}.json`);
        writeFileSync(
          real,
          JSON.stringify({
            name: ANALYZER.name,
            version: "1.0.0",
            main: "index.js",
          }),
        );
        rmSync(join(pkg, "package.json"));
        symlinkSync(real, join(pkg, "package.json"));
      },
      (nm) => void fakePackage(nm, ANALYZER.name, { name: "other" }),
      (nm) => void fakePackage(nm, ANALYZER.name, { version: ["1"] }),
      (nm) => void fakePackage(nm, ANALYZER.name, { main: "../x.js" }),
      (nm) => void fakePackage(nm, ANALYZER.name, { version: "1 2" }),
      (nm) => void fakePackage(nm, ANALYZER.name, { main: "." }),
    ];
    for (const [index, make] of cases.entries()) {
      const own = layout();
      make(join(own.runtime, "node_modules"));
      assert.equal(findAnalyzer(own).ok, false, String(index));
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
      fakePackage(join(own.runtime, "node_modules"), ANALYZER.name, shape);
      assert.equal(findAnalyzer(own).ok, true, JSON.stringify(shape));
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
      fakePackage(join(own.runtime, "node_modules"), ANALYZER.name, shape);
      assert.equal(findAnalyzer(own).ok, false, JSON.stringify(shape));
    }
    const dirEntry = layout();
    const pkg = fakePackage(
      join(dirEntry.runtime, "node_modules"),
      ANALYZER.name,
      { main: "lib" },
    );
    mkdirSync(join(pkg, "lib"));
    assert.equal(findAnalyzer(dirEntry).ok, false);
  });

  it("follows a package directory symlink only when it stays inside the runtime's node_modules", () => {
    const inside = layout();
    const nm = join(inside.runtime, "node_modules");
    const store = fakePackage(join(nm, ".store"), ANALYZER.name);
    symlinkSync(store, join(nm, ANALYZER.name));
    assert.equal(findAnalyzer(inside).ok, true);

    for (const outsideName of ["elsewhere", "node_modules-evil", "hooks"]) {
      const outside = layout();
      const target = fakePackage(
        join(outside.base, outsideName),
        ANALYZER.name,
      );
      mkdirSync(join(outside.runtime, "node_modules"), { recursive: true });
      symlinkSync(target, join(outside.runtime, "node_modules", ANALYZER.name));
      assert.equal(findAnalyzer(outside).ok, false, outsideName);
    }
    // A node_modules in an ancestor of the runtime directory is not a root either.
    const ancestor = layout();
    const target = fakePackage(
      join(ancestor.base, "node_modules"),
      ANALYZER.name,
    );
    mkdirSync(join(ancestor.runtime, "node_modules"), { recursive: true });
    symlinkSync(target, join(ancestor.runtime, "node_modules", ANALYZER.name));
    assert.equal(findAnalyzer(ancestor).ok, false);
  });

  it("reports the group members that are missing, by the names in the list", () => {
    const own = layout();
    const result = checkDependencies(
      ["analyzer"],
      ANALYZER_DEPENDENCIES,
      own.dir,
      own.runtime,
    );
    assert.equal(result.ok, false);
    assert.deepEqual(result.missing, ["lindera"]);
    fakePackage(join(own.runtime, "node_modules"), ANALYZER.name);
    const again = checkDependencies(
      ["analyzer"],
      ANALYZER_DEPENDENCIES,
      own.dir,
      own.runtime,
    );
    assert.equal(again.ok, true);
    assert.equal(again.found[0]?.group, "analyzer");
    assert.deepEqual(
      checkDependencies(
        ["grammar"],
        ANALYZER_DEPENDENCIES,
        own.dir,
        own.runtime,
      ).found,
      [],
    );
  });

  it("treats a runtime directory that does not exist as missing", () => {
    const own = layout();
    const result = checkDependencies(
      ["analyzer"],
      ANALYZER_DEPENDENCIES,
      own.dir,
      join(own.base, "no-such-runtime"),
    );
    assert.deepEqual(result.missing, ["lindera"]);
    assert.equal(runtimeDirState(join(own.base, "no-such-runtime")), "absent");
  });

  it("treats a runtime directory that group or others can write to as unsafe, and its node_modules and unidic too", () => {
    for (const target of ["", "node_modules", "unidic"]) {
      const own = layout();
      fakePackage(join(own.runtime, "node_modules"), ANALYZER.name);
      mkdirSync(join(own.runtime, "unidic"), { mode: 0o700 });
      assert.equal(runtimeDirState(own.runtime), "ok", target);
      chmodSync(join(own.runtime, target), 0o775);
      assert.equal(runtimeDirState(own.runtime), "unsafe", target);
      assert.equal(findAnalyzer(own).ok, false, target);
      chmodSync(join(own.runtime, target), 0o700);
    }
  });

  it("resolves the runtime directory from an absolute variable or from HOME, never from the cwd", () => {
    const home = { HOME: "/x/h" };
    assert.equal(
      resolveRuntimeDir({ ...home, JAPANESE_CHECK_RUNTIME_DIR: "/a/b" }),
      "/a/b",
    );
    for (const value of ["relative/dir", "", "./here", undefined])
      assert.equal(
        resolveRuntimeDir({ ...home, JAPANESE_CHECK_RUNTIME_DIR: value }),
        "/x/h/.config/japanese-check",
        String(value),
      );
  });

  it("lists only packages that package.json declares, and the adapter does not import one by name", () => {
    const rootManifest = JSON.parse(
      readFileSync(
        join(repositoryRoot, "home/dot_config/japanese-check/package.json"),
        "utf8",
      ),
    ) as { dependencies: Record<string, string> };
    for (const dep of ANALYZER_DEPENDENCIES)
      assert.ok(dep.name in rootManifest.dependencies, dep.name);
    const adapter = readFileSync(
      join(checkerSource, "adapter-lindera-unidic.ts"),
      "utf8",
    );
    assert.ok(!/import\(\s*["']lindera["']/u.test(adapter));
    const cli = readFileSync(join(checkerSource, "cli.ts"), "utf8");
    assert.ok(!/^import\s[^;]*from\s+["']\.\/tokenizer\.ts["']/mu.test(cli));
  });

  it("keeps the pinned values in one place each and equal where they meet", () => {
    const manifest = JSON.parse(
      readFileSync(
        join(repositoryRoot, "home/dot_config/japanese-check/package.json"),
        "utf8",
      ),
    ) as { dependencies: Record<string, string> };
    assert.equal(manifest.dependencies.lindera, LINDERA_VERSION);
    assert.deepEqual(Object.keys(manifest.dependencies), ["lindera"]);
    // bun.lock is JSONC: look for the resolved package string.
    const lock = readFileSync(
      join(repositoryRoot, "home/dot_config/japanese-check/bun.lock"),
      "utf8",
    );
    for (const name of [
      "lindera",
      "lindera-darwin-arm64",
      "lindera-darwin-x64",
      "lindera-linux-x64-gnu",
    ])
      assert.ok(lock.includes(`"${name}@${LINDERA_VERSION}"`), name);
    const yaml = readFileSync(
      join(repositoryRoot, "home/.chezmoidata/japanese_check.yaml"),
      "utf8",
    );
    assert.equal(/^\s+version: "([^"]+)"$/mu.exec(yaml)?.[1], LINDERA_VERSION);
    assert.match(
      /^\s+sha256: "([^"]+)"$/mu.exec(yaml)?.[1] ?? "",
      /^[0-9a-f]{64}$/u,
    );
  });

  it("fails when it is given no dependency list to check", () => {
    const own = layout();
    const result = checkDependencies(["analyzer"], [], own.dir, own.runtime);
    assert.equal(result.ok, false);
    assert.equal(result.found.length, 0);
  });

  describe("through the process", () => {
    const body = "SECRETBODYのような本文です。\n";
    function run(
      own: ReturnType<typeof layout>,
      args: string[],
      options: { cwd?: string; runtime?: string } = {},
    ) {
      const home = join(own.base, "state-home");
      mkdirSync(home, { recursive: true });
      return spawnSync(process.execPath, [join(own.dir, "cli.ts"), ...args], {
        encoding: "utf8",
        cwd: options.cwd ?? own.dir,
        env: {
          ...process.env,
          HOME: home,
          JAPANESE_CHECK_RUNTIME_DIR: options.runtime ?? own.runtime,
        },
      });
    }
    function document(base: string) {
      mkdirSync(base, { recursive: true });
      const file = join(base, "doc.md");
      writeFileSync(file, body);
      return file;
    }
    // A runtime that passes every check of the adapter: the platform's native
    // package, the real dictionary files (hard links), and a lindera whose
    // version is the pinned one and whose tokenizer is `tokenizeBody`.
    function fakeRuntime(own: ReturnType<typeof layout>, tokenizeBody: string) {
      const nm = join(own.runtime, "node_modules");
      fakePackage(nm, platformPackageName(), { main: undefined }, "");
      fakePackage(
        nm,
        "lindera",
        { version: LINDERA_VERSION },
        `import { readFileSync } from "node:fs";
export function loadDictionary() { return {}; }
export class Tokenizer {
  tokenize(text) {
    ${tokenizeBody}
  }
}
`,
      );
      placeDictionary(join(own.runtime, "unidic"));
    }

    it("lets defer and secrets work without any dependency, and stops the tokenizing commands", () => {
      const own = layout();
      const file = document(own.base);
      assert.equal(run(own, ["secrets", file]).status, 0);
      const deferred = run(own, [
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
        const result = run(own, args, {
          runtime: join(own.base, "no-such-runtime"),
        });
        assert.equal(result.status, 2, args[0]);
        assert.match(result.stderr, /lindera/u);
        assert.match(result.stderr, /chezmoi apply/u);
        assert.ok(!(result.stdout + result.stderr).includes("SECRETBODY"));
      }
    });

    it("does not use a package placed next to the document or in the cwd, nor a runtime directory inside the cwd that is not named by the variable", () => {
      const own = layout();
      const file = document(own.base);
      const marker = join(own.base, "used");
      const marking = `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(marker)}, "used");\nexport function loadDictionary() { return {}; }\nexport class Tokenizer { tokenize() { return []; } }\n`;
      const cwd = join(own.base, "cwd");
      mkdirSync(cwd, { recursive: true });
      for (const place of [
        own.base,
        cwd,
        join(cwd, ".config", "japanese-check"),
      ])
        fakePackage(join(place, "node_modules"), "lindera", {}, marking);
      const result = run(own, ["check", file], {
        cwd,
        runtime: join(own.base, "no-such-runtime"),
      });
      assert.equal(result.status, 2);
      assert.throws(() => readFileSync(marker));
    });

    it(
      "fails with fixed text when the runtime directory can be written by others",
      needsRuntime,
      () => {
        const own = layout();
        const file = document(own.base);
        fakeRuntime(own, "return [];");
        assert.equal(run(own, ["check", file, "--no-record"]).status, 0);
        chmodSync(own.runtime, 0o775);
        const result = run(own, ["check", file, "--no-record"]);
        assert.equal(result.status, 2);
        assert.match(result.stderr, /実行環境/u);
        assert.ok(!(result.stdout + result.stderr).includes("SECRETBODY"));
        assert.ok(!result.stderr.includes(own.runtime));
      },
    );

    it(
      "fails with fixed text and records no receipt when the dictionary directory is missing",
      needsRuntime,
      () => {
        const own = layout();
        const file = document(own.base);
        fakeRuntime(own, "return [];");
        rmSync(join(own.runtime, "unidic"), { recursive: true });
        const result = run(own, ["check", file]);
        assert.equal(result.status, 2);
        assert.match(result.stderr, /辞書/u);
        assert.ok(!result.stderr.includes(own.runtime));
        const receipts = join(
          own.base,
          "state-home/.claude/state/japanese-check/receipts",
        );
        assert.throws(() => readdirSync(receipts));
      },
    );

    const throwing: Record<string, string> = {
      synchronous: "throw new Error('LEAK ' + text);",
      rejection:
        "Promise.reject(new Error('LEAK ' + readFileSync(process.argv[3], 'utf8'))); throw new Error('LEAK ' + text);",
      timer:
        "setTimeout(() => { throw new Error('LEAK ' + readFileSync(process.argv[3], 'utf8')); }, 0); throw new Error('LEAK ' + text);",
    };
    for (const [name, code] of Object.entries(throwing)) {
      it(
        `keeps the document out of the output when the tokenizer fails (${name})`,
        needsRuntime,
        () => {
          const own = layout();
          const file = document(own.base);
          fakeRuntime(own, code);
          const result = run(own, ["check", file]);
          assert.equal(result.status, 2);
          assert.ok(!(result.stdout + result.stderr).includes("SECRETBODY"));
          assert.ok(!(result.stdout + result.stderr).includes("LEAK"));
        },
      );
    }

    it("prints only an allowed error name", needsRuntime, () => {
      const own = layout();
      const file = document(own.base);
      fakeRuntime(
        own,
        `const e = new Error("x"); e.name = "\\u001b[31mX"; throw e;`,
      );
      const result = run(own, ["check", file]);
      assert.equal(result.status, 2);
      assert.ok(!result.stderr.includes("\u001b"));
      assert.match(result.stderr, /Error/u);
    });

    it(
      "names the analyzer failure with a fixed message and no fragment",
      needsRuntime,
      () => {
        const own = layout();
        const file = document(own.base);
        fakeRuntime(
          own,
          `return [{ surface: "FRAGMENT", byteStart: 0, byteEnd: 8, details: ["名詞"] }];`,
        );
        const result = run(own, ["check", file]);
        assert.equal(result.status, 2);
        assert.match(result.stderr, /形態素と入力位置を対応できません/u);
        assert.ok(!(result.stdout + result.stderr).includes("FRAGMENT"));
        assert.ok(!(result.stdout + result.stderr).includes("SECRETBODY"));
      },
    );

    it("does not echo an unknown profile id", () => {
      const own = layout();
      const file = document(own.base);
      const result = run(own, ["check", file, "--profile", "\u001b[31mevil"]);
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
      const result = run(own, ["check", file, "--profile", "design"]);
      assert.equal(result.status, 2);
      assert.ok(!(result.stdout + result.stderr).includes("FRAGMENT"));
    });

    it("reports a broken package.json as a missing dependency without a fragment", () => {
      const own = layout();
      const file = document(own.base);
      const pkg = fakePackage(join(own.runtime, "node_modules"), "lindera");
      writeFileSync(join(pkg, "package.json"), '{"name": FRAGMENT-TWO');
      const result = run(own, ["check", file]);
      assert.equal(result.status, 2);
      assert.ok(!(result.stdout + result.stderr).includes("FRAGMENT"));
      assert.match(result.stderr, /lindera/u);
    });
  });
});
