import { spawnSync } from "node:child_process";

/**
 * A proxy for "what we send is already public": the repository at `cwd` has a
 * github.com origin and GitHub reports it public. It does not look at the
 * brief, and `cwd` is where route was started, not necessarily where the
 * delegated tool runs. Replace this with a per-delegation exposure class when
 * one exists. Any doubt answers false; the origin URL (it may carry
 * credentials) is never returned or printed.
 */

const SPAWN_TIMEOUT_MS = 5000;
const SPAWN_MAX_BUFFER = 64 * 1024;
const NAME_PATTERN = /^[A-Za-z0-9_.-]+$/;
const SCP_PATTERN = /^git@github\.com:(.+)$/;
// Variables that would make `git -C <cwd>` act on some other repository.
const GIT_REPO_VARS = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_COMMON_DIR",
];

type Env = Record<string, string | undefined>;

function ownerAndRepo(path: string): { owner: string; repo: string } | null {
  const parts = path.split("/");
  if (parts.length !== 2) return null;
  const [owner, rawRepo] = parts as [string, string];
  const repo = rawRepo.endsWith(".git") ? rawRepo.slice(0, -4) : rawRepo;
  for (const name of [owner, repo]) {
    if (!NAME_PATTERN.test(name) || name === "." || name === "..") return null;
  }
  return { owner, repo };
}

/** Only github.com over ssh or https; userinfo is allowed and ignored. */
export function parseGithubOrigin(
  url: string,
): { owner: string; repo: string } | null {
  const scp = SCP_PATTERN.exec(url);
  if (scp !== null) return ownerAndRepo(scp[1] as string);
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "ssh:" && parsed.protocol !== "https:") return null;
  if (parsed.hostname !== "github.com") return null;
  if (!parsed.pathname.startsWith("/")) return null;
  return ownerAndRepo(parsed.pathname.slice(1));
}

/** `timeoutMs` is for tests; route always uses the default. */
export function repoIsPublic(
  env: Env,
  cwd: string,
  timeoutMs: number = SPAWN_TIMEOUT_MS,
): boolean {
  const gitEnv: Env = { ...env };
  for (const name of GIT_REPO_VARS) delete gitEnv[name];
  const remote = spawnSync("git", ["-C", cwd, "remote", "get-url", "origin"], {
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: SPAWN_MAX_BUFFER,
    env: gitEnv,
  });
  if (remote.error !== undefined || remote.signal !== null) return false;
  if (remote.status !== 0) return false;
  const origin = parseGithubOrigin(remote.stdout.trim());
  if (origin === null) return false;

  // DELEGATION_GH_BIN lets tests substitute a fake, like DELEGATION_AI_USAGE_BIN.
  const ghEnv: Env = { ...env };
  delete ghEnv.GH_HOST;
  delete ghEnv.GH_REPO;
  ghEnv.GH_PROMPT_DISABLED = "1";
  const gh = spawnSync(
    env.DELEGATION_GH_BIN ?? "gh",
    ["api", `repos/${origin.owner}/${origin.repo}`, "--jq", ".visibility"],
    {
      encoding: "utf8",
      timeout: timeoutMs,
      maxBuffer: SPAWN_MAX_BUFFER,
      env: ghEnv,
    },
  );
  if (gh.error !== undefined || gh.signal !== null) return false;
  if (gh.status !== 0) return false;
  return gh.stdout.trim() === "public";
}
