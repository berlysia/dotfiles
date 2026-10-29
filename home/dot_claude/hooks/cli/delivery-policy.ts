#!/usr/bin/env -S bun run --silent

/**
 * delivery-policy: `show` the recorded scope, print the `ask` question, or
 * `merge <PR>` when the ledger and GitHub's state allow it.
 *
 * Started through the bin wrapper, which pins the cwd, the environment and
 * PATH because the allow rule for the wrapper skips the permission
 * classifier. Everything an agent could steer lives outside this file: the
 * ledger and `waits.json` sit under the passwd home (never HOME), and `--cwd`
 * only chooses the directory gh resolves the repo from.
 *
 * Exit codes are the contract: 0 merged / ok, 2 bad arguments, 10 still
 * pending (run again), 11 head changed while waiting, 12 wait budget used up,
 * 20 scope is not merge, 30 a condition is not met, 40 gh failed or the state
 * cannot be read.
 */

import {
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import {
  buildDeliveryPolicyQuestion,
  type ChangedFile,
  type CheckRun,
  createGh,
  decideLedger,
  decideMerge,
  type Gh,
  ledgerDir,
  ledgerPath,
  passwdHome,
  type Ledger,
  mergeRequiredContexts,
  type MergeState,
  type PrInfo,
  readLedger,
  type RepoInfo,
  type RequiredContext,
  resolveRepo,
  type StatusContext,
  waitsPath,
} from "../lib/delivery-policy.ts";

const WAIT_INTERVAL_MS = 15_000;
const PER_CALL_TIMEOUT_MS = 10_000;
// How long one (repo, PR, head sha) may keep asking to be run again.
const TOTAL_WAIT_BUDGET_MS = 20 * 60_000;
// The deadline runs from the start of the call and the budget from the first
// wait, so the setup before that wait (repo, viewer, first reads: about 80 s
// of gh at worst) plus one 15 s wait and one round of reads (about 60 s) must
// fit in the margin, or exit 10 would come before exit 12 for a new head.
// 3 minutes covers the 155 s worst case; 2 minutes does not.
const CALL_WAIT_LIMIT_MS = TOTAL_WAIT_BUDGET_MS + 3 * 60_000;
// Rounds in a row whose reads may fail before the wait gives up with 40.
const MAX_FAILED_ROUNDS = 4;
const WAITS_RETENTION_MS = 24 * 60 * 60_000;
const MAX_FILE_PAGES = 30;
const FILES_PER_PAGE = 100;

export interface DeliveryPolicyCliDeps {
  /** The passwd home. */
  home: string;
  gh: Gh;
  /** Wall clock, ms. */
  now: () => number;
  /** Monotonic clock, ms. */
  monotonic: () => number;
  /** Resolves early, without rejecting, when `signal` aborts. */
  sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  /** Aborted by SIGTERM, SIGINT or SIGHUP; see runCliMain. */
  signal: AbortSignal;
  out: (text: string) => void;
  err: (text: string) => void;
}

class FetchError extends Error {}
class DeadlineError extends Error {}
// Not a FetchError: an interruption is no failed read, and the round's catch
// (FetchError only) must let it through to the exit 10.
class InterruptedError extends Error {}

const INTERRUPTED_REASON = "interrupted; run the same command again";
const DEADLINE_REASON =
  "time limit of this call reached; run the same command again";
const MAX_LINE_CHARS = 500;

/**
 * One output line, safe to be read back as a notification body: control,
 * format and line/paragraph-separator characters (ESC, newlines, U+0085,
 * bidi controls, zero-width characters, Tags) become spaces, so an outside
 * string such as a check name cannot start a fake `delivery-policy: 0:` line
 * or hide instructions. The category is matched instead of a list of
 * characters, and the length is cut so one long name cannot fill the body.
 */
export function sanitizeLine(line: string): string {
  const spaced = line.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, " ");
  const chars = Array.from(spaced);
  return chars.length > MAX_LINE_CHARS
    ? chars.slice(0, MAX_LINE_CHARS).join("")
    : spaced;
}

/**
 * A timer that an abort cuts short. Resolving (not rejecting) on abort keeps
 * the abort a decision of the loop; clearing the timer matters because a
 * pending 15 s timer would keep the process alive after "interrupted".
 */
export function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

type Parsed =
  | { kind: "show" }
  | { kind: "ask" }
  | { kind: "merge"; pr: number }
  | { kind: "help" }
  | { kind: "usage" };

const USAGE_LINE =
  "delivery-policy: usage: delivery-policy show | ask | merge <PR number>\n";

const HELP_TEXT = `usage: delivery-policy show | ask | merge <PR number>

  show               print the recorded delivery scope
  ask                print the scope question to pass to AskUserQuestion
  merge <PR number>  merge the PR once every required check is green

exit codes:
  0   merged / ok
  2   bad arguments
  10  required checks still pending; run the same command again
  11  head changed while waiting; run it once more, no more than once
  12  wait budget used up; hand back to the human
  20  recorded scope is not merge; run ask
  30  a merge condition is not met; hand back to the human
  40  gh failed or the state cannot be read; hand back to the human
`;

/**
 * A lone help flag only. `show --help` stays a bad argument: each command
 * takes a fixed argument count, so a trailing flag is a typo, not a request.
 */
export function isHelpRequest(args: readonly string[]): boolean {
  return args.length === 1 && (args[0] === "--help" || args[0] === "-h");
}

function parseArgs(args: readonly string[]): Parsed {
  if (isHelpRequest(args)) return { kind: "help" };
  if (args.length === 1 && args[0] === "show") return { kind: "show" };
  if (args.length === 1 && args[0] === "ask") return { kind: "ask" };
  if (
    args.length === 2 &&
    args[0] === "merge" &&
    /^[1-9][0-9]*$/.test(args[1] ?? "")
  ) {
    const pr = Number(args[1]);
    if (Number.isSafeInteger(pr)) return { kind: "merge", pr };
  }
  return { kind: "usage" };
}

function formatRecordedDate(at: string): string {
  const time = Date.parse(at);
  return Number.isNaN(time) ? at : new Date(time).toISOString().slice(0, 10);
}

function scopeLine(ledger: Ledger, repo: RepoInfo): string {
  const record = ledger.latest.get(repo.nameWithOwner);
  return record === undefined
    ? "delivery-policy: scope: unrecorded"
    : `delivery-policy: scope: ${record.scope} (${formatRecordedDate(record.at)})`;
}

function invalidLines(ledger: Ledger, home: string): string[] {
  if (ledger.invalid.length === 0 && ledger.readError === undefined) return [];
  const lines = ledger.invalid.map(
    (i) => `delivery-policy: invalid: ${i.line}: ${i.reason}`,
  );
  if (ledger.readError !== undefined) {
    lines.push(`delivery-policy: invalid: read error: ${ledger.readError}`);
  }
  lines.push(
    `delivery-policy: ledger: ${ledgerPath(home)}`,
    "delivery-policy: fix: the user removes the invalid lines by hand (the numbers are physical lines of that file, blank lines counted); an agent does not edit it",
  );
  return lines;
}

// --- GitHub reads ----------------------------------------------------------

const PR_QUERY =
  "query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){state author{login} baseRepository{nameWithOwner} baseRefName headRefName isCrossRepository changedFiles mergeStateStatus}}}";
const SHA_QUERY =
  "query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){headRefOid state}}}";
const CHECKS_QUERY =
  "query($owner:String!,$name:String!,$sha:GitObjectID!){repository(owner:$owner,name:$name){object(oid:$sha){... on Commit{status{contexts{context state creator{__typename}}} checkSuites(first:100){nodes{app{databaseId} checkRuns(first:100){nodes{name status conclusion}}}}}}}}";

function parseJson(text: string, what: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new FetchError(`${what} did not answer JSON`);
  }
}

async function ghJson(gh: Gh, args: string[], what: string): Promise<unknown> {
  const result = await gh(args);
  if (result.status !== 0) {
    throw new FetchError(
      `${what} failed: ${result.stderr.trim().slice(0, 200)}`,
    );
  }
  return parseJson(result.stdout, what);
}

async function ghGraphql(
  gh: Gh,
  query: string,
  variables: Record<string, string | number>,
  what: string,
): Promise<Record<string, unknown>> {
  const args = ["api", "graphql", "-f", `query=${query}`];
  for (const [name, value] of Object.entries(variables)) {
    args.push(typeof value === "number" ? "-F" : "-f", `${name}=${value}`);
  }
  const body = await ghJson(gh, args, what);
  if (typeof body !== "object" || body === null) {
    throw new FetchError(`${what} answered an unexpected shape`);
  }
  const { data, errors } = body as { data?: unknown; errors?: unknown };
  if (errors !== undefined) throw new FetchError(`${what} answered errors`);
  if (typeof data !== "object" || data === null) {
    throw new FetchError(`${what} answered no data`);
  }
  return data as Record<string, unknown>;
}

function splitRepo(repo: RepoInfo): { owner: string; name: string } {
  const [owner = "", name = ""] = repo.nameWithOwner.split("/");
  return { owner, name };
}

function dig(value: unknown, ...path: string[]): unknown {
  let current = value;
  for (const key of path) {
    if (typeof current !== "object" || current === null) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

interface HeadRead {
  sha: string;
  /** Uppercased. */
  state: string;
}

/** Head sha and PR state in one read, so they describe the same moment. */
async function readHead(gh: Gh, repo: RepoInfo, pr: number): Promise<HeadRead> {
  const data = await ghGraphql(
    gh,
    SHA_QUERY,
    { ...splitRepo(repo), number: pr },
    "reading the head sha",
  );
  const sha = dig(data, "repository", "pullRequest", "headRefOid");
  if (typeof sha !== "string" || !/^[0-9a-f]{40}$/.test(sha)) {
    throw new FetchError("the head sha was not a commit id");
  }
  const state = dig(data, "repository", "pullRequest", "state");
  if (typeof state !== "string") {
    throw new FetchError("the PR state was not a string");
  }
  return { sha, state: state.toUpperCase() };
}

async function readViewer(gh: Gh): Promise<string> {
  const user = await ghJson(gh, ["api", "user"], "reading the viewer");
  const login = dig(user, "login");
  if (typeof login !== "string" || login === "") {
    throw new FetchError("the viewer has no login");
  }
  return login.toLowerCase();
}

async function readPr(gh: Gh, repo: RepoInfo, number: number): Promise<PrInfo> {
  const data = await ghGraphql(
    gh,
    PR_QUERY,
    { ...splitRepo(repo), number },
    "reading the PR",
  );
  const pr = dig(data, "repository", "pullRequest");
  const state = dig(pr, "state");
  const author = dig(pr, "author", "login");
  const baseRepository = dig(pr, "baseRepository", "nameWithOwner");
  const baseRefName = dig(pr, "baseRefName");
  const headRefName = dig(pr, "headRefName");
  const isCrossRepository = dig(pr, "isCrossRepository");
  const changedFiles = dig(pr, "changedFiles");
  const mergeStateStatus = dig(pr, "mergeStateStatus");
  if (
    typeof state !== "string" ||
    typeof author !== "string" ||
    typeof baseRepository !== "string" ||
    typeof baseRefName !== "string" ||
    typeof headRefName !== "string" ||
    typeof isCrossRepository !== "boolean" ||
    typeof changedFiles !== "number" ||
    typeof mergeStateStatus !== "string"
  ) {
    throw new FetchError("the PR answered an unexpected shape");
  }
  return {
    state: state.toUpperCase(),
    author: author.toLowerCase(),
    baseRepository: baseRepository.toLowerCase(),
    baseRefName,
    headRefName,
    isCrossRepository,
    changedFiles,
    mergeStateStatus: mergeStateStatus.toUpperCase(),
  };
}

function integrationIdOf(value: unknown): number | undefined {
  return typeof value === "number" && value > 0 ? value : undefined;
}

async function readRequiredContexts(
  gh: Gh,
  repo: RepoInfo,
  base: string,
): Promise<RequiredContext[]> {
  const rules = await ghJson(
    gh,
    ["api", `repos/${repo.nameWithOwner}/rules/branches/${base}`],
    "reading the branch rules",
  );
  if (!Array.isArray(rules)) {
    throw new FetchError("the branch rules answered an unexpected shape");
  }
  const fromRuleset: RequiredContext[] = [];
  for (const rule of rules) {
    if (dig(rule, "type") !== "required_status_checks") continue;
    const checks = dig(rule, "parameters", "required_status_checks");
    if (!Array.isArray(checks)) continue;
    for (const check of checks) {
      const context = dig(check, "context");
      if (typeof context !== "string") continue;
      const integrationId = integrationIdOf(dig(check, "integration_id"));
      fromRuleset.push(
        integrationId === undefined ? { context } : { context, integrationId },
      );
    }
  }

  const classicResult = await gh([
    "api",
    `repos/${repo.nameWithOwner}/branches/${base}/protection/required_status_checks`,
  ]);
  let classic: RequiredContext[] | null = null;
  if (classicResult.status === 0) {
    const body = parseJson(
      classicResult.stdout,
      "reading the branch protection",
    );
    classic = [];
    const pinned = new Set<string>();
    const checks = dig(body, "checks");
    if (Array.isArray(checks)) {
      for (const check of checks) {
        const context = dig(check, "context");
        if (typeof context !== "string") continue;
        pinned.add(context);
        const integrationId = integrationIdOf(dig(check, "app_id"));
        classic.push(
          integrationId === undefined
            ? { context }
            : { context, integrationId },
        );
      }
    }
    const contexts = dig(body, "contexts");
    if (Array.isArray(contexts)) {
      for (const context of contexts) {
        if (typeof context === "string" && !pinned.has(context)) {
          classic.push({ context });
        }
      }
    }
  } else if (
    !/HTTP 404/.test(`${classicResult.stderr}${classicResult.stdout}`)
  ) {
    throw new FetchError(
      `reading the branch protection failed: ${classicResult.stderr.trim().slice(0, 200)}`,
    );
  }
  return mergeRequiredContexts(fromRuleset, classic);
}

interface CommitChecks {
  checkRuns: CheckRun[];
  statusContexts: StatusContext[];
}

/** Check runs and commit statuses of one sha, from a single query so they describe the same commit. */
async function readCommitChecks(
  gh: Gh,
  repo: RepoInfo,
  sha: string,
): Promise<CommitChecks> {
  const data = await ghGraphql(
    gh,
    CHECKS_QUERY,
    { ...splitRepo(repo), sha },
    "reading the check runs",
  );
  const commit = dig(data, "repository", "object");
  const suites = dig(commit, "checkSuites", "nodes");
  if (!Array.isArray(suites)) {
    throw new FetchError("the check runs answered an unexpected shape");
  }
  const runs: CheckRun[] = [];
  for (const suite of suites) {
    const appId = dig(suite, "app", "databaseId");
    const nodes = dig(suite, "checkRuns", "nodes");
    if (!Array.isArray(nodes)) continue;
    for (const node of nodes) {
      const name = dig(node, "name");
      const status = dig(node, "status");
      const conclusion = dig(node, "conclusion");
      if (typeof name !== "string" || typeof status !== "string") {
        throw new FetchError("a check run answered an unexpected shape");
      }
      runs.push({
        name,
        status,
        conclusion: typeof conclusion === "string" ? conclusion : null,
        appId: typeof appId === "number" ? appId : null,
      });
    }
  }

  // A commit with no status at all answers `status: null`; a missing key means
  // the query was not understood, which must not read as "no statuses".
  if (typeof commit !== "object" || commit === null || !("status" in commit)) {
    throw new FetchError("the commit statuses answered an unexpected shape");
  }
  const status = (commit as Record<string, unknown>).status;
  const contexts = status === null ? [] : dig(status, "contexts");
  if (!Array.isArray(contexts)) {
    throw new FetchError("the commit statuses answered an unexpected shape");
  }
  const statusContexts: StatusContext[] = contexts.map((node) => {
    const context = dig(node, "context");
    const state = dig(node, "state");
    if (typeof context !== "string" || typeof state !== "string") {
      throw new FetchError("a commit status answered an unexpected shape");
    }
    // A missing creator only makes this one status uncounted; failing here
    // would stop every merge for the sake of a status nobody requires.
    const creatorType = dig(node, "creator", "__typename");
    return {
      context,
      state,
      creatorType: typeof creatorType === "string" ? creatorType : "",
    };
  });
  return { checkRuns: runs, statusContexts };
}

async function readChangedFiles(
  gh: Gh,
  repo: RepoInfo,
  pr: number,
  expected: number,
): Promise<ChangedFile[]> {
  const files: ChangedFile[] = [];
  for (let page = 1; page <= MAX_FILE_PAGES; page++) {
    const body = await ghJson(
      gh,
      [
        "api",
        `repos/${repo.nameWithOwner}/pulls/${pr}/files?per_page=${FILES_PER_PAGE}&page=${page}`,
      ],
      "reading the changed files",
    );
    if (!Array.isArray(body)) {
      throw new FetchError("the changed files answered an unexpected shape");
    }
    for (const item of body) {
      const path = dig(item, "filename");
      if (typeof path !== "string") {
        throw new FetchError("a changed file answered an unexpected shape");
      }
      const previous = dig(item, "previous_filename");
      files.push(
        typeof previous === "string"
          ? { path, previousPath: previous }
          : { path },
      );
    }
    if (body.length < FILES_PER_PAGE) break;
  }
  if (files.length !== expected) {
    throw new FetchError(
      `read ${files.length} changed files, the PR reports ${expected}`,
    );
  }
  return files;
}

// --- wait budget -----------------------------------------------------------

type WaitEntries = Record<string, string>;

function readWaitEntries(home: string): WaitEntries {
  try {
    const parsed: unknown = JSON.parse(readFileSync(waitsPath(home), "utf-8"));
    const entries = dig(parsed, "entries");
    if (
      dig(parsed, "v") !== 1 ||
      typeof entries !== "object" ||
      entries === null
    ) {
      return {};
    }
    const result: WaitEntries = {};
    for (const [key, value] of Object.entries(entries)) {
      if (typeof value === "string") result[key] = value;
    }
    return result;
  } catch {
    // A missing or broken file only restarts the budget: the wait gets longer,
    // the conditions for merging do not get looser.
    return {};
  }
}

function writeWaitEntries(home: string, entries: WaitEntries): void {
  mkdirSync(ledgerDir(home), { recursive: true, mode: 0o700 });
  const target = waitsPath(home);
  const temp = `${target}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify({ v: 1, entries })}\n`, {
    mode: 0o600,
  });
  renameSync(temp, target);
}

/** The recorded first-wait time of this key, without writing one. Future times count as now. */
function peekFirstWaitMs(
  home: string,
  key: string,
  nowMs: number,
): number | undefined {
  const entries = readWaitEntries(home);
  const recorded = key in entries ? Date.parse(entries[key] ?? "") : Number.NaN;
  return Number.isNaN(recorded) ? undefined : Math.min(recorded, nowMs);
}

/** The time this key first waited, recorded now when it is new. Future times count as now. */
function firstWaitMs(home: string, key: string, nowMs: number): number {
  const entries = readWaitEntries(home);
  const known = peekFirstWaitMs(home, key, nowMs);
  if (known !== undefined) return known;
  const kept: WaitEntries = {};
  for (const [k, value] of Object.entries(entries)) {
    const time = Date.parse(value);
    if (!Number.isNaN(time) && nowMs - time <= WAITS_RETENTION_MS)
      kept[k] = value;
  }
  kept[key] = new Date(nowMs).toISOString();
  writeWaitEntries(home, kept);
  return nowMs;
}

// --- commands --------------------------------------------------------------

async function runShow(deps: DeliveryPolicyCliDeps): Promise<number> {
  const resolved = await resolveRepo(deps.gh);
  if (!resolved.ok) {
    deps.err(`delivery-policy: ${resolved.reason}\n`);
    return 40;
  }
  const ledger = readLedger(deps.home);
  const lines = [
    scopeLine(ledger, resolved.repo),
    ...invalidLines(ledger, deps.home),
  ];
  deps.out(`${lines.join("\n")}\n`);
  return lines.length > 1 ? 40 : 0;
}

async function runAsk(deps: DeliveryPolicyCliDeps): Promise<number> {
  const resolved = await resolveRepo(deps.gh);
  if (!resolved.ok) {
    deps.err(`delivery-policy: ${resolved.reason}\n`);
    return 40;
  }
  const questions = buildDeliveryPolicyQuestion(
    resolved.repo.nameWithOwner,
    resolved.repo.url,
  );
  deps.out(`${JSON.stringify({ questions })}\n`);
  return 0;
}

function alreadyMergedReason(sha: string): string {
  return `already merged at ${sha.slice(0, 12)}; merger not determined`;
}

async function runMerge(
  deps: DeliveryPolicyCliDeps,
  prNumber: number,
): Promise<number> {
  const say = (line: string) => deps.out(`${sanitizeLine(line)}\n`);
  const finish = (code: number, reason: string) => {
    say(`delivery-policy: ${code}: ${reason}`);
    return code;
  };
  const startedAt = deps.monotonic();
  const deadline = startedAt + CALL_WAIT_LIMIT_MS;
  // Every gh call is bounded by what is left of this call's time, so a slow
  // gh cannot carry one run past the deadline with no code and no reason.
  const bounded: Gh = async (args) => {
    // The monotonic clock has fractional milliseconds, and execFile rejects a
    // timeout that is not an integer, so the remaining time is floored here.
    const remaining = Math.floor(deadline - deps.monotonic());
    if (remaining < 1) throw new DeadlineError();
    return deps.gh(args, {
      timeoutMs: Math.min(PER_CALL_TIMEOUT_MS, remaining),
    });
  };
  // Reads stop at an abort. `gh pr merge` uses `bounded` instead: once it is
  // started it is left to finish, because stopping it would leave no way to
  // tell whether the PR was merged.
  const gh: Gh = async (args) => {
    if (deps.signal.aborted) throw new InterruptedError();
    return bounded(args);
  };
  try {
    const resolved = await resolveRepo(gh);
    if (!resolved.ok) return finish(40, resolved.reason);
    const { repo } = resolved;

    // Printed once, from the ledger as it is at the start. Whether the scope
    // still allows a merge is judged every round below.
    const startLedger = readLedger(deps.home);
    const recorded = startLedger.latest.get(repo.nameWithOwner);
    if (recorded !== undefined) {
      say(
        `delivery-policy: scope ${recorded.scope} recorded ${formatRecordedDate(recorded.at)}; to change it run ~/.local/bin/delivery-policy ask`,
      );
    }

    const viewer = await readViewer(gh);
    let baseSha: string | undefined;
    let failedRounds = 0;
    for (;;) {
      let state: MergeState;
      try {
        const head = await readHead(gh, repo, prNumber);
        baseSha ??= head.sha;
        // Before MERGED: a PR merged at another head is not the one this call
        // was asked about, and the caller's rerun then sees the new head.
        if (head.sha !== baseSha) {
          return finish(
            11,
            `head changed from ${baseSha.slice(0, 12)} to ${head.sha.slice(0, 12)}`,
          );
        }
        // Before the ledger: this call merges nothing here, so a scope
        // narrowed after someone else's merge must not turn it into a 20.
        if (head.state === "MERGED") {
          return finish(0, alreadyMergedReason(baseSha));
        }

        // Read again every round: a wait of up to 20 minutes is long enough
        // for the scope to be narrowed, and that must stop the merge at the
        // next round, not after the wait. A read error is not retried; it is
        // the same stop decideLedger gives anywhere else.
        const ledger = readLedger(deps.home);
        const ledgerDecision = decideLedger(ledger, repo);
        if (ledgerDecision.kind === "stop") {
          for (const line of invalidLines(ledger, deps.home)) say(line);
          return finish(ledgerDecision.code, ledgerDecision.reason);
        }

        const pr = await readPr(gh, repo, prNumber);
        const requiredContexts = await readRequiredContexts(
          gh,
          repo,
          pr.baseRefName,
        );
        const { checkRuns, statusContexts } = await readCommitChecks(
          gh,
          repo,
          baseSha,
        );
        const files = await readChangedFiles(
          gh,
          repo,
          prNumber,
          pr.changedFiles,
        );

        const after = await readHead(gh, repo, prNumber);
        if (after.sha !== baseSha) {
          return finish(
            11,
            `head changed from ${baseSha.slice(0, 12)} to ${after.sha.slice(0, 12)}`,
          );
        }

        state = {
          ledger,
          repo,
          viewer,
          pr,
          files,
          requiredContexts,
          checkRuns,
          statusContexts,
        };
      } catch (error) {
        // Every read error is retried a few times without telling its kind:
        // gh's output cannot separate an expired login or a rate limit from a
        // blip. DeadlineError is not a read error and ends the call below.
        if (!(error instanceof FetchError)) throw error;
        failedRounds++;
        // Same order as the wait branch below. The budget is only peeked at:
        // recording a first wait from here would start the 20 minutes before
        // anything waited, and leave a record behind an exit 40.
        if (baseSha !== undefined) {
          const firstWait = peekFirstWaitMs(
            deps.home,
            `${repo.nameWithOwner}#${prNumber}@${baseSha}`,
            deps.now(),
          );
          if (
            firstWait !== undefined &&
            deps.now() - firstWait >= TOTAL_WAIT_BUDGET_MS
          ) {
            return finish(
              12,
              `${error.message}; the wait budget of ${TOTAL_WAIT_BUDGET_MS / 60_000} minutes for this head is used up`,
            );
          }
        }
        // Before the count: a gh cut short by the deadline arrives here as a
        // FetchError, and that is no failed read.
        if (deps.monotonic() + WAIT_INTERVAL_MS >= deadline) {
          return finish(10, `${error.message}; run the same command again`);
        }
        if (failedRounds >= MAX_FAILED_ROUNDS) {
          return finish(40, error.message);
        }
        if (deps.signal.aborted) return finish(10, INTERRUPTED_REASON);
        say(
          `delivery-policy: waiting: transient error (${failedRounds}/${MAX_FAILED_ROUNDS}): ${error.message}`,
        );
        await deps.sleep(WAIT_INTERVAL_MS, deps.signal);
        continue;
      }
      failedRounds = 0;

      const decision = decideMerge(state);
      if (decision.kind === "stop") {
        for (const line of invalidLines(state.ledger, deps.home)) say(line);
        return finish(decision.code, decision.reason);
      }
      if (decision.kind === "wait") {
        const key = `${repo.nameWithOwner}#${prNumber}@${baseSha}`;
        const waited = deps.now() - firstWaitMs(deps.home, key, deps.now());
        if (waited >= TOTAL_WAIT_BUDGET_MS) {
          return finish(
            12,
            `${decision.reason}; the wait budget of ${TOTAL_WAIT_BUDGET_MS / 60_000} minutes for this head is used up`,
          );
        }
        const elapsed = deps.monotonic() - startedAt;
        if (deps.monotonic() + WAIT_INTERVAL_MS >= deadline) {
          return finish(10, `${decision.reason}; run the same command again`);
        }
        if (deps.signal.aborted) return finish(10, INTERRUPTED_REASON);
        say(
          `delivery-policy: waiting: ${decision.reason} (${Math.round(elapsed / 1000)}s)`,
        );
        await deps.sleep(WAIT_INTERVAL_MS, deps.signal);
        continue;
      }

      // Narrowing the scope while waiting must stop the merge: only the
      // ledger is re-read, everything else stays as judged above.
      const last = decideMerge({ ...state, ledger: readLedger(deps.home) });
      if (last.kind !== "merge") {
        if (last.kind === "stop") return finish(last.code, last.reason);
        return finish(40, last.reason);
      }
      // Not enough time left for gh pr merge to finish inside its own timeout:
      // starting it would let the deadline cut it short. No promise that a
      // rerun merges; checks and the ledger are judged again.
      if (deadline - deps.monotonic() < PER_CALL_TIMEOUT_MS) {
        return finish(10, DEADLINE_REASON);
      }
      // Last, to leave the shortest gap between this check and the start.
      if (deps.signal.aborted) return finish(10, INTERRUPTED_REASON);
      const merged = await bounded([
        "pr",
        "merge",
        String(prNumber),
        "-R",
        repo.nameWithOwner,
        "--merge",
        "--match-head-commit",
        baseSha,
      ]);
      if (merged.status !== 0) {
        const failure = `gh pr merge failed: ${merged.stderr.trim().slice(0, 200)}`;
        // A merge that went through can still exit non-zero (timeout, lost
        // connection). Read once more, straight from deps.gh: the deadline
        // wrapper refuses to run when the failure used up the time, which is
        // exactly when this answer is needed.
        let reread: HeadRead;
        try {
          reread = await readHead(
            (args) => deps.gh(args, { timeoutMs: PER_CALL_TIMEOUT_MS }),
            repo,
            prNumber,
          );
        } catch (error) {
          if (!(error instanceof FetchError)) throw error;
          return finish(
            40,
            `${failure}; reading the PR again failed: ${error.message}`,
          );
        }
        if (reread.state === "MERGED" && reread.sha === baseSha) {
          return finish(0, alreadyMergedReason(baseSha));
        }
        if (reread.state === "OPEN" && merged.status === null) {
          // Not 10: "run it again" would be wrong for a PR that may be merged.
          return finish(
            40,
            "gh pr merge timed out and the merge state is unknown; check the PR, then run the command again",
          );
        }
        return finish(40, failure);
      }
      return finish(0, `merged #${prNumber} at ${baseSha.slice(0, 12)}`);
    }
  } catch (error) {
    if (error instanceof InterruptedError) {
      return finish(10, INTERRUPTED_REASON);
    }
    if (error instanceof DeadlineError) return finish(10, DEADLINE_REASON);
    return finish(
      40,
      error instanceof FetchError
        ? error.message
        : `unexpected failure: ${String(error).slice(0, 200)}`,
    );
  }
}

/** Runs one command and returns its exit code; the caller sets `process.exitCode`. */
export async function runDeliveryPolicyCli(
  args: readonly string[],
  deps: DeliveryPolicyCliDeps,
): Promise<number> {
  const parsed = parseArgs(args);
  switch (parsed.kind) {
    case "help":
      deps.out(HELP_TEXT);
      return 0;
    case "usage":
      deps.err(USAGE_LINE);
      return 2;
    case "show":
      return runShow(deps);
    case "ask":
      return runAsk(deps);
    case "merge":
      return runMerge(deps, parsed.pr);
  }
}

export type ResolvedCliDeps =
  | { ok: true; deps: DeliveryPolicyCliDeps; args: string[] }
  | { ok: false; exitCode: 2 | 40; error: string };

/**
 * Called from the entry point only. The wrapper puts `--cwd <dir>` first;
 * the rest is the command, validated by runDeliveryPolicyCli. The home is
 * the passwd entry's, so a changed HOME moves neither the ledger nor the
 * waits file.
 */
export function resolveCliDeps(
  argv: readonly string[],
  signal: AbortSignal = new AbortController().signal,
  homeOverride?: string,
): ResolvedCliDeps {
  if (argv[0] !== "--cwd" || argv[1] === undefined) {
    return {
      ok: false,
      exitCode: 2,
      error: "--cwd <dir> is required (the wrapper passes it)",
    };
  }
  const cwd = argv[1];
  try {
    if (!cwd.startsWith("/") || !statSync(cwd).isDirectory()) {
      return {
        ok: false,
        exitCode: 2,
        error: `--cwd is not an absolute existing directory: ${cwd}`,
      };
    }
  } catch {
    return {
      ok: false,
      exitCode: 2,
      error: `--cwd is not an absolute existing directory: ${cwd}`,
    };
  }
  const home = homeOverride ?? passwdHome();
  if (home === null) {
    return { ok: false, exitCode: 40, error: "cannot determine passwd home" };
  }
  return {
    ok: true,
    args: argv.slice(2),
    deps: {
      home,
      gh: createGh(cwd),
      now: () => Date.now(),
      monotonic: () => performance.now(),
      sleep: abortableSleep,
      signal,
      out: (text) => void process.stdout.write(text),
      err: (text) => void process.stderr.write(text),
    },
  };
}

const INTERRUPT_SIGNALS = ["SIGTERM", "SIGINT", "SIGHUP"] as const;

/**
 * The whole entry: returns the exit code, the caller sets `process.exitCode`.
 * `options.home` exists for the process tests, which need a ledger of their
 * own; the real entry never passes it.
 */
export async function runCliMain(
  argv: readonly string[],
  options: { home?: string } = {},
): Promise<number> {
  // Help is answered before resolveCliDeps so it needs neither --cwd nor a
  // passwd home; the wrapper's `--cwd <dir> --help` reaches the same text
  // through runDeliveryPolicyCli.
  if (isHelpRequest(argv)) {
    process.stdout.write(HELP_TEXT);
    return 0;
  }
  const controller = new AbortController();
  const resolved = resolveCliDeps(argv, controller.signal, options.home);
  if (!resolved.ok) {
    process.stderr.write(`delivery-policy: ${resolved.error}\n`);
    return resolved.exitCode;
  }
  if (resolved.args[0] === "merge") {
    // Registered before the first await, with `on`: a handler replaces the
    // default exit, so a second signal must not bring it back while a gh pr
    // merge is still being waited for. The handler only aborts; the loop
    // decides how to stop (no process.exit, see docs/decisions/0002).
    for (const name of INTERRUPT_SIGNALS) {
      process.on(name, () => controller.abort());
    }
    // A signal can come with the reader of stdout already gone; the final
    // line then has nowhere to go, and EPIPE must not turn exit 10 into a crash.
    process.stdout.on("error", () => {});
  }
  return runDeliveryPolicyCli(resolved.args, resolved.deps);
}

if (import.meta.main) {
  // Not process.exit(): see docs/decisions/0002 (no-process-exit under hooks/).
  process.exitCode = await runCliMain(process.argv.slice(2));
}
