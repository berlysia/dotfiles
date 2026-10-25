// Reads and validates formal.json. This is the only module that resolves
// paths: everything downstream receives {rel, abs} pairs, so a path is never
// interpreted twice with different rules.
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, join, posix, relative, sep } from "node:path";
import { MANIFEST as M } from "./codes.mjs";

const SUPPORTED_SCHEMA_VERSIONS = [1];
const KINDS = ["enumerate", "z3", "tla"];
const EXPECTS = ["hold", "violate"];
const ROLES = ["contract", "broken-variant", "finding"];
const DEFAULT_TIMEOUT_SEC = 60;
const MAX_TIMEOUT_SEC = 600;
const ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
const PATH_CHARS = /^[A-Za-z0-9._/-]+$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const COMMIT_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

const CHECK_KEYS = [
  "id",
  "kind",
  "model",
  "cfg",
  "imports",
  "property",
  "expect",
  "role",
  "brokenBy",
  "question",
  "sync",
  "timeoutSec",
  "checkDeadlock",
  "note",
];
const TOP_KEYS = ["schemaVersion", "checks"];
const SYNC_KEYS = ["commit", "covers"];
const COVER_KEYS = ["path", "sha256"];

const has = (object, key) => Object.hasOwn(object, key);
const get = (object, key) => (has(object, key) ? object[key] : undefined);
const isObject = (v) =>
  typeof v === "object" && v !== null && !Array.isArray(v);

// Separator-aware: "/repo/a-evil" is not inside "/repo/a".
function isInside(parent, child) {
  return child === parent || child.startsWith(parent + sep);
}

function findRepoRoot(start) {
  let dir = start;
  for (;;) {
    if (existsSync(join(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

// The error code for a syntactically unacceptable path, or null.
function pathSyntaxIssue(value) {
  if (typeof value !== "string")
    return { code: M.INVALID_TYPE, what: "must be a string" };
  if (value === "") return { code: M.PATH_ESCAPE, what: "must not be empty" };
  if (!PATH_CHARS.test(value)) {
    return {
      code: M.INVALID_PATH_CHARS,
      what: "may only contain [A-Za-z0-9._/-]",
    };
  }
  if (value === ".") return { code: M.PATH_ESCAPE, what: "must name a file" };
  if (value.startsWith("-"))
    return { code: M.PATH_ESCAPE, what: "must not start with '-'" };
  if (value.startsWith("/"))
    return { code: M.PATH_ESCAPE, what: "must be relative" };
  if (value.includes("//"))
    return { code: M.PATH_ESCAPE, what: "must not contain '//'" };
  if (value.split("/").includes("..")) {
    return { code: M.PATH_ESCAPE, what: "must not contain '..'" };
  }
  return null;
}

export function loadManifest(file) {
  const errors = [];
  const fail = () => ({ ok: false, errors });
  const push = (code, message, recover) => {
    errors.push(
      recover === undefined ? { code, message } : { code, message, recover },
    );
  };

  let abs;
  try {
    abs = realpathSync(file);
  } catch {
    push(M.MISSING_FILE, `manifest: file not found: ${file}`);
    return fail();
  }
  let doc;
  try {
    doc = JSON.parse(readFileSync(abs, "utf8"));
  } catch (error) {
    push(M.INVALID_JSON, `manifest is not valid JSON: ${error.message}`);
    return fail();
  }
  if (!isObject(doc)) {
    push(M.INVALID_TYPE, "manifest: the top level must be an object");
    return fail();
  }
  // Without a known version the field rules below mean nothing, so stop
  // instead of burying the real problem under structural noise.
  if (!has(doc, "schemaVersion")) {
    push(M.MISSING_SCHEMA_VERSION, "schemaVersion is required");
    return fail();
  }
  if (!SUPPORTED_SCHEMA_VERSIONS.includes(doc.schemaVersion)) {
    push(
      M.UNSUPPORTED_SCHEMA_VERSION,
      `schemaVersion ${JSON.stringify(doc.schemaVersion)} is not supported (supported: ${SUPPORTED_SCHEMA_VERSIONS.join(", ")})`,
    );
    return fail();
  }

  const manifestDir = dirname(abs);
  const repoRoot = findRepoRoot(manifestDir);
  if (repoRoot === null) {
    push(
      M.NO_REPO_ROOT,
      `no .git found above ${manifestDir}; the repository root cannot be determined`,
    );
    return fail();
  }
  if (repoRoot === manifestDir) {
    push(
      M.MANIFEST_AT_REPO_ROOT,
      "the manifest dir must not be the repository root; put it in a dedicated subdirectory",
    );
  }
  const toRel = (absolute) => relative(repoRoot, absolute).split(sep).join("/");

  for (const key of Object.keys(doc)) {
    if (!TOP_KEYS.includes(key))
      push(M.UNKNOWN_KEY, `unknown key "${key}" at top level`);
  }

  const checks = [];
  if (!has(doc, "checks")) {
    push(M.MISSING_FIELD, "checks is required");
  } else if (!Array.isArray(doc.checks)) {
    push(M.INVALID_TYPE, "checks must be an array");
  } else {
    const knownIds = new Set(
      doc.checks.flatMap((c) =>
        isObject(c) && typeof get(c, "id") === "string" ? [c.id] : [],
      ),
    );
    const seenIds = new Set();
    doc.checks.forEach((raw, index) => {
      const checked = validateCheck(raw, index, knownIds, seenIds);
      if (checked) checks.push(checked);
    });
  }

  function expectEnum(value, allowed, where) {
    if (typeof value !== "string") {
      push(M.INVALID_TYPE, `${where} must be a string`);
      return false;
    }
    if (!allowed.includes(value)) {
      push(M.INVALID_ENUM, `${where} must be one of ${allowed.join(" | ")}`);
      return false;
    }
    return true;
  }

  // baseDir resolves the value; containDir bounds the realpath result.
  function resolvePath(
    value,
    where,
    { baseDir, containDir, mustExist, notFileCode },
  ) {
    const issue = pathSyntaxIssue(value);
    if (issue) {
      push(issue.code, `${where} ${issue.what}`);
      return null;
    }
    const lexical = join(baseDir, posix.normalize(value));
    let real;
    try {
      real = realpathSync(lexical);
    } catch {
      if (mustExist) {
        push(M.MISSING_FILE, `${where}: file not found: ${value}`);
        return null;
      }
      return { rel: toRel(lexical), abs: lexical };
    }
    if (!isInside(containDir, real)) {
      push(
        M.PATH_ESCAPE,
        `${where} resolves outside ${containDir === repoRoot ? "the repository" : "the manifest dir"}: ${value}`,
      );
      return null;
    }
    if (!statSync(real).isFile()) {
      push(notFileCode, `${where} is not a regular file: ${value}`);
      return null;
    }
    return { rel: toRel(lexical), abs: real };
  }

  function underManifestDir(value, where) {
    return resolvePath(value, where, {
      baseDir: manifestDir,
      containDir: manifestDir,
      mustExist: true,
      notFileCode: M.MISSING_FILE,
    });
  }
  function underRepoRoot(
    value,
    where,
    notFileCode = M.MISSING_FILE,
    mustExist = true,
  ) {
    return resolvePath(value, where, {
      baseDir: repoRoot,
      containDir: repoRoot,
      mustExist,
      notFileCode,
    });
  }

  function validateCheck(raw, index, knownIds, seenIds) {
    const loc = `checks[${index}]`;
    if (!isObject(raw)) {
      push(M.INVALID_TYPE, `${loc} must be an object`);
      return null;
    }
    const before = errors.length;

    // Which of kind/role are usable decides which optional keys are allowed.
    const kindOk =
      typeof get(raw, "kind") === "string" && KINDS.includes(raw.kind);
    const roleOk =
      typeof get(raw, "role") === "string" && ROLES.includes(raw.role);
    const kind = kindOk ? raw.kind : null;
    const role = roleOk ? raw.role : null;

    for (const key of Object.keys(raw)) {
      if (!CHECK_KEYS.includes(key)) {
        push(M.UNKNOWN_KEY, `unknown key "${key}" at ${loc}`);
        continue;
      }
      const blocked =
        (["cfg", "checkDeadlock"].includes(key) &&
          kind !== null &&
          kind !== "tla") ||
        (key === "imports" && kind === "tla") ||
        (key === "brokenBy" && role !== null && role !== "contract") ||
        (key === "question" && role !== null && role !== "finding");
      if (blocked) {
        push(
          M.KEY_NOT_ALLOWED,
          `${loc}.${key} is not allowed for ${["cfg", "checkDeadlock", "imports"].includes(key) ? `kind "${kind}"` : `role "${role}"`}`,
        );
      }
    }

    const out = {};
    const need = (key) => {
      if (!has(raw, key)) {
        push(M.MISSING_FIELD, `${loc}.${key} is required`);
        return false;
      }
      return true;
    };

    if (need("id")) {
      if (typeof raw.id !== "string")
        push(M.INVALID_TYPE, `${loc}.id must be a string`);
      else if (!ID_PATTERN.test(raw.id))
        push(
          M.INVALID_FORMAT,
          `${loc}.id "${raw.id}" must match ${ID_PATTERN}`,
        );
      else if (seenIds.has(raw.id))
        push(M.DUPLICATE_ID, `${loc}.id "${raw.id}" is already used`);
      else {
        seenIds.add(raw.id);
        out.id = raw.id;
      }
    }
    if (need("kind")) expectEnum(raw.kind, KINDS, `${loc}.kind`);
    out.kind = kind;

    out.model = need("model")
      ? underManifestDir(raw.model, `${loc}.model`)
      : null;
    out.cfg = null;
    if (kind === "tla") {
      if (need("cfg")) out.cfg = underManifestDir(raw.cfg, `${loc}.cfg`);
    }
    out.imports = [];
    if ((kind === "enumerate" || kind === "z3") && has(raw, "imports")) {
      if (!Array.isArray(raw.imports))
        push(M.INVALID_TYPE, `${loc}.imports must be an array`);
      else {
        raw.imports.forEach((value, i) => {
          const resolved = underRepoRoot(value, `${loc}.imports[${i}]`);
          if (resolved) out.imports.push(resolved);
        });
      }
    }

    if (need("property")) {
      if (typeof raw.property !== "string")
        push(M.INVALID_TYPE, `${loc}.property must be a string`);
      else if (raw.property === "")
        push(M.MISSING_FIELD, `${loc}.property must not be empty`);
      else out.property = raw.property;
    }
    const expectOk =
      need("expect") && expectEnum(raw.expect, EXPECTS, `${loc}.expect`);
    const roleChecked =
      need("role") && expectEnum(raw.role, ROLES, `${loc}.role`);
    if (expectOk && roleChecked) {
      const wanted = role === "contract" ? "hold" : "violate";
      if (raw.expect !== wanted) {
        push(
          M.ROLE_EXPECT_MISMATCH,
          `${loc}: role "${role}" requires expect "${wanted}"`,
        );
      }
    }
    out.expect = expectOk ? raw.expect : null;
    out.role = role;

    out.brokenBy = null;
    if (role === "contract" && has(raw, "brokenBy")) {
      if (typeof raw.brokenBy !== "string")
        push(M.INVALID_TYPE, `${loc}.brokenBy must be a string`);
      else if (!knownIds.has(raw.brokenBy)) {
        push(
          M.UNKNOWN_BROKEN_BY,
          `${loc}.brokenBy "${raw.brokenBy}" does not match any check id`,
        );
      } else out.brokenBy = raw.brokenBy;
    }
    out.question = null;
    if (role === "finding") {
      if (need("question")) {
        if (typeof raw.question !== "string")
          push(M.INVALID_TYPE, `${loc}.question must be a string`);
        else out.question = raw.question;
      }
    }

    out.note = null;
    if (has(raw, "note")) {
      if (typeof raw.note !== "string")
        push(M.INVALID_TYPE, `${loc}.note must be a string`);
      else out.note = raw.note;
    }

    out.sync = null;
    if (has(raw, "sync"))
      out.sync = validateSync(raw, loc, { kind, role, out });
    else if (role === "contract" || role === "finding") need("sync");

    out.timeoutSec = DEFAULT_TIMEOUT_SEC;
    if (has(raw, "timeoutSec")) {
      const v = raw.timeoutSec;
      if (typeof v !== "number")
        push(M.INVALID_TYPE, `${loc}.timeoutSec must be a number`);
      else if (!Number.isInteger(v) || v < 1 || v > MAX_TIMEOUT_SEC) {
        push(
          M.OUT_OF_RANGE,
          `${loc}.timeoutSec must be an integer from 1 to ${MAX_TIMEOUT_SEC}`,
        );
      } else out.timeoutSec = v;
    }
    out.checkDeadlock = false;
    if (kind === "tla" && has(raw, "checkDeadlock")) {
      if (typeof raw.checkDeadlock !== "boolean") {
        push(M.INVALID_TYPE, `${loc}.checkDeadlock must be a boolean`);
      } else out.checkDeadlock = raw.checkDeadlock;
    }
    if (
      kind === "tla" &&
      raw.property === "Deadlock" &&
      out.checkDeadlock !== true
    ) {
      push(
        M.DEADLOCK_PROPERTY_WITHOUT_CHECK,
        `${loc}: property "Deadlock" needs checkDeadlock: true`,
      );
    }

    return errors.length === before ? out : null;
  }

  function validateSync(raw, loc, { kind, role, out }) {
    const where = `${loc}.sync`;
    const sync = raw.sync;
    if (!isObject(sync)) {
      push(M.INVALID_TYPE, `${where} must be an object`);
      return null;
    }
    for (const key of Object.keys(sync)) {
      if (!SYNC_KEYS.includes(key))
        push(M.UNKNOWN_KEY, `unknown key "${key}" at ${where}`);
    }
    let commit = null;
    if (has(sync, "commit") && sync.commit !== null) {
      if (typeof sync.commit !== "string")
        push(M.INVALID_TYPE, `${where}.commit must be a string`);
      else if (!COMMIT_PATTERN.test(sync.commit)) {
        push(
          M.INVALID_FORMAT,
          `${where}.commit must be 40 or 64 lowercase hex digits`,
        );
      } else commit = sync.commit;
    }
    const covers = [];
    if (!has(sync, "covers")) {
      push(M.MISSING_FIELD, `${where}.covers is required`);
    } else if (!Array.isArray(sync.covers)) {
      push(M.INVALID_TYPE, `${where}.covers must be an array`);
    } else {
      const seen = new Set();
      sync.covers.forEach((entry, i) => {
        const at = `${where}.covers[${i}]`;
        if (!isObject(entry)) {
          push(M.INVALID_TYPE, `${at} must be an object`);
          return;
        }
        for (const key of Object.keys(entry)) {
          if (!COVER_KEYS.includes(key))
            push(M.UNKNOWN_KEY, `unknown key "${key}" at ${at}`);
        }
        let sha256 = null;
        if (!has(entry, "sha256"))
          push(
            M.MISSING_FIELD,
            `${at}.sha256 is required (null when not recorded yet)`,
          );
        else if (entry.sha256 !== null) {
          if (typeof entry.sha256 !== "string")
            push(M.INVALID_TYPE, `${at}.sha256 must be a string or null`);
          else if (!SHA256_PATTERN.test(entry.sha256)) {
            push(
              M.INVALID_FORMAT,
              `${at}.sha256 must be 64 lowercase hex digits`,
            );
          } else sha256 = entry.sha256;
        }
        if (!has(entry, "path")) {
          push(M.MISSING_FIELD, `${at}.path is required`);
          return;
        }
        const resolved = underRepoRoot(
          entry.path,
          `${at}.path`,
          M.COVERS_NOT_FILE,
          false,
        );
        if (!resolved) return;
        if (seen.has(resolved.rel)) {
          push(M.DUPLICATE_PATH, `${at}.path "${entry.path}" is listed twice`);
          return;
        }
        seen.add(resolved.rel);
        covers.push({ ...resolved, sha256 });
      });
      if (sync.covers.length === 0) {
        if (
          role === "contract" &&
          !(typeof raw.note === "string" && raw.note !== "")
        ) {
          push(
            M.EMPTY_COVERS_WITHOUT_NOTE,
            `${where}.covers is empty; explain why in ${loc}.note`,
          );
        }
        if (role === "finding") {
          push(
            M.EMPTY_COVERS_ON_FINDING,
            `${where}.covers must not be empty on a finding (it names the implementation)`,
          );
        }
      }
      if (
        (role === "contract" || role === "finding") &&
        (kind === "enumerate" || kind === "z3")
      ) {
        for (const imported of out.imports) {
          if (!isInside(manifestDir, imported.abs) && !seen.has(imported.rel)) {
            push(
              M.IMPORT_NOT_COVERED,
              `${loc}.imports "${imported.rel}" is outside the manifest dir but missing from ${where}.covers`,
            );
          }
        }
      }
    }
    return { commit, covers };
  }

  if (errors.length > 0) return fail();
  return {
    ok: true,
    manifest: { schemaVersion: doc.schemaVersion, checks },
    manifestPath: { rel: toRel(abs), abs },
    repoRoot,
    manifestDir,
  };
}
