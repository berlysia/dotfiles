import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, extname, resolve } from "node:path";
import { patchTargetPaths } from "../agent-learnings/codex/patch-paths.ts";

const JAPANESE = /[\u3040-\u30ff\u3400-\u9fff]/u;
const TEXT = new Set([".md", ".mdx", ".txt", ".rst", ".html", ".htm"]);
const ARTIFACT = new Set([".docx", ".pdf", ".pptx"]);
const MACHINE_ONLY = new Set(["AGENTS.md", "CLAUDE.md", "SKILL.md"]);

export function documentCandidate(file: string): boolean {
  if (
    /(?:^|\/)(?:node_modules|\.git)(?:\/|$)/u.test(file) ||
    MACHINE_ONLY.has(basename(file))
  )
    return false;
  const ext = extname(file).toLowerCase();
  if (!TEXT.has(ext) && !ARTIFACT.has(ext)) return false;
  if (!existsSync(file) || !statSync(file).isFile()) return false;
  if (ARTIFACT.has(ext)) return true;
  return (
    statSync(file).size > 1024 * 1024 ||
    JAPANESE.test(readFileSync(file, "utf8"))
  );
}

export function gitDocumentCandidates(cwd: string): string[] {
  // Non-repository documents are covered by explicit file tools and track.
  const probe = execFileSync(
    "git",
    ["-C", cwd, "rev-parse", "--show-toplevel"],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 2000 },
  ).trim();
  const rows = execFileSync(
    "git",
    ["-C", probe, "status", "--porcelain=v1", "-z", "--untracked-files=all"],
    { encoding: "utf8", maxBuffer: 4 * 1024 * 1024, timeout: 3000 },
  ).split("\0");
  const files: string[] = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (!row || row.length < 4) continue;
    const file = resolve(probe, row.slice(3));
    if (documentCandidate(file)) files.push(file);
    if (/^[RC]|^ [RC]/u.test(row)) i++;
  }
  return files;
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
