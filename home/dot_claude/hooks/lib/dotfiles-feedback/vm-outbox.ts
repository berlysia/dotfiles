import { constants } from "node:fs";
import { join } from "node:path";
import type { FeedbackDeps, FeedbackFs } from "./deps.ts";
import type { FeedbackItemV1 } from "./item.ts";
import { hasCode } from "./lock.ts";
import {
  CACHE_TEMP_RANDOM_BYTES,
  LOCAL_ID_PATTERN,
  MAX_VM_OUTBOX_ITEMS,
} from "./constants.ts";

export type VmOutboxDeps = Pick<
  FeedbackDeps,
  "vmOutboxDir" | "uid" | "randomBytes"
> & {
  fs: Pick<
    FeedbackFs,
    "mkdir" | "lstat" | "readdir" | "open" | "rename" | "unlink"
  >;
};
export type VmSendResult =
  | { kind: "queued" }
  | { kind: "full" }
  | { kind: "unsafe" }
  | { kind: "failed"; errno: string };

const ITEM_FILE = /^(.+)\.json$/;
const isItemName = (name: string) => {
  const match = ITEM_FILE.exec(name);
  return match !== null && LOCAL_ID_PATTERN.test(match[1] ?? "");
};
const errnoOf = (error: unknown): string => {
  const code =
    error instanceof Error && "code" in error ? String(error.code) : "";
  return /^E[A-Z]+$/.test(code) ? code : "EUNKNOWN";
};

// ホストの取り込み待ちの件数。ディレクトリが無ければ 0 件。
export async function countVmOutbox(deps: VmOutboxDeps): Promise<number> {
  try {
    return (await deps.fs.readdir(deps.vmOutboxDir)).filter(isItemName).length;
  } catch (error) {
    if (hasCode(error, "ENOENT")) return 0;
    throw error;
  }
}

// VM の中の send。ネットワークにも spool にも触れず、outbox の専用ディレクトリに置くだけ。
// ホストの取り込みがディレクトリごと持ち去るので、毎回作り直す（spec K8）。
export async function sendFromVm(
  item: FeedbackItemV1,
  deps: VmOutboxDeps,
): Promise<VmSendResult> {
  const { fs } = deps;
  const text = JSON.stringify({
    ...item,
    source: { ...item.source, vm: true },
  });
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    const temporary = join(
      deps.vmOutboxDir,
      `.tmp-${Buffer.from(deps.randomBytes(CACHE_TEMP_RANDOM_BYTES)).toString("hex")}`,
    );
    try {
      await fs.mkdir(deps.vmOutboxDir, { mode: 0o700, recursive: true });
      const stat = await fs.lstat(deps.vmOutboxDir);
      if (
        !stat.isDirectory() ||
        stat.isSymbolicLink() ||
        stat.uid !== deps.uid ||
        (stat.mode & 0o077) !== 0
      )
        return { kind: "unsafe" };
      if ((await countVmOutbox(deps)) >= MAX_VM_OUTBOX_ITEMS)
        return { kind: "full" };
      const handle = await fs.open(
        temporary,
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_EXCL |
          constants.O_NOFOLLOW,
        0o600,
      );
      try {
        await handle.writeFile(text);
      } finally {
        await handle.close();
      }
      await fs.rename(temporary, join(deps.vmOutboxDir, `${item.id}.json`));
      return { kind: "queued" };
    } catch (error) {
      lastError = error;
      // 書きかけを残さない。ホストが移した後ならディレクトリごと無いので、失敗は無視する。
      await fs.unlink(temporary).catch(() => undefined);
    }
  }
  return { kind: "failed", errno: errnoOf(lastError) };
}
