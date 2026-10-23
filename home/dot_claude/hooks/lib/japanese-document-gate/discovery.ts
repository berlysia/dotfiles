import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, extname, resolve } from "node:path";
import { patchTargetPaths } from "../agent-learnings/codex/patch-paths.ts";

const JAPANESE = /[\u3040-\u30ff\u3400-\u9fff]/u;
const TEXT = new Set([".md", ".mdx", ".txt", ".rst", ".html", ".htm"]);
const ARTIFACT = new Set([".docx", ".pdf", ".pptx"]);
const MACHINE_ONLY = new Set(["AGENTS.md", "CLAUDE.md", "SKILL.md"]);

export type Candidates =
  | { ok: true; paths: string[] }
  | { ok: false; reason: string };

export type RunGit = (
  args: string[],
  timeoutMs: number,
) => {
  status: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
};

// Document Workflow artifacts (<root>/.tmp/sessions/<id>/...) are working
// notes for the model, not documents for people. `resolve` does not follow
// symlinks, so a path that reaches a workflow dir through one is still a
// candidate; this exclusion saves effort and is not a security boundary.
export function inWorkflowDir(absolutePath: string): boolean {
  const parts = absolutePath.split("/");
  return parts.some(
    (part, i) => part === ".tmp" && parts[i + 1] === "sessions",
  );
}

export function documentCandidate(file: string): boolean {
  if (
    /(?:^|\/)(?:node_modules|\.git)(?:\/|$)/u.test(file) ||
    MACHINE_ONLY.has(basename(file))
  )
    return false;
  const ext = extname(file).toLowerCase();
  if (!TEXT.has(ext) && !ARTIFACT.has(ext)) return false;
  try {
    if (!existsSync(file) || !statSync(file).isFile()) return false;
    if (ARTIFACT.has(ext)) return true;
    return (
      statSync(file).size > 1024 * 1024 ||
      JAPANESE.test(readFileSync(file, "utf8"))
    );
  } catch {
    // An unreadable file cannot be attributed or checked; skip it.
    return false;
  }
}

// The path is normalised against the hook's cwd before the workflow-dir test.
export function trackableDocument(file: string, cwd: string): boolean {
  const absolute = resolve(cwd, file);
  return !inWorkflowDir(absolute) && documentCandidate(absolute);
}

export const spawnGit: RunGit = (args, timeoutMs) => {
  const result = spawnSync("git", args, {
    encoding: "utf8",
    timeout: timeoutMs,
    killSignal: "SIGKILL",
    maxBuffer: 4 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, LC_ALL: "C" },
  });
  const code = (result.error as NodeJS.ErrnoException | undefined)?.code;
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    timedOut: code === "ETIMEDOUT",
  };
};

// `clock` is injectable so the shared deadline can be tested without waiting.
export function gitDocumentCandidates(
  cwd: string,
  run: RunGit,
  deadlineMs = 1000,
  clock: () => number = () => performance.now(),
): Candidates {
  // Non-repository documents are covered by explicit file tools and track.
  const started = clock();
  const probe = run(
    [
      "--no-optional-locks",
      "-C",
      cwd,
      "-c",
      "core.fsmonitor=",
      "rev-parse",
      "--show-toplevel",
    ],
    deadlineMs,
  );
  if (probe.timedOut) return { ok: false, reason: "timeout" };
  if (probe.status === 128 && probe.stderr.includes("not a git repository"))
    return { ok: true, paths: [] };
  if (probe.status !== 0) return { ok: false, reason: "git" };
  const root = probe.stdout.trim();
  const remaining = deadlineMs - (clock() - started);
  if (remaining <= 0) return { ok: false, reason: "timeout" };
  const listing = run(
    [
      "--no-optional-locks",
      "-C",
      root,
      "-c",
      "core.fsmonitor=",
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=all",
    ],
    Math.ceil(remaining),
  );
  if (listing.timedOut) return { ok: false, reason: "timeout" };
  if (listing.status !== 0) return { ok: false, reason: "git" };
  const rows = listing.stdout.split("\0");
  const paths: string[] = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (!row || row.length < 4) continue;
    const file = resolve(root, row.slice(3));
    if (trackableDocument(file, root)) paths.push(file);
    if (/^[RC]|^ [RC]/u.test(row)) i++;
  }
  return { ok: true, paths };
}

export function fileTargets(
  tool: string,
  input: Record<string, unknown>,
  cwd: string,
): string[] {
  if (tool === "apply_patch" && typeof input.command === "string") {
    return patchTargetPaths(input.command).map((path) => resolve(cwd, path));
  }
  if (["Write", "Edit", "MultiEdit"].includes(tool)) {
    const path = input.file_path ?? input.path;
    return typeof path === "string" ? [resolve(cwd, path)] : [];
  }
  return [];
}
