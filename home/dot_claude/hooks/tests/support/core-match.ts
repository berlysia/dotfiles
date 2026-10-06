import ignore from "ignore";
import { relative } from "node:path";

export interface CoreEnv {
  home: string;
  cwd: string;
  // The directory a `/path` rule anchors at: ~/.claude for user settings.
  settingsDir: string;
}
export interface CoreRules {
  deny: string[];
  ask: string[];
  allow: string[];
}

// Reproduces only the pattern-matching format of Claude Code's gitignore-style rules.
// Not reproduced: the symlink double check, protected paths (spec R5; verified by the
// acceptance experiments), and the core's depth rule for single-segment relative patterns
// such as `src/**` (this repo's rules use the `//` and `~/` anchors instead).

// Splits "Edit(pattern)" into the tool and an absolute anchor plus a gitignore pattern.
// Anchored forms (//, ~/, /) get a leading "/" so that `ignore` matches them only at the
// anchor; a slash-free pattern would otherwise match at any depth. Relative patterns stay
// unanchored, as the docs describe for bare names.
function parseRule(
  rule: string,
  env: CoreEnv,
): { tool: string; anchor: string; pattern: string } | null {
  const m = /^(\w+)\((.*)\)$/.exec(rule);
  if (!m?.[1] || m[2] === undefined) return null;
  const body = m[2];
  if (body.startsWith("//"))
    return { tool: m[1], anchor: "/", pattern: `/${body.slice(2)}` };
  if (body.startsWith("~/"))
    return { tool: m[1], anchor: env.home, pattern: `/${body.slice(2)}` };
  if (body.startsWith("/"))
    return { tool: m[1], anchor: env.settingsDir, pattern: body };
  return {
    tool: m[1],
    anchor: env.cwd,
    pattern: body.startsWith("./") ? body.slice(2) : body,
  };
}

export function coreMatch(
  rule: string,
  absPath: string,
  env: CoreEnv,
): boolean {
  const parsed = parseRule(rule, env);
  if (!parsed) return false;
  const rel = relative(parsed.anchor, absPath);
  if (rel === "" || rel.startsWith("..")) return false;
  return ignore().add(parsed.pattern).ignores(rel);
}

export function coreDecision(
  tool: "Edit" | "Read",
  absPath: string,
  rules: CoreRules,
  env: CoreEnv,
): "deny" | "ask" | "allow" | "none" {
  const hits = (list: string[]) =>
    list.some((r) => r.startsWith(`${tool}(`) && coreMatch(r, absPath, env));
  if (hits(rules.deny)) return "deny";
  if (hits(rules.ask)) return "ask";
  if (hits(rules.allow)) return "allow";
  return "none";
}
