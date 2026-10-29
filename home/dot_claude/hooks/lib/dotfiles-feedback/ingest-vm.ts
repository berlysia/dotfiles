import { constants } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { FeedbackDeps, FeedbackFs, FsPath } from "./deps.ts";
import { acquireLock, hasCode } from "./lock.ts";
import {
  decodeVmBytes,
  isMachineName,
  rewriteVmItem,
  vmItemId,
} from "./vm-item.ts";
import { openSpool, PendingFullError, type VmFailedReason } from "./spool.ts";
import {
  INGEST_LOCK_FILE,
  INGEST_LOCK_STALE_MS,
  INGEST_TIME_LIMIT_MS,
  INTAKE_NAME_PATTERN,
  LOCAL_ID_PATTERN,
  MAX_INTAKE_QUARANTINE,
  MAX_VM_FILE_BYTES,
  MAX_VM_INGEST_ITEMS,
  MAX_VM_SCAN_ENTRIES,
  type INGEST_STDERR_REASONS,
  type INGEST_STDOUT_REASONS,
} from "./constants.ts";

export type IngestDeps = Pick<
  FeedbackDeps,
  | "root"
  | "uid"
  | "now"
  | "pid"
  | "randomBytes"
  | "isPidAlive"
  | "getPidStartTime"
  | "spawnFlush"
> & {
  fs: FeedbackFs;
  // 量の上限。unit テストが小さい値で同じ振る舞いを確かめるために差し替える。CLI は渡さない。
  limits?: { scanEntries: number; ingestItems: number };
};
export type IngestStdoutReason = (typeof INGEST_STDOUT_REASONS)[number];
export type IngestStderrReason = (typeof INGEST_STDERR_REASONS)[number];
// stdout と stderr の中身は、固定の語と数だけ。VM が書いた名前と中身は載せない。
export type IngestOutput = { code: 0 | 1; stdout: string; stderr: string };

type Counts = {
  ingested: number;
  failed: number;
  discarded: number;
  kept: number;
};
const ZERO: Counts = { ingested: 0, failed: 0, discarded: 0, kept: 0 };

class UnsafeStateDirError extends Error {}
class InvalidArgumentError extends Error {}

const summary = (counts: Counts, reason?: IngestStdoutReason) =>
  `dotfiles-feedback ingest-vm: ingested=${counts.ingested} failed=${counts.failed} discarded=${counts.discarded} kept=${counts.kept}${reason ? ` reason=${reason}` : ""}\n`;
const failure = (word: IngestStderrReason | string): IngestOutput => ({
  code: 1,
  stdout: "",
  stderr: `dotfiles-feedback: ${word}\n`,
});
const errnoWord = (error: unknown): string => {
  const code =
    error instanceof Error && "code" in error ? String(error.code) : "";
  return /^E[A-Z]+$/.test(code) ? code : "internal";
};
// 置き場の中の名前は UTF-8 とは限らない。latin1 なら 1 バイトが 1 文字になり、不正なバイトが U+FFFD に化けない。
const nameText = (name: Buffer): string => {
  if (!Buffer.isBuffer(name)) throw new Error("internal");
  return name.toString("latin1");
};
const childPath = (parent: Buffer, name: Buffer): Buffer =>
  Buffer.concat([parent, Buffer.from("/"), name]);

export async function ingestVm(
  options: { stateDir: string; machine: string },
  deps: IngestDeps,
): Promise<IngestOutput> {
  try {
    return await run(options, deps);
  } catch (error) {
    if (error instanceof InvalidArgumentError)
      return failure("invalid-argument");
    if (error instanceof UnsafeStateDirError)
      return failure("unsafe-state-dir");
    return failure(errnoWord(error));
  }
}

async function safeDirectory(
  path: string,
  deps: IngestDeps,
  allowGroupRead: boolean,
): Promise<void> {
  const stat = await deps.fs.lstat(path).catch((error: unknown) => {
    if (hasCode(error, "ENOENT")) throw new UnsafeStateDirError();
    throw error;
  });
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    stat.uid !== deps.uid ||
    (stat.mode & (allowGroupRead ? 0o022 : 0o077)) !== 0
  )
    throw new UnsafeStateDirError();
}

async function ensureDirectory(path: string, deps: IngestDeps) {
  try {
    await deps.fs.lstat(path);
  } catch (error) {
    if (!hasCode(error, "ENOENT")) throw error;
    await deps.fs.mkdir(path, { mode: 0o700, recursive: true });
  }
  await safeDirectory(path, deps, false);
}

async function run(
  options: { stateDir: string; machine: string },
  deps: IngestDeps,
): Promise<IngestOutput> {
  const { stateDir, machine } = options;
  const { fs } = deps;
  // 1. 引数
  if (!isMachineName(machine) || !isAbsolute(stateDir))
    throw new InvalidArgumentError();
  await safeDirectory(stateDir, deps, true);
  // 2. lock と期限
  const spool = await openSpool(deps.root, { ...deps, fs });
  const release = await acquireLock(
    join(deps.root, INGEST_LOCK_FILE),
    { staleMs: INGEST_LOCK_STALE_MS },
    deps,
  );
  if (!release) return { code: 0, stdout: summary(ZERO, "busy"), stderr: "" };
  try {
    return await ingestLocked(spool, stateDir, machine, deps);
  } finally {
    await release();
  }
}

async function ingestLocked(
  spool: Awaited<ReturnType<typeof openSpool>>,
  stateDir: string,
  machine: string,
  deps: IngestDeps,
): Promise<IngestOutput> {
  const { fs } = deps;
  const startedAt = deps.now().getTime();
  // 3. 置き場と隔離のディレクトリ
  const intakeRoot = join(stateDir, "intake");
  const intakeMachine = join(intakeRoot, machine);
  const quarantineRoot = join(stateDir, "intake-quarantine");
  const quarantineMachine = join(quarantineRoot, machine);
  for (const path of [
    intakeRoot,
    intakeMachine,
    quarantineRoot,
    quarantineMachine,
  ])
    await ensureDirectory(path, deps);
  const randomHex = () => Buffer.from(deps.randomBytes(8)).toString("hex");

  // 4. 置き場を決める
  const place = await choosePlace(intakeMachine, deps);
  let placePath: Buffer;
  if (place) placePath = place;
  else {
    const target = Buffer.from(join(intakeMachine, randomHex()));
    try {
      await fs.rename(
        join(stateDir, "outbox", machine, "dotfiles-feedback"),
        target,
      );
    } catch (error) {
      if (hasCode(error, "ENOENT"))
        return { code: 0, stdout: summary(ZERO), stderr: "" };
      if (hasCode(error, "EACCES") || hasCode(error, "EPERM"))
        return failure("rename-denied");
      throw error;
    }
    placePath = target;
  }

  // 5. 移したものが実ディレクトリか
  const moved = await fs.lstat(placePath);
  if (!moved.isDirectory() || moved.isSymbolicLink()) {
    await fs.unlink(placePath);
    return {
      code: 0,
      stdout: summary({ ...ZERO, discarded: 1 }),
      stderr: "",
    };
  }

  const counts: Counts = { ...ZERO };
  let reason: IngestStdoutReason | undefined;
  let removed = 0;
  let listed = 0;
  let opened = false;
  // 6. fd で権限を直す。開けない・直せない回は、項目を減らせなかった回として扱う
  try {
    const handle = await fs.open(
      placePath,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    try {
      await handle.chmod(0o700);
      opened = true;
    } finally {
      await handle.close();
    }
  } catch {
    opened = false;
  }

  // 7. 項目の処分
  if (opened) {
    const entries = (await fs.readdirBuffer(placePath)).sort(Buffer.compare);
    listed = entries.length;
    for (const name of entries.slice(
      0,
      deps.limits?.scanEntries ?? MAX_VM_SCAN_ENTRIES,
    )) {
      if (deps.now().getTime() - startedAt >= INGEST_TIME_LIMIT_MS) {
        reason = "timeout";
        break;
      }
      if (counts.ingested >= (deps.limits?.ingestItems ?? MAX_VM_INGEST_ITEMS))
        break;
      try {
        const outcome = await disposeEntry(
          spool,
          machine,
          placePath,
          name,
          counts,
          deps,
        );
        if (outcome === "removed") removed++;
        else if (outcome === "pending-full") {
          reason = "pending-full";
          break;
        }
      } catch (error) {
        // 1 項目の失敗は全体を止めない。その項目は減らせなかったものとして数える。
        if (error instanceof Error && error.message === "internal") throw error;
      }
    }
    counts.kept = Math.min(
      Math.max(listed - removed, 0),
      deps.limits?.scanEntries ?? MAX_VM_SCAN_ENTRIES,
    );
  }

  // 9. 置き場の後始末と隔離
  let quarantinePath: string | undefined;
  let emptied = false;
  if (opened) {
    try {
      await fs.rmdir(placePath);
      emptied = true;
    } catch {
      /* 空でなければ残す。 */
    }
  }
  if (
    !emptied &&
    removed === 0 &&
    reason !== "pending-full" &&
    reason !== "timeout"
  ) {
    if (
      (await fs.readdirBuffer(quarantineMachine)).length >=
      MAX_INTAKE_QUARANTINE
    )
      reason = "quarantine-full";
    else {
      const target = join(quarantineMachine, randomHex());
      try {
        await fs.rename(placePath, target);
        quarantinePath = target;
        reason = "quarantined";
      } catch (error) {
        if (!hasCode(error, "EACCES") && !hasCode(error, "EPERM")) throw error;
        reason = "quarantine-denied";
      }
    }
  }

  // 10. 取り込んだ件があれば送り出しを起動する
  let stderr = "";
  if (counts.ingested > 0 && !(await deps.spawnFlush()))
    stderr = "dotfiles-feedback: flush-spawn-failed\n";
  return {
    code: 0,
    stdout: `${summary(counts, reason)}${quarantinePath ? `quarantined: ${quarantinePath}\n` : ""}`,
    stderr,
  };
}

// intake/<m>/ の先頭 200 項目から、16 桁 hex の実ディレクトリの最初の 1 つを使う。
// ほかの項目は消せるものだけ消す（ここでは再帰しない）。
async function choosePlace(
  intakeMachine: string,
  deps: IngestDeps,
): Promise<Buffer | null> {
  const { fs } = deps;
  const parent = Buffer.from(intakeMachine);
  const names = (await fs.readdirBuffer(parent))
    .sort(Buffer.compare)
    .slice(0, deps.limits?.scanEntries ?? MAX_VM_SCAN_ENTRIES);
  let chosen: Buffer | null = null;
  for (const name of names) {
    const path = childPath(parent, name);
    try {
      const stat = await fs.lstat(path);
      const real = stat.isDirectory() && !stat.isSymbolicLink();
      if (INTAKE_NAME_PATTERN.test(nameText(name)) && real) {
        chosen ??= path;
        continue;
      }
      if (real) await fs.rmdir(path);
      else await fs.unlink(path);
    } catch (error) {
      if (error instanceof Error && error.message === "internal") throw error;
    }
  }
  return chosen;
}

async function removeEntry(
  path: FsPath,
  isDirectory: boolean,
  deps: IngestDeps,
) {
  const { fs } = deps;
  try {
    if (isDirectory) await fs.rmdir(path);
    else await fs.unlink(path);
  } catch (error) {
    if (hasCode(error, "ENOENT")) return;
    // 差し替えで種類が変わった。ディレクトリなら再帰せず rmdir だけを試す。
    if (!isDirectory && (hasCode(error, "EISDIR") || hasCode(error, "EPERM"))) {
      try {
        await fs.rmdir(path);
        return;
      } catch (inner) {
        if (hasCode(inner, "ENOENT")) return;
        throw inner;
      }
    }
    throw error;
  }
}

async function readCapped(path: FsPath, deps: IngestDeps) {
  const handle = await deps.fs.open(
    path,
    constants.O_RDONLY |
      constants.O_NOFOLLOW |
      constants.O_NONBLOCK |
      constants.O_NOCTTY,
  );
  try {
    const stat = await handle.stat();
    if (!stat.isFile())
      return { kind: "not-file" as const, directory: stat.isDirectory() };
    const buffer = Buffer.alloc(MAX_VM_FILE_BYTES + 1);
    let total = 0;
    while (total < buffer.length) {
      const { bytesRead } = await handle.read(
        buffer,
        total,
        buffer.length - total,
        total,
      );
      if (bytesRead === 0) break;
      total += bytesRead;
    }
    return { kind: "bytes" as const, bytes: buffer.subarray(0, total) };
  } finally {
    await handle.close();
  }
}

type Disposal = "removed" | "kept" | "pending-full";

async function disposeEntry(
  spool: Awaited<ReturnType<typeof openSpool>>,
  machine: string,
  place: Buffer,
  name: Buffer,
  counts: Counts,
  deps: IngestDeps,
): Promise<Disposal> {
  const text = nameText(name);
  const path = childPath(place, name);
  // 一覧に出たのに実体を引けない項目は、消えたと数えない。
  const stat = await deps.fs.lstat(path);
  if (text.startsWith(".tmp-") || !stat.isFile()) {
    await removeEntry(path, stat.isDirectory() && !stat.isSymbolicLink(), deps);
    counts.discarded++;
    return "removed";
  }
  let read: Awaited<ReturnType<typeof readCapped>>;
  try {
    read = await readCapped(path, deps);
  } catch (error) {
    // 開けない（symlink への差し替えなど）。写さずに消す。消せなければ例外のまま減らせなかった扱いになる。
    if (error instanceof Error && error.message === "internal") throw error;
    await removeEntry(path, false, deps);
    counts.discarded++;
    return "removed";
  }
  if (read.kind === "not-file") {
    await removeEntry(path, read.directory, deps);
    counts.discarded++;
    return "removed";
  }
  const { bytes } = read;
  const nameOk =
    text.endsWith(".json") && LOCAL_ID_PATTERN.test(text.slice(0, -5));
  const rewritten = nameOk ? rewriteVmItem(bytes, machine, deps.now()) : null;
  if (rewritten?.kind === "ok") {
    if (await spool.hasId(rewritten.item.id)) counts.discarded++;
    else {
      try {
        await spool.writePending(rewritten.item, { origin: "vm" });
      } catch (error) {
        if (error instanceof PendingFullError) return "pending-full";
        throw error;
      }
      counts.ingested++;
    }
  } else {
    await copyToFailed(
      spool,
      machine,
      bytes,
      rewritten?.kind === "unsupported-version"
        ? "unsupported-version"
        : "invalid",
      counts,
      deps,
    );
  }
  await removeEntry(path, false, deps);
  return "removed";
}

async function copyToFailed(
  spool: Awaited<ReturnType<typeof openSpool>>,
  machine: string,
  bytes: Uint8Array,
  reason: VmFailedReason,
  counts: Counts,
  deps: IngestDeps,
) {
  const item = decodeVmBytes(bytes);
  if (item === null) {
    counts.discarded++;
    return;
  }
  const written = await spool.writeVmFailed(
    machine,
    vmItemId(machine, bytes),
    JSON.stringify({ reason, item, at: deps.now().toISOString() }),
    reason,
  );
  if (written === "written") counts.failed++;
  else counts.discarded++;
}
