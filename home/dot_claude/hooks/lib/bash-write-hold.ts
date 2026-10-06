import { isAbsolute, resolve } from "node:path";
import {
  parseBashCommand,
  parseForCollect,
  parserGiveUpMark,
  parserGiveUpReasonSince,
  type SimpleCommand,
} from "./bash-parser.ts";
import {
  CORE_PROTECTED_NON_DOT,
  classifyWriteTarget,
  type HoldContext,
  hasInnerParentSegment,
  untrustedBaseReason,
} from "./write-protection.ts";

export interface BashHoldContext extends HoldContext {
  cwd: string;
  // CLAUDE_PROJECT_DIR (getProjectRoot): the base below which the dot rule counts for Bash words.
  projectRoot: string;
}
export interface BashAssessment {
  reason: string | null;
  commands: SimpleCommand[];
}

const SEP = String.raw`[\s"'=:/(){}<>|;&,]`;
// A "." that starts a path segment and is followed by a name character. A short option with an
// attached value (`-o.claude/x`) puts the path right behind the option letters, so a "." that
// directly follows a word-initial `-` plus letters counts as well.
const DOT_FRAGMENT = new RegExp(
  String.raw`(?:^|${SEP})(?:-[A-Za-z]+)?\.(?![./]|${SEP}|$)`,
  "i",
);
const CHEZMOI_GIT_SOURCE = /dot_gitconfig|dot_config\/[^\s/]*git(?:[\s/"']|$)/i;
// Forms whose words cannot be pinned down statically: variable, command and brace expansion, plus
// glob (`*`, `?`, `[`) and tilde expansion, where the shell picks the real path at run time.
const UNRESOLVED = /[$`{*?[~]/;
// Commands that run or build other commands from data, so their write targets are chosen at run time.
const RUNTIME_COMMANDS = new Set([
  "xargs",
  "parallel",
  "sh",
  "bash",
  "zsh",
  "dash",
  "eval",
  "exec",
  "source",
  ".",
]);
const FIND_ACTION = /^-(?:exec|execdir|ok|okdir|delete|fprint|fprintf|fls)$/;
// env -C/--chdir changes the cwd and -S/--split-string re-parses a string into a command.
const ENV_RUNTIME_OPTION = /^(?:-[A-Za-z]*[CS]|--chdir|--split-string)/;
// Escapes that printf/echo -e decode into characters the static text never shows.
const ESCAPE_SEQUENCE = /\\[0-7xuU]/;
const RUNTIME_REASON = "runtime-derived write target";
const CWD_CHANGERS = new Set(["cd", "pushd", "popd"]);
const REDIRECT_OP = /^\d*(?:>>|>\||>&|&>>|&>|>|<)\s*/;
// Absolute path words that reach into a .git/worktree/ directory.
const WORKTREE_PATH = /\/[^\s"';|&<>()]*\/\.git\/worktree\/[^\s"';|&<>()]*/gi;

// Removes absolute path fragments that K3 verifies as worktree content.
function maskWorktreeContent(command: string, ctx: HoldContext): string {
  return command.replace(WORKTREE_PATH, (fragment) =>
    classifyWriteTarget(fragment, ctx, { worktreeRootIsContent: true }).kind ===
    "worktree-content"
      ? "WT"
      : fragment,
  );
}

function fragmentReason(text: string): string | null {
  if (DOT_FRAGMENT.test(text)) return "dot path in command text";
  const lower = text.toLowerCase();
  if (CORE_PROTECTED_NON_DOT.some((name) => lower.includes(name)))
    return "protected name in command text";
  if (CHEZMOI_GIT_SOURCE.test(text))
    return "chezmoi git source in command text";
  return null;
}

// Replaces the project root where it stands as a whole path prefix (after a separator or at the
// start, followed by "/", a separator or the end), so that dot segments above the root (such as
// ~/.local) do not count. A sibling such as `<root>2` or a root inside another path is left alone.
// Skipped when there is no trusted root (buildHoldContext empties unusable roots) or the root
// itself is untrusted.
export function maskProjectRoot(command: string, ctx: BashHoldContext): string {
  if (!ctx.projectRoot || untrustedBaseReason(ctx.projectRoot, ctx))
    return command;
  // Same check on the physical root as trustedBaseFor; an unresolvable root is not masked.
  try {
    if (untrustedBaseReason(ctx.fs.realpath(ctx.projectRoot), ctx))
      return command;
  } catch {
    return command;
  }
  const root = ctx.projectRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(String.raw`(^|${SEP})${root}(?=/|${SEP}|$)`, "g");
  return command.replace(pattern, "$1PROJ");
}

function textReason(command: string, ctx: BashHoldContext): string | null {
  if (UNRESOLVED.test(command)) return "unresolved word";
  const masked = maskProjectRoot(maskWorktreeContent(command, ctx), ctx);
  const joined = masked.replace(/\\\n/g, "").replace(/['"\\]/g, "");
  return fragmentReason(masked) ?? fragmentReason(joined);
}

function unquote(word: string): string {
  return word.replace(/^(['"])(.*)\1$/s, "$2");
}

function pathWordsOf(cmd: SimpleCommand): string[] {
  const words: string[] = [];
  for (const raw of cmd.args) {
    const arg = unquote(raw);
    if (!arg.startsWith("-")) words.push(arg);
    else if (arg.includes("="))
      words.push(unquote(arg.slice(arg.indexOf("=") + 1)));
    // `-ofile`: the text after the 2-char option may be a path (`--long` options are excluded).
    else if (!arg.startsWith("--") && arg.length > 2) words.push(arg.slice(2));
  }
  for (const r of cmd.redirections) {
    if (r.startsWith("<<")) continue; // heredocs carry no write target
    const target = unquote(r.replace(REDIRECT_OP, ""));
    if (target !== "" && target !== "/dev/null") words.push(target);
  }
  return words;
}

function buildsTargetsAtRunTime(cmd: SimpleCommand): boolean {
  const name = (cmd.name ?? "").split("/").pop() ?? "";
  const args = cmd.args.map(unquote);
  if (RUNTIME_COMMANDS.has(name)) return true;
  if (name === "find") return args.some((arg) => FIND_ACTION.test(arg));
  if (name === "env") return args.some((arg) => ENV_RUNTIME_OPTION.test(arg));
  const decodesEscapes =
    name === "printf" ||
    (name === "echo" && args.some((arg) => /^-[A-Za-z]*e/.test(arg)));
  return decodesEscapes && args.some((arg) => ESCAPE_SEQUENCE.test(arg));
}

async function syntaxErrorOrGiveUp(command: string): Promise<boolean> {
  let tree: Awaited<ReturnType<typeof parseForCollect>> = null;
  try {
    tree = await parseForCollect(command);
    return tree === null || tree.rootNode.hasError;
  } finally {
    tree?.delete();
  }
}

export async function assessBashCommand(
  command: string,
  ctx: BashHoldContext,
): Promise<BashAssessment> {
  const mark = parserGiveUpMark();
  const parsed = await parseBashCommand(command, true);
  const broken =
    parsed.parsingMethod === "fallback" || (await syntaxErrorOrGiveUp(command));
  const gaveUp = parserGiveUpReasonSince(mark);
  const commands = parsed.commands;
  if (broken || gaveUp !== null)
    return { reason: `unparsed command (${gaveUp ?? "syntax"})`, commands };
  if (commands.some((c) => CWD_CHANGERS.has(c.name ?? "")))
    return { reason: "cwd changes before the words", commands };
  if (commands.some(buildsTargetsAtRunTime))
    return { reason: RUNTIME_REASON, commands };
  const text = textReason(command, ctx);
  if (text) return { reason: text, commands };
  for (const cmd of commands) {
    for (const word of pathWordsOf(cmd)) {
      if (hasInnerParentSegment(word))
        return { reason: `${word}: '..' after the first segment`, commands };
      const abs = isAbsolute(word) ? word : resolve(ctx.cwd, word);
      const target = classifyWriteTarget(abs, ctx, {
        worktreeRootIsContent: true,
        trustedBase: ctx.projectRoot,
      });
      if (target.kind === "hold")
        return { reason: `${word}: ${target.reason}`, commands };
    }
  }
  return { reason: null, commands };
}
