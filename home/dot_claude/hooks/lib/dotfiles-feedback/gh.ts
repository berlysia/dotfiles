import { execFile } from "node:child_process";
import { stripInvisible } from "../invisible-chars.ts";
import type { FeedbackError } from "./cache.ts";
import type { FeedbackDeps, GhRunResult } from "./deps.ts";
import {
  parseMarker,
  type MarkerResult,
  type renderIssue,
} from "./issue-body.ts";
import {
  DAY_MS,
  FEEDBACK_LABEL,
  FEEDBACK_LABELS,
  FEEDBACK_OWNER,
  FEEDBACK_KINDS,
  GH_PAGE_SIZE,
  GH_TIMEOUT_MS,
} from "./constants.ts";

export type GhResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: FeedbackError; permanent: boolean; message: string };
export type GhDeps = Pick<FeedbackDeps, "home" | "repo" | "runGh">;
export type FeedbackIssue = {
  number: number;
  state: string;
  body: string;
  user: string;
  marker: MarkerResult;
};
const envKeys = [
  "PATH",
  "LANG",
  "LC_ALL",
  "XDG_CONFIG_HOME",
  "XDG_RUNTIME_DIR",
  "DBUS_SESSION_BUS_ADDRESS",
  "HTTPS_PROXY",
  "NO_PROXY",
] as const;
export function ghEnvironment(
  home: string,
  parent = process.env,
): Record<string, string> {
  const env: Record<string, string> = { HOME: home };
  for (const key of envKeys)
    if (parent[key] !== undefined) env[key] = parent[key];
  return env;
}
export const runGh: FeedbackDeps["runGh"] = (argv, options) =>
  new Promise((resolve) => {
    const child = execFile(
      "gh",
      [...argv],
      {
        env: options.env,
        timeout: options.timeoutMs,
        maxBuffer: 16 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        resolve({
          code: error
            ? typeof error.code === "number"
              ? error.code
              : null
            : 0,
          stdout,
          stderr,
          ...(error && typeof error.code === "string"
            ? { spawnError: error.code }
            : {}),
          timedOut: error?.killed === true,
        });
      },
    );
    child.stdin?.on("error", () => {
      console.error("dotfiles-feedback: gh stdin failed");
    });
    child.stdin?.end(options.stdin);
  });
function failure(result: GhRunResult, creating: boolean): GhResult<never> {
  const error: FeedbackError =
    result.spawnError === "ENOENT"
      ? "gh-missing"
      : result.code === 4 || /authentication|gh auth login/i.test(result.stderr)
        ? "auth"
        : result.timedOut ||
            /could not resolve|connection|timeout|TLS/i.test(result.stderr)
          ? "network"
          : "other";
  return {
    ok: false,
    error,
    permanent: creating && /HTTP 422/.test(result.stderr),
    message: stripInvisible(result.stderr.slice(0, 200), {
      keepNewlines: false,
    }),
  };
}
export function openGh(
  deps: GhDeps,
  timeoutMs: () => number = () => GH_TIMEOUT_MS,
) {
  async function call(
    argv: string[],
    stdin?: string,
    creating = false,
  ): Promise<GhResult<string>> {
    const timeout = Math.min(GH_TIMEOUT_MS, timeoutMs());
    if (timeout <= 0)
      return {
        ok: false,
        error: "network",
        permanent: false,
        message: "deadline exceeded",
      };
    const result = await deps.runGh(argv, {
      ...(stdin === undefined ? {} : { stdin }),
      timeoutMs: timeout,
      env: ghEnvironment(deps.home),
    });
    return result.code === 0 && !result.spawnError && !result.timedOut
      ? { ok: true, value: result.stdout }
      : failure(result, creating);
  }
  const malformed = (): GhResult<never> => ({
    ok: false,
    error: "other",
    permanent: false,
    message: "invalid gh response",
  });
  async function listFeedbackIssues(options: {
    repo: string;
    state: "open" | "closed" | "all";
    since?: string;
    creator: string;
  }): Promise<GhResult<FeedbackIssue[]>> {
    const argv = [
      "api",
      "--method",
      "GET",
      "--paginate",
      `repos/${options.repo}/issues`,
      "-f",
      `state=${options.state}`,
      "-f",
      `labels=${FEEDBACK_LABEL}`,
      "-f",
      `creator=${options.creator}`,
      "-f",
      `per_page=${GH_PAGE_SIZE}`,
    ];
    if (options.since) argv.push("-f", `since=${options.since}`);
    argv.push(
      "--jq",
      ".[] | {number, state, body, user: .user.login, pull_request: (.pull_request != null)}",
    );
    const result = await call(argv);
    if (!result.ok) return result;
    try {
      const issues: FeedbackIssue[] = [];
      for (const line of result.value
        .split("\n")
        .filter((line) => line.trim())) {
        const value = JSON.parse(line) as {
          number: number;
          state: string;
          body: string | null;
          user: string;
          pull_request: boolean;
        };
        if (
          !value ||
          !Number.isSafeInteger(value.number) ||
          value.number <= 0 ||
          typeof value.state !== "string" ||
          !(value.body === null || typeof value.body === "string") ||
          typeof value.user !== "string" ||
          typeof value.pull_request !== "boolean"
        )
          return malformed();
        if (!value.pull_request)
          issues.push({
            number: value.number,
            state: value.state,
            body: value.body ?? "",
            user: value.user,
            marker: parseMarker(value.body ?? ""),
          });
      }
      return { ok: true, value: issues };
    } catch {
      return malformed();
    }
  }
  return {
    async checkDestination(): Promise<GhResult<void>> {
      const user = await call(["api", "--method", "GET", "user"]);
      if (!user.ok) return user;
      const repo = await call([
        "repo",
        "view",
        deps.repo,
        "--json",
        "isPrivate,owner",
      ]);
      if (!repo.ok) return repo;
      try {
        const account = JSON.parse(user.value) as { login: string };
        const destination = JSON.parse(repo.value) as {
          isPrivate: boolean;
          owner: { login: string };
        };
        if (
          account.login !== FEEDBACK_OWNER ||
          destination.isPrivate !== true ||
          destination.owner.login !== FEEDBACK_OWNER
        )
          return {
            ok: false,
            error: "not-private",
            permanent: false,
            message: "destination is not private or owned by the expected user",
          };
        return { ok: true, value: undefined };
      } catch {
        return malformed();
      }
    },
    async ensureLabels(): Promise<GhResult<void>> {
      for (const label of FEEDBACK_LABELS) {
        const result = await call([
          "label",
          "create",
          label,
          "--repo",
          deps.repo,
          "--force",
        ]);
        if (!result.ok) return result;
      }
      return { ok: true, value: undefined };
    },
    listFeedbackIssues,
    async findIssueById(
      id: string,
      createdAt: string,
      now: Date,
    ): Promise<GhResult<FeedbackIssue | null>> {
      const since = new Date(
        Math.min(Date.parse(createdAt), now.getTime()) - DAY_MS,
      ).toISOString();
      const result = await listFeedbackIssues({
        repo: deps.repo,
        state: "all",
        creator: FEEDBACK_OWNER,
        since,
      });
      if (!result.ok) return result;
      return {
        ok: true,
        value:
          result.value.find(
            (issue) =>
              issue.marker.status !== "unreadable" && issue.marker.id === id,
          ) ?? null,
      };
    },
    async createIssue(
      rendered: ReturnType<typeof renderIssue>,
    ): Promise<GhResult<number>> {
      if (
        rendered.labels.some(
          (label) =>
            ![
              FEEDBACK_LABEL,
              ...FEEDBACK_KINDS.map((kind) => `kind:${kind}`),
            ].includes(label),
        )
      )
        return malformed();
      const result = await call(
        [
          "issue",
          "create",
          "--repo",
          deps.repo,
          `--title=${rendered.title}`,
          ...rendered.labels.map((label) => `--label=${label}`),
          "--body-file",
          "-",
        ],
        rendered.body,
        true,
      );
      if (!result.ok) return result;
      const match =
        /^https:\/\/github\.com\/([^\s]+)\/issues\/([1-9]\d*)$/.exec(
          result.value.trim(),
        );
      const number = Number(match?.[2]);
      return match?.[1] === deps.repo && Number.isSafeInteger(number)
        ? { ok: true, value: number }
        : malformed();
    },
  };
}
