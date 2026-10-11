import { readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import {
  assessBashCommand,
  type BashAssessment,
  type BashHoldContext,
} from "./bash-write-hold.ts";
import { createMatchContext, getProjectRoot } from "./project-root.ts";
import {
  classifyWriteTarget,
  hasInnerParentSegment,
  nodeHoldFs,
} from "./write-protection.ts";

const WRITE_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

// The file names the Read `ask` rules in .settings.permissions.json name. An allow from a hook
// skips the prompt those rules ask for, so a Read of one is held. hold-invariants.test.ts fails
// when a Read ask rule is added without a matching name here.
const ASK_RULE_READ_NAMES = new Set([
  ".env",
  ".env.local",
  ".env.development",
  ".env.dev",
  ".env.production",
  ".env.prod",
  ".env.staging",
  ".env.preview",
  ".env.test",
]);
// Read(//**/.env.*.local)
const ASK_RULE_READ_LOCAL = /^\.env\..*\.local$/;

function isAskRuleReadName(name: string): boolean {
  return ASK_RULE_READ_NAMES.has(name) || ASK_RULE_READ_LOCAL.test(name);
}

// Any segment counts, not only the last: a gitignore-style rule can also match what lies under
// a directory of that name, and holding more than the rules cover only withholds an auto-approval.
function hasAskRuleReadName(path: string): boolean {
  return path.split("/").some(isAskRuleReadName);
}

// Core matches its rules against the target of a symlink as well (measured, ADR-0027), so the
// resolved path is judged too. A path that does not exist has no other name; write-protection.ts
// reads the same two codes as "absent".
function resolvedOrSame(path: string, ctx: BashHoldContext): string {
  try {
    return ctx.fs.realpath(path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return path;
    throw error;
  }
}

function assessRead(toolInput: unknown, ctx: BashHoldContext): HoldDecision {
  const raw = (toolInput as { file_path?: unknown } | null)?.file_path;
  if (typeof raw !== "string" || raw === "") return { hold: false };
  // `~` is not expanded here and resolve() folds `..` lexically, so the file judged could differ
  // from the file read. The write tools are held for the same two reasons below.
  if (raw.startsWith("~"))
    return { hold: true, reason: "Read path starts with ~" };
  if (raw.split("/").includes(".."))
    return { hold: true, reason: "Read path has a .. segment" };
  const lexical = isAbsolute(raw) ? raw : resolve(ctx.cwd, raw);
  return hasAskRuleReadName(lexical) ||
    hasAskRuleReadName(resolvedOrSame(lexical, ctx))
    ? { hold: true, reason: "Read of a file an ask rule names" }
    : { hold: false };
}
const PATH_KEYS = ["file_path", "path", "notebook_path"] as const;

// The field a write tool actually writes. getFilePathFromToolInput takes the first key present,
// so a harmless file_path could mask the notebook_path NotebookEdit writes.
function writtenPathKey(toolName: string): (typeof PATH_KEYS)[number] {
  return toolName === "NotebookEdit" ? "notebook_path" : "file_path";
}

export type HoldDecision =
  | { hold: true; reason: string; bash?: BashAssessment }
  | { hold: false; bash?: BashAssessment };

function readChezmoiSource(home: string): string {
  const root = join(home, ".local/share/chezmoi");
  try {
    const sub = readFileSync(join(root, ".chezmoiroot"), "utf8").trim();
    return sub ? join(root, sub) : root;
  } catch {
    // Same path as the ask rules in .settings.permissions.json.
    return join(root, "home");
  }
}

// Reason prefixes shared by the hooks that log a hold and by permission-analyzer, which skips them.
export const HELD_PREFIX = "held: ";
export const SKIPPED_LLM_PREFIX = "skipped-llm: ";

// Every hook builds its context from createMatchContext (project-root.ts:31), the same source
// auto-approve already uses for cwd and home, so the three hooks judge one input alike.
export function holdContextFromInput(
  inputCwd: string | undefined,
): BashHoldContext {
  return buildHoldContext({
    ...createMatchContext(inputCwd),
    projectRoot: getProjectRoot(inputCwd),
  });
}

// A root that cannot serve as a base becomes "" (no relaxation): not absolute, "/", or HOME
// itself (every dot directory under HOME would then count as "below the root").
function usableProjectRoot(root: string, home: string): string {
  if (!isAbsolute(root)) return "";
  const normalized = resolve(root);
  return normalized === "/" || normalized === resolve(home) ? "" : normalized;
}

export function buildHoldContext(env: {
  cwd: string;
  home: string;
  projectRoot?: string;
}): BashHoldContext {
  return {
    cwd: env.cwd,
    home: env.home,
    projectRoot: usableProjectRoot(env.projectRoot ?? env.cwd, env.home),
    chezmoiSource: readChezmoiSource(env.home),
    fs: nodeHoldFs,
  };
}

async function assess(
  toolName: string,
  toolInput: unknown,
  ctx: BashHoldContext,
): Promise<HoldDecision> {
  if (toolName === "Bash") {
    const command = (toolInput as { command?: unknown } | null)?.command;
    if (typeof command !== "string")
      return { hold: true, reason: "Bash input without a command" };
    const bash = await assessBashCommand(command, ctx);
    return bash.reason === null
      ? { hold: false, bash }
      : { hold: true, reason: bash.reason, bash };
  }
  if (toolName === "Read") return assessRead(toolInput, ctx);
  if (!WRITE_TOOLS.has(toolName)) return { hold: false };
  const input = (toolInput ?? {}) as Record<string, unknown>;
  const key = writtenPathKey(toolName);
  const raw = input[key];
  if (typeof raw !== "string" || raw === "")
    return { hold: true, reason: `${toolName} input without a path` };
  // A second path-like key leaves it unclear which one the tool writes.
  if (PATH_KEYS.some((other) => other !== key && other in input))
    return { hold: true, reason: `${toolName} input with several path keys` };
  // `~` is not expanded here, so resolving it against cwd would judge a different file.
  if (raw.startsWith("~"))
    return { hold: true, reason: `${toolName} path starts with ~` };
  // resolve() folds `..` lexically, which is wrong when the segment before it is a symlink.
  if (!isAbsolute(raw) && hasInnerParentSegment(raw))
    return { hold: true, reason: `${toolName} path has an inner ..` };
  const target = classifyWriteTarget(
    isAbsolute(raw) ? raw : resolve(ctx.cwd, raw),
    ctx,
  );
  return target.kind === "hold"
    ? { hold: true, reason: target.reason }
    : { hold: false };
}

export async function assessAutoApprovalHold(
  toolName: string,
  toolInput: unknown,
  ctx: BashHoldContext,
): Promise<HoldDecision> {
  try {
    return await assess(toolName, toolInput, ctx);
  } catch (error) {
    // Never let a failure here turn into an approval.
    return {
      hold: true,
      reason: `hold check failed (${error instanceof Error ? error.name : typeof error})`,
    };
  }
}
