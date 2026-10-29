import { execFileSync, spawnSync } from "node:child_process";
import { createReadStream, createWriteStream } from "node:fs";
import { createInterface } from "node:readline";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import * as fsPromises from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { detectAgent } from "../lib/agent-caller.ts";
import { resolveRepoKey } from "../lib/repo-key.ts";
import { runGit } from "../lib/run-git.ts";
import { readLastFlush } from "../lib/dotfiles-feedback/cache.ts";
import {
  ERROR_HINTS,
  FEEDBACK_KINDS,
  FEEDBACK_REPO,
  FLUSH_LOCK_FILE,
  FLUSH_LOCK_STALE_MS,
  VM_OUTBOX_DIR,
} from "../lib/dotfiles-feedback/constants.ts";
import type {
  FeedbackDeps,
  InteractiveDeps,
} from "../lib/dotfiles-feedback/deps.ts";
import { collectList, collectShow } from "../lib/dotfiles-feedback/collect.ts";
import {
  formatCancelled,
  formatError,
  formatList,
  formatShow,
  formatTriageResult,
  newNonce,
} from "../lib/dotfiles-feedback/display.ts";
import { flush } from "../lib/dotfiles-feedback/flush.ts";
import { refresh } from "../lib/dotfiles-feedback/refresh.ts";
import { parseTriageArgs, triage } from "../lib/dotfiles-feedback/triage.ts";
import { runGh } from "../lib/dotfiles-feedback/gh.ts";
import {
  resolvePasswdHome,
  type HomeResult,
} from "../lib/dotfiles-feedback/home.ts";
import {
  isFeedbackId,
  newLocalId,
  normalizeField,
  validateItem,
  type FeedbackItemV1,
  type FeedbackKind,
} from "../lib/dotfiles-feedback/item.ts";
import { isLockHeld } from "../lib/dotfiles-feedback/lock.ts";
import { openRetry } from "../lib/dotfiles-feedback/retry.ts";
import {
  flushArgv,
  refreshArgv,
  spawnDetached,
} from "../lib/dotfiles-feedback/spawn.ts";
import { openSpool } from "../lib/dotfiles-feedback/spool.ts";
import {
  countVmOutbox,
  sendFromVm,
} from "../lib/dotfiles-feedback/vm-outbox.ts";

const STDIN_MAX_BYTES = 64 * 1024;
const USAGE = `使い方: dotfiles-feedback <command>
  send --title <t> --target <t> --kind <bug|improvement|missing>   本文は stdin で渡す
  flush [--retry <id>]
  status
  drop <id>
  list
  show <#番号|id>
  triage <#番号|id> --to <issue|plan|reject> [--path <docs/plans/x.md>] [--reason <理由>]
  refresh`;
export type CliDeps = FeedbackDeps &
  InteractiveDeps & {
    cliPath: string;
    spawnDetached(argv: readonly string[]): Promise<boolean>;
    stdout(text: string): void;
    stderr(text: string): void;
  };
type Command = (args: string[], deps: CliDeps) => Promise<number>;

function lastFlushLine(deps: CliDeps, hasPending: boolean): string | null {
  const last = readLastFlush(
    join(deps.root, "state", "last-flush.json"),
    deps.now(),
    hasPending,
  );
  return last
    ? `直近の送信の失敗: ${last.error} (${last.at}) 対処: ${ERROR_HINTS[last.error] ?? ""}`
    : null;
}

// VM の中では spool にも gh にも触れず、outbox に置くだけにする。flush も起動しない（spec K4・K8）。
async function sendInsideVm(
  candidate: FeedbackItemV1,
  redacted: boolean,
  deps: CliDeps,
): Promise<number> {
  const outcome = await sendFromVm(candidate, deps);
  if (outcome.kind === "queued") {
    deps.stdout(
      `${[
        `保存した: ${candidate.id}`,
        `伏せた箇所: ${redacted ? "あり" : "なし"}`,
        "ホストが取り込むまで outbox に置いた",
      ].join("\n")}\n`,
    );
    return 0;
  }
  deps.stderr(
    outcome.kind === "full"
      ? "ホストが取り込むまで送れない。ホストの dotfiles-feedback が古いなら更新する\n"
      : outcome.kind === "unsafe"
        ? "outbox のディレクトリが安全でないので書かなかった\n"
        : `送れなかった: ${candidate.id} (${outcome.errno})\n`,
  );
  return 1;
}

const send: Command = async (args, deps) => {
  const { values } = parseArgs({
    args,
    options: {
      title: { type: "string" },
      target: { type: "string" },
      kind: { type: "string" },
    },
    strict: true,
  });
  const { title, target, kind } = values;
  if (title === undefined || target === undefined || kind === undefined) {
    deps.stderr(`--title, --target, --kind が必要\n${USAGE}\n`);
    return 1;
  }
  if (!FEEDBACK_KINDS.includes(kind as FeedbackKind)) {
    deps.stderr(`--kind は ${FEEDBACK_KINDS.join(" / ")} のどれか\n`);
    return 1;
  }
  if (deps.stdinIsTty) {
    deps.stderr("本文は stdin で渡す\n");
    return 1;
  }
  let rawBody: string;
  try {
    rawBody = await deps.readStdin();
  } catch {
    deps.stderr("stdin を読めなかった (上限 64KB)\n");
    return 1;
  }
  if (Buffer.byteLength(rawBody, "utf8") > STDIN_MAX_BYTES) {
    deps.stderr("本文が 64KB を超えている\n");
    return 1;
  }
  const fields = {
    title: normalizeField(title, "title"),
    target: normalizeField(target, "target"),
    body: normalizeField(rawBody.replace(/\s+$/, ""), "body"),
  };
  for (const [name, field] of Object.entries(fields)) {
    if (!field.ok) {
      deps.stderr(`拒否: ${field.reason} (${name})\n`);
      return 1;
    }
  }
  if (!fields.title.ok || !fields.target.ok || !fields.body.ok) return 1;
  const rawHost = normalizeField(deps.hostname(), "host");
  const rawKey = await deps.resolveRepoKey(deps.cwd);
  const key = rawKey === null ? null : normalizeField(rawKey, "repoKey");
  const now = deps.now();
  const candidate: FeedbackItemV1 = {
    schemaVersion: 1,
    id: newLocalId(now, deps.randomBytes),
    createdAt: now.toISOString().replace(/\.\d{3}Z$/, "Z"),
    title: fields.title.value,
    target: fields.target.value,
    kind: kind as FeedbackKind,
    body: fields.body.value,
    source: {
      agent: detectAgent(deps.envNames),
      repoKey: key?.ok ? key.value : null,
      host: rawHost.ok ? rawHost.value : "unknown",
      vm: false,
    },
  };
  const validated = validateItem(candidate);
  if (validated.kind !== "ok") {
    deps.stderr(`拒否: ${validated.reason}\n`);
    return 1;
  }
  const redacted =
    fields.title.redacted || fields.target.redacted || fields.body.redacted;
  if (deps.isVm) return sendInsideVm(candidate, redacted, deps);
  const spool = await openSpool(deps.root, deps);
  const before = await spool.countLocal();
  await spool.writePending(candidate, { origin: "local" });
  const lines = [
    `保存した: ${candidate.id}`,
    `伏せた箇所: ${redacted ? "あり" : "なし"}`,
    `手元の未送: ${before.unsent} 件、失敗: ${before.failed} 件`,
  ];
  const last = lastFlushLine(deps, before.unsent > 0);
  if (last) lines.push(last);
  deps.stdout(`${lines.join("\n")}\n`);
  if (!(await deps.spawnDetached(flushArgv(deps.cliPath))))
    deps.stderr(
      "警告: flush を起動できなかった。dotfiles-feedback flush を実行する\n",
    );
  return 0;
};

const flushCommand: Command = async (args, deps) => {
  const { values } = parseArgs({
    args,
    options: { retry: { type: "string" } },
    strict: true,
  });
  if (values.retry !== undefined) {
    if (!isFeedbackId(values.retry)) {
      deps.stderr("id の形式が正しくない\n");
      return 1;
    }
    const spool = await openSpool(deps.root, deps);
    await spool.retryFailed(values.retry);
    await openRetry(deps.root, deps).reset(values.retry);
  }
  const result = await flush(deps);
  deps.stdout(
    result.kind === "busy"
      ? "別の flush が実行中（終わると結果が status に出る）\n"
      : "flush 完了\n",
  );
  return 0;
};

const status: Command = async (_args, deps) => {
  if (deps.isVm) {
    deps.stdout(`ホストの取り込み待ち ${await countVmOutbox(deps)} 件\n`);
    return 0;
  }
  const spool = await openSpool(deps.root, deps);
  const counts = await spool.countLocal();
  const sending = await isLockHeld(
    join(deps.root, FLUSH_LOCK_FILE),
    FLUSH_LOCK_STALE_MS,
    deps,
  );
  const lines = [
    `未送: ${counts.unsent} 件${sending ? "（送り出し中）" : ""}`,
    `失敗: ${counts.failed} 件`,
    `新しい版で止まっている: ${counts.held} 件`,
  ];
  const last = lastFlushLine(deps, counts.unsent > 0);
  if (last) lines.push(last);
  deps.stdout(`${lines.join("\n")}\n`);
  return 0;
};

const drop: Command = async (args, deps) => {
  const id = args[0];
  if (args.length !== 1 || id === undefined || !isFeedbackId(id)) {
    deps.stderr("drop <id> の形式が正しくない\n");
    return 1;
  }
  const spool = await openSpool(deps.root, deps);
  await spool.drop(id);
  deps.stdout(`削除した: ${id}\n`);
  return 0;
};

// list と refresh は引数を取らず、show は位置引数を 1 つだけ取る。誤りは形式の誤りとして 1。
function badArguments(args: string[], positionals: number, deps: CliDeps) {
  try {
    const parsed = parseArgs({
      args,
      options: {},
      allowPositionals: true,
      strict: true,
    });
    if (parsed.positionals.length === positionals) return false;
  } catch {
    /* 未知の flag は下で同じ扱いにする。 */
  }
  deps.stderr(formatError(`引数が正しくない: ${args.join(" ")}`));
  return true;
}
const hintFor = (error: string, hint: string) =>
  hint !== "" ? hint : (ERROR_HINTS[error] ?? "");

const listCommand: Command = async (args, deps) => {
  if (badArguments(args, 0, deps)) return 1;
  deps.stdout(formatList(await collectList(deps)));
  return 0;
};

const showCommand: Command = async (args, deps) => {
  if (badArguments(args, 1, deps)) return 1;
  const shown = await collectShow(args[0] as string, deps);
  if (shown.kind === "ok") {
    deps.stdout(formatShow(shown.view, newNonce(deps.randomBytes)));
    return 0;
  }
  deps.stderr(
    shown.kind === "failed"
      ? formatError(
          `${shown.error}: ${shown.message}`,
          hintFor(shown.error, shown.hint),
        )
      : formatError(shown.reason),
  );
  return 1;
};

const triageCommand: Command = async (args, deps) => {
  const parsed = parseTriageArgs(args);
  if (!parsed.ok) {
    deps.stderr(formatError(parsed.reason));
    return 1;
  }
  const outcome = await triage(parsed.target, parsed.options, {
    ...deps,
    log: deps.stderr,
  });
  if (outcome.kind === "done") {
    deps.stdout(formatTriageResult(outcome.view));
    return 0;
  }
  // 終了コードは 1 のまま。public の issue を作っていないことをスクリプトから見分けられる。
  deps.stderr(
    outcome.kind === "gh-failed"
      ? formatError(
          `${outcome.error}: ${outcome.message}`,
          hintFor(outcome.error, outcome.hint),
        )
      : outcome.kind === "cancelled"
        ? formatCancelled(outcome.reason)
        : formatError(outcome.reason),
  );
  return 1;
};

const refreshCommand: Command = async (args, deps) => {
  if (badArguments(args, 0, deps)) return 1;
  // 前面で打った refresh は flush が終わるまで戻らないので、先に知らせる。
  deps.stdout("送り出し中\n");
  const result = await refresh({ ...deps, log: deps.stderr });
  if (result.kind === "failed") {
    deps.stderr(formatError(result.reason));
    return 1;
  }
  return 0;
};

const unimplemented: Command = async (_args, deps) => {
  deps.stderr("未実装\n");
  return 1;
};

const COMMANDS: Record<string, Command> = {
  send,
  flush: flushCommand,
  status,
  drop,
  list: listCommand,
  show: showCommand,
  triage: triageCommand,
  refresh: refreshCommand,
  "ingest-vm": unimplemented,
};

export async function runCli(argv: string[], deps: CliDeps): Promise<number> {
  if (argv.includes("--help") || argv.includes("-h")) {
    deps.stdout(`${USAGE}\n`);
    return 0;
  }
  const [name, ...rest] = argv;
  const command = name === undefined ? undefined : COMMANDS[name];
  if (!command) {
    deps.stderr(`${USAGE}\n`);
    return 1;
  }
  if (deps.isVm && name !== "status" && name !== "send") {
    deps.stderr("VM からの送信は未対応\n");
    return 1;
  }
  try {
    return await command(rest, deps);
  } catch (error) {
    deps.stderr(
      `dotfiles-feedback: ${error instanceof Error ? error.message : "失敗"}\n`,
    );
    return 1;
  }
}

export type EntryDeps = {
  resolveHome(): HomeResult;
  buildDeps(home: string): CliDeps;
  stderr(text: string): void;
};

export async function startCli(
  argv: string[],
  entryDeps: EntryDeps,
): Promise<number> {
  const home = entryDeps.resolveHome();
  if (!home.ok) {
    entryDeps.stderr(`dotfiles-feedback: ${home.reason}\n`);
    return 1;
  }
  return runCli(argv, entryDeps.buildDeps(home.home));
}

async function readStdinCapped(): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.from(chunk as Uint8Array);
    size += buffer.length;
    if (size > STDIN_MAX_BYTES) throw new Error("stdin too large");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function isPidAlive(pid: number): boolean | null {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as { code?: string }).code;
    return code === "ESRCH" ? false : code === "EPERM" ? true : null;
  }
}

async function getPidStartTime(pid: number): Promise<string | null> {
  try {
    if (process.platform === "linux") {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19] ?? null;
    }
    const out = execFileSync("/bin/ps", ["-o", "lstart=", "-p", String(pid)], {
      env: { PATH: "/usr/bin:/bin", LANG: "C" },
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 3_000,
    })
      .toString("utf8")
      .trim();
    return out === "" ? null : out;
  } catch {
    return null;
  }
}

// /dev/tty を開けない・EOF・空行・y 以外はすべて偽。エージェントの stdin では答えられない。
export const isConfirmed = (answer: string | null): boolean =>
  answer === "y" || answer === "Y";

export async function confirmOnTty(text: string): Promise<boolean> {
  let input: ReturnType<typeof createReadStream> | undefined;
  let output: ReturnType<typeof createWriteStream> | undefined;
  try {
    input = createReadStream("/dev/tty");
    output = createWriteStream("/dev/tty");
    await new Promise<void>((resolve, reject) => {
      input!.once("open", () => resolve());
      input!.once("error", reject);
    });
    output.write(`${text}\n[y/N] `);
    const lines = createInterface({ input });
    const answer = await new Promise<string | null>((resolve) => {
      lines.once("line", resolve);
      lines.once("close", () => resolve(null));
    });
    lines.close();
    return isConfirmed(answer);
  } catch {
    return false;
  } finally {
    input?.destroy();
    output?.destroy();
  }
}

// root と gh の HOME はどちらも passwd から得た home から作る。環境変数 HOME は読まない。
export function buildCliDeps(
  home: string,
  overrides: Partial<CliDeps> = {},
): CliDeps {
  const cliPath = fileURLToPath(import.meta.url);
  return {
    root: join(home, ".local", "share", "dotfiles-feedback"),
    home,
    uid: process.getuid?.() ?? -1,
    fs: {
      ...fsPromises,
      readdirBuffer: (path) => fsPromises.readdir(path, { encoding: "buffer" }),
    },
    repo: FEEDBACK_REPO,
    runGh,
    spawnFlush: () => spawnDetached(flushArgv(cliPath)),
    now: () => new Date(),
    randomBytes: (size) => randomBytes(size),
    hostname,
    pid: process.pid,
    isPidAlive,
    getPidStartTime,
    isVm: existsSync("/etc/agent-vm"),
    vmOutboxDir: VM_OUTBOX_DIR,
    readStdin: readStdinCapped,
    envNames: Object.keys(process.env),
    resolveRepoKey: async (cwd) => resolveRepoKey(cwd, runGit),
    cliPath,
    cwd: process.cwd(),
    stdinIsTty: process.stdin.isTTY === true,
    stdoutIsTty: process.stdout.isTTY === true,
    editor: process.env.EDITOR,
    runEditor: async (argv) =>
      argv[0] === undefined
        ? null
        : spawnSync(argv[0], argv.slice(1), { stdio: "inherit", shell: false })
            .status,
    makeTempDir: () => fsPromises.mkdtemp(join(tmpdir(), "dotfiles-feedback-")),
    removeTree: (path) => fsPromises.rm(path, { recursive: true, force: true }),
    confirm: confirmOnTty,
    spawnRefresh: () => spawnDetached(refreshArgv(cliPath)),
    resolveToplevel: async (cwd) => {
      const r = runGit(["rev-parse", "--show-toplevel"], cwd);
      return r.ok ? r.stdout.trim() || null : null;
    },
    realpath: (path) => fsPromises.realpath(path),
    spawnDetached,
    stdout: (text) => void process.stdout.write(text),
    stderr: (text) => void process.stderr.write(text),
    ...overrides,
  };
}

if (import.meta.main) {
  // Not process.exit(): see docs/decisions/0002 (no-process-exit under hooks/).
  process.exitCode = await startCli(process.argv.slice(2), {
    resolveHome: () =>
      typeof process.getuid === "function"
        ? resolvePasswdHome(
            (file, args, env) => {
              const r = spawnSync(file, [...args], {
                env,
                encoding: "utf8",
                timeout: 5_000,
                shell: false,
              });
              return { code: r.status, stdout: r.stdout ?? "" };
            },
            process.platform,
            process.getuid(),
          )
        : { ok: false, reason: "uid を取得できない" },
    buildDeps: (home) => buildCliDeps(home),
    stderr: (text) => void process.stderr.write(text),
  });
}
