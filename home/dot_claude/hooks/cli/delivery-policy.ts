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
  waitsPath,
} from "../lib/delivery-policy.ts";

const WAIT_INTERVAL_MS = 15_000;
const PER_CALL_TIMEOUT_MS = 10_000;
// The Bash tool's default timeout is 2 minutes and a timeout prints neither a
// code nor a reason, so one call waits well inside that.
const CALL_WAIT_LIMIT_MS = 100_000;
// How long one (repo, PR, head sha) may keep asking to be run again.
const TOTAL_WAIT_BUDGET_MS = 20 * 60_000;
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
  sleep: (ms: number) => Promise<void>;
  out: (text: string) => void;
  err: (text: string) => void;
}

class FetchError extends Error {}
class DeadlineError extends Error {}

type Parsed =
  | { kind: "show" }
  | { kind: "ask" }
  | { kind: "merge"; pr: number }
  | { kind: "usage" };

function parseArgs(args: readonly string[]): Parsed {
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
  "query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){headRefOid}}}";
const CHECKS_QUERY =
  "query($owner:String!,$name:String!,$sha:GitObjectID!){repository(owner:$owner,name:$name){object(oid:$sha){... on Commit{checkSuites(first:100){nodes{app{databaseId} checkRuns(first:100){nodes{name status conclusion}}}}}}}}";

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

async function readHeadSha(
  gh: Gh,
  repo: RepoInfo,
  pr: number,
): Promise<string> {
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
  return sha;
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

async function readCheckRuns(
  gh: Gh,
  repo: RepoInfo,
  sha: string,
): Promise<CheckRun[]> {
  const data = await ghGraphql(
    gh,
    CHECKS_QUERY,
    { ...splitRepo(repo), sha },
    "reading the check runs",
  );
  const suites = dig(data, "repository", "object", "checkSuites", "nodes");
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
  return runs;
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

/** The time this key first waited, recorded now when it is new. Future times count as now. */
function firstWaitMs(home: string, key: string, nowMs: number): number {
  const entries = readWaitEntries(home);
  const recorded = key in entries ? Date.parse(entries[key] ?? "") : Number.NaN;
  if (!Number.isNaN(recorded)) return Math.min(recorded, nowMs);
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

async function runMerge(
  deps: DeliveryPolicyCliDeps,
  prNumber: number,
): Promise<number> {
  const say = (line: string) => deps.out(`${line}\n`);
  const finish = (code: number, reason: string) => {
    say(`delivery-policy: ${code}: ${reason}`);
    return code;
  };
  const startedAt = deps.monotonic();
  const deadline = startedAt + CALL_WAIT_LIMIT_MS;
  // Every gh call is bounded by what is left of this call's time, so a slow
  // gh cannot carry one run past the Bash tool's default 2-minute timeout
  // (which would print neither a code nor a reason).
  const gh: Gh = async (args) => {
    const remaining = deadline - deps.monotonic();
    if (remaining <= 0) throw new DeadlineError();
    return deps.gh(args, {
      timeoutMs: Math.min(PER_CALL_TIMEOUT_MS, remaining),
    });
  };
  try {
    const resolved = await resolveRepo(gh);
    if (!resolved.ok) return finish(40, resolved.reason);
    const { repo } = resolved;

    const ledger = readLedger(deps.home);
    const recorded = ledger.latest.get(repo.nameWithOwner);
    if (recorded !== undefined) {
      say(
        `delivery-policy: scope ${recorded.scope} recorded ${formatRecordedDate(recorded.at)}; to change it run ~/.local/bin/delivery-policy ask`,
      );
    }
    const early = decideLedger(ledger, repo);
    if (early.kind === "stop") {
      for (const line of invalidLines(ledger, deps.home)) say(line);
      return finish(early.code, early.reason);
    }

    const viewer = await readViewer(gh);
    let baseSha: string | undefined;
    for (;;) {
      const sha = await readHeadSha(gh, repo, prNumber);
      baseSha ??= sha;
      if (sha !== baseSha) {
        return finish(
          11,
          `head changed from ${baseSha.slice(0, 12)} to ${sha.slice(0, 12)}`,
        );
      }

      const pr = await readPr(gh, repo, prNumber);
      const requiredContexts = await readRequiredContexts(
        gh,
        repo,
        pr.baseRefName,
      );
      const checkRuns = await readCheckRuns(gh, repo, baseSha);
      const files = await readChangedFiles(gh, repo, prNumber, pr.changedFiles);

      const after = await readHeadSha(gh, repo, prNumber);
      if (after !== baseSha) {
        return finish(
          11,
          `head changed from ${baseSha.slice(0, 12)} to ${after.slice(0, 12)}`,
        );
      }

      const state: MergeState = {
        ledger,
        repo,
        viewer,
        pr,
        files,
        requiredContexts,
        checkRuns,
      };
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
        say(
          `delivery-policy: waiting: ${decision.reason} (${Math.round(elapsed / 1000)}s)`,
        );
        await deps.sleep(WAIT_INTERVAL_MS);
        continue;
      }

      // Narrowing the scope while waiting must stop the merge: only the
      // ledger is re-read, everything else stays as judged above.
      const last = decideMerge({ ...state, ledger: readLedger(deps.home) });
      if (last.kind !== "merge") {
        if (last.kind === "stop") return finish(last.code, last.reason);
        return finish(40, last.reason);
      }
      const merged = await gh([
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
        return finish(
          40,
          `gh pr merge failed: ${merged.stderr.trim().slice(0, 200)}`,
        );
      }
      return finish(0, `merged #${prNumber} at ${baseSha.slice(0, 12)}`);
    }
  } catch (error) {
    if (error instanceof DeadlineError) {
      return finish(
        10,
        "time limit of this call reached; run the same command again",
      );
    }
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
    case "usage":
      deps.err(
        "delivery-policy: usage: delivery-policy show | ask | merge <PR number>\n",
      );
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
export function resolveCliDeps(argv: readonly string[]): ResolvedCliDeps {
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
  const home = passwdHome();
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
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      out: (text) => void process.stdout.write(text),
      err: (text) => void process.stderr.write(text),
    },
  };
}

if (import.meta.main) {
  const resolved = resolveCliDeps(process.argv.slice(2));
  if (!resolved.ok) {
    process.stderr.write(`delivery-policy: ${resolved.error}\n`);
    process.exitCode = resolved.exitCode;
  } else {
    // Not process.exit(): see docs/decisions/0002 (no-process-exit under hooks/).
    process.exitCode = await runDeliveryPolicyCli(resolved.args, resolved.deps);
  }
}
