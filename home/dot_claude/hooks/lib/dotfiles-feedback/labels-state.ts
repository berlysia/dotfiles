import { constants } from "node:fs";
import { join } from "node:path";
import type { FeedbackDeps } from "./deps.ts";
import {
  FEEDBACK_LABELS,
  LABELS_STATE_FILE,
  LABELS_STATE_MAX_BYTES,
  SCHEMA_VERSION,
} from "./constants.ts";
import { atomicWrite } from "./retry.ts";
import { openSpool, type SpoolDeps } from "./spool.ts";

// label を用意できたことの記録。性能のためだけにあり、正しさはこれに頼らない
// （label が無ければ件の作成か付与が失敗し、記録が消えて次の回で用意し直す）。
export type LabelsStateDeps = SpoolDeps & Pick<FeedbackDeps, "root" | "repo">;

const warn = (what: string) =>
  console.error(`dotfiles-feedback: labels state ${what}`);

// `triage #N` は spool を開かないので、state/ の権限の検査を通らない。
// 触れる前に openSpool で検査し、不安全なら例外を捕まえて何もしない。
async function guard(deps: LabelsStateDeps, what: string): Promise<boolean> {
  try {
    await openSpool(deps.root, deps);
    return true;
  } catch {
    warn(`${what} skipped (spool directory check failed)`);
    return false;
  }
}

// 記録が今の repo と label の一覧に一致するときだけ true。読めない・形が違う・不安全は false。
export async function readLabelsState(deps: LabelsStateDeps): Promise<boolean> {
  if (!(await guard(deps, "read"))) return false;
  let handle;
  try {
    handle = await deps.fs.open(
      join(deps.root, LABELS_STATE_FILE),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } catch {
    return false;
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > LABELS_STATE_MAX_BYTES) return false;
    const buffer = Buffer.alloc(LABELS_STATE_MAX_BYTES + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > LABELS_STATE_MAX_BYTES) return false;
    const value = JSON.parse(
      buffer.subarray(0, bytesRead).toString("utf8"),
    ) as {
      v?: unknown;
      repo?: unknown;
      labels?: unknown;
    } | null;
    return (
      !!value &&
      typeof value === "object" &&
      value.v === SCHEMA_VERSION &&
      value.repo === deps.repo &&
      Array.isArray(value.labels) &&
      value.labels.length === FEEDBACK_LABELS.length &&
      value.labels.every(
        (label, index) =>
          typeof label === "string" && label === FEEDBACK_LABELS[index],
      )
    );
  } catch {
    return false;
  } finally {
    await handle.close().catch(() => undefined);
  }
}

export async function writeLabelsState(deps: LabelsStateDeps): Promise<void> {
  if (!(await guard(deps, "write"))) return;
  try {
    await atomicWrite(
      join(deps.root, LABELS_STATE_FILE),
      JSON.stringify({
        v: SCHEMA_VERSION,
        repo: deps.repo,
        labels: [...FEEDBACK_LABELS],
      }),
      deps,
    );
  } catch {
    warn("write failed");
  }
}

// パスそのものを unlink する。symlink ならリンクだけが消え、リンク先は残る。
export async function clearLabelsState(deps: LabelsStateDeps): Promise<void> {
  if (!(await guard(deps, "clear"))) return;
  try {
    await deps.fs.unlink(join(deps.root, LABELS_STATE_FILE));
  } catch (error) {
    if ((error as { code?: string }).code !== "ENOENT") warn("clear failed");
  }
}
