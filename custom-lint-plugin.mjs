const plugin = {
  meta: { name: "custom-lint" },
  rules: {
    "no-console-log": {
      meta: { type: "problem" },
      create(context) {
        return {
          CallExpression(node) {
            if (!context.filename.includes("/hooks/")) return;
            if (
              node.callee.type === "MemberExpression" &&
              node.callee.object.name === "console" &&
              node.callee.property.name === "log"
            ) {
              context.report({
                node,
                message:
                  "console.log found in hook implementation\n" +
                  "  WHY: Hooks run as subprocess — console.log pollutes stdout and corrupts JSON protocol\n" +
                  "  FIX: Use console.error for debug output, or remove the log\n" +
                  "  ADR: docs/decisions/0002-hooks-typescript-bun.md",
              });
            }
          },
        };
      },
    },
    "no-process-exit": {
      meta: { type: "problem" },
      create(context) {
        return {
          CallExpression(node) {
            if (!context.filename.includes("/hooks/")) return;
            if (
              node.callee.type === "MemberExpression" &&
              node.callee.object.name === "process" &&
              node.callee.property.name === "exit"
            ) {
              context.report({
                node,
                message:
                  "process.exit() found in hook implementation\n" +
                  "  WHY: process.exit in hooks kills the Claude Code process unexpectedly\n" +
                  "  FIX: Throw an error or return an error response instead\n" +
                  "  ADR: docs/decisions/0002-hooks-typescript-bun.md",
              });
            }
          },
        };
      },
    },
    "no-any-cast": {
      meta: { type: "problem" },
      create(context) {
        return {
          TSAsExpression(node) {
            if (
              node.typeAnnotation &&
              node.typeAnnotation.type === "TSAnyKeyword"
            ) {
              context.report({
                node,
                message:
                  "'as any' cast found\n" +
                  "  WHY: as any bypasses all type checking and can mask real type errors\n" +
                  "  FIX: Use 'as unknown as T' for necessary casts, or fix the underlying type",
              });
            }
          },
        };
      },
    },
    "no-argv-main-check": {
      meta: { type: "problem" },
      create(context) {
        return {
          BinaryExpression(node) {
            if (!["===", "!==", "==", "!="].includes(node.operator)) return;
            const sides = [node.left, node.right];
            if (!sides.some(isImportMetaUrl)) return;
            const argvSide = sides.find((side) =>
              contains(side, isProcessArgv),
            );
            if (!argvSide) return;
            // realpathSync(process.argv[1]) は一致する。import.meta.main の無い
            // 古い Node で動く道具（tailnet-ssh）はこの形を使う。
            if (contains(argvSide, isRealpathCall)) return;
            context.report({
              node,
              message:
                "entry check compares import.meta.url with process.argv\n" +
                "  WHY: Node resolves the entry URL to its realpath but argv keeps the given path; through a symlink (macOS /var -> /private/var) they differ and the CLI exits 0 doing nothing\n" +
                "  FIX: Use `if (import.meta.main)`, or compare against pathToFileURL(realpathSync(process.argv[1]))",
            });
          },
        };
      },
    },
    "realpath-tmp-fixture": {
      meta: { type: "problem", fixable: "code" },
      create(context) {
        return {
          CallExpression(node) {
            if (calleeName(node.callee) !== "mkdtempSync") return;
            if (!node.arguments.some((arg) => contains(arg, isTmpdirCall)))
              return;
            const parent = node.parent;
            if (
              parent?.type === "CallExpression" &&
              calleeName(parent.callee) === "realpathSync" &&
              parent.arguments[0] === node
            )
              return;
            context.report({
              node,
              message:
                "mkdtempSync under tmpdir() without realpathSync\n" +
                "  WHY: on macOS tmpdir() and /tmp are symlinks; code that records realpaths then disagrees with the fixture path\n" +
                "  FIX: Wrap it: realpathSync(mkdtempSync(...))",
              fix: (fixer) => [
                fixer.insertTextBefore(node, "realpathSync("),
                fixer.insertTextAfter(node, ")"),
              ],
            });
          },
        };
      },
    },
  },
};

function calleeName(callee) {
  if (callee.type === "Identifier") return callee.name;
  if (callee.type === "MemberExpression" && !callee.computed)
    return callee.property.name;
  return null;
}

function isImportMetaUrl(node) {
  return (
    node.type === "MemberExpression" &&
    node.object.type === "MetaProperty" &&
    node.object.meta.name === "import" &&
    node.property.name === "url"
  );
}

function isProcessArgv(node) {
  return (
    node.type === "MemberExpression" &&
    node.object.type === "Identifier" &&
    node.object.name === "process" &&
    node.property.name === "argv"
  );
}

function isRealpathCall(node) {
  return (
    node.type === "CallExpression" && calleeName(node.callee) === "realpathSync"
  );
}

function isTmpdirCall(node) {
  return node.type === "CallExpression" && calleeName(node.callee) === "tmpdir";
}

// Walks the subtree without following `parent`, which points back up the tree.
function contains(node, predicate) {
  if (!node || typeof node.type !== "string") return false;
  if (predicate(node)) return true;
  for (const [key, value] of Object.entries(node)) {
    if (key === "parent") continue;
    const children = Array.isArray(value) ? value : [value];
    for (const child of children)
      if (child && typeof child === "object" && contains(child, predicate))
        return true;
  }
  return false;
}

export default plugin;
