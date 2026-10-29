import { deepStrictEqual, strictEqual } from "node:assert";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import { it } from "node:test";

const edges: Record<string, readonly string[]> = {
  constants: [],
  cache: ["constants"],
  deps: ["cache"],
  item: [
    "constants",
    "deps",
    "../redact-secrets",
    "../key-like",
    "../invisible-chars",
    "../agent-caller",
  ],
  "issue-body": ["item", "constants"],
  target: ["gh", "issue-body", "spool", "item", "constants", "deps"],
  refresh: [
    "flush",
    "gh",
    "issue-body",
    "spool",
    "retry",
    "lock",
    "cache",
    "constants",
    "deps",
    "item",
  ],
  collect: [
    "target",
    "gh",
    "spool",
    "issue-body",
    "item",
    "constants",
    "deps",
    "display",
  ],
  triage: [
    "target",
    "gh",
    "issue-body",
    "item",
    "display",
    "constants",
    "deps",
    "../agent-caller",
  ],
  display: ["../invisible-chars", "constants", "cache", "item"],
  lock: ["constants", "deps"],
  retry: ["lock", "constants", "deps", "item"],
  spool: ["item", "lock", "retry", "constants", "deps"],
  gh: [
    "issue-body",
    "item",
    "cache",
    "constants",
    "deps",
    "../invisible-chars",
  ],
  spawn: ["deps"],
  home: [],
  flush: [
    "spool",
    "retry",
    "gh",
    "spawn",
    "cache",
    "lock",
    "item",
    "issue-body",
    "constants",
    "deps",
  ],
  "cli/dotfiles-feedback": [
    "constants",
    "cache",
    "deps",
    "item",
    "issue-body",
    "lock",
    "retry",
    "spool",
    "gh",
    "spawn",
    "flush",
    "collect",
    "refresh",
    "triage",
    "display",
    "home",
    "../repo-key",
    "../run-git",
    "../agent-caller",
  ],
};
const shared = [
  "redact-secrets",
  "key-like",
  "invisible-chars",
  "agent-caller",
  "repo-key",
  "run-git",
];
const hooks = resolve(import.meta.dirname, "../..");

function imports(source: string): { target: string; typeOnly: boolean }[] {
  // コメントと文字列をひとまとまりに読み、本文中の import らしい文字列は数えない。
  const tokens = (
    source.match(
      /\/\/[^\n]*|\/\*[\s\S]*?\*\/|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|[A-Za-z_$][\w$]*|[^\s]/g,
    ) ?? []
  ).filter((token) => !token.startsWith("//") && !token.startsWith("/*"));
  const found: { target: string; typeOnly: boolean }[] = [];
  const literal = (token: string | undefined): token is string =>
    !!token && /^(?:"|'|`)/.test(token);
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (token !== "import" && token !== "export" && token !== "require")
      continue;
    let cursor = index + 1;
    if (tokens[cursor] === "(") {
      const target = tokens[cursor + 1];
      if (literal(target))
        found.push({ target: target.slice(1, -1), typeOnly: false });
      continue;
    }
    if (token === "require") continue;
    const immediate = tokens[cursor];
    if (literal(immediate)) {
      found.push({ target: immediate.slice(1, -1), typeOnly: false });
      continue;
    }
    const typeOnly = tokens[cursor] === "type";
    while (
      cursor < tokens.length &&
      ![";", "import", "export"].includes(tokens[cursor] ?? "") &&
      !literal(tokens[cursor])
    ) {
      const target = tokens[cursor + 1];
      if (tokens[cursor] === "from" && literal(target)) {
        found.push({ target: target.slice(1, -1), typeOnly });
        break;
      }
      cursor++;
    }
  }
  return found;
}

function violations(file: string, source: string): string[] {
  const module = basename(file, ".ts");
  const feedback = file.startsWith("lib/dotfiles-feedback/");
  const cli = file === "cli/dotfiles-feedback.ts";
  const learnings = file.startsWith("lib/agent-learnings/");
  const isShared = shared.includes(module) && file === `lib/${module}.ts`;
  return imports(source).flatMap(({ target, typeOnly }) => {
    if (target.startsWith("node:"))
      return module === "deps" && !typeOnly ? [target] : [];
    const destination = relative(
      hooks,
      resolve(hooks, file, "..", target),
    ).replace(/\.ts$/, "");
    if (
      (learnings || isShared) &&
      destination.startsWith("lib/dotfiles-feedback/")
    )
      return [target];
    if (
      (feedback || isShared) &&
      destination.startsWith("lib/agent-learnings/")
    )
      return [target];
    if (feedback || cli) {
      const allowed = edges[cli ? "cli/dotfiles-feedback" : module] ?? [];
      const edge = destination.startsWith("lib/dotfiles-feedback/")
        ? basename(destination)
        : `../${destination.replace(/^lib\//, "")}`;
      if (
        !target.startsWith(".") ||
        !allowed.includes(edge) ||
        (module === "deps" && !typeOnly)
      )
        return [target];
    }
    return [];
  });
}

function files(dir: string): string[] {
  return readdirSync(join(hooks, dir), { withFileTypes: true }).flatMap(
    (entry) =>
      entry.isDirectory()
        ? files(`${dir}/${entry.name}`)
        : entry.name.endsWith(".ts")
          ? [`${dir}/${entry.name}`]
          : [],
  );
}
it("keeps current modules inside the full dependency allow-list", () => {
  const targets = [
    ...files("lib/dotfiles-feedback"),
    ...files("lib/agent-learnings"),
    ...shared.map((name) => `lib/${name}.ts`),
    ...(existsSync(join(hooks, "cli/dotfiles-feedback.ts"))
      ? ["cli/dotfiles-feedback.ts"]
      : []),
  ];
  for (const file of targets)
    deepStrictEqual(
      violations(file, readFileSync(join(hooks, file), "utf8")),
      [],
      file,
    );
});
for (const source of [
  'import { x } from "./spool.ts";',
  'export * from "../agent-learnings/core/store.ts";',
  'await import("../agent-learnings/x.ts");',
  'require("../agent-learnings/x");',
]) {
  it(`rejects forbidden edge: ${source}`, () =>
    strictEqual(
      violations("lib/dotfiles-feedback/cache.ts", source).length,
      1,
    ));
}
it("rejects dependencies from shared components and reverse dependencies", () => {
  strictEqual(
    violations("lib/key-like.ts", 'import "./dotfiles-feedback/item.ts";')
      .length,
    1,
  );
  strictEqual(
    violations(
      "lib/agent-learnings/core/store.ts",
      'export * from "../../dotfiles-feedback/item.ts";',
    ).length,
    1,
  );
});
it("allows only type imports in deps and rejects unrelated packages", () => {
  deepStrictEqual(
    violations(
      "lib/dotfiles-feedback/deps.ts",
      'import type { FeedbackError } from "./cache.ts";',
    ),
    [],
  );
  strictEqual(
    violations(
      "lib/dotfiles-feedback/deps.ts",
      'import { readLastFlush } from "./cache.ts";',
    ).length,
    1,
  );
  strictEqual(
    violations("lib/dotfiles-feedback/cache.ts", 'import x from "typescript";')
      .length,
    1,
  );
});
it("retains the allow-list for future modules and the CLI", () => {
  deepStrictEqual(
    violations(
      "lib/dotfiles-feedback/flush.ts",
      'import { x } from "./spool.ts";',
    ),
    [],
  );
  deepStrictEqual(
    violations(
      "cli/dotfiles-feedback.ts",
      'import { x } from "../lib/dotfiles-feedback/flush.ts";',
    ),
    [],
  );
});

it("ignores imports quoted as data or comments", () => {
  deepStrictEqual(
    violations(
      "lib/dotfiles-feedback/cache.ts",
      `// import x from "./spool.ts";
/* require("../agent-learnings/x"); */
const sample = 'import x from "./spool.ts";';`,
    ),
    [],
  );
});
it("requires type-only node imports in deps", () => {
  strictEqual(
    violations("lib/dotfiles-feedback/deps.ts", 'import fs from "node:fs";')
      .length,
    1,
  );
  deepStrictEqual(
    violations(
      "lib/dotfiles-feedback/deps.ts",
      'import type { Stats } from "node:fs";',
    ),
    [],
  );
});

const feedbackFiles = () => files("lib/dotfiles-feedback");
it("only triage, deps and the CLI refer to InteractiveDeps", () => {
  const users = feedbackFiles().filter((file) =>
    readFileSync(join(hooks, file), "utf8").includes("InteractiveDeps"),
  );
  deepStrictEqual(users.sort(), [
    "lib/dotfiles-feedback/deps.ts",
    "lib/dotfiles-feedback/triage.ts",
  ]);
  strictEqual(
    readFileSync(join(hooks, "cli/dotfiles-feedback.ts"), "utf8").includes(
      "InteractiveDeps",
    ),
    true,
  );
});
it("has no import cycle among dotfiles-feedback modules, type imports included", () => {
  const graph = new Map<string, string[]>();
  for (const file of feedbackFiles()) {
    const module = basename(file, ".ts");
    const edges = imports(readFileSync(join(hooks, file), "utf8"))
      .filter(({ target }) => target.startsWith("./"))
      .map(({ target }) => basename(target, ".ts"));
    graph.set(module, edges);
  }
  const state = new Map<string, "visiting" | "done">();
  const visit = (node: string, path: string[]): void => {
    if (state.get(node) === "done") return;
    if (state.get(node) === "visiting")
      throw new Error(`cycle: ${[...path, node].join(" -> ")}`);
    state.set(node, "visiting");
    for (const next of graph.get(node) ?? []) visit(next, [...path, node]);
    state.set(node, "done");
  };
  for (const node of graph.keys()) visit(node, []);
});
