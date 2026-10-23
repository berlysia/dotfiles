import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import {
  BLOG_EXTRACT_VERSION,
  SMALL_STRATUM_THRESHOLD,
  aggregateByRule,
  classifyBlogEntry,
  TOOLS,
  extractBlogBody,
  findLeakedFields,
  flattenStrings,
  parseBlogFrontmatter,
  parseJsonl,
  removeWorkDir,
  sweepStaleWorkDirs,
  validateMeta,
  validateRow,
} from "./lib/ja-baseline.mjs";

const LIB_URL = pathToFileURL(
  new URL("./lib/ja-baseline.mjs", import.meta.url).pathname,
).href;

// 本文の一部に見立てた文字列。結果や出力のどこにも出てはならない。
const FRAGMENT = "SECRET-BODY-FRAGMENT-0123";

// `node -e` に渡す短いスクリプトを、親プロセスとして起こす。
function startParent(body) {
  const script = `const lib = await import(${JSON.stringify(LIB_URL)});\n${body}`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  const handle = { child, stdout: "", stderr: "" };
  handle.exited = new Promise((resolve) =>
    child.once("close", (code, signal) => resolve({ code, signal })),
  );
  child.stdout.on("data", (c) => (handle.stdout += c));
  child.stderr.on("data", (c) => (handle.stderr += c));
  return handle;
}

async function waitFor(check, label, timeoutMs = 15_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const value = check();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`timeout waiting for ${label}`);
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function scratch() {
  return mkdtempSync(join(tmpdir(), "ja-baseline-test-"));
}

// ---- ブログの本文の取り出し ----

test("ブログの取り出し: frontmatter・import・JSX の要素の行を除き、コードフェンスと本文を残す", () => {
  const raw = [
    "---",
    "title: 題",
    "date: 2024-03-01",
    "---",
    'import Foo from "./foo"',
    "export const meta = {}",
    "",
    "本文の一行目。",
    "<Figure",
    '  src="a.png"',
    '  alt="a > b"',
    "/>",
    "<Note kind={x > 1}>",
    "中身の行",
    "</Note>",
    "```ts",
    "<Keep />",
    "```",
    "本文の最後。",
    "",
  ].join("\n");
  const body = extractBlogBody(raw);
  assert.equal(
    body,
    ["", "本文の一行目。", "```ts", "<Keep />", "```", "本文の最後。", ""].join(
      "\n",
    ),
  );
  // 行番号は取り出した後の本文で数える
  assert.equal(body.split("\n").indexOf("本文の一行目。") + 1, 2);
  assert.equal(typeof BLOG_EXTRACT_VERSION, "string");
});

test("ブログの取り出し: 入れ子の同名の要素も閉じまで除く", () => {
  const body = extractBlogBody(
    ["<Box>", "<Box>", "x", "</Box>", "y", "</Box>", "残る"].join("\n"),
  );
  assert.equal(body, "残る");
});

test("ブログの選定: draft と日付で始まらない名前は対象外、2024-02 以降は候補", () => {
  const draft = parseBlogFrontmatter(
    "---\ntitle: 下書き\ndate: 2024-05-01\ndraft: true\n---\n本文\n",
  );
  assert.equal(draft.draft, true);
  assert.equal(draft.title, "下書き");
  assert.deepEqual(classifyBlogEntry("2024-05-01-x", draft), {
    candidate: false,
    reason: "draft",
  });
  const plain = parseBlogFrontmatter("---\ntitle: t\n---\n本文\n");
  assert.deepEqual(classifyBlogEntry("sample", plain), {
    candidate: false,
    reason: "no-date-prefix",
  });
  assert.equal(
    classifyBlogEntry("2024-01-31-old", plain).reason,
    "before-2024-02",
  );
  assert.equal(classifyBlogEntry("2024-02-01-new", plain).candidate, true);
});

// ---- 子プロセスの起動と失敗の分類 ----

test("子プロセスの失敗は列挙値と終了コードだけになり、本文の一部は結果にも出力にも出ない", async () => {
  const parent = startParent(`
    const run = (script, timeoutMs) =>
      lib.runChild(process.execPath, ["-e", script], { cwd: ${JSON.stringify(tmpdir())}, timeoutMs });
    const results = [
      await run(${JSON.stringify(`process.stdout.write("${FRAGMENT}"); process.stderr.write("${FRAGMENT}"); throw new Error("${FRAGMENT}")`)}, 20000),
      await run(${JSON.stringify(`process.stdout.write("${FRAGMENT}"); process.exit(3)`)}, 20000),
      await run("setTimeout(() => {}, 90000)", 1000),
    ];
    console.log(JSON.stringify(results));
  `);
  const { code } = await parent.exited;
  assert.equal(code, 0, parent.stderr);
  const results = JSON.parse(parent.stdout);
  assert.deepEqual(
    results.map((r) => [r.status, r.exitCode]),
    [
      ["exit-nonzero", 1],
      ["exit-nonzero", 3],
      ["timeout", null],
    ],
  );
  assert.ok(!parent.stdout.includes(FRAGMENT));
  assert.ok(!parent.stderr.includes(FRAGMENT));
});

test("子プロセスの成功は許すキーだけを読む。JSON でない出力は parse-error", async () => {
  const parent = startParent(`
    const cwd = ${JSON.stringify(tmpdir())};
    const pick = (v) => ({ ruleIds: v.messages.map((m) => String(m.ruleId)) });
    const ok = await lib.runChild(process.execPath, ["-e", ${JSON.stringify(`process.stdout.write(JSON.stringify({ messages: [{ ruleId: "r1", message: "${FRAGMENT}" }], other: "${FRAGMENT}" }))`)}], { cwd, parseOutput: pick });
    const bad = await lib.runChild(process.execPath, ["-e", ${JSON.stringify(`process.stdout.write("not json ${FRAGMENT}")`)}], { cwd, parseOutput: pick });
    console.log(JSON.stringify([ok, bad]));
  `);
  assert.equal((await parent.exited).code, 0, parent.stderr);
  const [ok, bad] = JSON.parse(parent.stdout);
  assert.deepEqual(ok, {
    status: "ok",
    exitCode: 0,
    data: { ruleIds: ["r1"] },
  });
  assert.deepEqual(bad, { status: "parse-error", exitCode: 0, data: null });
  assert.ok(!parent.stdout.includes(FRAGMENT));
});

// ---- 一時 dir と後始末 ----

const SLEEPER = `require("fs").writeFileSync(process.argv[1], String(process.pid)); setInterval(() => {}, 1000)`;

test("親に SIGINT を送ると、親が終わった後に一時 dir が無い", async () => {
  const side = scratch();
  const pidFile = join(side, "pid");
  const parent = startParent(`
    const dir = lib.createWorkDir();
    console.log("DIR " + dir);
    await lib.runChild(process.execPath, ["-e", ${JSON.stringify(SLEEPER)}, ${JSON.stringify(pidFile)}], { cwd: dir, timeoutMs: 120000 });
  `);
  try {
    const dir = await waitFor(
      () => /^DIR (.+)$/m.exec(parent.stdout)?.[1],
      "work dir",
    );
    await waitFor(() => existsSync(pidFile), "child start");
    assert.ok(existsSync(dir));
    parent.child.kill("SIGINT");
    const { code } = await parent.exited;
    assert.equal(code, 130);
    assert.ok(!existsSync(dir));
  } finally {
    rmSync(side, { recursive: true, force: true });
  }
});

test("os.tmpdir() の外のパスと symlink は、後始末の関数が消さずに止まる", () => {
  const root = scratch();
  try {
    const outer = join(root, "ja-baseline-outer");
    mkdirSync(join(outer, "ja-baseline-inner"), { recursive: true });
    // os.tmpdir() の直下でない
    assert.throws(() => removeWorkDir(join(outer, "ja-baseline-inner")), {
      message: "unsafe-path",
    });
    assert.ok(existsSync(join(outer, "ja-baseline-inner")));
    // 別の root を tmpRoot に渡したときの、その外
    assert.throws(() => removeWorkDir(outer, { tmpRoot: join(root, "x") }));
    assert.throws(() =>
      removeWorkDir("/nonexistent-ja-baseline/ja-baseline-x"),
    );
    assert.ok(existsSync(outer));
    // symlink（たどらず、消さない）
    const target = join(root, "target");
    mkdirSync(target);
    const link = join(root, "ja-baseline-link");
    symlinkSync(target, link);
    assert.throws(() => removeWorkDir(link, { tmpRoot: root }), {
      message: "unsafe-path",
    });
    assert.ok(existsSync(target));
    assert.ok(existsSync(link));
    // 接頭辞が違う名前
    mkdirSync(join(root, "other"));
    assert.throws(() => removeWorkDir(join(root, "other"), { tmpRoot: root }));
    // 正しいものは消える
    assert.equal(removeWorkDir(outer, { tmpRoot: root }), true);
    assert.ok(!existsSync(outer));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("起動時の掃除は、更新から 1 時間を超えた自分の ja-baseline- の dir だけを消す", () => {
  const root = scratch();
  try {
    const old = join(root, "ja-baseline-old");
    const fresh = join(root, "ja-baseline-fresh");
    const unrelated = join(root, "unrelated-old");
    for (const dir of [old, fresh, unrelated]) mkdirSync(dir);
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    utimesSync(old, twoHoursAgo, twoHoursAgo);
    utimesSync(unrelated, twoHoursAgo, twoHoursAgo);
    assert.deepEqual(sweepStaleWorkDirs({ tmpRoot: root }), [
      "ja-baseline-old",
    ]);
    assert.ok(!existsSync(old));
    assert.ok(existsSync(fresh));
    assert.ok(existsSync(unrelated));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("一時 dir を 3 回作っても handler は 1 つだけ付く。SIGINT では子が止まってから dir が消える", async () => {
  const counts = startParent(`
    const names = ["SIGINT", "SIGTERM", "SIGHUP", "uncaughtException", "unhandledRejection"];
    const before = names.map((n) => process.listenerCount(n));
    const dirs = [lib.createWorkDir(), lib.createWorkDir(), lib.createWorkDir()];
    const after = names.map((n) => process.listenerCount(n));
    dirs.forEach((d) => lib.disposeWorkDir(d));
    console.log(JSON.stringify({ before, after }));
  `);
  assert.equal((await counts.exited).code, 0, counts.stderr);
  const { before, after } = JSON.parse(counts.stdout);
  assert.deepEqual(
    after.map((n, i) => n - before[i]),
    [1, 1, 1, 1, 1],
  );

  // 子は dir を作り直し続ける。dir を消した後も生きていれば dir が戻る。
  const side = scratch();
  const pidFile = join(side, "pid");
  const reviver = `const fs = require("fs"); const dir = process.argv[2]; fs.writeFileSync(process.argv[1], String(process.pid)); setInterval(() => fs.mkdirSync(dir, { recursive: true }), 2)`;
  const parent = startParent(`
    const dir = lib.createWorkDir();
    console.log("DIR " + dir);
    await lib.runChild(process.execPath, ["-e", ${JSON.stringify(reviver)}, ${JSON.stringify(pidFile)}, dir], { cwd: dir, timeoutMs: 120000 });
  `);
  try {
    const dir = await waitFor(
      () => /^DIR (.+)$/m.exec(parent.stdout)?.[1],
      "work dir",
    );
    const pid = Number(
      await waitFor(
        () => existsSync(pidFile) && readFileSync(pidFile, "utf8"),
        "child pid",
      ),
    );
    parent.child.kill("SIGINT");
    await parent.exited;
    assert.ok(!isAlive(pid), "child still alive");
    await new Promise((r) => setTimeout(r, 100));
    assert.ok(!existsSync(dir), "work dir came back or remained");
  } finally {
    rmSync(side, { recursive: true, force: true });
  }
});

test("未捕捉の例外と unhandled rejection でも、本文の一部は出ず、一時 dir は消える", async () => {
  for (const trigger of [
    `setTimeout(() => { throw new Error("${FRAGMENT}"); }, 30)`,
    `Promise.reject(new Error("${FRAGMENT}"))`,
  ]) {
    const parent = startParent(`
      const dir = lib.createWorkDir();
      console.log("DIR " + dir);
      ${trigger};
      setInterval(() => {}, 1000);
    `);
    const { code } = await parent.exited;
    const dir = /^DIR (.+)$/m.exec(parent.stdout)?.[1];
    assert.equal(code, 1);
    assert.ok(dir, "work dir was not printed");
    assert.ok(!parent.stdout.includes(FRAGMENT));
    assert.ok(!parent.stderr.includes(FRAGMENT));
    assert.ok(!existsSync(dir));
  }
});

// ---- 許すスキーマ ----

const SHA = "a".repeat(40);
const HASH = "b".repeat(64);
const META = {
  rules: {
    tanteki: ["no-ai-jargon", "stock-boundary"],
    yomiyasu: ["dash_list_ending"],
  },
  c108Consent: { answer: "no", date: null },
};
const LINT_ROW = {
  schema: 1,
  source: "a-doc",
  doc: "docs/decisions/0001-x.md",
  tool: "tanteki",
  rule: "no-ai-jargon",
  positions: [[1, 2]],
  count: 1,
};
const DOC_ROW = {
  schema: 1,
  id: "docs/decisions/0001-x.md",
  source: "a-doc",
  writer: "ai-coauthored",
  docType: "design",
  polished: "unknown",
  originalHash: HASH,
  passedHash: HASH,
  bytes: 10,
  repo: "dotfiles",
  sha: SHA,
  path: "docs/decisions/0001-x.md",
  blob: SHA,
  runs: {
    tanteki: { status: "ok", exitCode: 0, type: "adr" },
    yomiyasu: { status: "ok", exitCode: 0, docType: null, skipped: [] },
  },
  hasDisable: false,
};
const PAIR = {
  commit: SHA,
  parent: SHA,
  path: "docs/plans/x.md",
  oldBlob: SHA,
  newBlob: SHA,
};
const DIFF_ROW = {
  schema: 1,
  row: "risk",
  pair: PAIR,
  kind: "number",
  subkind: "lost",
  oldLines: [3],
  newLines: [],
  count: 1,
};

test("検証の関数: 正しい行は通り、snippet の欄・未知の kind・形の違う規則の id・走らせていない規則の id・不可のままの c108 の章は誤りになる", () => {
  assert.deepEqual(validateRow("lint", LINT_ROW, META), []);
  assert.deepEqual(validateRow("documents", DOC_ROW, META), []);
  assert.deepEqual(validateRow("diff", DIFF_ROW, META), []);

  const bad = [
    ["lint", { ...LINT_ROW, snippet: FRAGMENT }, "unknown-key"],
    ["diff", { ...DIFF_ROW, kind: "invented" }, "kind"],
    ["diff", { ...DIFF_ROW, subkind: "invented" }, "subkind"],
    ["lint", { ...LINT_ROW, rule: "has space" }, "rule"],
    ["lint", { ...LINT_ROW, rule: "x".repeat(65) }, "rule"],
    ["lint", { ...LINT_ROW, rule: "valid-but-not-run" }, "not-in-ran-rules"],
    [
      "lint",
      { ...LINT_ROW, source: "c108", doc: "c108-01" },
      "c108-chapter-without-consent",
    ],
    [
      "documents",
      { ...DOC_ROW, source: "c108", id: "c108-01" },
      "c108-chapter-without-consent",
    ],
  ];
  for (const [file, row, reason] of bad) {
    const errors = validateRow(file, row, META);
    assert.ok(errors.length > 0, `${file}:${reason} was accepted`);
    assert.ok(
      errors.some((e) => e.includes(reason)),
      `${file}:${reason} -> ${errors.join(",")}`,
    );
    // 誤りの文に値は入らない
    assert.ok(!errors.join("\n").includes(FRAGMENT));
  }
});

test("検証の関数: 可のときは c108 の章の行と SHA を通し、c108-all は lint に置けない", () => {
  const yes = { ...META, c108Consent: { answer: "yes", date: "2026-10-24" } };
  const chapter = {
    ...DOC_ROW,
    source: "c108",
    id: "c108-01",
    docType: "book",
    writer: "handwritten",
  };
  delete chapter.repo;
  delete chapter.path;
  delete chapter.blob;
  assert.deepEqual(validateRow("documents", chapter, yes), []);
  assert.ok(
    validateRow("lint", { ...LINT_ROW, source: "c108", doc: "c108-all" }, yes)
      .length > 0,
  );
});

test("検証の関数: 不可のときの c108-all の集計の行は、章を特定する欄を持てない", () => {
  const aggregate = {
    schema: 1,
    id: "c108-all",
    source: "c108",
    writer: "handwritten",
    docType: "book",
    aggregate: {
      tools: {
        tanteki: { ok: 9, failures: {} },
        yomiyasu: { ok: 8, failures: { timeout: 1 } },
      },
      rules: [
        {
          tool: "tanteki",
          rule: "no-ai-jargon",
          denominator: 9,
          hitDocs: 0,
          hits: 0,
        },
      ],
      totalBytes: 100,
    },
  };
  assert.deepEqual(validateRow("documents", aggregate, META), []);
  assert.ok(
    validateRow("documents", { ...aggregate, sha: SHA }, META).length > 0,
  );
  assert.ok(
    validateRow(
      "documents",
      { ...aggregate, aggregate: { ...aggregate.aggregate, files: ["x"] } },
      META,
    ).length > 0,
  );
});

test("meta.json の検証: 型と形に合わない値と未知のキーを誤りにする", () => {
  const meta = {
    schema: 1,
    recordedOn: "2026-10-24",
    shas: { dotfiles: SHA, blog: SHA, c108: null },
    visibility: { dotfiles: "PUBLIC", blog: "PUBLIC" },
    c108Consent: { answer: "no", date: null },
    rules: { tanteki: ["no-ai-jargon"], yomiyasu: ["dash_list_ending"] },
    enabledRulesByType: { adr: ["no-ai-jargon"] },
    tools: {
      tanteki: { version: "10.0.4", identicalToRecordedSha: true },
      yomiyasu: { version: "2.0.2", identicalToRecordedSha: true },
      textlintLock: {
        identicalToRecordedSha: true,
        installedVersionsMatch: true,
      },
    },
    blogExtract: { version: BLOG_EXTRACT_VERSION, limits: ["nested-jsx"] },
    population: {
      "a-doc": { count: 1, bytes: 2 },
      b: { count: 1, bytes: 2 },
      pairs: 1,
      "a-pr": 20,
      c108: { count: 9, bytes: 100 },
      blog: { count: 1, bytes: 2 },
      blogExcludedByUser: 0,
      nonRegularMode: 0,
      tooLarge: 0,
    },
    preflight: {
      ancestorConfigIgnored: true,
      yomiyasuLeavesNoState: true,
      yomiyasuRunsIsolated: true,
    },
    auxiliaryCheckPassed: true,
    checkTiming: { medianMs: 1000, node: "v24.22.1", cpuGeneration: "Zen 4" },
  };
  assert.deepEqual(validateMeta(meta), []);
  assert.ok(validateMeta({ ...meta, free: "text" }).length > 0);
  assert.ok(
    validateMeta({
      ...meta,
      visibility: { dotfiles: "PRIVATE", blog: "PUBLIC" },
    }).length > 0,
  );
  assert.ok(
    validateMeta({ ...meta, shas: { ...meta.shas, c108: "short" } }).length > 0,
  );
});

// ---- c108 の補助の検査 ----

test("補助の検査: c108 の本文の 12 字の窓が書き出す文字列にあれば欄の名前だけを返し、公開の出所は突き合わせない", () => {
  const secret = "これは非公開の原稿のなかの一文であり外に出してはならない。";
  const fragment = secret.slice(5, 5 + 12);
  const fields = [
    ["lint.0.rule", "no-ai-jargon"],
    ["documents.3.note", `前置き${fragment}後置き`],
  ];
  assert.deepEqual(
    findLeakedFields([{ source: "c108", body: secret }], fields),
    ["documents.3.note"],
  );
  // 11 字だけでは一致としない
  assert.deepEqual(
    findLeakedFields(
      [{ source: "c108", body: secret }],
      [["f", secret.slice(5, 5 + 11)]],
    ),
    [],
  );
  // 公開の出所の本文は突き合わせない
  for (const source of ["a-doc", "a-pr", "b", "blog"]) {
    assert.deepEqual(findLeakedFields([{ source, body: secret }], fields), []);
  }
  // 返り値に本文は入らない
  assert.ok(
    !JSON.stringify(
      findLeakedFields([{ source: "c108", body: secret }], fields),
    ).includes(fragment),
  );
});

test("flattenStrings は経路つきで全部の文字列を集める", () => {
  assert.deepEqual(flattenStrings({ a: [{ b: "x" }], c: 1, d: "y" }), [
    ["a.0.b", "x"],
    ["d", "y"],
  ]);
});

// ---- 集計の骨組み ----

test("集計: 分母は走行に成功し、その規則が有効だった文書。分母が閾値未満の区分には印が付く", () => {
  const meta = {
    rules: {
      tanteki: ["no-ai-jargon", "stock-boundary"],
      yomiyasu: ["dash_list_ending"],
    },
    enabledRulesByType: {
      adr: ["no-ai-jargon"],
      stock: ["no-ai-jargon", "stock-boundary"],
    },
  };
  const doc = (id, docType, type, tantekiStatus = "ok") => ({
    ...DOC_ROW,
    id,
    path: id,
    docType,
    runs: {
      tanteki: { status: tantekiStatus, exitCode: 0, type },
      yomiyasu: { status: "ok", exitCode: 0, docType: null, skipped: [] },
    },
  });
  const documents = [
    doc("docs/decisions/a.md", "design", "adr"),
    doc("docs/decisions/b.md", "design", "adr", "timeout"),
    doc("docs/plans/c.md", "report", "stock"),
  ];
  const lint = [{ ...LINT_ROW, doc: "docs/decisions/a.md", count: 2 }];
  const cells = aggregateByRule({ documents, lint, meta });
  const find = (stratum, tool, rule) =>
    cells.find(
      (c) => c.stratum === stratum && c.tool === tool && c.rule === rule,
    );
  const designJargon = find(
    "a-doc/ai-coauthored/design",
    "tanteki",
    "no-ai-jargon",
  );
  assert.equal(designJargon.denominator, 1);
  assert.equal(designJargon.hitDocs, 1);
  assert.equal(designJargon.hits, 2);
  assert.equal(designJargon.small, 1 < SMALL_STRATUM_THRESHOLD);
  assert.equal(
    find("a-doc/ai-coauthored/design", "tanteki", "stock-boundary").denominator,
    0,
  );
  assert.equal(
    find("a-doc/ai-coauthored/report", "tanteki", "stock-boundary").denominator,
    1,
  );
});

// ---- 結果のファイル（tests/ja-baseline/）の検査（plan-2 T5） ----

const RESULT_DIR = new URL("./ja-baseline/", import.meta.url);
const readResult = (name) => readFileSync(new URL(name, RESULT_DIR), "utf8");
const resultMeta = JSON.parse(readResult("meta.json"));
const resultDocuments = parseJsonl(readResult("documents.jsonl"));
const resultLint = parseJsonl(readResult("lint.jsonl"));
const resultDiff = parseJsonl(readResult("diff.jsonl"));
// stock-boundary が有効な種別（配布先の tanteki の stockTypes）。meta.json から読む。
const stockBoundaryTypes = Object.entries(resultMeta.enabledRulesByType)
  .filter(([, rules]) => rules.includes("stock-boundary"))
  .map(([type]) => type);

test("結果: 全部の行が許すスキーマに収まる（未知のキー、自由な文字列、未知の規則の id、未知の kind が 0 件）", () => {
  assert.deepEqual(validateMeta(resultMeta), []);
  const errors = [];
  for (const [file, rows] of [
    ["documents", resultDocuments],
    ["lint", resultLint],
    ["diff", resultDiff],
  ]) {
    rows.forEach((row, i) => {
      for (const e of validateRow(file, row, resultMeta))
        errors.push(`${file}[${i}] ${e}`);
    });
  }
  assert.deepEqual(errors, []);
});

test("結果: lint.jsonl は（出所、文書、道具、規則）で一意", () => {
  const keys = resultLint.map((r) =>
    [r.source, r.doc, r.tool, r.rule].join("\u0000"),
  );
  assert.equal(new Set(keys).size, keys.length);
});

test("結果: 全部の文書と組に走行の成否がある", () => {
  for (const row of resultDocuments) {
    if (row.aggregate) continue;
    for (const tool of TOOLS) assert.ok(row.runs[tool].status, row.id);
  }
  const pairRows = resultDiff.filter((r) => r.row === "pair");
  assert.equal(pairRows.length, resultMeta.population.pairs);
  for (const row of pairRows) assert.ok(row.run.status);
});

test("結果: 規則ごと・区分ごとに、当たった文書の数と分母を出せ、小さい区分に印が付く", () => {
  const cells = aggregateByRule({
    documents: resultDocuments,
    lint: resultLint,
    meta: resultMeta,
  });
  // 走らせた規則の全集合から列挙するので、当たり 0 件の規則も出る
  const strata = new Set(cells.map((c) => c.stratum));
  for (const stratum of strata) {
    for (const tool of TOOLS) {
      const rules = new Set(
        cells
          .filter((c) => c.stratum === stratum && c.tool === tool)
          .map((c) => c.rule),
      );
      assert.deepEqual([...rules].sort(), [...resultMeta.rules[tool]].sort());
    }
  }
  for (const c of cells) {
    assert.ok(c.hitDocs <= c.denominator, `${c.stratum} ${c.tool} ${c.rule}`);
    assert.equal(c.small, c.denominator < SMALL_STRATUM_THRESHOLD);
  }
  // stock-boundary の分母には、その規則が有効でない種別（flow・record）の文書が入らない
  assert.ok(stockBoundaryTypes.includes("stock"));
  assert.ok(!stockBoundaryTypes.includes("flow"));
  assert.ok(!stockBoundaryTypes.includes("record"));
  for (const c of cells.filter(
    (x) => x.tool === "tanteki" && x.rule === "stock-boundary",
  )) {
    const docType = c.stratum.split("/")[2];
    if (docType === "caller" || docType === "book" || docType === "essay")
      assert.equal(c.denominator, 0, c.stratum);
  }
});

test("結果: 取り出しの関数の版と配布先の同一性と補助の検査の印", () => {
  assert.equal(resultMeta.blogExtract.version, BLOG_EXTRACT_VERSION);
  assert.equal(resultMeta.tools.tanteki.identicalToRecordedSha, true);
  assert.equal(resultMeta.tools.yomiyasu.identicalToRecordedSha, true);
  assert.equal(resultMeta.tools.textlintLock.identicalToRecordedSha, true);
  assert.equal(resultMeta.tools.textlintLock.installedVersionsMatch, true);
  assert.equal(resultMeta.auxiliaryCheckPassed, true);
  assert.deepEqual(resultMeta.preflight, {
    ancestorConfigIgnored: true,
    yomiyasuLeavesNoState: true,
    yomiyasuRunsIsolated: true,
  });
});

test("結果: c108 は回答どおりに残る（不可は集計の行だけ、可は章の行と SHA と回答の日付）", () => {
  const c108Docs = resultDocuments.filter((r) => r.source === "c108");
  const c108Lint = resultLint.filter((r) => r.source === "c108");
  if (resultMeta.c108Consent.answer === "no") {
    assert.equal(c108Docs.length, 1);
    const [row] = c108Docs;
    assert.equal(row.id, "c108-all");
    assert.equal(c108Lint.length, 0);
    assert.equal(resultMeta.shas.c108, null);
    assert.equal(resultMeta.c108Consent.date, null);
    // 章を特定する欄（識別子、ハッシュ、SHA、位置、章ごとのバイト数）が無い
    assert.deepEqual(Object.keys(row.aggregate).sort(), [
      "rules",
      "tools",
      "totalBytes",
    ]);
    for (const key of ["originalHash", "passedHash", "sha", "bytes", "runs"])
      assert.ok(!(key in row), key);
    // 走らせた規則の全集合から、当たり 0 件の規則を含めて列挙できる
    for (const tool of TOOLS) {
      const listed = row.aggregate.rules
        .filter((r) => r.tool === tool)
        .map((r) => r.rule)
        .sort();
      assert.deepEqual(listed, [...resultMeta.rules[tool]].sort());
    }
    for (const r of row.aggregate.rules) assert.ok(r.hitDocs <= r.denominator);
    assert.equal(
      resultMeta.population.c108.count,
      row.aggregate.tools.tanteki.ok +
        Object.values(row.aggregate.tools.tanteki.failures).reduce(
          (a, b) => a + b,
          0,
        ),
    );
  } else {
    assert.ok(c108Docs.every((r) => r.id !== "c108-all"));
    assert.ok(c108Docs.every((r) => r.sha === resultMeta.shas.c108));
    assert.ok(resultMeta.c108Consent.date);
  }
});

test("結果: スキーマは結果のファイルに効いている（snippet の欄と、不可のままの c108 の章を足すと誤りになる）", () => {
  const baseLint = resultLint[0];
  assert.ok(baseLint, "lint.jsonl に行がある");
  assert.ok(
    validateRow("lint", { ...baseLint, snippet: FRAGMENT }, resultMeta).some(
      (e) => e.includes("unknown-key"),
    ),
  );
  const noConsent = {
    ...resultMeta,
    c108Consent: { answer: "no", date: null },
  };
  assert.ok(
    validateRow(
      "lint",
      { ...baseLint, source: "c108", doc: "c108-01" },
      noConsent,
    ).some((e) => e.includes("c108-chapter-without-consent")),
  );
  const doc = resultDocuments.find((r) => !r.aggregate);
  assert.ok(
    validateRow(
      "documents",
      { ...doc, source: "c108", id: "c108-01" },
      noConsent,
    ).some((e) => e.includes("c108-chapter-without-consent")),
  );
});
