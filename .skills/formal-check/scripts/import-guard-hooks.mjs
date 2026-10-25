// Resolve hook body (runs on the loader thread). Kept apart from
// import-guard.mjs because module.register takes the hook as a module URL.
//
// Rules, in order:
//   node: builtins pass; any other non-file: URL (data:, http:) is blocked.
//   A file passes if it is the model, a declared import, or a child-side
//   harness file. Anything else passes only if its *parent* is trusted: a
//   declared import, or a file a trusted parent already imported. The closure
//   is keyed by parent, not target, so a node_modules file reached through a
//   declared implementation is not thereby open to the model itself.
// Limits (accepted): the closure from a declared file is unbounded, and
// `node:` stays open, so createRequire, node:vm and friends bypass this. It
// keeps the approved file list and the direct imports identical; it does not
// isolate anything.
import { realpathSync } from "node:fs";
import { sep } from "node:path";
import { fileURLToPath } from "node:url";

let allowedFiles = new Set();
let harnessDirs = [];
let trusted = new Set();

export async function initialize(data) {
  allowedFiles = new Set([data.model, ...data.imports, ...data.harnessFiles]);
  harnessDirs = data.harnessDirs;
  // The model itself is allowed but deliberately not trusted.
  trusted = new Set(data.imports);
}

const blocked = (what) => new Error(`undeclared import: ${what}`);

// Fail closed: a path that cannot be resolved to a real file is not allowed.
function realPathOf(url) {
  try {
    return realpathSync(fileURLToPath(url));
  } catch {
    return null;
  }
}

export async function resolve(specifier, context, nextResolve) {
  const resolved = await nextResolve(specifier, context);
  const { url } = resolved;
  if (url.startsWith("node:")) return resolved;
  if (!url.startsWith("file:")) throw blocked(url);

  const target = realPathOf(url);
  if (target === null) throw blocked(url);
  if (
    allowedFiles.has(target) ||
    harnessDirs.some((dir) => target.startsWith(dir + sep))
  ) {
    return resolved;
  }
  const parent = context.parentURL?.startsWith("file:")
    ? realPathOf(context.parentURL)
    : null;
  if (parent !== null && trusted.has(parent)) {
    // Recorded at resolve time and never removed: whether the load succeeds
    // later does not change who vouched for the file.
    trusted.add(target);
    return resolved;
  }
  throw blocked(target);
}
