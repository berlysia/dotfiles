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
                  "  FIX: Use console.error for debug output, or remove the log",
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
                  "  FIX: Throw an error or return an error response instead",
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
  },
};
export default plugin;
