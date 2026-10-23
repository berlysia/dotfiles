// 旧の日本語校正の道具（tanteki と yomiyasu）の測定結果（tests/ja-baseline/）を扱う部品。
//
// この module は旧の道具も git も import しない。測定の道具（tests/lib/ja-baseline/*.mjs）と
// test が import する。依存の向きは test → この module → 結果のデータの一方向。
// 本文を結果に入れないための守りは、ここの許すスキーマ（validateRow / validateMeta）と、
// 子プロセスの stderr を捨てて列挙値だけを返す構造である。

import { spawn } from "node:child_process";
import {
  lstatSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

// ---- 定数 ----

// ブログの本文の取り出しの版。meta.json に写し、結果の test が一致を確かめる。
export const BLOG_EXTRACT_VERSION = "1";
// 取り出しの限界（meta.json に列挙値で写す）。
export const BLOG_EXTRACT_LIMITS = ["nested-jsx", "embedded-expressions"];

// 区分の文書がこの数に満たないとき、その区分の「当たり 0 件」を採否の根拠にしない。
// 1〜2 件の文書の偶然の 0 件で規則を外さない最小の線。plan-5 も同じ値を使う。
export const SMALL_STRATUM_THRESHOLD = 3;

// 1 文書の上限（spec K5 の入力の上限と同じ）。
export const MAX_DOCUMENT_BYTES = 256 * 1024;

export const CHILD_TIMEOUT_MS = 60_000;
const CHILD_STDOUT_LIMIT = 64 * 1024 * 1024;

export const WORKDIR_PREFIX = "ja-baseline-";
const STALE_WORKDIR_MS = 60 * 60 * 1000;

export const FAILURE_KINDS = [
  "timeout",
  "exit-nonzero",
  "parse-error",
  "too-large",
];
export const RUN_STATUSES = ["ok", ...FAILURE_KINDS];

export const SOURCES = ["a-doc", "a-pr", "b", "c108", "blog"];
export const WRITERS = ["ai-coauthored", "handwritten"];
export const DOC_TYPES = ["design", "report", "caller", "book", "essay"];
export const TOOLS = ["tanteki", "yomiyasu"];
export const REPOS = ["dotfiles", "blog.berlysia.net"];

// 文書の種類から旧の道具の種別への写し（固定。結果に記録する）。
// yomiyasu の null は --doc-type を付けないこと。
export const TYPE_MAP = {
  design: { tanteki: "adr", yomiyasu: null },
  report: { tanteki: "stock", yomiyasu: null },
  caller: { tanteki: "flow", yomiyasu: "pr" },
  book: { tanteki: "record", yomiyasu: "article" },
  essay: { tanteki: "record", yomiyasu: "essay" },
};
export const TANTEKI_TYPES = [
  "design-doc",
  "prd",
  "adr",
  "rfc",
  "stock",
  "flow",
  "record",
];
// yomiyasu の --doc-type の値（markdown_visibility.py の DOC_TYPES から写した）。
export const YOMIYASU_DOC_TYPES = [
  "pr",
  "article",
  "incident",
  "proposal",
  "minutes",
  "manual",
  "slides",
  "essay",
];

// yomiyasu_diff.py の meaning_risks の kind と subkind（ソースから写した。test は .skills を読まない）。
// subkind が無い kind は null を許す。
export const DIFF_KIND_SUBKINDS = {
  number: ["replaced", "added", "lost", "order"],
  negation: [],
  swap: [],
  sentence_type: ["marks", "question"],
  protected: [
    "code",
    "inline_code",
    "url",
    "link",
    "frontmatter",
    "html",
    "quote",
  ],
  contrast_reversal: [],
  feeling: [],
  certainty: ["strengthened", "weakened"],
  certainty_review: ["strengthened", "weakened"],
  quote: ["changed", "lost"],
  state: ["lost"],
  promise: ["prevention", "guarantee", "added"],
  promise_review: ["added"],
  claim: ["causal"],
  citation: ["replaced", "added", "lost"],
  unsupported: ["number", "name"],
};

// 文書の種類の決め（(a) の docs の下のパスから）。procedure には写せない。
export function docTypeForPath(path) {
  if (/^docs\/decisions\/[^/]+\.md$/.test(path)) return "design";
  if (/^docs\/plans\/.+\.md$/.test(path)) return "report";
  return null;
}

// c108 の canon が著者稿とする glob `{1-0[1-4],2-0[13456]}-*.md`。
export function isC108Chapter(fileName) {
  return /^(?:1-0[1-4]|2-0[13456])-.*\.md$/.test(fileName);
}

// ---- ブログの本文の取り出し ----

// frontmatter を読む。題・日付・draft だけを返す（本文は見ない）。
export function parseBlogFrontmatter(raw) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(raw);
  if (!match) return { title: null, date: null, draft: false, end: 0 };
  const field = (name) => {
    const line = new RegExp(`^${name}:[ \\t]*(.*)$`, "m").exec(match[1]);
    if (!line) return null;
    return line[1].trim().replace(/^(["'])(.*)\1$/, "$2");
  };
  return {
    title: field("title"),
    date: field("date"),
    draft: field("draft") === "true",
    end: match[0].length,
  };
}

// 記事の名前（ファイル名かディレクトリ名）と frontmatter から、候補か対象外かを決める。
// 候補は 2024-02-01 以降の、draft でない、日付で始まる名前の記事。
export function classifyBlogEntry(entryName, frontmatter) {
  const dated = /^(\d{4}-\d{2}-\d{2})/.exec(entryName);
  if (!dated) return { candidate: false, reason: "no-date-prefix" };
  if (frontmatter.draft) return { candidate: false, reason: "draft" };
  if (dated[1] < "2024-02-01")
    return { candidate: false, reason: "before-2024-02" };
  return { candidate: true, reason: null, date: dated[1] };
}

// JSX の開始タグ `<Name ...>` を text[start] から読む。属性が行をまたぐもの、属性値の
// 引用符と波括弧の中の `>` を含む。tagEnd は `>` の次の位置。
function readOpeningTag(text, start) {
  const name = /^<([A-Z][\w.]*)/.exec(text.slice(start, start + 200));
  if (!name) return null;
  let i = start + name[0].length;
  let braces = 0;
  let quote = null;
  for (; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) {
      if (ch === quote) quote = null;
    } else if (braces > 0) {
      if (ch === "{") braces += 1;
      else if (ch === "}") braces -= 1;
      else if (ch === '"' || ch === "'" || ch === "`") quote = ch;
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === "{") braces = 1;
    else if (ch === ">") {
      return {
        name: name[1],
        tagEnd: i + 1,
        selfClosing: text[i - 1] === "/",
      };
    }
  }
  return null;
}

// 大文字で始まる JSX の要素が閉じる位置（その行の末尾の次）を返す。閉じが見つからなければ、
// 開始タグの終わる行の末尾にする（要素の中身は除ききれない限界）。
function findElementEnd(text, start) {
  const open = readOpeningTag(text, start);
  const lineEnd = (pos) => {
    const nl = text.indexOf("\n", pos);
    return nl === -1 ? text.length : nl + 1;
  };
  if (!open) return lineEnd(start);
  if (open.selfClosing) return lineEnd(open.tagEnd);
  const sameName = new RegExp(
    `<${open.name.replace(/\./g, "\\.")}(?![\\w.])|</${open.name.replace(/\./g, "\\.")}\\s*>`,
    "g",
  );
  sameName.lastIndex = open.tagEnd;
  let depth = 1;
  for (let m = sameName.exec(text); m; m = sameName.exec(text)) {
    if (m[0].startsWith("</")) {
      depth -= 1;
      if (depth === 0) return lineEnd(m.index + m[0].length);
    } else {
      const nested = readOpeningTag(text, m.index);
      if (nested && !nested.selfClosing) depth += 1;
    }
  }
  return lineEnd(open.tagEnd);
}

// ブログの本文（mdx）から旧の道具に渡す本文を取り出す。
// frontmatter、行頭の import と export の行、大文字で始まる JSX の要素（行をまたぐものを含む）を除く。
// コードフェンスはそのまま渡す。行番号と列は、この戻り値（渡した本文）で数える。
export function extractBlogBody(raw) {
  const text = raw.slice(parseBlogFrontmatter(raw).end);
  let out = "";
  let pos = 0;
  let fence = null;
  while (pos < text.length) {
    const nl = text.indexOf("\n", pos);
    const lineEnd = nl === -1 ? text.length : nl + 1;
    const line = text.slice(pos, lineEnd);
    const fenceMark = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (fence) {
      // コードフェンスの中は旧の道具の既定の扱いのまま渡す
      if (
        fenceMark &&
        fenceMark[0] === fence[0] &&
        fenceMark.length >= fence.length
      )
        fence = null;
      out += line;
      pos = lineEnd;
    } else if (fenceMark) {
      fence = fenceMark;
      out += line;
      pos = lineEnd;
    } else if (/^(?:import|export)\s/.test(line)) {
      pos = lineEnd;
    } else if (/^[ \t]*<[A-Z]/.test(line)) {
      pos = findElementEnd(text, pos + line.search(/</));
    } else {
      out += line;
      pos = lineEnd;
    }
  }
  return out;
}

// ---- 失敗の分類 ----

// 子プロセスの結末を列挙値と終了コードだけにする。例外の文と stderr は持ち込まない。
// parseOutput は stdout の JSON から許すキーだけを取り出す関数（形が違えば投げる）。
export function classifyOutcome(
  { timedOut, exitCode, stdout, overflow },
  parseOutput,
) {
  if (timedOut) return { status: "timeout", exitCode: null, data: null };
  if (exitCode !== 0)
    return {
      status: "exit-nonzero",
      exitCode: Number.isInteger(exitCode) ? exitCode : null,
      data: null,
    };
  if (overflow) return { status: "parse-error", exitCode, data: null };
  try {
    return { status: "ok", exitCode, data: parseOutput(JSON.parse(stdout)) };
  } catch {
    return { status: "parse-error", exitCode, data: null };
  }
}

// ---- 子プロセスの起動 ----

// 子プロセスの環境は PATH と言語の設定だけ（GH_TOKEN などを渡さない）。
export function minimalChildEnv(source = process.env) {
  const env = {};
  for (const name of ["PATH", "LANG", "LC_ALL", "LC_CTYPE"]) {
    if (source[name] !== undefined) env[name] = source[name];
  }
  return env;
}

const liveChildren = new Set();

function killChildGroup(child) {
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {
      // すでに終わっている
    }
  }
}

// 旧の道具などを子プロセスで動かす。stdout は parseOutput で許すキーだけ読み、stderr は捨てる。
// cwd は呼び出し側が空の dir を渡す。打ち切りは timeoutMs。結果は列挙値と終了コードだけ。
export function runChild(
  command,
  args,
  { cwd, input, timeoutMs = CHILD_TIMEOUT_MS, parseOutput = (value) => value },
) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, {
        cwd,
        env: minimalChildEnv(),
        stdio: [input === undefined ? "ignore" : "pipe", "pipe", "ignore"],
        detached: true,
      });
    } catch {
      resolve({ status: "exit-nonzero", exitCode: null, data: null });
      return;
    }
    const chunks = [];
    let size = 0;
    let overflow = false;
    let timedOut = false;
    let settled = false;
    const finish = (exitCode) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      liveChildren.delete(entry);
      resolve(
        classifyOutcome(
          {
            timedOut,
            exitCode,
            overflow,
            stdout: Buffer.concat(chunks).toString("utf8"),
          },
          parseOutput,
        ),
      );
    };
    const entry = {
      child,
      exited: new Promise((done) => child.once("close", done)),
    };
    liveChildren.add(entry);
    const timer = setTimeout(() => {
      timedOut = true;
      killChildGroup(child);
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      size += chunk.length;
      if (size > CHILD_STDOUT_LIMIT) {
        overflow = true;
        killChildGroup(child);
        return;
      }
      chunks.push(chunk);
    });
    child.once("error", () => finish(null));
    child.once("close", (code) => finish(code));
    if (input !== undefined) {
      child.stdin.on("error", () => {});
      child.stdin.end(input);
    }
  });
}

// ---- 一時 dir の作成と後始末 ----

// path を消してよいか確かめて消す。os.tmpdir()（tmpRoot）の直下の `ja-baseline-` で始まる名前の
// 実 dir だけを消す。外のパスと symlink は消さずに投げる（symlink はたどらない）。
export function removeWorkDir(path, { tmpRoot = tmpdir() } = {}) {
  let parent;
  let root;
  try {
    parent = realpathSync(dirname(path));
    root = realpathSync(tmpRoot);
  } catch {
    throw new Error("unsafe-path");
  }
  if (parent !== root || !basename(path).startsWith(WORKDIR_PREFIX))
    throw new Error("unsafe-path");
  let stat;
  try {
    stat = lstatSync(path);
  } catch {
    return false;
  }
  if (stat.isSymbolicLink() || !stat.isDirectory())
    throw new Error("unsafe-path");
  rmSync(path, { recursive: true, force: true });
  return true;
}

// 自分の所有で、更新から 1 時間を超えた `ja-baseline-` の dir だけを消す（並行して走る
// 別の実行の dir を巻き込まない）。更新時刻を使うのは、birthtime が使えない fs があるため。
export function sweepStaleWorkDirs({
  tmpRoot = tmpdir(),
  maxAgeMs = STALE_WORKDIR_MS,
  now = Date.now(),
} = {}) {
  const removed = [];
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  for (const name of readdirSync(tmpRoot)) {
    if (!name.startsWith(WORKDIR_PREFIX)) continue;
    const path = join(tmpRoot, name);
    try {
      const stat = lstatSync(path);
      if (stat.isSymbolicLink() || !stat.isDirectory()) continue;
      if (uid !== null && stat.uid !== uid) continue;
      if (now - stat.mtimeMs <= maxAgeMs) continue;
      if (removeWorkDir(path, { tmpRoot })) removed.push(name);
    } catch {
      // 消せないものは残す
    }
  }
  return removed;
}

const liveWorkDirs = new Set();
let handlersInstalled = false;
let shuttingDown = false;

// 子プロセスを止めてから一時 dir を消して終わる。出すのは列挙値だけ。
async function shutdown(reason, exitCode) {
  if (shuttingDown) return;
  shuttingDown = true;
  try {
    process.stderr.write(`ja-baseline: aborted (${reason})\n`);
  } catch {
    // stderr が閉じていても後始末は続ける
  }
  const entries = [...liveChildren];
  for (const { child } of entries) killChildGroup(child);
  await Promise.race([
    Promise.all(entries.map((entry) => entry.exited)),
    new Promise((done) => setTimeout(done, 2000)),
  ]);
  for (const dir of liveWorkDirs) {
    try {
      removeWorkDir(dir);
    } catch {
      // 消せないものは次の起動時の掃除に任せる
    }
  }
  process.exit(exitCode);
}

function installHandlersOnce() {
  if (handlersInstalled) return;
  handlersInstalled = true;
  for (const [signal, code] of [
    ["SIGINT", 130],
    ["SIGTERM", 143],
    ["SIGHUP", 129],
  ]) {
    process.on(signal, () => void shutdown(signal, code));
  }
  process.on("uncaughtException", () => void shutdown("uncaught-exception", 1));
  process.on(
    "unhandledRejection",
    () => void shutdown("unhandled-rejection", 1),
  );
}

// 一時 dir（権限 700）を os.tmpdir() の下に作る。handler はプロセスで 1 回だけ付け、
// そのとき古い dir の掃除もする。
export function createWorkDir() {
  if (!handlersInstalled) {
    sweepStaleWorkDirs();
    installHandlersOnce();
  }
  const dir = realpathSync(
    mkdtempSync(join(realpathSync(tmpdir()), WORKDIR_PREFIX)),
  );
  liveWorkDirs.add(dir);
  return dir;
}

// 正常終了の後始末。
export function disposeWorkDir(dir) {
  liveWorkDirs.delete(dir);
  removeWorkDir(dir);
}

// ---- c108 の補助の検査 ----

const LEAK_WINDOW = 12;

function windowsOf(text) {
  const chars = Array.from(text);
  const out = new Set();
  for (let i = 0; i + LEAK_WINDOW <= chars.length; i += 1) {
    out.add(chars.slice(i, i + LEAK_WINDOW).join(""));
  }
  return out;
}

// 値の中の文字列を、欄の名前（`documents.0.id` のような経路）つきで集める。
export function flattenStrings(value, prefix = "", out = []) {
  if (typeof value === "string") out.push([prefix, value]);
  else if (Array.isArray(value))
    value.forEach((v, i) => flattenStrings(v, `${prefix}.${i}`, out));
  else if (value && typeof value === "object")
    for (const [k, v] of Object.entries(value))
      flattenStrings(v, prefix ? `${prefix}.${k}` : k, out);
  return out;
}

// c108 の本文の 12 字の窓が、書き出す文字列に入っていないか調べ、入っている欄の名前だけを返す。
// 公開の出所（a-doc、a-pr、b、blog）の本文は突き合わせない。集合は保存しない。
export function findLeakedFields(entries, fields) {
  const windows = new Set();
  for (const { source, body } of entries) {
    if (source !== "c108") continue;
    for (const w of windowsOf(body)) windows.add(w);
  }
  if (windows.size === 0) return [];
  const leaked = [];
  for (const [name, text] of fields) {
    const chars = Array.from(text);
    for (let i = 0; i + LEAK_WINDOW <= chars.length; i += 1) {
      if (windows.has(chars.slice(i, i + LEAK_WINDOW).join(""))) {
        leaked.push(name);
        break;
      }
    }
  }
  return leaked;
}

// ---- 許すスキーマ ----

const HEX40 = /^[0-9a-f]{40}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const RULE_ID = /^[A-Za-z0-9@/_.-]{1,64}$/;
const VERSION = /^[0-9A-Za-z.+-]{1,32}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const PATH_CHARS = "[^\\s\\u0000-\\u001f\\u007f]+";
const DOC_PATH = new RegExp(`^docs/(?:decisions|plans)/${PATH_CHARS}\\.md$`);
const BLOG_PATH = new RegExp(`^articles/${PATH_CHARS}\\.mdx$`);
const NO_DOTDOT = (s) => !s.split("/").includes("..");

const ID_BY_SOURCE = {
  "a-doc": (s) => DOC_PATH.test(s) && NO_DOTDOT(s),
  b: (s) => DOC_PATH.test(s) && NO_DOTDOT(s),
  blog: (s) => BLOG_PATH.test(s) && NO_DOTDOT(s),
  "a-pr": (s) => /^pr-\d+$/.test(s),
  c108: (s) => /^c108-\d{2}$/.test(s) || s === "c108-all",
};

// 型の記述: 値を検査して誤りの文（欄の名前と列挙値だけ。値は含めない）を返す。
const T = {
  int: (v) => Number.isSafeInteger(v) && v >= 0,
  bool: (v) => typeof v === "boolean",
  schema1: (v) => v === 1,
  hex40: (v) => typeof v === "string" && HEX40.test(v),
  hex64: (v) => typeof v === "string" && HEX64.test(v),
  rule: (v) => typeof v === "string" && RULE_ID.test(v),
  version: (v) => typeof v === "string" && VERSION.test(v),
  date: (v) => typeof v === "string" && DATE.test(v),
  oneOf: (list) => (v) => list.includes(v),
  nullable: (check) => (v) => v === null || check(v),
  arrayOf: (check) => (v) => Array.isArray(v) && v.every(check),
  record: (keys, check) => (v) =>
    isPlainObject(v) &&
    Object.keys(v).every((k) => keys.includes(k)) &&
    Object.values(v).every(check),
};

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

// shape: { 欄: 検査関数 }。必須の欄は全部要る（optional に挙げた欄だけ省ける）。
function checkShape(label, value, shape, errors, optional = []) {
  if (!isPlainObject(value)) {
    errors.push(`${label}: not-an-object`);
    return;
  }
  for (const key of Object.keys(value)) {
    if (!(key in shape)) errors.push(`${label}.${key}: unknown-key`);
  }
  for (const [key, check] of Object.entries(shape)) {
    if (!(key in value)) {
      if (!optional.includes(key)) errors.push(`${label}.${key}: missing`);
    } else if (!check(value[key])) errors.push(`${label}.${key}: invalid`);
  }
}

const positions = T.arrayOf(
  (p) =>
    Array.isArray(p) &&
    p.length === 2 &&
    p.every((n) => Number.isSafeInteger(n) && n >= 0),
);
const lineNumbers = T.arrayOf((n) => Number.isSafeInteger(n) && n >= 0);

const TANTEKI_RUN = (v) => {
  const errors = [];
  checkShape(
    "run",
    v,
    {
      status: T.oneOf(RUN_STATUSES),
      exitCode: T.nullable(T.int),
      type: T.nullable(T.oneOf(TANTEKI_TYPES)),
    },
    errors,
  );
  return errors.length === 0;
};
const YOMIYASU_RUN = (v) => {
  const errors = [];
  checkShape(
    "run",
    v,
    {
      status: T.oneOf(RUN_STATUSES),
      exitCode: T.nullable(T.int),
      docType: T.nullable(T.oneOf(YOMIYASU_DOC_TYPES)),
      skipped: T.arrayOf(T.rule),
    },
    errors,
  );
  return errors.length === 0;
};
const RUN_FAILURE_COUNTS = T.record(FAILURE_KINDS, T.int);

const PAIR = (v) => {
  const errors = [];
  checkShape(
    "pair",
    v,
    {
      commit: T.hex40,
      parent: T.hex40,
      path: (s) => typeof s === "string" && DOC_PATH.test(s) && NO_DOTDOT(s),
      oldBlob: T.hex40,
      newBlob: T.hex40,
    },
    errors,
  );
  return errors.length === 0;
};

// meta.json の検査。結果の行の検査（validateRow）が引数に取る走らせた規則の集合などの出どころ。
export function validateMeta(meta) {
  const errors = [];
  const rulesOf = T.record(TOOLS, T.arrayOf(T.rule));
  checkShape(
    "meta",
    meta,
    {
      schema: T.schema1,
      recordedOn: T.date,
      shas: (v) => {
        const e = [];
        checkShape(
          "shas",
          v,
          {
            dotfiles: T.hex40,
            blog: T.nullable(T.hex40),
            c108: T.nullable(T.hex40),
          },
          e,
        );
        return e.length === 0;
      },
      visibility: (v) => {
        const e = [];
        checkShape(
          "visibility",
          v,
          {
            dotfiles: T.oneOf(["PUBLIC"]),
            blog: T.oneOf(["PUBLIC"]),
          },
          e,
        );
        return e.length === 0;
      },
      c108Consent: (v) => {
        const e = [];
        checkShape(
          "c108Consent",
          v,
          {
            answer: T.oneOf(["yes", "no"]),
            date: T.nullable(T.date),
          },
          e,
        );
        return e.length === 0;
      },
      rules: (v) => rulesOf(v) && TOOLS.every((t) => t in v),
      enabledRulesByType: T.record(TANTEKI_TYPES, T.arrayOf(T.rule)),
      tools: (v) => {
        const e = [];
        const tool = {
          version: T.version,
          identicalToRecordedSha: T.bool,
        };
        checkShape(
          "tools",
          v,
          {
            tanteki: (t) => {
              const e2 = [];
              checkShape("tanteki", t, tool, e2);
              return e2.length === 0;
            },
            yomiyasu: (t) => {
              const e2 = [];
              checkShape("yomiyasu", t, tool, e2);
              return e2.length === 0;
            },
            textlintLock: (t) => {
              const e2 = [];
              checkShape(
                "textlintLock",
                t,
                {
                  identicalToRecordedSha: T.bool,
                  installedVersionsMatch: T.bool,
                },
                e2,
              );
              return e2.length === 0;
            },
          },
          e,
        );
        return e.length === 0;
      },
      blogExtract: (v) => {
        const e = [];
        checkShape(
          "blogExtract",
          v,
          {
            version: T.version,
            limits: T.arrayOf(T.oneOf(BLOG_EXTRACT_LIMITS)),
          },
          e,
        );
        return e.length === 0;
      },
      population: (v) => {
        const e = [];
        const count = (x) => {
          const e2 = [];
          checkShape("count", x, { count: T.int, bytes: T.int }, e2);
          return e2.length === 0;
        };
        checkShape(
          "population",
          v,
          {
            "a-doc": count,
            b: count,
            pairs: T.int,
            "a-pr": T.int,
            c108: count,
            blog: count,
            blogExcludedByUser: T.int,
            nonRegularMode: T.int,
            tooLarge: T.int,
          },
          e,
        );
        return e.length === 0;
      },
      // 測定の前の確かめ（plan-2 T4）。祖先の設定が効かないこと、yomiyasu が状態を残さないこと、
      // `python3 -I` で動くこと。
      preflight: (v) => {
        const e = [];
        checkShape(
          "preflight",
          v,
          {
            ancestorConfigIgnored: T.bool,
            yomiyasuLeavesNoState: T.bool,
            yomiyasuRunsIsolated: T.bool,
          },
          e,
        );
        return e.length === 0;
      },
      auxiliaryCheckPassed: T.bool,
      checkTiming: (v) => {
        const e = [];
        checkShape(
          "checkTiming",
          v,
          {
            medianMs: T.int,
            node: (s) =>
              typeof s === "string" && /^[0-9A-Za-z.+-]{1,32}$/.test(s),
            cpuGeneration: (s) =>
              typeof s === "string" && /^[0-9A-Za-z._ -]{1,32}$/.test(s),
          },
          e,
        );
        return e.length === 0;
      },
    },
    errors,
  );
  return errors;
}

function checkRuleKnown(label, tool, rule, meta, errors) {
  const known = meta?.rules?.[tool];
  if (!Array.isArray(known) || !known.includes(rule))
    errors.push(`${label}.rule: not-in-ran-rules`);
}

const AGGREGATE_RULE = (v) => {
  const e = [];
  checkShape(
    "rule",
    v,
    {
      tool: T.oneOf(TOOLS),
      rule: T.rule,
      denominator: T.int,
      hitDocs: T.int,
      hits: T.int,
    },
    e,
  );
  return e.length === 0;
};

const AGGREGATE = (v) => {
  const e = [];
  checkShape(
    "aggregate",
    v,
    {
      tools: (t) => {
        const e2 = [];
        const toolShape = (x) => {
          const e3 = [];
          checkShape(
            "tool",
            x,
            { ok: T.int, failures: RUN_FAILURE_COUNTS },
            e3,
          );
          return e3.length === 0;
        };
        checkShape("tools", t, { tanteki: toolShape, yomiyasu: toolShape }, e2);
        return e2.length === 0;
      },
      rules: T.arrayOf(AGGREGATE_RULE),
      totalBytes: T.int,
    },
    e,
  );
  return e.length === 0;
};

// 結果の 1 行を許すスキーマで検査し、誤りの並び（欄の名前と理由だけ）を返す。
// file は "documents" | "lint" | "diff"。meta は走らせた規則の集合と c108 の回答を持つ meta.json の内容。
export function validateRow(file, row, meta) {
  const errors = [];
  const consent = meta?.c108Consent?.answer === "yes";
  if (file === "documents") {
    if (!isPlainObject(row)) return ["row: not-an-object"];
    const source = row.source;
    if (!SOURCES.includes(source)) return ["row.source: invalid"];
    if (typeof row.id !== "string" || !ID_BY_SOURCE[source](row.id))
      errors.push("row.id: invalid");
    if (source === "c108" && !consent && row.id !== "c108-all")
      errors.push("row.id: c108-chapter-without-consent");
    if (source === "c108" && row.id === "c108-all") {
      checkShape(
        "row",
        row,
        {
          schema: T.schema1,
          id: (v) => v === "c108-all",
          source: (v) => v === "c108",
          writer: T.oneOf(WRITERS),
          docType: T.oneOf(DOC_TYPES),
          aggregate: AGGREGATE,
        },
        errors,
      );
      if (Array.isArray(row.aggregate?.rules)) {
        for (const r of row.aggregate.rules) {
          if (T.rule(r?.rule) && TOOLS.includes(r?.tool))
            checkRuleKnown("row.aggregate", r.tool, r.rule, meta, errors);
        }
      }
      return errors;
    }
    const base = {
      schema: T.schema1,
      id: (v) => typeof v === "string",
      source: T.oneOf(SOURCES),
      writer: T.oneOf(WRITERS),
      docType: T.oneOf(DOC_TYPES),
      polished: T.oneOf(["unknown"]),
      originalHash: T.hex64,
      passedHash: T.hex64,
      bytes: T.int,
      runs: (v) => {
        const e = [];
        checkShape(
          "runs",
          v,
          {
            tanteki: TANTEKI_RUN,
            yomiyasu: YOMIYASU_RUN,
          },
          e,
        );
        return e.length === 0;
      },
      hasDisable: T.bool,
    };
    const extra =
      source === "a-pr"
        ? { pr: T.int }
        : source === "c108"
          ? consent
            ? { sha: T.hex40 }
            : {}
          : {
              repo: T.oneOf(REPOS),
              sha: T.hex40,
              path: (v) => typeof v === "string",
              blob: T.hex40,
            };
    checkShape("row", row, { ...base, ...extra }, errors);
    if (
      source !== "a-pr" &&
      source !== "c108" &&
      typeof row.path === "string" &&
      row.path !== row.id
    )
      errors.push("row.path: differs-from-id");
    return errors;
  }
  if (file === "lint") {
    checkShape(
      "row",
      row,
      {
        schema: T.schema1,
        source: T.oneOf(SOURCES),
        doc: (v) => typeof v === "string",
        tool: T.oneOf(TOOLS),
        rule: T.rule,
        positions,
        count: T.int,
      },
      errors,
    );
    if (!isPlainObject(row)) return errors;
    if (SOURCES.includes(row.source) && typeof row.doc === "string") {
      if (!ID_BY_SOURCE[row.source](row.doc)) errors.push("row.doc: invalid");
      if (row.source === "c108" && !consent)
        errors.push("row.doc: c108-chapter-without-consent");
      if (row.source === "c108" && row.doc === "c108-all")
        errors.push("row.doc: aggregate-in-lint");
    }
    if (TOOLS.includes(row.tool) && T.rule(row.rule))
      checkRuleKnown("row", row.tool, row.rule, meta, errors);
    return errors;
  }
  if (file === "diff") {
    if (!isPlainObject(row)) return ["row: not-an-object"];
    if (row.row === "pair") {
      checkShape(
        "row",
        row,
        {
          schema: T.schema1,
          row: T.oneOf(["pair"]),
          pair: PAIR,
          run: (v) => {
            const e = [];
            checkShape(
              "run",
              v,
              {
                status: T.oneOf(RUN_STATUSES),
                exitCode: T.nullable(T.int),
              },
              e,
            );
            return e.length === 0;
          },
        },
        errors,
      );
      return errors;
    }
    checkShape(
      "row",
      row,
      {
        schema: T.schema1,
        row: T.oneOf(["risk"]),
        pair: PAIR,
        kind: T.oneOf(Object.keys(DIFF_KIND_SUBKINDS)),
        subkind: T.nullable((v) => typeof v === "string"),
        oldLines: lineNumbers,
        newLines: lineNumbers,
        count: T.int,
      },
      errors,
    );
    if (
      errors.length === 0 &&
      row.subkind !== null &&
      !DIFF_KIND_SUBKINDS[row.kind].includes(row.subkind)
    )
      errors.push("row.subkind: invalid");
    if (
      errors.length === 0 &&
      row.subkind === null &&
      DIFF_KIND_SUBKINDS[row.kind].length > 0
    )
      errors.push("row.subkind: missing");
    return errors;
  }
  return ["file: unknown"];
}

// ---- 結果の読み取りと集計（T5 で使う） ----

export function parseJsonl(text) {
  return text
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line));
}

export function strataKey(row) {
  return `${row.source}/${row.writer}/${row.docType}`;
}

// 規則ごと・区分ごとの分母（その道具の走行に成功し、その規則が有効だった文書の数）、
// 当たった文書の数、当たりの件数。分母が SMALL_STRATUM_THRESHOLD 未満の区分には small を付ける。
// c108 が不可のときは c108-all の集計の行をそのまま 1 つの区分として使う。
// 走らせた規則の全集合から数えるので、当たり 0 件の規則も出る。
export function aggregateByRule({ documents, lint, meta }) {
  const cells = new Map();
  const cell = (stratum, tool, rule) => {
    const key = `${stratum}\u0000${tool}\u0000${rule}`;
    if (!cells.has(key))
      cells.set(key, {
        stratum,
        tool,
        rule,
        denominator: 0,
        hitDocs: 0,
        hits: 0,
        small: true,
      });
    return cells.get(key);
  };
  const docById = new Map();
  for (const row of documents) {
    if (row.aggregate) {
      const stratum = strataKey(row);
      for (const r of row.aggregate.rules) {
        const c = cell(stratum, r.tool, r.rule);
        c.denominator += r.denominator;
        c.hitDocs += r.hitDocs;
        c.hits += r.hits;
      }
      continue;
    }
    docById.set(`${row.source}\u0000${row.id}`, row);
    const stratum = strataKey(row);
    for (const tool of TOOLS) {
      // 分母が 0 の規則も一覧に出す（走らせた規則の全集合から作る）
      for (const rule of meta.rules[tool]) cell(stratum, tool, rule);
      const run = row.runs[tool];
      if (run.status !== "ok") continue;
      const enabled =
        tool === "tanteki"
          ? new Set(meta.enabledRulesByType[run.type] ?? [])
          : new Set(
              meta.rules.yomiyasu.filter((r) => !run.skipped.includes(r)),
            );
      for (const rule of meta.rules[tool]) {
        if (enabled.has(rule)) cell(stratum, tool, rule).denominator += 1;
      }
    }
  }
  for (const row of lint) {
    const doc = docById.get(`${row.source}\u0000${row.doc}`);
    if (!doc) continue;
    const c = cell(strataKey(doc), row.tool, row.rule);
    c.hitDocs += 1;
    c.hits += row.count;
  }
  const out = [...cells.values()];
  for (const c of out) c.small = c.denominator < SMALL_STRATUM_THRESHOLD;
  return out;
}
