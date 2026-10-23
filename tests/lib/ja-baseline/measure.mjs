// 旧の日本語校正の道具（tanteki と yomiyasu）の測定を一度だけ走らせ、結果だけを tests/ja-baseline/
// に書く。本文は 1 つのプロセスの中の一時 dir に置き、結果を書いた後に消す。
//
// 使い方（利用者の回答は引数で受ける）:
//   node tests/lib/ja-baseline/measure.mjs \
//     --dotfiles-sha <SHA> --blog-sha <SHA> \
//     [--cpk DIR --c108-consent yes|no --c108-date YYYY-MM-DD] \
//     --blog DIR --blog-pick YYYY-MM-DD=essay|book ... --blog-excluded N
//
// 守り: 子プロセスの stderr は捨て、結果は許すスキーマ（tests/lib/ja-baseline.mjs）で書き出す前に
// 検査する。失敗は識別子と列挙値だけで報告する。c108 の本文は 12 字の窓で書き出す全部の文字列と
// 突き合わせる（補助）。c108 の章の識別子・ファイル名・SHA は、利用者の回答が「可」のとき以外は
// 出力にも結果にも出さない。

import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { cpus, homedir, tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BLOG_EXTRACT_LIMITS,
  BLOG_EXTRACT_VERSION,
  FAILURE_KINDS,
  MAX_DOCUMENT_BYTES,
  TANTEKI_TYPES,
  TOOLS,
  TYPE_MAP,
  WORKDIR_PREFIX,
  classifyBlogEntry,
  createWorkDir,
  disposeWorkDir,
  docTypeForPath,
  extractBlogBody,
  findLeakedFields,
  flattenStrings,
  isC108Chapter,
  parseBlogFrontmatter,
  runChild,
  validateMeta,
  validateRow,
} from "../ja-baseline.mjs";
import {
  blobSizes,
  defaultBranchHead,
  gh,
  git,
  listRecentPrNumbers,
  listRevisionPairs,
  listTree,
} from "./extract.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "../../..");
const RUNNER = join(HERE, "tanteki-runner.mjs");
const DEPLOYED = join(homedir(), ".claude", "skills");
const TANTEKI_LINT = join(DEPLOYED, "tanteki", "scripts", "lint.mjs");
const YOMIYASU_LINT = join(DEPLOYED, "yomiyasu", "scripts", "yomiyasu_lint.py");
const YOMIYASU_CHECK = join(
  DEPLOYED,
  "yomiyasu",
  "scripts",
  "yomiyasu_check.py",
);
const TEXTLINT_DIR = join(homedir(), ".config", "textlint");
const PR_COUNT = 20;
const CONCURRENCY = 4;

let stage = "start";

function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

function gitBlobSha1(buffer) {
  return createHash("sha1")
    .update(`blob ${buffer.length}\0`)
    .update(buffer)
    .digest("hex");
}

function fail(label) {
  throw new Error(label);
}

// ---- 引数 ----

function parseArgs(argv) {
  const opts = {
    consent: "no",
    consentDate: null,
    blogPicks: [],
    blogExcluded: 0,
    out: join(REPO_ROOT, "tests", "ja-baseline"),
    dotfiles: REPO_ROOT,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = () => argv[++i];
    if (arg === "--dotfiles") opts.dotfiles = resolve(value());
    else if (arg === "--blog") opts.blog = resolve(value());
    else if (arg === "--cpk") opts.cpk = resolve(value());
    else if (arg === "--dotfiles-sha") opts.dotfilesSha = value();
    else if (arg === "--blog-sha") opts.blogSha = value();
    else if (arg === "--c108-consent") opts.consent = value();
    else if (arg === "--c108-date") opts.consentDate = value();
    else if (arg === "--blog-excluded") opts.blogExcluded = Number(value());
    else if (arg === "--out") opts.out = resolve(value());
    else if (arg === "--blog-pick") {
      const [date, type] = value().split("=");
      if (
        !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
        !["essay", "book"].includes(type)
      )
        fail("bad-blog-pick");
      opts.blogPicks.push({ date, docType: type });
    } else fail("unknown-option");
  }
  if (!/^[0-9a-f]{40}$/.test(opts.dotfilesSha ?? "")) fail("bad-dotfiles-sha");
  if (opts.blog && !/^[0-9a-f]{40}$/.test(opts.blogSha ?? ""))
    fail("bad-blog-sha");
  if (!["yes", "no"].includes(opts.consent)) fail("bad-consent");
  if (
    opts.consent === "yes" &&
    !/^\d{4}-\d{2}-\d{2}$/.test(opts.consentDate ?? "")
  )
    fail("bad-consent-date");
  if (!Number.isInteger(opts.blogExcluded) || opts.blogExcluded < 0)
    fail("bad-blog-excluded");
  return opts;
}

// ---- 公開の確認、同一性、版 ----

function repoVisibility(slug) {
  return JSON.parse(gh(["repo", "view", slug, "--json", "visibility"]))
    .visibility;
}

function assertReachable(dir, sha) {
  const head = defaultBranchHead(dir);
  try {
    git(dir, ["merge-base", "--is-ancestor", sha, head]);
  } catch {
    fail("sha-not-reachable-from-default-branch");
  }
}

// 記録した SHA の dir の中身と、配布先の dir の中身が同じか（__pycache__ と node_modules は除く）。
function listDeployedFiles(root) {
  const out = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      if (name === "__pycache__" || name === "node_modules") continue;
      const path = join(dir, name);
      const stat = lstatSync(path);
      if (stat.isDirectory()) walk(path);
      else if (stat.isFile()) out.push(relative(root, path));
    }
  };
  walk(root);
  return out.sort();
}

function sameAsRecorded(dotfiles, sha, relDir, deployedRoot) {
  const entries = listTree(dotfiles, sha, [`${relDir}/`]).filter(
    (e) =>
      (e.mode === "100644" || e.mode === "100755") &&
      !e.path.includes("/__pycache__/") &&
      !e.path.startsWith(`${relDir}/node_modules`),
  );
  const recorded = new Map(
    entries.map((e) => [e.path.slice(relDir.length + 1), e.blob]),
  );
  const deployed = listDeployedFiles(deployedRoot);
  if (deployed.length !== recorded.size) return false;
  return deployed.every(
    (file) =>
      recorded.get(file) ===
      gitBlobSha1(readFileSync(join(deployedRoot, file))),
  );
}

// bun.lock の packages の行から、最上位の `名前 -> 版` を読む。
function readLockVersions(text) {
  const versions = new Map();
  for (const m of text.matchAll(
    /^ {4}"((?:@[^"/]+\/)?[^"/]+)": \["((?:@[^"/]+\/)?[^"@/]+)@([^"]+)"/gm,
  )) {
    if (m[1] === m[2]) versions.set(m[1], m[3]);
  }
  return versions;
}

function textlintInstalledVersionsMatch(lockText) {
  const lock = readLockVersions(lockText);
  const modules = join(TEXTLINT_DIR, "node_modules");
  const names = [];
  for (const name of readdirSync(modules)) {
    if (name === "@textlint") {
      for (const sub of readdirSync(join(modules, name)))
        names.push(`${name}/${sub}`);
    } else if (name.startsWith("textlint")) names.push(name);
  }
  if (names.length === 0) return false;
  return names.every((name) => {
    const pkg = JSON.parse(
      readFileSync(join(modules, name, "package.json"), "utf8"),
    );
    return lock.get(name) === pkg.version;
  });
}

// ---- 測定の前の確かめ ----

const PROBE_TEXT =
  "# 題\n\nこれは非常に長い文で、読点が多く、しかし、それでも、続いて、さらに、そして、また、終わらない。である。ですます。\n";

function parseTantekiOutput(value) {
  if (!value || !Array.isArray(value.messages)) throw new Error("shape");
  return value.messages.map((m) => {
    if (
      typeof m.ruleId !== "string" ||
      !Number.isInteger(m.line) ||
      !Number.isInteger(m.column)
    )
      throw new Error("shape");
    return { ruleId: m.ruleId, line: m.line, column: m.column };
  });
}

function parseYomiyasuLint(value) {
  if (!value || !Array.isArray(value.findings)) throw new Error("shape");
  const skipped = Object.keys(value.context?.skipped_by_doc_type ?? {});
  return {
    findings: value.findings.map((f) => {
      if (typeof f.rule !== "string" || !Number.isInteger(f.line))
        throw new Error("shape");
      return { rule: f.rule, line: f.line };
    }),
    skipped,
  };
}

function parseYomiyasuCheck(value) {
  const risks = value?.diff?.meaning_risks ?? [];
  if (!Array.isArray(risks)) throw new Error("shape");
  return risks.map((r) => {
    if (typeof r.kind !== "string") throw new Error("shape");
    const line = (n) => (Number.isInteger(n) && n >= 0 ? n : null);
    return {
      kind: r.kind,
      subkind: typeof r.subkind === "string" ? r.subkind : null,
      oldLine: line(r.old_line),
      newLine: line(r.new_line),
    };
  });
}

function runTanteki(type, file, configPath, cwd) {
  return runChild(
    process.execPath,
    [RUNNER, "lint", TANTEKI_LINT, type, file, configPath],
    { cwd, parseOutput: parseTantekiOutput },
  );
}

function runYomiyasuLint(text, docType, cwd) {
  const args = ["-I", "-B", YOMIYASU_LINT, "--json"];
  if (docType) args.push("--doc-type", docType);
  return runChild("python3", args, {
    cwd,
    input: text,
    parseOutput: parseYomiyasuLint,
  });
}

function runYomiyasuCheck(oldText, newText, cwd) {
  const input = `<<<yomiyasu:original>>>\n${oldText}\n<<<yomiyasu:final>>>\n${newText}`;
  return runChild(
    "python3",
    ["-I", "-B", YOMIYASU_CHECK, "run", "--stdin", "--no-record", "--json"],
    { cwd, input, parseOutput: parseYomiyasuCheck },
  );
}

async function preflight(work, configPath) {
  const outer = join(work, "outer");
  const inner = join(outer, "inner");
  const cwd = join(work, "cwd");
  mkdirSync(inner, { recursive: true });
  mkdirSync(cwd);
  const probe = join(inner, "probe.md");
  writeFileSync(probe, PROBE_TEXT);

  const base = await runTanteki("adr", probe, configPath, cwd);
  const decoy = (dir) => {
    writeFileSync(
      join(dir, ".textlintrc.json"),
      JSON.stringify({ rules: { "max-ten": false } }),
    );
    mkdirSync(join(dir, "node_modules", "textlint-rule-x"), {
      recursive: true,
    });
    writeFileSync(
      join(dir, "node_modules", "textlint-rule-x", "package.json"),
      JSON.stringify({ name: "textlint-rule-x", main: "index.js" }),
    );
    writeFileSync(
      join(dir, "node_modules", "textlint-rule-x", "index.js"),
      "module.exports = () => ({});\n",
    );
  };
  decoy(cwd);
  decoy(outer);
  const withDecoy = await runTanteki("adr", probe, configPath, cwd);
  const ancestorConfigIgnored =
    base.status === "ok" &&
    base.data.length > 0 &&
    withDecoy.status === "ok" &&
    JSON.stringify(base.data) === JSON.stringify(withDecoy.data);

  // yomiyasu が状態を残さないこと
  const stateCwd = join(work, "state-cwd");
  mkdirSync(stateCwd);
  const topLevel = execFileSync(
    "git",
    ["-C", REPO_ROOT, "rev-parse", "--show-toplevel"],
    {
      encoding: "utf8",
    },
  ).trim();
  const listTmp = () =>
    readdirSync(realpathSync(tmpdir()))
      .filter((n) => n !== work.split("/").pop())
      .sort();
  const beforeTmp = listTmp();
  const beforeTop = existsSync(join(topLevel, ".yomiyasu"));
  const check = await runYomiyasuCheck(
    "# 題\n\n2024年に行わない。\n",
    "# 題\n\n2025年に行う。\n",
    stateCwd,
  );
  const lint = await runYomiyasuLint(PROBE_TEXT, null, stateCwd);
  const afterTmp = listTmp();
  const noState =
    JSON.stringify(beforeTmp) === JSON.stringify(afterTmp) &&
    existsSync(join(topLevel, ".yomiyasu")) === beforeTop &&
    readdirSync(stateCwd).length === 0;
  return {
    ancestorConfigIgnored,
    yomiyasuLeavesNoState: noState,
    yomiyasuRunsIsolated: check.status === "ok" && lint.status === "ok",
  };
}

function cpuGeneration() {
  const model = cpus()[0]?.model ?? "";
  const gen = /(\d+)(?:st|nd|rd|th) Gen/.exec(model)?.[0];
  const vendor = /Intel|AMD|Apple|ARM/.exec(model)?.[0] ?? "unknown";
  return gen ? `${gen} ${vendor}`.slice(0, 32) : vendor;
}

function measureCheckTime(adrText, work) {
  const file = join(work, "adr-0036.md");
  writeFileSync(file, adrText);
  const cli = join(REPO_ROOT, "home", "dot_claude", "japanese-check", "cli.ts");
  const once = () => {
    const start = performance.now();
    const result = spawnSync(
      process.execPath,
      [cli, "check", file, "--no-record"],
      {
        cwd: REPO_ROOT,
        stdio: "ignore",
        timeout: 300_000,
      },
    );
    if (result.error || result.signal) fail("check-timing-run-failed");
    return performance.now() - start;
  };
  once();
  const times = [once(), once(), once()].sort((a, b) => a - b);
  return {
    medianMs: Math.round(times[1]),
    node: process.version,
    cpuGeneration: cpuGeneration(),
  };
}

// ---- 規則の全集合 ----

function yomiyasuRuleIds() {
  const source = readFileSync(YOMIYASU_LINT, "utf8");
  const ids = new Set();
  for (const m of source.matchAll(/"rule": "([a-z_]+)"/g)) ids.add(m[1]);
  for (const m of source.matchAll(/\brule = "([a-z_]+)"/g)) ids.add(m[1]);
  const script = `import importlib.util,json,sys
spec=importlib.util.spec_from_file_location("yl",sys.argv[1])
m=importlib.util.module_from_spec(spec)
sys.modules["yl"]=m
spec.loader.exec_module(m)
print(json.dumps([r for _,r,_ in m.INFO_SENTENCE_PATTERNS]))`;
  const out = execFileSync(
    "python3",
    ["-I", "-B", "-c", script, YOMIYASU_LINT],
    {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    },
  );
  for (const rule of JSON.parse(out)) ids.add(rule);
  return [...ids].sort();
}

async function tantekiRules(configPath, cwd) {
  const byType = {};
  for (const type of TANTEKI_TYPES) {
    const run = await runChild(
      process.execPath,
      [RUNNER, "describe", TANTEKI_LINT, type, configPath],
      {
        cwd,
        parseOutput: (v) => {
          if (
            !Array.isArray(v?.rules) ||
            !v.rules.every((r) => typeof r === "string")
          )
            throw new Error("shape");
          return v.rules;
        },
      },
    );
    if (run.status !== "ok") fail("tanteki-describe-failed");
    byType[type] = run.data;
  }
  const all = [];
  for (const rules of Object.values(byType))
    for (const rule of rules) if (!all.includes(rule)) all.push(rule);
  return { byType, all };
}

// ---- 母集団 ----

function readBlob(dir, blob) {
  return git(dir, ["cat-file", "blob", blob]);
}

function collectDotfilesDocuments(dotfiles, sha) {
  const tree = listTree(dotfiles, sha, ["docs/decisions", "docs/plans"]);
  const regular = tree.filter((e) => e.mode === "100644");
  const aDocs = regular
    .filter((e) => docTypeForPath(e.path) !== null)
    .sort((x, y) => x.path.localeCompare(y.path));
  const docs = [];
  const sizes = blobSizes(
    dotfiles,
    aDocs.map((e) => e.blob),
  );
  for (const e of aDocs) {
    docs.push({
      source: "a-doc",
      id: e.path,
      writer: "ai-coauthored",
      docType: docTypeForPath(e.path),
      ident: { repo: "dotfiles", sha, path: e.path, blob: e.blob },
      size: sizes.get(e.blob),
      load: () => readBlob(dotfiles, e.blob),
    });
  }
  // (b): 履歴に 2 版以上あるファイルの最初の版
  for (const e of aDocs) {
    const commits = git(dotfiles, [
      "log",
      "--no-merges",
      "--reverse",
      "--format=%H",
      sha,
      "--",
      e.path,
    ])
      .trim()
      .split("\n")
      .filter(Boolean);
    if (commits.length < 2) continue;
    const blob = git(dotfiles, ["rev-parse", `${commits[0]}:${e.path}`]).trim();
    docs.push({
      source: "b",
      id: e.path,
      writer: "ai-coauthored",
      docType: docTypeForPath(e.path),
      ident: { repo: "dotfiles", sha: commits[0], path: e.path, blob },
      size: Number(git(dotfiles, ["cat-file", "-s", blob]).trim()),
      load: () => readBlob(dotfiles, blob),
    });
  }
  return {
    docs,
    aDocCount: aDocs.length,
    aDocBytes: aDocs.reduce((n, e) => n + sizes.get(e.blob), 0),
    nonRegularMode: tree.filter((e) => e.mode !== "100644").length,
    paths: aDocs.map((e) => e.path),
    adr0036: regular.find((e) =>
      /^docs\/decisions\/0036-[^/]+\.md$/.test(e.path),
    ),
  };
}

function collectPrDocuments(dotfiles, sha) {
  const numbers = listRecentPrNumbers(dotfiles, sha, PR_COUNT);
  return numbers.map((number) => ({
    source: "a-pr",
    id: `pr-${number}`,
    writer: "ai-coauthored",
    docType: "caller",
    ident: { pr: number },
    size: null,
    load: () => {
      // 親のプロセスが自分の資格情報で取る。旧の道具の子プロセスには渡さない。
      const out = JSON.parse(
        gh([
          "pr",
          "view",
          String(number),
          "-R",
          "berlysia/dotfiles",
          "--json",
          "body,number",
        ]),
      );
      if (out.number !== number) fail("pr-number-mismatch");
      return out.body ?? "";
    },
  }));
}

function collectBlogDocuments(blog, sha, picks) {
  const entries = listTree(blog, sha, ["articles/"]).filter(
    (e) => e.mode === "100644",
  );
  const candidates = [];
  const sizes = new Map();
  const files = [];
  for (const e of entries) {
    const rel = e.path.slice("articles/".length);
    const parts = rel.split("/");
    const isFile = parts.length === 1 && rel.endsWith(".mdx");
    const isIndex = parts.length === 2 && parts[1] === "index.mdx";
    if (!isFile && !isIndex) continue;
    files.push({ e, entryName: isFile ? rel.replace(/\.mdx$/, "") : parts[0] });
  }
  for (const [blob, size] of blobSizes(
    blog,
    files.map((f) => f.e.blob),
  ))
    sizes.set(blob, size);
  for (const { e, entryName } of files) {
    const head = readBlob(blog, e.blob).slice(0, 4096);
    const verdict = classifyBlogEntry(entryName, parseBlogFrontmatter(head));
    if (verdict.candidate)
      candidates.push({
        path: e.path,
        blob: e.blob,
        date: verdict.date,
        size: sizes.get(e.blob),
      });
  }
  const docs = [];
  for (const pick of picks) {
    const matches = candidates.filter((c) => c.date === pick.date);
    if (matches.length !== 1) fail("blog-pick-not-unique");
    const c = matches[0];
    docs.push({
      source: "blog",
      id: c.path,
      writer: "handwritten",
      docType: pick.docType,
      ident: { repo: "blog.berlysia.net", sha, path: c.path, blob: c.blob },
      size: c.size,
      extract: extractBlogBody,
      load: () => readBlob(blog, c.blob),
    });
  }
  return docs;
}

function collectC108Documents(cpk, consentYes) {
  const sha = defaultBranchHead(cpk);
  const chapters = listTree(cpk, sha, ["books/C108/manuscript/"])
    .filter(
      (e) =>
        e.mode === "100644" &&
        /^books\/C108\/manuscript\/[^/]+$/.test(e.path) &&
        isC108Chapter(e.path.split("/").pop()),
    )
    .sort((x, y) => x.path.localeCompare(y.path));
  const sizes = blobSizes(
    cpk,
    chapters.map((e) => e.blob),
  );
  return {
    sha,
    docs: chapters.map((e, index) => ({
      source: "c108",
      id: `c108-${String(index + 1).padStart(2, "0")}`,
      writer: "handwritten",
      docType: "book",
      ident: consentYes ? { sha } : {},
      size: sizes.get(e.blob),
      load: () => readBlob(cpk, e.blob),
    })),
  };
}

// ---- 走らせる ----

async function pool(items, limit, fn) {
  const results = Array.from({ length: items.length });
  let next = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker),
  );
  return results;
}

function tooLargeRun(extra) {
  return { status: "too-large", exitCode: null, ...extra };
}

async function measureDocument(doc, index, dirs, configPath) {
  const body = doc.body;
  const tantekiType = TYPE_MAP[doc.docType].tanteki;
  const yomiyasuType = TYPE_MAP[doc.docType].yomiyasu;
  if (
    doc.size > MAX_DOCUMENT_BYTES ||
    Buffer.byteLength(body) > MAX_DOCUMENT_BYTES
  ) {
    return {
      tanteki: tooLargeRun({ type: tantekiType }),
      yomiyasu: tooLargeRun({ docType: yomiyasuType, skipped: [] }),
      findings: { tanteki: [], yomiyasu: [] },
    };
  }
  const file = join(dirs.input, `doc-${String(index).padStart(4, "0")}.md`);
  writeFileSync(file, body);
  const [t, y] = await Promise.all([
    runTanteki(tantekiType, file, configPath, dirs.cwd),
    runYomiyasuLint(body, yomiyasuType, dirs.cwd),
  ]);
  return {
    tanteki: { status: t.status, exitCode: t.exitCode, type: tantekiType },
    yomiyasu: {
      status: y.status,
      exitCode: y.exitCode,
      docType: yomiyasuType,
      skipped: y.status === "ok" ? y.data.skipped.sort() : [],
    },
    findings: {
      tanteki:
        t.status === "ok"
          ? t.data.map((m) => ({
              rule: m.ruleId,
              position: [m.line, m.column],
            }))
          : [],
      yomiyasu:
        y.status === "ok"
          ? y.data.findings.map((f) => ({
              rule: f.rule,
              position: [f.line, 0],
            }))
          : [],
    },
  };
}

function groupFindings(findings) {
  const groups = new Map();
  for (const f of findings) {
    if (!groups.has(f.rule)) groups.set(f.rule, []);
    groups.get(f.rule).push(f.position);
  }
  return groups;
}

// ---- main ----

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const consentYes = opts.consent === "yes";
  const work = createWorkDir();
  try {
    const dirs = {
      input: join(work, "in"),
      cwd: join(work, "run-cwd"),
      cfg: join(work, "cfg"),
    };
    for (const d of Object.values(dirs)) mkdirSync(d);

    stage = "visibility";
    const visibility = {
      dotfiles: repoVisibility("berlysia/dotfiles"),
      blog: repoVisibility("berlysia/blog.berlysia.net"),
    };
    if (visibility.dotfiles !== "PUBLIC" || visibility.blog !== "PUBLIC")
      fail("repo-not-public");

    stage = "reachability";
    assertReachable(opts.dotfiles, opts.dotfilesSha);
    if (opts.blog) assertReachable(opts.blog, opts.blogSha);
    // c108 の SHA は結果に残さない（可のときだけ残す）。測定にだけ使う。

    stage = "identity";
    const tantekiIdentical = sameAsRecorded(
      opts.dotfiles,
      opts.dotfilesSha,
      ".skills/tanteki",
      join(DEPLOYED, "tanteki"),
    );
    const yomiyasuIdentical = sameAsRecorded(
      opts.dotfiles,
      opts.dotfilesSha,
      ".skills/yomiyasu",
      join(DEPLOYED, "yomiyasu"),
    );
    const recordedLock = git(opts.dotfiles, [
      "cat-file",
      "blob",
      `${opts.dotfilesSha}:home/dot_config/textlint/bun.lock`,
    ]);
    const deployedLock = readFileSync(join(TEXTLINT_DIR, "bun.lock"), "utf8");
    const lockIdentical = recordedLock === deployedLock;
    const installedMatch = textlintInstalledVersionsMatch(deployedLock);
    if (
      !tantekiIdentical ||
      !yomiyasuIdentical ||
      !lockIdentical ||
      !installedMatch
    )
      fail("deployed-tools-differ-from-recorded-sha");

    const configPath = join(dirs.cfg, ".textlintrc.json");
    writeFileSync(
      configPath,
      git(opts.dotfiles, [
        "cat-file",
        "blob",
        `${opts.dotfilesSha}:.skills/tanteki/.textlintrc.json`,
      ]),
    );

    stage = "rules";
    const tanteki = await tantekiRules(configPath, dirs.cwd);
    const rules = { tanteki: tanteki.all, yomiyasu: yomiyasuRuleIds() };

    stage = "preflight";
    const pre = await preflight(work, configPath);
    if (
      !pre.ancestorConfigIgnored ||
      !pre.yomiyasuLeavesNoState ||
      !pre.yomiyasuRunsIsolated
    ) {
      console.log(`preflight failed: ${JSON.stringify(pre)}`);
      fail("preflight-failed");
    }

    stage = "population";
    const dotfilesSet = collectDotfilesDocuments(
      opts.dotfiles,
      opts.dotfilesSha,
    );
    const prDocs = collectPrDocuments(opts.dotfiles, opts.dotfilesSha);
    const blogDocs = opts.blog
      ? collectBlogDocuments(opts.blog, opts.blogSha, opts.blogPicks)
      : [];
    stage = "population-c108";
    const c108 = opts.cpk
      ? collectC108Documents(opts.cpk, consentYes)
      : { sha: null, docs: [] };
    const docs = [...dotfilesSet.docs, ...prDocs, ...blogDocs, ...c108.docs];

    stage = "load";
    for (const doc of docs) {
      doc.raw = doc.load();
      doc.body = doc.extract ? doc.extract(doc.raw) : doc.raw;
      if (doc.size === null) doc.size = Buffer.byteLength(doc.raw);
    }

    stage = "time";
    const adrBlob = dotfilesSet.adr0036;
    if (!adrBlob) fail("adr-0036-missing");
    const checkTiming = measureCheckTime(
      readBlob(opts.dotfiles, adrBlob.blob),
      work,
    );

    stage = "run-documents";
    const measured = await pool(docs, CONCURRENCY, (doc, i) =>
      measureDocument(doc, i, dirs, configPath),
    );

    stage = "pairs";
    const pairs = listRevisionPairs(
      opts.dotfiles,
      opts.dotfilesSha,
      dotfilesSet.paths,
    );
    const pairRows = await pool(pairs, CONCURRENCY, async (p) => {
      const oldBlob = git(opts.dotfiles, [
        "rev-parse",
        `${p.parent}:${p.path}`,
      ]).trim();
      const newBlob = git(opts.dotfiles, [
        "rev-parse",
        `${p.commit}:${p.path}`,
      ]).trim();
      const pair = {
        commit: p.commit,
        parent: p.parent,
        path: p.path,
        oldBlob,
        newBlob,
      };
      const oldSize = Number(
        git(opts.dotfiles, ["cat-file", "-s", oldBlob]).trim(),
      );
      const newSize = Number(
        git(opts.dotfiles, ["cat-file", "-s", newBlob]).trim(),
      );
      if (oldSize > MAX_DOCUMENT_BYTES || newSize > MAX_DOCUMENT_BYTES)
        return {
          pair,
          run: { status: "too-large", exitCode: null },
          risks: [],
        };
      const run = await runYomiyasuCheck(
        readBlob(opts.dotfiles, oldBlob),
        readBlob(opts.dotfiles, newBlob),
        dirs.cwd,
      );
      return {
        pair,
        run: { status: run.status, exitCode: run.exitCode },
        risks: run.status === "ok" ? run.data : [],
      };
    });

    stage = "assemble";
    const documentsOut = [];
    const lintOut = [];
    const diffOut = [];
    const c108Agg = {
      tools: {
        tanteki: { ok: 0, failures: {} },
        yomiyasu: { ok: 0, failures: {} },
      },
      ruleCells: new Map(),
      totalBytes: 0,
    };
    for (const tool of TOOLS)
      for (const rule of rules[tool])
        c108Agg.ruleCells.set(`${tool}\0${rule}`, {
          tool,
          rule,
          denominator: 0,
          hitDocs: 0,
          hits: 0,
        });
    let c108Count = 0;
    let c108Bytes = 0;
    docs.forEach((doc, i) => {
      const m = measured[i];
      const bodyBytes = Buffer.byteLength(doc.body);
      if (doc.source === "c108") {
        c108Count += 1;
        c108Bytes += doc.size;
        c108Agg.totalBytes += bodyBytes;
      }
      const consentHidden = doc.source === "c108" && !consentYes;
      for (const tool of TOOLS) {
        const run = m[tool];
        const groups = groupFindings(m.findings[tool]);
        if (consentHidden) {
          const agg = c108Agg.tools[tool];
          if (run.status === "ok") agg.ok += 1;
          else agg.failures[run.status] = (agg.failures[run.status] ?? 0) + 1;
          if (run.status === "ok") {
            const enabled =
              tool === "tanteki"
                ? new Set(tanteki.byType[run.type])
                : new Set(
                    rules.yomiyasu.filter((r) => !run.skipped.includes(r)),
                  );
            for (const rule of rules[tool])
              if (enabled.has(rule))
                c108Agg.ruleCells.get(`${tool}\0${rule}`).denominator += 1;
            for (const [rule, positions] of groups) {
              const cell = c108Agg.ruleCells.get(`${tool}\0${rule}`);
              if (!cell) fail("unknown-rule-in-c108");
              cell.hitDocs += 1;
              cell.hits += positions.length;
            }
          }
          continue;
        }
        for (const [rule, positions] of [...groups].sort(([a], [b]) =>
          a.localeCompare(b),
        ))
          lintOut.push({
            schema: 1,
            source: doc.source,
            doc: doc.id,
            tool,
            rule,
            positions: positions.sort((a, b) => a[0] - b[0] || a[1] - b[1]),
            count: positions.length,
          });
      }
      if (consentHidden) return;
      documentsOut.push({
        schema: 1,
        id: doc.id,
        source: doc.source,
        writer: doc.writer,
        docType: doc.docType,
        polished: "unknown",
        originalHash: sha256(doc.raw),
        passedHash: sha256(doc.body),
        bytes: bodyBytes,
        runs: { tanteki: m.tanteki, yomiyasu: m.yomiyasu },
        hasDisable: /textlint-disable/.test(doc.raw),
        ...doc.ident,
      });
    });
    if (c108Count > 0 && !consentYes) {
      documentsOut.push({
        schema: 1,
        id: "c108-all",
        source: "c108",
        writer: "handwritten",
        docType: "book",
        aggregate: {
          tools: c108Agg.tools,
          rules: [...c108Agg.ruleCells.values()],
          totalBytes: c108Agg.totalBytes,
        },
      });
    }
    for (const { pair, run, risks } of pairRows) {
      diffOut.push({ schema: 1, row: "pair", pair, run });
      const grouped = new Map();
      for (const r of risks) {
        const key = `${r.kind}\0${r.subkind ?? ""}`;
        if (!grouped.has(key))
          grouped.set(key, {
            kind: r.kind,
            subkind: r.subkind,
            oldLines: new Set(),
            newLines: new Set(),
            count: 0,
          });
        const g = grouped.get(key);
        g.count += 1;
        if (r.oldLine !== null) g.oldLines.add(r.oldLine);
        if (r.newLine !== null) g.newLines.add(r.newLine);
      }
      for (const g of grouped.values())
        diffOut.push({
          schema: 1,
          row: "risk",
          pair,
          kind: g.kind,
          subkind: g.subkind,
          oldLines: [...g.oldLines].sort((a, b) => a - b),
          newLines: [...g.newLines].sort((a, b) => a - b),
          count: g.count,
        });
    }
    const sortKey = (r) =>
      `${r.source ?? ""}\0${r.id ?? r.doc ?? ""}\0${r.tool ?? ""}\0${r.rule ?? ""}`;
    documentsOut.sort((a, b) => sortKey(a).localeCompare(sortKey(b)));
    lintOut.sort((a, b) => sortKey(a).localeCompare(sortKey(b)));

    const sumBytes = (list) => list.reduce((n, d) => n + d.size, 0);
    const bySource = (s) => docs.filter((d) => d.source === s);
    const meta = {
      schema: 1,
      recordedOn: new Date().toISOString().slice(0, 10),
      shas: {
        dotfiles: opts.dotfilesSha,
        blog: opts.blog ? opts.blogSha : null,
        c108: consentYes ? c108.sha : null,
      },
      visibility,
      c108Consent: {
        answer: opts.consent,
        date: consentYes ? opts.consentDate : null,
      },
      rules,
      enabledRulesByType: tanteki.byType,
      tools: {
        tanteki: {
          version: JSON.parse(
            readFileSync(
              join(
                TEXTLINT_DIR,
                "node_modules",
                "textlint-rule-preset-japanese",
                "package.json",
              ),
              "utf8",
            ),
          ).version,
          identicalToRecordedSha: tantekiIdentical,
        },
        yomiyasu: {
          version: /__version__ = "([^"]+)"/.exec(
            readFileSync(YOMIYASU_LINT, "utf8"),
          )[1],
          identicalToRecordedSha: yomiyasuIdentical,
        },
        textlintLock: {
          identicalToRecordedSha: lockIdentical,
          installedVersionsMatch: installedMatch,
        },
      },
      blogExtract: {
        version: BLOG_EXTRACT_VERSION,
        limits: BLOG_EXTRACT_LIMITS,
      },
      population: {
        "a-doc": { count: dotfilesSet.aDocCount, bytes: dotfilesSet.aDocBytes },
        b: { count: bySource("b").length, bytes: sumBytes(bySource("b")) },
        pairs: pairs.length,
        "a-pr": prDocs.length,
        c108: { count: c108Count, bytes: c108Bytes },
        blog: { count: blogDocs.length, bytes: sumBytes(bySource("blog")) },
        blogExcludedByUser: opts.blogExcluded,
        nonRegularMode: dotfilesSet.nonRegularMode,
        tooLarge: docs.filter((d) => d.size > MAX_DOCUMENT_BYTES).length,
      },
      preflight: pre,
      auxiliaryCheckPassed: false,
      checkTiming,
    };

    stage = "auxiliary-check";
    const fields = [
      ...flattenStrings(documentsOut, "documents"),
      ...flattenStrings(lintOut, "lint"),
      ...flattenStrings(diffOut, "diff"),
      ...flattenStrings(meta, "meta"),
    ];
    // 値が公開リポジトリの既存のパスと完全に一致する欄は、偶然 c108 の本文の窓と重なっても何も漏らさない
    // （そのパスは元から公開）ので、突き合わせから外す。それ以外の欄は全部突き合わせる。
    const publicPaths = new Set([
      ...dotfilesSet.paths,
      ...blogDocs.map((d) => d.id),
    ]);
    const leaked = findLeakedFields(
      docs.map((d) => ({ source: d.source, body: d.body })),
      fields.filter(([, text]) => !publicPaths.has(text)),
    );
    if (leaked.length > 0) {
      console.log(
        `auxiliary check matched fields: ${[...new Set(leaked.map((n) => n.replace(/\.\d+/g, ".N")))].join(",")}`,
      );
      fail("auxiliary-check-matched");
    }
    meta.auxiliaryCheckPassed = true;

    stage = "self-validate";
    const errors = [...validateMeta(meta)];
    documentsOut.forEach((r, i) =>
      validateRow("documents", r, meta).forEach((e) =>
        errors.push(`documents[${i}] ${e}`),
      ),
    );
    lintOut.forEach((r, i) =>
      validateRow("lint", r, meta).forEach((e) =>
        errors.push(`lint[${i}] ${e}`),
      ),
    );
    diffOut.forEach((r, i) =>
      validateRow("diff", r, meta).forEach((e) =>
        errors.push(`diff[${i}] ${e}`),
      ),
    );
    const seen = new Set();
    for (const r of lintOut) {
      const key = `${r.source}\0${r.doc}\0${r.tool}\0${r.rule}`;
      if (seen.has(key)) errors.push("lint: duplicate-key");
      seen.add(key);
    }
    if (errors.length > 0) {
      console.log(`self-validate errors (${errors.length}):`);
      for (const e of errors.slice(0, 40)) console.log(`  ${e}`);
      fail("self-validate-failed");
    }

    stage = "write";
    mkdirSync(opts.out, { recursive: true });
    const jsonl = (rows) => rows.map((r) => `${JSON.stringify(r)}\n`).join("");
    writeFileSync(join(opts.out, "documents.jsonl"), jsonl(documentsOut));
    writeFileSync(join(opts.out, "lint.jsonl"), jsonl(lintOut));
    writeFileSync(join(opts.out, "diff.jsonl"), jsonl(diffOut));
    writeFileSync(
      join(opts.out, "meta.json"),
      `${JSON.stringify(meta, null, 2)}\n`,
    );

    // 報告（識別子と列挙値と件数だけ）
    const statusCount = {};
    const failed = [];
    documentsOut.forEach((d) => {
      if (d.aggregate) return;
      for (const tool of TOOLS) {
        const s = d.runs[tool].status;
        statusCount[`${d.source}/${tool}/${s}`] =
          (statusCount[`${d.source}/${tool}/${s}`] ?? 0) + 1;
        if (s !== "ok")
          failed.push(
            `${d.source} ${d.id} ${tool} ${s} exit=${d.runs[tool].exitCode}`,
          );
      }
    });
    console.log(
      JSON.stringify(
        {
          statusCount,
          c108Aggregate: consentYes ? undefined : { tools: c108Agg.tools },
        },
        null,
        1,
      ),
    );
    console.log(`failed documents (${failed.length}):`);
    for (const f of failed) console.log(`  ${f}`);
    const pairStatus = {};
    for (const p of pairRows)
      pairStatus[p.run.status] = (pairStatus[p.run.status] ?? 0) + 1;
    console.log(`pairs: ${pairRows.length} ${JSON.stringify(pairStatus)}`);
    for (const p of pairRows)
      if (p.run.status !== "ok")
        console.log(
          `  pair ${p.pair.commit.slice(0, 8)} ${p.pair.path} ${p.run.status} exit=${p.run.exitCode}`,
        );
    console.log(`population: ${JSON.stringify(meta.population)}`);
    console.log(
      `rules: tanteki=${rules.tanteki.length} yomiyasu=${rules.yomiyasu.length}`,
    );
    console.log(`preflight: ${JSON.stringify(pre)}`);
    console.log(`checkTiming: ${JSON.stringify(checkTiming)}`);
    console.log(
      `rows: documents=${documentsOut.length} lint=${lintOut.length} diff=${diffOut.length}`,
    );
    void FAILURE_KINDS;
  } finally {
    stage = `${stage}:cleanup`;
    disposeWorkDir(work);
    void WORKDIR_PREFIX;
  }
}

main().catch((error) => {
  // 例外の文は出さない（パスや本文の一部を含みうる）。段階と名前だけ。
  console.error(`measure: failed at ${stage} (${error?.name ?? "Error"})`);
  // 調査用。c108 を読む実行（--cpk 付き）では例外の文を出さない。
  if (process.env.JA_BASELINE_DEBUG === "1" && !process.argv.includes("--cpk"))
    console.error(String(error?.message ?? "").slice(0, 300));
  process.exitCode = 1;
});
