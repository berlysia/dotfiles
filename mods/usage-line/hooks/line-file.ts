// Where the forecast file of one session lives. Both the mod (writer) and
// statusline.ts (reader) derive the path here, so it must import neither
// `node:*` nor `$`: the mod engine and bun both load this module.

type Env = { XDG_RUNTIME_DIR?: string; TMPDIR?: string };

const SESSION_ID = /^[A-Za-z0-9-]{1,128}$/;
// Only the per-user temp directory of macOS. A TMPDIR such as /tmp is shared:
// another user could plant a symlink first, and `$.fs.write` cannot tell.
const MACOS_USER_TMP = "/var/folders/";

function usableDir(value: string | undefined): string | null {
  if (value === undefined || value === "" || !value.startsWith("/"))
    return null;
  if (value.split("/").includes("..")) return null;
  const trimmed = value.replace(/\/+$/, "");
  return trimmed === "" ? null : trimmed;
}

export function lineFilePath(env: Env, sessionId: string): string | null {
  if (!SESSION_ID.test(sessionId)) return null;
  const dir = runtimeDir(env);
  return dir === null ? null : `${dir}/usage-line/${sessionId}.json`;
}

function runtimeDir(env: Env): string | null {
  const runtime = usableDir(env.XDG_RUNTIME_DIR);
  if (runtime !== null) return runtime;
  const tmp = usableDir(env.TMPDIR);
  if (tmp !== null && tmp.startsWith(MACOS_USER_TMP)) return tmp;
  return null;
}

export function externalFilePath(env: Env): string | null {
  const dir = runtimeDir(env);
  return dir === null ? null : `${dir}/usage-line/_external.json`;
}
