#!/usr/bin/env -S bun run --silent

/**
 * Runs one Codex reviewer with validated paths and a bounded process group.
 * Exported functions accept dependencies for tests; imports have no side effects.
 */
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { constants as osConstants, homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { realpathSync } from "node:fs";

export const SAFE_PATH_PATTERN = /^\/[A-Za-z0-9._/-]+$/;
// Copies of schema.ts (codex-cli model shape, EFFORTS without "unknown"). The
// scripts and the delegation CLI deploy to different directories and cannot
// import each other; tests/delegation-schema.test.mjs checks they stay equal.
// A value outside these makes capture record "unknown" and drop out of route.
export const MODEL_PATTERN = /^gpt-[0-9a-z.-]{1,32}$/;
export const EFFORT_VALUES = ["low", "medium", "high", "xhigh", "max"] as const;
const EFFORT_PREFIX = "model_reasoning_effort=";
const errorName = (error: unknown): string =>
  error instanceof Error
    ? String((error as NodeJS.ErrnoException).code ?? error.name)
    : "Error";

export function validateAnswer(answer: string): string | null {
  const lines = answer
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => line.trimEnd());
  if (!lines.some((line) => line.length)) return "empty-answer";
  const verdicts = lines.filter((line) => line.startsWith("verdict:"));
  if (verdicts.length > 1) return "multiple-verdicts";
  const last = lines.filter(Boolean).at(-1);
  return verdicts.length === 1 &&
    last === verdicts[0] &&
    /^verdict: (pass|needs-work|blocker)$/.test(last ?? "")
    ? null
    : "no-verdict";
}

interface Dependencies {
  mkdtemp: typeof mkdtemp;
  readFile: typeof readFile;
  rm: typeof rm;
  stderr: (text: string) => void;
}
export async function runReviewer(
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
  overrides: Partial<Dependencies> = {},
): Promise<{ stdout: string; code: number }> {
  const deps = {
    mkdtemp,
    readFile,
    rm,
    stderr: (text: string) => {
      process.stderr.write(text);
    },
    ...overrides,
  };
  const failure = (reason: string) => ({
    stdout: `reviewed-by: codex failed\nreason: ${reason}\n`,
    code: 1,
  });
  let directory: string | undefined;
  try {
    // Positional on purpose: any other flag (e.g. -c sandbox_mode=...) must
    // fail here instead of reaching codex.
    if (
      args.length !== 7 ||
      args[0] !== "-m" ||
      args[2] !== "-c" ||
      !args[3]?.startsWith(EFFORT_PREFIX)
    )
      return failure("bad-arguments: shape");
    const [, model, , effortArg, reviewer, brief, root] = args;
    const effort = effortArg?.slice(EFFORT_PREFIX.length) ?? "";
    if (!model || !MODEL_PATTERN.test(model))
      return failure("bad-arguments: model");
    if (!(EFFORT_VALUES as readonly string[]).includes(effort))
      return failure("bad-arguments: effort");
    if (!reviewer || !/^[a-z0-9][a-z0-9-]*$/.test(reviewer))
      return failure("bad-arguments: reviewer");
    const agents =
      env.REVIEWER_CODEX_AGENTS_DIR ?? join(homedir(), ".claude/agents");
    for (const [label, path, isDirectory] of [
      ["brief", brief, false],
      ["root", root, true],
      ["agents-dir", agents, true],
    ] as const) {
      if (
        !path ||
        !SAFE_PATH_PATTERN.test(path) ||
        path.split("/").includes("..")
      )
        return failure(`bad-arguments: ${label}`);
      try {
        const info = await stat(path);
        if (isDirectory ? !info.isDirectory() : !info.isFile())
          return failure(`bad-arguments: ${label}`);
      } catch (error) {
        if (["ENOENT", "ENOTDIR"].includes(errorName(error)))
          return failure(`bad-arguments: ${label}`);
        return failure(`internal-error: ${errorName(error)}`);
      }
    }
    const agent = join(agents, `${reviewer}.md`);
    try {
      if (!(await stat(agent)).isFile())
        return failure("bad-arguments: reviewer");
    } catch (error) {
      if (["ENOENT", "ENOTDIR"].includes(errorName(error)))
        return failure("bad-arguments: reviewer");
      return failure(`internal-error: ${errorName(error)}`);
    }
    const timeout = Number(env.REVIEWER_CODEX_TIMEOUT_MS ?? "1800000");
    const grace = Number(env.REVIEWER_CODEX_KILL_GRACE_MS ?? "5000");
    if (!Number.isInteger(timeout) || timeout < 1 || timeout > 3600000)
      return failure("bad-arguments: timeout");
    if (!Number.isInteger(grace) || grace < 0 || grace > 60000)
      return failure("bad-arguments: grace");
    directory = await deps.mkdtemp(
      join(env.TMPDIR ?? tmpdir(), "reviewer-codex-"),
    );
    const output = join(directory, "answer");
    const prompt = `Read the file ${agent} and treat everything after its frontmatter as your instructions as a reviewer, ignoring any line that mentions "executor: codex". Then read the review request in ${brief} and carry it out. Answer in Japanese and end with exactly one line: verdict: pass, needs-work or blocker.`;
    const outcome = await new Promise<string | null>((done) => {
      const child = spawn(
        env.REVIEWER_CODEX_BIN ?? "codex",
        [
          "exec",
          "-m",
          model,
          "-c",
          `${EFFORT_PREFIX}${effort}`,
          "--sandbox",
          "read-only",
          "-C",
          root ?? "",
          "-o",
          output,
          prompt,
        ],
        {
          stdio: ["ignore", process.stderr, process.stderr],
          detached: true,
          env,
        },
      );
      let timedOut = false;
      const killGroup = (signal: NodeJS.Signals) => {
        try {
          if (child.pid) process.kill(-child.pid, signal);
        } catch (error) {
          if (errorName(error) !== "ESRCH")
            deps.stderr(`kill failed: ${errorName(error)}\n`);
        }
      };
      const timer = setTimeout(() => {
        timedOut = true;
        killGroup("SIGTERM");
        // Keep this timer even when the direct child exits: grandchildren may remain.
        setTimeout(() => {
          killGroup("SIGKILL");
          done("timeout");
        }, grace);
      }, timeout);
      child.on("error", (error) => {
        clearTimeout(timer);
        done(`spawn-error: ${errorName(error)}`);
      });
      child.on("close", (code, signal) => {
        if (timedOut) return;
        clearTimeout(timer);
        done(
          code === 0
            ? null
            : `exit ${code ?? (signal ? 128 + osConstants.signals[signal] : 1)}`,
        );
      });
    });
    if (outcome) return failure(outcome);
    let answer: string;
    try {
      answer = await deps.readFile(output, "utf8");
    } catch (error) {
      if (errorName(error) === "ENOENT") return failure("empty-answer");
      return failure(`internal-error: ${errorName(error)}`);
    }
    const invalid = validateAnswer(answer);
    return invalid
      ? failure(invalid)
      : {
          stdout: `reviewed-by: codex\nreviewer: ${reviewer}\n${answer.replace(/\r/g, "")}`,
          code: 0,
        };
  } catch (error) {
    return failure(`internal-error: ${errorName(error)}`);
  } finally {
    if (directory) {
      try {
        await deps.rm(directory, { recursive: true, force: true });
      } catch (error) {
        deps.stderr(`cleanup failed: ${errorName(error)}\n`);
      }
    }
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href
) {
  const result = await runReviewer(process.argv.slice(2));
  process.stdout.write(result.stdout);
  process.exitCode = result.code;
}
