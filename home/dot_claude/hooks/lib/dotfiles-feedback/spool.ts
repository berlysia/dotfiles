import { constants } from "node:fs";
import { join } from "node:path";
import type { FeedbackDeps, FeedbackFs } from "./deps.ts";
import { isFeedbackId, parseItem, type FeedbackItemV1 } from "./item.ts";
import { hasCode, unlinkIfPresent } from "./lock.ts";
import { atomicWrite, openRetry, type RetryDeps } from "./retry.ts";
import {
  CACHE_TEMP_RANDOM_BYTES,
  CLAIM_STALE_MS,
  DAY_MS,
  FAILED_RETENTION_MS,
  MACHINE_NAME_PATTERN,
  MAX_SENT_LINES,
  MAX_HELD,
  MAX_PENDING_PER_ORIGIN,
  MAX_VM_FAILED_ITEMS,
  MAX_VM_UNSUPPORTED_ITEMS,
  SCHEMA_VERSION,
  VM_ID_PATTERN,
} from "./constants.ts";

export type SpoolDeps = Omit<RetryDeps, "fs"> &
  Pick<FeedbackDeps, "uid"> & {
    fs: Pick<
      FeedbackFs,
      | "open"
      | "readFile"
      | "rename"
      | "link"
      | "unlink"
      | "lstat"
      | "mkdir"
      | "readdir"
      | "rmdir"
      | "utimes"
    >;
  };
export type ClaimedItem = { id: string; nonce: string };
export type VmFailedReason = "invalid" | "unsupported-version";
export type VmFailedWrite = "written" | "exists" | "full";
export type VmFailedFound = { machine: string; path: string; text: string };

// VM の分の pending/ が枠に満ちている。呼び出し側が文言ではなく型で見分ける。
export class PendingFullError extends Error {
  constructor() {
    super("dotfiles-feedback: pending full");
    this.name = "PendingFullError";
  }
}
export type LocalPlace = "pending" | "sending" | "held" | "failed";
export type LocalEntry = {
  id: string;
  place: LocalPlace;
  title: string | null;
  reason?: string;
  daysUntilDeleted?: number;
};
// flush.lock の解放関数。掃除は flush と並べないので、持っている印として受ける。
// 偽の関数を渡せば呼べるため、lock を持つ証明ではなく呼び出し側の取り違えを防ぐ補助である。
export type FlushLockHeld = () => Promise<void>;

export async function openSpool(root: string, deps: SpoolDeps) {
  const { fs } = deps;
  const directories = [
    root,
    ...["pending", "held", "sending", "failed", "state"].map((name) =>
      join(root, name),
    ),
  ];
  async function safeDirectory(path: string): Promise<boolean> {
    try {
      const stat = await fs.lstat(path);
      if (
        !stat.isDirectory() ||
        stat.isSymbolicLink() ||
        stat.uid !== deps.uid ||
        (stat.mode & 0o077) !== 0
      )
        throw new Error("dotfiles-feedback: unsafe spool directory");
      return true;
    } catch (error) {
      if (hasCode(error, "ENOENT")) return false;
      console.error("dotfiles-feedback: directory validation failed");
      throw error;
    }
  }
  // Validate every existing directory before creating any missing directory.
  const missing: string[] = [];
  for (const path of directories)
    if (!(await safeDirectory(path))) missing.push(path);
  if (!missing.includes(join(root, "failed"))) {
    for (const name of await fs.readdir(join(root, "failed"))) {
      if (name.startsWith("vm-"))
        await safeDirectory(join(root, "failed", name));
    }
  }
  for (const path of missing) {
    await fs.mkdir(path, { mode: 0o700, recursive: true });
    await safeDirectory(path);
  }
  const retry = openRetry(root, deps);
  const nonce = () =>
    Buffer.from(deps.randomBytes(CACHE_TEMP_RANDOM_BYTES)).toString("hex");
  const check = (id: string) => {
    if (!isFeedbackId(id)) throw new Error("dotfiles-feedback: invalid id");
  };
  const itemPath = (dir: string, id: string) => {
    check(id);
    return join(root, dir, `${id}.json`);
  };
  const claimPath = (claimed: ClaimedItem) => {
    check(claimed.id);
    if (!/^[0-9a-f]+$/.test(claimed.nonce))
      throw new Error("dotfiles-feedback: invalid nonce");
    return join(root, "sending", `${claimed.id}.${claimed.nonce}.json`);
  };
  const filenameId = (name: string) => {
    const id = name.endsWith(".json") ? name.slice(0, -5) : "";
    return isFeedbackId(id) ? id : null;
  };
  const claimedName = (name: string): ClaimedItem | null => {
    const match = /^(.*)\.([0-9a-f]+)\.json$/.exec(name);
    return match && isFeedbackId(match[1] ?? "")
      ? { id: match[1]!, nonce: match[2]! }
      : null;
  };
  async function exists(path: string) {
    try {
      await fs.lstat(path);
      return true;
    } catch (error) {
      if (hasCode(error, "ENOENT")) return false;
      console.error("dotfiles-feedback: stat failed");
      throw error;
    }
  }
  async function move(from: string, to: string, id: string) {
    await fs.rename(from, to);
    await retry.reset(id);
  }
  async function fail(from: string, id: string, reason: string) {
    const item = await fs.readFile(from, "utf8");
    await atomicWrite(
      itemPath("failed", id),
      JSON.stringify({ reason, item }),
      deps,
    );
    await unlinkIfPresent(from, fs);
    await retry.reset(id);
  }
  async function heldCount() {
    return (await fs.readdir(join(root, "held"))).filter(
      (name) => filenameId(name) !== null,
    ).length;
  }
  // failed/ 直下と failed/vm-*/ の件を、(場所の相対パス, id) で列挙する。
  async function failedFiles(): Promise<
    { path: string; id: string; vm: boolean }[]
  > {
    const out: { path: string; id: string; vm: boolean }[] = [];
    for (const name of await fs.readdir(join(root, "failed"))) {
      const id = filenameId(name);
      if (id) out.push({ path: join(root, "failed", name), id, vm: false });
      else if (
        name.startsWith("vm-") &&
        (await safeDirectory(join(root, "failed", name)))
      )
        for (const inner of await fs.readdir(join(root, "failed", name))) {
          const innerId = filenameId(inner);
          if (innerId)
            out.push({
              path: join(root, "failed", name, inner),
              id: innerId,
              vm: true,
            });
        }
    }
    return out;
  }
  // 包み { reason, item } の reason。読めなければ undefined。
  const reasonOf = (text: string | null): string | undefined => {
    if (text === null) return undefined;
    try {
      const wrapped = JSON.parse(text) as { reason?: unknown } | null;
      return typeof wrapped?.reason === "string" ? wrapped.reason : undefined;
    } catch {
      return undefined;
    }
  };
  async function readOrNull(path: string): Promise<string | null> {
    try {
      return await fs.readFile(path, "utf8");
    } catch (error) {
      if (hasCode(error, "ENOENT")) return null;
      throw error;
    }
  }
  const titleOf = (json: string): string | null => {
    const parsed = parseItem(json);
    return parsed.kind === "ok" ? parsed.item.title : null;
  };
  // except と完全に一致するパスのファイルは数えない（--retry が取り込み直している自分のファイル）。
  async function hasIdExcept(id: string, except?: string): Promise<boolean> {
    check(id);
    const counts = async (path: string) =>
      path !== except && (await exists(path));
    for (const dir of ["pending", "held", "failed"])
      if (await counts(itemPath(dir, id))) return true;
    if (
      (await fs.readdir(join(root, "sending"))).some(
        (name) => claimedName(name)?.id === id,
      )
    )
      return true;
    for (const name of await fs.readdir(join(root, "failed"))) {
      if (
        name.startsWith("vm-") &&
        (await safeDirectory(join(root, "failed", name))) &&
        (await counts(join(root, "failed", name, `${id}.json`)))
      )
        return true;
    }
    let sent: string;
    try {
      sent = await fs.readFile(join(root, "sent.jsonl"), "utf8");
    } catch (error) {
      if (hasCode(error, "ENOENT")) return false;
      console.error("dotfiles-feedback: sent read failed");
      throw error;
    }
    return sent.split("\n").some((line) => {
      try {
        const entry = JSON.parse(line) as {
          v?: number;
          id?: string;
          issue?: number;
          at?: string;
        } | null;
        return (
          !!entry &&
          entry.v === 1 &&
          entry.id === id &&
          Number.isSafeInteger(entry.issue) &&
          (entry.issue ?? 0) > 0 &&
          typeof entry.at === "string" &&
          Number.isFinite(Date.parse(entry.at))
        );
      } catch {
        return false;
      }
    });
  }
  return {
    root,
    async countLocal(): Promise<{
      unsent: number;
      failed: number;
      held: number;
      failedVmUnsupported: number;
    }> {
      const count = async (dir: string, claimed = false) =>
        (await fs.readdir(join(root, dir))).filter((name) =>
          claimed ? claimedName(name) !== null : filenameId(name) !== null,
        ).length;
      const failed = await failedFiles();
      // 取り込み直しの途中で落ちた孤児（pending/ などにも同じ id がある件）は、CLI の更新で取り込める件に数えない。
      let failedVmUnsupported = 0;
      for (const entry of failed)
        if (
          entry.vm &&
          reasonOf(await readOrNull(entry.path)) === "unsupported-version" &&
          !(await hasIdExcept(entry.id, entry.path))
        )
          failedVmUnsupported++;
      return {
        unsent: (await count("pending")) + (await count("sending", true)),
        failed: failed.length,
        held: await count("held"),
        failedVmUnsupported,
      };
    },
    async listLocal(now: Date): Promise<LocalEntry[]> {
      const entries: LocalEntry[] = [];
      for (const dir of ["pending", "sending", "held"] as const)
        for (const name of (await fs.readdir(join(root, dir))).sort()) {
          const id =
            dir === "sending" ? claimedName(name)?.id : filenameId(name);
          if (!id) continue;
          const text = await readOrNull(join(root, dir, name));
          if (text === null) continue;
          entries.push({ id, place: dir, title: titleOf(text) });
        }
      for (const { path, id } of await failedFiles()) {
        const text = await readOrNull(path);
        if (text === null) continue;
        let title: string | null = null;
        let reason: string | undefined;
        try {
          const wrapped = JSON.parse(text) as {
            reason?: unknown;
            item?: unknown;
          } | null;
          if (typeof wrapped?.item === "string") title = titleOf(wrapped.item);
          if (typeof wrapped?.reason === "string") reason = wrapped.reason;
        } catch {
          /* 壊れた件は title なしで id だけ出す。 */
        }
        const mtime = (await fs.lstat(path)).mtimeMs;
        entries.push({
          id,
          place: "failed",
          title,
          ...(reason === undefined ? {} : { reason }),
          daysUntilDeleted: Math.max(
            0,
            Math.floor((mtime + FAILED_RETENTION_MS - now.getTime()) / DAY_MS),
          ),
        });
      }
      return entries;
    },
    async findLocal(id: string): Promise<LocalPlace | null> {
      check(id);
      for (const dir of ["pending", "held"] as const)
        if (await exists(itemPath(dir, id))) return dir;
      if (
        (await fs.readdir(join(root, "sending"))).some(
          (name) => claimedName(name)?.id === id,
        )
      )
        return "sending";
      return (await failedFiles()).some((entry) => entry.id === id)
        ? "failed"
        : null;
    },
    // show 用。failed/ は { reason, item } の包みを開いて件を返す。読めなければ unreadable。
    async readLocal(
      id: string,
      place: LocalPlace,
    ): Promise<{ kind: "ok"; item: FeedbackItemV1 } | { kind: "unreadable" }> {
      check(id);
      let path: string | undefined;
      if (place === "sending") {
        const name = (await fs.readdir(join(root, "sending"))).find(
          (entry) => claimedName(entry)?.id === id,
        );
        path = name === undefined ? undefined : join(root, "sending", name);
      } else if (place === "failed")
        path = (await failedFiles()).find((entry) => entry.id === id)?.path;
      else path = itemPath(place, id);
      const text = path === undefined ? null : await readOrNull(path);
      if (text === null) return { kind: "unreadable" };
      let json = text;
      if (place === "failed") {
        try {
          const wrapped = JSON.parse(text) as { item?: unknown } | null;
          if (typeof wrapped?.item !== "string") return { kind: "unreadable" };
          json = wrapped.item;
        } catch {
          return { kind: "unreadable" };
        }
      }
      const parsed = parseItem(json);
      return parsed.kind === "ok"
        ? { kind: "ok", item: parsed.item }
        : { kind: "unreadable" };
    },
    async findSent(id: string): Promise<number | null> {
      check(id);
      const text = await readOrNull(join(root, "sent.jsonl"));
      if (text === null) return null;
      let found: number | null = null;
      for (const line of text.split("\n")) {
        try {
          const entry = JSON.parse(line) as {
            v?: number;
            id?: string;
            issue?: number;
          } | null;
          if (
            entry?.v === 1 &&
            entry.id === id &&
            Number.isSafeInteger(entry.issue) &&
            (entry.issue ?? 0) > 0
          )
            found = entry.issue ?? null;
        } catch {
          /* 形の合わない行は飛ばす。 */
        }
      }
      return found;
    },
    // mtime は moveToFailed が書いた時刻。30 日ちょうどは残し、それより古いものを消す。
    async pruneFailed(now: Date, _flushLockHeld: FlushLockHeld): Promise<void> {
      for (const { path, vm } of await failedFiles()) {
        try {
          // CLI を更新すれば取り込める件は、30 日で消さない（spec K4）。
          if (vm && reasonOf(await readOrNull(path)) === "unsupported-version")
            continue;
          if (
            now.getTime() - (await fs.lstat(path)).mtimeMs >
            FAILED_RETENTION_MS
          )
            await unlinkIfPresent(path, fs);
        } catch (error) {
          // 並走する drop や flush --retry が先に消したものは飛ばす。
          if (!hasCode(error, "ENOENT")) throw error;
        }
      }
      // machine ごとに増える空のディレクトリを、走査し続けないために消す。
      for (const name of await fs.readdir(join(root, "failed"))) {
        if (!name.startsWith("vm-")) continue;
        const dir = join(root, "failed", name);
        try {
          const stat = await fs.lstat(dir);
          if (
            stat.isDirectory() &&
            !stat.isSymbolicLink() &&
            (await fs.readdir(dir)).length === 0
          )
            await fs.rmdir(dir);
        } catch (error) {
          // 並走の取り込みが書いた、または消した場合は残す。
          if (!hasCode(error, "ENOENT") && !hasCode(error, "ENOTEMPTY"))
            throw error;
        }
      }
    },
    async truncateSent(_flushLockHeld: FlushLockHeld): Promise<void> {
      const path = join(root, "sent.jsonl");
      const text = await readOrNull(path);
      if (text === null) return;
      const lines = text.split("\n").filter((line) => line !== "");
      if (lines.length <= MAX_SENT_LINES) return;
      await atomicWrite(
        path,
        `${lines.slice(-MAX_SENT_LINES).join("\n")}\n`,
        deps,
      );
    },
    async writePending(
      item: FeedbackItemV1,
      { origin }: { origin: "local" | "vm" },
    ): Promise<void> {
      check(item.id);
      let count = 0;
      for (const name of await fs.readdir(join(root, "pending"))) {
        const id = filenameId(name);
        if (id && (id.startsWith("vm-") ? "vm" : "local") === origin) count++;
      }
      if (count >= MAX_PENDING_PER_ORIGIN) throw new PendingFullError();
      if ((item.id.startsWith("vm-") ? "vm" : "local") !== origin)
        throw new Error("dotfiles-feedback: origin mismatch");
      await atomicWrite(
        itemPath("pending", item.id),
        JSON.stringify(item),
        deps,
      );
    },
    // 取り込んだ VM の件を、通らなかった理由つきで failed/vm-<machine>/ に写す。
    // wrapped は呼び出し側が作った包み { reason, item, at } の文字列。理由ごとの枠は machine ごと。
    async writeVmFailed(
      machine: string,
      id: string,
      wrapped: string,
      reason: VmFailedReason,
    ): Promise<VmFailedWrite> {
      if (!MACHINE_NAME_PATTERN.test(machine))
        throw new Error("dotfiles-feedback: invalid machine");
      if (!VM_ID_PATTERN.test(id))
        throw new Error("dotfiles-feedback: invalid id");
      const dir = join(root, "failed", `vm-${machine}`);
      const ensureDir = async () => {
        if (!(await safeDirectory(dir))) {
          await fs.mkdir(dir, { mode: 0o700, recursive: true });
          await safeDirectory(dir);
        }
      };
      await ensureDir();
      const target = join(dir, `${id}.json`);
      if (await exists(target)) return "exists";
      let count = 0;
      for (const name of await fs.readdir(dir)) {
        if (filenameId(name) === null) continue;
        const existing = reasonOf(await readOrNull(join(dir, name)));
        if ((existing ?? "invalid") === reason) count++;
      }
      if (
        count >=
        (reason === "invalid" ? MAX_VM_FAILED_ITEMS : MAX_VM_UNSUPPORTED_ITEMS)
      )
        return "full";
      try {
        await atomicWrite(target, wrapped, deps);
      } catch (error) {
        // 作った直後に pruneFailed が空のディレクトリを消した場合だけ、作り直して 1 回書く。
        if (!hasCode(error, "ENOENT")) throw error;
        await ensureDir();
        await atomicWrite(target, wrapped, deps);
      }
      return "written";
    },
    // failed/vm-*/ を一覧から探す。id から組み立てたパスを直接開かない。
    async findVmFailed(id: string): Promise<VmFailedFound | null> {
      if (!VM_ID_PATTERN.test(id)) return null;
      for (const name of await fs.readdir(join(root, "failed"))) {
        if (!name.startsWith("vm-")) continue;
        const dir = join(root, "failed", name);
        try {
          const stat = await fs.lstat(dir);
          if (!stat.isDirectory() || stat.isSymbolicLink()) continue;
          if (!(await fs.readdir(dir)).includes(`${id}.json`)) continue;
          const path = join(dir, `${id}.json`);
          const text = await readOrNull(path);
          if (text !== null)
            return { machine: name.slice("vm-".length), path, text };
        } catch (error) {
          // 並走の掃除が空のディレクトリを消した。
          if (!hasCode(error, "ENOENT")) throw error;
        }
      }
      return null;
    },
    async sortPending(): Promise<void> {
      for (const directory of ["held", "pending"] as const) {
        let keptHeld = 0;
        for (const name of (await fs.readdir(join(root, directory))).sort()) {
          const id = filenameId(name);
          if (!id) continue;
          const path = itemPath(directory, id);
          let version: number | undefined;
          const contents = await fs.readFile(path, "utf8");
          try {
            version = (
              JSON.parse(contents) as { schemaVersion?: number } | null
            )?.schemaVersion;
          } catch {
            continue;
          }
          if (directory === "held" && version === SCHEMA_VERSION)
            await move(path, itemPath("pending", id), id);
          else if (directory === "held" && ++keptHeld > MAX_HELD)
            await fail(path, id, "unsupported-version");
          if (
            directory === "pending" &&
            typeof version === "number" &&
            version > SCHEMA_VERSION
          ) {
            if ((await heldCount()) >= MAX_HELD)
              await fail(path, id, "unsupported-version");
            else await move(path, itemPath("held", id), id);
          }
        }
      }
    },
    async hasId(id: string, options?: { except?: string }): Promise<boolean> {
      return hasIdExcept(id, options?.except);
    },
    async claim(id: string): Promise<ClaimedItem | null> {
      const from = itemPath("pending", id);
      const claimed = { id, nonce: nonce() };
      try {
        await fs.utimes(from, deps.now(), deps.now());
        await fs.rename(from, claimPath(claimed));
        return claimed;
      } catch {
        return null;
      }
    },
    async stillClaimed(claimed: ClaimedItem): Promise<boolean> {
      return exists(claimPath(claimed));
    },
    async reclaimStale(now: Date): Promise<void> {
      for (const name of await fs.readdir(join(root, "sending"))) {
        const claimed = claimedName(name);
        if (!claimed) continue;
        const from = claimPath(claimed);
        try {
          if (now.getTime() - (await fs.lstat(from)).mtimeMs > CLAIM_STALE_MS)
            await fs.rename(from, itemPath("pending", claimed.id));
        } catch (error) {
          if (!hasCode(error, "ENOENT")) {
            console.error("dotfiles-feedback: reclaim failed");
            throw error;
          }
        }
      }
    },
    async markSent(claimed: ClaimedItem, issueNumber: number): Promise<void> {
      const from = claimPath(claimed);
      if (!Number.isSafeInteger(issueNumber) || issueNumber <= 0)
        throw new Error("dotfiles-feedback: invalid issue number");
      const handle = await fs.open(
        join(root, "sent.jsonl"),
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_APPEND |
          constants.O_NOFOLLOW,
        0o600,
      );
      try {
        await handle.write(
          `${JSON.stringify({ v: 1, id: claimed.id, issue: issueNumber, at: deps.now().toISOString() })}\n`,
        );
      } finally {
        await handle.close();
      }
      await unlinkIfPresent(from, fs);
      await retry.reset(claimed.id);
    },
    async moveToFailed(
      value: ClaimedItem | string,
      reason: string,
    ): Promise<void> {
      await fail(
        typeof value === "string"
          ? itemPath("pending", value)
          : claimPath(value),
        typeof value === "string" ? value : value.id,
        reason,
      );
    },
    async retryFailed(id: string): Promise<void> {
      const from = itemPath("failed", id);
      const value = JSON.parse(await fs.readFile(from, "utf8")) as {
        item?: string;
      } | null;
      if (!value || typeof value.item !== "string")
        throw new Error("dotfiles-feedback: invalid failed item");
      await atomicWrite(itemPath("pending", id), value.item, deps);
      await unlinkIfPresent(from, fs);
    },
    async drop(id: string): Promise<void> {
      check(id);
      for (const dir of ["pending", "held", "failed"])
        await unlinkIfPresent(itemPath(dir, id), fs);
      for (const name of await fs.readdir(join(root, "sending")))
        if (claimedName(name)?.id === id)
          await unlinkIfPresent(join(root, "sending", name), fs);
      for (const name of await fs.readdir(join(root, "failed")))
        if (
          name.startsWith("vm-") &&
          (await safeDirectory(join(root, "failed", name)))
        )
          await unlinkIfPresent(join(root, "failed", name, `${id}.json`), fs);
      await retry.reset(id);
    },
    async holdClaimed(claimed: ClaimedItem): Promise<void> {
      if ((await heldCount()) >= MAX_HELD)
        await fail(claimPath(claimed), claimed.id, "unsupported-version");
      else
        await move(
          claimPath(claimed),
          itemPath("held", claimed.id),
          claimed.id,
        );
    },
  };
}
