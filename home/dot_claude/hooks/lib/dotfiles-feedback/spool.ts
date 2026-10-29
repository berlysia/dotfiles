import { constants } from "node:fs";
import { join } from "node:path";
import type { FeedbackDeps, FeedbackFs } from "./deps.ts";
import { isFeedbackId, type FeedbackItemV1 } from "./item.ts";
import { hasCode, unlinkIfPresent } from "./lock.ts";
import { atomicWrite, openRetry, type RetryDeps } from "./retry.ts";
import {
  CACHE_TEMP_RANDOM_BYTES,
  CLAIM_STALE_MS,
  MAX_HELD,
  MAX_PENDING_PER_ORIGIN,
  SCHEMA_VERSION,
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
      | "utimes"
    >;
  };
export type ClaimedItem = { id: string; nonce: string };

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
  return {
    root,
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
      if (count >= MAX_PENDING_PER_ORIGIN)
        throw new Error("dotfiles-feedback: pending full");
      if ((item.id.startsWith("vm-") ? "vm" : "local") !== origin)
        throw new Error("dotfiles-feedback: origin mismatch");
      await atomicWrite(
        itemPath("pending", item.id),
        JSON.stringify(item),
        deps,
      );
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
    async hasId(id: string): Promise<boolean> {
      check(id);
      for (const dir of ["pending", "held", "failed"])
        if (await exists(itemPath(dir, id))) return true;
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
          (await exists(join(root, "failed", name, `${id}.json`)))
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
