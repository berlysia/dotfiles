// Finds the TLA+ modules a model pulls in (EXTENDS / INSTANCE) and whether any
// of them can reach outside the model. A leaf module: node: built-ins only, and
// no hashing, so hash.mjs and inspect.mjs decide what to do with the paths.
import { lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, join, relative, sep } from "node:path";
import { MANIFEST } from "./codes.mjs";

// Modules that ship in tla2tools.jar and cannot read files or run code. Any
// other name that is not a sibling file counts as "may do I/O" (deny by
// default): TLCExt, Json, CSV, IOUtils, ... all land on the true side.
const PURE_STANDARD_MODULES = new Set([
  "Bags",
  "FiniteSets",
  "Integers",
  "Naturals",
  "Randomization",
  "RealTime",
  "Reals",
  "Sequences",
  "TLC",
  "Toolbox",
]);

const NAME = /[A-Za-z0-9_]+/y;

// Skips whitespace and comments from `at`. "(* ... *)" is closed at the first
// "*)" without counting nesting, and "\*" runs to the end of the line. This is
// deliberately cruder than TLC's lexer: it only has to keep a comment from
// ending a name list early, and a name read out of a comment costs nothing.
function skipBlank(text, at) {
  let i = at;
  for (;;) {
    while (i < text.length && /\s/.test(text[i])) i++;
    if (text.startsWith("(*", i)) {
      const end = text.indexOf("*)", i + 2);
      i = end === -1 ? text.length : end + 2;
    } else if (text.startsWith("\\*", i)) {
      const end = text.indexOf("\n", i);
      i = end === -1 ? text.length : end + 1;
    } else return i;
  }
}

function readName(text, at) {
  NAME.lastIndex = at;
  const match = NAME.exec(text);
  return match === null ? null : { name: match[0], end: NAME.lastIndex };
}

// Names come from the raw text, comments included. The usesIo answer rests on
// this list: dropping a real "EXTENDS IOUtils" because comment removal
// disagreed with TLC's lexer would show "no I/O" for a model that does I/O,
// while an extra name in a comment only adds one look for the approver.
export function referencedNames(text) {
  const names = [];
  for (const m of text.matchAll(/\bEXTENDS\b/g)) {
    let at = m.index + m[0].length;
    for (;;) {
      at = skipBlank(text, at);
      const item = readName(text, at);
      if (item === null) break;
      names.push(item.name);
      at = skipBlank(text, item.end);
      if (text[at] !== ",") break;
      at += 1;
    }
  }
  for (const m of text.matchAll(/\bINSTANCE\b/g)) {
    const item = readName(text, skipBlank(text, m.index + m[0].length));
    if (item !== null) names.push(item.name);
  }
  return names;
}

// Any .class or .jar under the model's dir: TLC can load Java overrides for
// standard modules, which would run code the digest never covered.
function findBinary(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (/\.(class|jar)$/.test(entry.name)) return path;
    // A symlinked dir is not followed: it could point back up and loop.
    if (entry.isDirectory()) {
      const found = findBinary(path);
      if (found !== null) return found;
    }
  }
  return null;
}

export function collectModules({ modelAbs, repoRoot }) {
  const errors = [];
  const modules = [];
  const dir = dirname(modelAbs);
  const realDir = realpathSync(dir);

  const binary = findBinary(dir);
  if (binary !== null) {
    errors.push({
      code: MANIFEST.UNEXPECTED_BINARY,
      message: `${relative(repoRoot, binary).split(sep).join("/")}: a .class or .jar file next to a TLA+ model can replace a standard module and run outside the approved digest`,
    });
    return { modules, usesIo: null, errors };
  }

  let usesIo = false;
  const visited = new Set([basename(modelAbs, ".tla")]);
  const pending = [modelAbs];
  while (pending.length > 0) {
    let text;
    try {
      text = readFileSync(pending.pop(), "utf8");
    } catch (error) {
      errors.push({
        code: MANIFEST.MISSING_FILE,
        message: `cannot read a TLA+ module: ${error.message}`,
      });
      continue;
    }
    for (const name of referencedNames(text)) {
      if (visited.has(name)) continue;
      visited.add(name);
      const local = join(dir, `${name}.tla`);
      let present = true;
      try {
        lstatSync(local);
      } catch {
        present = false;
      }
      // A sibling file wins over a standard module of the same name, which is
      // what TLC does too.
      if (!present) {
        if (!PURE_STANDARD_MODULES.has(name)) usesIo = true;
        continue;
      }
      let real;
      try {
        real = realpathSync(local);
      } catch {
        real = null;
      }
      // Modules can only live next to the model, so that dir is the boundary,
      // narrower than the repository.
      if (real === null || dirname(real) !== realDir) {
        errors.push({
          code: MANIFEST.PATH_ESCAPE,
          message: `module ${name}.tla resolves outside the model's directory`,
        });
        continue;
      }
      modules.push({
        rel: relative(repoRoot, local).split(sep).join("/"),
        abs: local,
      });
      pending.push(local);
    }
  }
  modules.sort((a, b) => (a.rel < b.rel ? -1 : 1));
  return { modules, usesIo, errors };
}
