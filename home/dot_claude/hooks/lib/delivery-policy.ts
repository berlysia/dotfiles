/**
 * Shared by the delivery-policy CLI, its recording hook and the guard: the
 * ledger of how far an agent may take finished work per repo, the question
 * that records an answer, and the pure decision whether a PR may be merged.
 *
 * Imports only node builtins on purpose. Everything this module imports is
 * code the merge decision runs on, so each import widens PROTECTED_PATHS (a PR
 * touching one of those files is never merged by the wrapper itself).
 */

import { execFile, execFileSync } from "node:child_process";
import {
  closeSync,
  constants as fsConstants,
  mkdirSync,
  openSync,
  readFileSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";

export type Scope = "commit" | "pr" | "merge";
export const SCOPES: readonly Scope[] = ["commit", "pr", "merge"];

export function isScope(value: unknown): value is Scope {
  return (
    typeof value === "string" && (SCOPES as readonly string[]).includes(value)
  );
}

// --- locations -------------------------------------------------------------

/** Relative to the passwd home. Never derived from an env var an agent can set. */
export const LEDGER_DIR_RELATIVE = ".claude/state/delivery-policy";

export function ledgerDir(home: string): string {
  return join(home, LEDGER_DIR_RELATIVE);
}

export function ledgerPath(home: string): string {
  return join(ledgerDir(home), "ledger.jsonl");
}

export function waitsPath(home: string): string {
  return join(ledgerDir(home), "waits.json");
}

// --- passwd home -----------------------------------------------------------

function runTool(file: string, args: string[]): string | null {
  try {
    return execFileSync(file, args, {
      encoding: "utf8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "ignore"],
      env: { PATH: "/usr/bin:/bin" },
    });
  } catch {
    return null;
  }
}

/**
 * The home directory of the current uid from the passwd database, or null.
 * bun's os.userInfo() and os.homedir() both return $HOME, so neither can be
 * used where an agent-set HOME must not move a path. There is deliberately no
 * fallback to them: a caller that gets null refuses to proceed.
 */
export function passwdHome(
  run: (file: string, args: string[]) => string | null = runTool,
): string | null {
  const uid = process.getuid?.();
  if (uid === undefined) return null;
  let home: string | null = null;
  if (process.platform === "darwin") {
    const found = run("/usr/bin/dscl", [
      ".",
      "-search",
      "/Users",
      "UniqueID",
      String(uid),
    ]);
    const user = found?.trim().split(/\s+/)[0];
    if (user && /^[A-Za-z0-9._-]+$/.test(user)) {
      const read = run("/usr/bin/dscl", [
        ".",
        "-read",
        `/Users/${user}`,
        "NFSHomeDirectory",
      ]);
      home = read?.replace(/^NFSHomeDirectory:\s*/, "").trim() ?? null;
    }
  } else {
    const entry =
      run("/usr/bin/getent", ["passwd", String(uid)]) ??
      run("/bin/getent", ["passwd", String(uid)]);
    home = entry?.trim().split("\n")[0]?.split(":")[5] ?? null;
  }
  return home !== null && home.startsWith("/") && home.length > 1 ? home : null;
}

// --- ledger ----------------------------------------------------------------

export interface LedgerRecord {
  v: 1;
  repo: string;
  scope: Scope;
  at: string;
}

export interface InvalidLine {
  /** Physical line of the file (1-based, blank lines counted). */
  line: number;
  reason: "json" | "version" | "shape";
}

export interface Ledger {
  /** Last valid record per repo, by append order only. */
  latest: Map<string, LedgerRecord>;
  invalid: InvalidLine[];
  /** Set when the file exists but cannot be read; treated like an invalid line. */
  readError?: string;
}

/**
 * One write on an O_APPEND descriptor with the newline first: a line cut off
 * by a crash is then followed by a fresh line instead of being extended into
 * a different, possibly valid, record. O_NOFOLLOW: a symlink planted at the
 * ledger's name makes the append fail instead of writing elsewhere.
 */
export function appendLedger(
  home: string,
  record: { repo: string; scope: Scope; at: string },
): void {
  mkdirSync(ledgerDir(home), { recursive: true, mode: 0o700 });
  const fd = openSync(
    ledgerPath(home),
    fsConstants.O_WRONLY |
      fsConstants.O_APPEND |
      fsConstants.O_CREAT |
      fsConstants.O_NOFOLLOW,
    0o600,
  );
  try {
    writeSync(fd, `\n${JSON.stringify({ v: 1, ...record })}`);
  } finally {
    closeSync(fd);
  }
}

function classifyLine(line: string): LedgerRecord | InvalidLine["reason"] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return "json";
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return "shape";
  }
  const o = parsed as Record<string, unknown>;
  if (o.v !== 1) return "version";
  if (
    typeof o.repo !== "string" ||
    o.repo === "" ||
    !isScope(o.scope) ||
    typeof o.at !== "string"
  ) {
    return "shape";
  }
  return { v: 1, repo: o.repo, scope: o.scope, at: o.at };
}

/**
 * Order is the only thing trusted: `at` is for display, so a clock that
 * jumped never invalidates a line. A line that is not understood is reported,
 * never skipped silently: skipping could resurrect an older `merge` that the
 * unreadable line had narrowed.
 */
export function parseLedger(text: string): Ledger {
  const latest = new Map<string, LedgerRecord>();
  const invalid: InvalidLine[] = [];
  text.split("\n").forEach((line, index) => {
    if (line.trim() === "") return;
    const result = classifyLine(line);
    if (typeof result === "string") {
      invalid.push({ line: index + 1, reason: result });
      return;
    }
    latest.set(result.repo, result);
  });
  return { latest, invalid };
}

export function readLedger(home: string): Ledger {
  let text: string;
  try {
    text = readFileSync(ledgerPath(home), "utf-8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { latest: new Map(), invalid: [] };
    return {
      latest: new Map(),
      invalid: [],
      readError: code ?? String(error),
    };
  }
  return parseLedger(text);
}

// --- question --------------------------------------------------------------

export const DELIVERY_POLICY_QUESTION_PREFIX = "Delivery policy の記録";
const DELIVERY_POLICY_HEADER = "Delivery";
const MERGE_WARNING =
  "merge を選ぶと、この repo では agent が自分の PR を、確認なしで default branch に merge する";
const NO_CHECK_NOTE = "必須の check が無い repo では merge せず人間に戻す";

export interface DeliveryPolicyQuestion {
  question: string;
  header: string;
  multiSelect: false;
  options: Array<{ label: Scope; description: string }>;
}

const SCOPE_DESCRIPTIONS: Record<Scope, string> = {
  commit: "commit まで。push も PR も作らない",
  pr: "PR を作るところまで。merge は人間",
  merge: "CI が通ったら agent が merge する",
};

/** The question depends on the repo and the remote URL alone, so a hook can rebuild it. */
export function buildDeliveryPolicyQuestion(
  repo: string,
  remoteUrl: string,
): DeliveryPolicyQuestion[] {
  return [
    {
      question: `${DELIVERY_POLICY_QUESTION_PREFIX}: ${repo}（${remoteUrl}）で、作業をどこまで進めるか。${MERGE_WARNING}。${NO_CHECK_NOTE}。`,
      header: DELIVERY_POLICY_HEADER,
      multiSelect: false,
      options: SCOPES.map((label) => ({
        label,
        description: SCOPE_DESCRIPTIONS[label],
      })),
    },
  ];
}

/**
 * Loose on purpose: a false positive in the guard only refuses a question a
 * model should not have written by hand. Total: any input yields a boolean.
 */
export function isDeliveryPolicyQuestion(questions: unknown): boolean {
  try {
    if (!Array.isArray(questions)) return false;
    return questions.some((q: unknown) => {
      if (typeof q !== "object" || q === null) return false;
      const text = (q as { question?: unknown }).question;
      return (
        typeof text === "string" &&
        text.startsWith(DELIVERY_POLICY_QUESTION_PREFIX)
      );
    });
  } catch {
    return false;
  }
}

// --- gh --------------------------------------------------------------------

export interface GhResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

export interface GhOptions {
  /** Per-call limit in ms; defaults to 30 s. */
  timeoutMs?: number;
}

export type Gh = (args: string[], options?: GhOptions) => Promise<GhResult>;

/** gh bound to a working directory; the repo gh resolves comes from that directory's git config. */
export function createGh(cwd: string): Gh {
  return (args, options) =>
    new Promise((resolvePromise) => {
      execFile(
        "gh",
        args,
        {
          cwd,
          encoding: "utf8",
          maxBuffer: 16 * 1024 * 1024,
          // execFile throws ERR_OUT_OF_RANGE for a non-integer timeout.
          timeout: Math.max(1, Math.floor(options?.timeoutMs ?? 30_000)),
          env: {
            ...process.env,
            GH_PROMPT_DISABLED: "1",
            GH_NO_UPDATE_NOTIFIER: "1",
            NO_COLOR: "1",
          },
        },
        (error, stdout, stderr) => {
          const code = (error as { code?: unknown } | null)?.code;
          resolvePromise({
            status: error === null ? 0 : typeof code === "number" ? code : null,
            stdout,
            stderr,
          });
        },
      );
    });
}

export interface RepoInfo {
  /** Lowercased. */
  nameWithOwner: string;
  /** Lowercased. */
  ownerLogin: string;
  isInOrganization: boolean;
  defaultBranch: string;
  url: string;
}

export type RepoResolution =
  | { ok: true; repo: RepoInfo }
  | { ok: false; reason: string };

export async function resolveRepo(gh: Gh): Promise<RepoResolution> {
  const result = await gh([
    "repo",
    "view",
    "--json",
    "nameWithOwner,owner,isInOrganization,defaultBranchRef,url",
  ]);
  if (result.status !== 0) {
    return {
      ok: false,
      reason: `gh repo view failed: ${result.stderr.trim().slice(0, 200)}`,
    };
  }
  try {
    const o = JSON.parse(result.stdout) as {
      nameWithOwner?: unknown;
      owner?: { login?: unknown } | null;
      isInOrganization?: unknown;
      defaultBranchRef?: { name?: unknown } | null;
      url?: unknown;
    };
    if (
      typeof o.nameWithOwner !== "string" ||
      !o.nameWithOwner.includes("/") ||
      typeof o.owner?.login !== "string" ||
      typeof o.isInOrganization !== "boolean" ||
      typeof o.defaultBranchRef?.name !== "string" ||
      typeof o.url !== "string"
    ) {
      return { ok: false, reason: "gh repo view answered an unexpected shape" };
    }
    return {
      ok: true,
      repo: {
        nameWithOwner: o.nameWithOwner.toLowerCase(),
        ownerLogin: o.owner.login.toLowerCase(),
        isInOrganization: o.isInOrganization,
        defaultBranch: o.defaultBranchRef.name,
        url: o.url,
      },
    };
  } catch {
    return { ok: false, reason: "gh repo view did not answer JSON" };
  }
}

// --- required checks -------------------------------------------------------

export interface RequiredContext {
  context: string;
  integrationId?: number;
}

export interface CheckRun {
  name: string;
  /** GraphQL enum, any case; compared upper-cased. */
  status: string;
  conclusion: string | null;
  appId: number | null;
}

/**
 * Union of the ruleset's and the classic protection's required contexts.
 * `classic` is null when that protection does not exist (404). For one
 * context, an entry pinned to an app replaces the unpinned one; two entries
 * pinned to different apps both stay, which no single app can satisfy, so
 * the merge is refused rather than guessed.
 */
export function mergeRequiredContexts(
  ruleset: readonly RequiredContext[],
  classic: readonly RequiredContext[] | null,
): RequiredContext[] {
  const byContext = new Map<string, RequiredContext[]>();
  for (const entry of [...ruleset, ...(classic ?? [])]) {
    byContext.set(entry.context, [
      ...(byContext.get(entry.context) ?? []),
      entry,
    ]);
  }
  const merged: RequiredContext[] = [];
  for (const [context, entries] of byContext) {
    const ids = new Set<number>();
    for (const e of entries) {
      if (e.integrationId !== undefined) ids.add(e.integrationId);
    }
    if (ids.size === 0) merged.push({ context });
    else
      for (const integrationId of ids) merged.push({ context, integrationId });
  }
  return merged;
}

type CheckOutcome = "pass" | "pending" | "fail";

const PASSING_CONCLUSIONS = new Set(["SUCCESS", "NEUTRAL", "SKIPPED"]);

function classifyCheckRun(run: CheckRun): CheckOutcome {
  if (run.conclusion === null || run.status.toUpperCase() !== "COMPLETED") {
    return "pending";
  }
  return PASSING_CONCLUSIONS.has(run.conclusion.toUpperCase())
    ? "pass"
    : "fail";
}

function outcomeOfContext(
  required: RequiredContext,
  runs: readonly CheckRun[],
): CheckOutcome {
  const matching = runs.filter(
    (r) =>
      r.name === required.context &&
      (required.integrationId === undefined ||
        r.appId === required.integrationId),
  );
  if (matching.length === 0) return "pending";
  const outcomes = matching.map(classifyCheckRun);
  if (outcomes.includes("fail")) return "fail";
  if (outcomes.includes("pending")) return "pending";
  return "pass";
}

// --- protected paths -------------------------------------------------------

/**
 * Repo paths whose change a PR may not carry into an automatic merge: what
 * the guard, the recorder and the CLI run on, and how they are registered or
 * delivered. A trailing "/" is a prefix, "*" a glob (not crossing "/"),
 * anything else an exact path. The import-closure test fails when one of the
 * three entry points imports a file that none of these match.
 */
export const PROTECTED_PATHS: readonly string[] = [
  ".github/",
  "home/dot_claude/hooks/lib/delivery-policy.ts",
  "home/dot_claude/hooks/implementations/delivery-policy-recorder.ts",
  "home/dot_claude/hooks/cli/delivery-policy.ts",
  "home/dot_local/bin/executable_delivery-policy",
  "home/dot_claude/hooks/implementations/document-workflow-guard.ts",
  "home/dot_claude/hooks/executable_run-guard.sh",
  "home/dot_claude/.settings.permissions.json",
  "home/dot_claude/.settings.hooks.json.tmpl",
  "home/dot_claude/.settings.base.json.tmpl",
  "home/.chezmoiscripts/run_onchange_update-settings-json.sh.tmpl",
  "home/dot_claude/package.json",
  "home/dot_claude/bun.lock",
  "home/.chezmoiscripts/",
  "home/.chezmoiignore",
  "home/.chezmoitemplates/",
  "home/.chezmoiexternal*",
  "mods/",
  // Imported (transitively) by the guard, the recorder or the CLI.
  "home/dot_claude/hooks/lib/ask-user-question-input.ts",
  "home/dot_claude/hooks/lib/bash-parser.ts",
  "home/dot_claude/hooks/lib/command-parsing.ts",
  "home/dot_claude/hooks/lib/context-helpers.ts",
  "home/dot_claude/hooks/lib/deny-input.ts",
  "home/dot_claude/hooks/lib/document-hash.ts",
  "home/dot_claude/hooks/lib/guarded-tools.ts",
  "home/dot_claude/hooks/lib/heredoc-data.ts",
  "home/dot_claude/hooks/lib/linear-match.ts",
  "home/dot_claude/hooks/lib/path-containment.ts",
  "home/dot_claude/hooks/lib/path-utils.ts",
  "home/dot_claude/hooks/lib/project-root.ts",
  "home/dot_claude/hooks/lib/sanitize-display.ts",
  "home/dot_claude/hooks/lib/temp-roots.ts",
  "home/dot_claude/hooks/lib/workflow-approval-record.ts",
  "home/dot_claude/hooks/lib/workflow-approval.ts",
  "home/dot_claude/hooks/lib/workflow-audit-log.ts",
  "home/dot_claude/hooks/lib/workflow-files.ts",
  "home/dot_claude/hooks/lib/workflow-fs.ts",
  "home/dot_claude/hooks/lib/workflow-gate.ts",
  "home/dot_claude/hooks/lib/workflow-marker.ts",
  "home/dot_claude/hooks/lib/workflow-paths.ts",
  "home/dot_claude/hooks/lib/workflow-resolve.ts",
  "home/dot_claude/hooks/types/project-types.ts",
  "home/dot_claude/hooks/types/tool-schemas.ts",
];

function globToRegExp(glob: string): RegExp {
  const escaped = glob
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join("[^/]*");
  return new RegExp(`^${escaped}$`);
}

export function isProtectedPath(path: string): boolean {
  return PROTECTED_PATHS.some((entry) => {
    if (entry.endsWith("/")) return path.startsWith(entry);
    if (entry.includes("*")) return globToRegExp(entry).test(path);
    return path === entry;
  });
}

// --- guarded home paths ----------------------------------------------------

/**
 * Paths under the passwd home that an agent may not write: the ledger, the
 * code that decides, and the config the wrapper's bun and the CLI read even
 * with a pinned cwd and env (global bunfig, mise, bare-package resolution).
 * A trailing "/" means everything below it. The guard and the permissions deny
 * list both derive from this one list.
 */
export const GUARDED_HOME_PATHS: readonly string[] = [
  ".claude/state/delivery-policy/",
  ".claude/hooks/",
  ".local/bin/delivery-policy",
  ".claude/settings.json",
  ".bunfig.toml",
  ".config/.bunfig.toml",
  ".config/mise/",
  ".local/share/mise/",
  ".claude/node_modules/",
  "node_modules/",
  ".claude/package.json",
  ".claude/tsconfig.json",
];

// Edit(...) alone covers Write: Claude Code never consults Write(...) rules
// (see permission-rule-names.ts) and warns about them at startup.
export function guardedHomeDenyRules(): string[] {
  return GUARDED_HOME_PATHS.map((path) => {
    const pattern = path.endsWith("/") ? `~/${path}**` : `~/${path}`;
    return `Edit(${pattern})`;
  });
}

const LEDGER_DIR_MARK = ".claude/state/delivery-policy";
const WRAPPER_MARK = ".local/bin/delivery-policy";
const SHELL_METACHARACTERS = /[;&|><`\n\r]|\$\(/;

/**
 * Why a Bash command must be refused because it names the ledger or the
 * wrapper, or null. Only the exact forms `<wrapper> show`, `<wrapper> ask`
 * and `<wrapper> merge <N>` pass: the allow rule for the wrapper skips the
 * permission classifier, so anything else that reaches it is stopped here.
 */
export function namesDeliveryPolicyPath(command: string): boolean {
  return command.includes(LEDGER_DIR_MARK) || command.includes(WRAPPER_MARK);
}

export function judgeDeliveryPolicyBash(
  command: string,
  home: string,
): string | null {
  if (!command.includes(LEDGER_DIR_MARK) && !command.includes(WRAPPER_MARK)) {
    return null;
  }
  const trimmed = command.trim();
  if (!SHELL_METACHARACTERS.test(trimmed)) {
    for (const wrapper of [`~/${WRAPPER_MARK}`, `${home}/${WRAPPER_MARK}`]) {
      const rest = trimmed.startsWith(`${wrapper} `)
        ? trimmed.slice(wrapper.length + 1)
        : null;
      if (
        rest === "show" ||
        rest === "ask" ||
        /^merge [1-9][0-9]*$/.test(rest ?? "")
      ) {
        return null;
      }
    }
  }
  return "The delivery-policy ledger and wrapper are changed only by the user's answers and by chezmoi. A command that names them is allowed only as exactly `~/.local/bin/delivery-policy show`, `ask` or `merge <PR number>`, with no redirection, chaining or extra arguments.";
}

// --- merge decision --------------------------------------------------------

export interface PrInfo {
  state: string;
  /** Lowercased login. */
  author: string;
  /** Lowercased nameWithOwner. */
  baseRepository: string;
  baseRefName: string;
  headRefName: string;
  isCrossRepository: boolean;
  changedFiles: number;
  mergeStateStatus: string;
}

export interface ChangedFile {
  path: string;
  previousPath?: string;
}

export interface MergeState {
  ledger: Ledger;
  repo: RepoInfo;
  /** Lowercased login of `gh api user`. */
  viewer: string;
  pr: PrInfo;
  files: readonly ChangedFile[];
  requiredContexts: readonly RequiredContext[];
  checkRuns: readonly CheckRun[];
}

export type StopCode = 20 | 30 | 40;

export type MergeDecision =
  | { kind: "merge" }
  | { kind: "wait"; reason: string }
  | { kind: "stop"; code: StopCode; reason: string };

function stop(code: StopCode, reason: string): MergeDecision {
  return { kind: "stop", code, reason };
}

/** Rows 1 and 2 of the table, usable before any GitHub state is fetched. */
export function decideLedger(
  ledger: Ledger,
  repo: Pick<RepoInfo, "nameWithOwner">,
): MergeDecision {
  if (ledger.readError !== undefined) {
    return stop(40, `ledger cannot be read (${ledger.readError})`);
  }
  if (ledger.invalid.length > 0) {
    return stop(40, "ledger has invalid lines");
  }
  const scope = ledger.latest.get(repo.nameWithOwner)?.scope;
  if (scope !== "merge") {
    return stop(20, `scope is ${scope ?? "unrecorded"}, not merge`);
  }
  return { kind: "merge" };
}

/**
 * The order of the checks is the contract: the first row that applies is the
 * answer (a failure is reported before waiting for a pending check, a
 * protected path before either).
 */
export function decideMerge(state: MergeState): MergeDecision {
  const { repo, pr, viewer } = state;
  const ledgerDecision = decideLedger(state.ledger, repo);
  if (ledgerDecision.kind !== "merge") return ledgerDecision;

  if (viewer.toLowerCase() !== repo.ownerLogin) {
    return stop(30, "viewer is not the repo owner");
  }
  if (repo.isInOrganization) return stop(30, "repo belongs to an organization");
  if (pr.author !== viewer.toLowerCase()) {
    return stop(30, "PR author is not the viewer");
  }
  if (pr.state !== "OPEN") return stop(30, `PR state is ${pr.state}`);
  if (pr.baseRepository !== repo.nameWithOwner) {
    return stop(30, `PR base repository is ${pr.baseRepository}`);
  }
  if (pr.baseRefName !== repo.defaultBranch) {
    return stop(30, `PR base is ${pr.baseRefName}, not the default branch`);
  }
  if (pr.headRefName === repo.defaultBranch) {
    return stop(30, "PR head is the default branch");
  }
  if (pr.isCrossRepository) return stop(30, "PR comes from a fork");

  for (const file of state.files) {
    for (const path of [file.path, file.previousPath]) {
      if (path !== undefined && isProtectedPath(path)) {
        return stop(30, `PR touches protected path ${path}`);
      }
    }
  }

  if (state.requiredContexts.length === 0) {
    return stop(30, "no required checks are configured");
  }
  const outcomes = state.requiredContexts.map((required) => ({
    required,
    outcome: outcomeOfContext(required, state.checkRuns),
  }));
  const failed = outcomes.find((o) => o.outcome === "fail");
  if (failed)
    return stop(30, `required check ${failed.required.context} failed`);
  const pending = outcomes.find((o) => o.outcome === "pending");
  if (pending) {
    return {
      kind: "wait",
      reason: `required check ${pending.required.context} is not finished`,
    };
  }

  if (pr.mergeStateStatus === "UNKNOWN") {
    return { kind: "wait", reason: "mergeStateStatus is UNKNOWN" };
  }
  if (pr.mergeStateStatus !== "CLEAN") {
    return stop(30, `mergeStateStatus is ${pr.mergeStateStatus}`);
  }
  return { kind: "merge" };
}
