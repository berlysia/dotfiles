// Shared injection for the sessions tests and the launcher scripts next to
// them: the dir-basic fixture plus dir-basic.inject.json become a
// ListSessionsDeps without touching /proc or git.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  readSessionFiles,
  type SessionFile,
} from "../../lib/sessions/read-session-files.ts";
import type { ListSessionsDeps } from "../../lib/sessions/list-sessions.ts";
import type { RepoIdentity } from "../../lib/sessions/types.ts";

export const FIXTURES = fileURLToPath(
  new URL("../fixtures/sessions/", import.meta.url),
);
export const FIXTURE_DIR = join(FIXTURES, "dir-basic");
export const SELF_PID = 1;

type Inject = {
  liveness: Record<string, "alive" | "dead">;
  identifyRepo: Record<string, RepoIdentity>;
};
export const inject = JSON.parse(
  readFileSync(join(FIXTURES, "dir-basic.inject.json"), "utf8"),
) as Inject;

const enoent = () =>
  Object.assign(new Error("ENOENT"), { code: "ENOENT" as const });

/** A /proc/<pid>/stat line whose 22nd field is `procStart`. */
export const statLine = (pid: number, procStart: string): string =>
  `${pid} (x) S ${"0 ".repeat(18)}${procStart} 0`;

export function injectedDeps(overrides: Partial<ListSessionsDeps> = {}): {
  deps: ListSessionsDeps;
  identifyCalls: string[];
} {
  const identifyCalls: string[] = [];
  const deps: ListSessionsDeps = {
    readSessionFiles: (dir) => readSessionFiles(dir),
    readStat: (pid) => {
      if (pid === SELF_PID) return statLine(pid, "1");
      if (inject.liveness[String(pid)] !== "alive") throw enoent();
      const text = readFileSync(join(FIXTURE_DIR, `${pid}.json`), "utf8");
      return statLine(
        pid,
        (JSON.parse(text) as { procStart: string }).procStart,
      );
    },
    selfPid: SELF_PID,
    identifyRepo: async (cwd) => {
      identifyCalls.push(cwd);
      const identity = inject.identifyRepo[cwd];
      if (identity === undefined) throw new Error(`unexpected cwd ${cwd}`);
      return identity;
    },
    setTimer: (callback, ms) => setTimeout(callback, ms),
    clearTimer: (handle) => clearTimeout(handle as NodeJS.Timeout),
    ...overrides,
  };
  return { deps, identifyCalls };
}

/** Builds the text of one sessions json; any field can be replaced. */
export function sessionJson(
  pid: number,
  fields: Record<string, unknown> = {},
): string {
  const n = String(pid).padStart(12, "0");
  return JSON.stringify({
    pid,
    sessionId: `00000000-0000-4000-8000-${n}`,
    cwd: `/w/${pid}`,
    procStart: String(100000 + pid),
    name: `n${pid}`,
    status: "idle",
    ...fields,
  });
}

export const filesResult = (
  files: SessionFile[],
  skippedBeforeContent = 0,
) => ({
  ok: true as const,
  value: {
    files,
    scanned: files.length + skippedBeforeContent,
    skippedBeforeContent,
  },
});

export const fileOf = (pid: number, fields: Record<string, unknown> = {}) => ({
  name: `${pid}.json`,
  pid,
  text: sessionJson(pid, fields),
});
