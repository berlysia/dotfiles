// lib/commit-sign-failure.ts
//
// Pure detection and wording for the commit-sign-failure-ask hook, plus the
// small per-session marker store it shares across PostToolUse / Stop.
//
// Detection keys on output text, not exit codes: `git commit ...; git log`
// exits 0 even when the commit failed. It is gated on the command creating a
// commit so that `grep`/`git log`/`git show` over text that merely contains the
// failure line never fires. The injected wording is fixed: tool output is
// untrusted and must not be copied into hook-authored context.

import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { gitSubcommand, splitCommand } from "./command-words.ts";
import { isSafeSessionId } from "./session-id.ts";

export const HOOK_ID = "[commit-sign-failure-ask]";

export type SignFailureLabel =
  | "failed-to-write-commit-object"
  | "gpg-failed-to-sign"
  | "1password-agent-error";

const LABEL_TEXT: Record<SignFailureLabel, string> = {
  "failed-to-write-commit-object": "commit object の書き込みに失敗",
  "gpg-failed-to-sign": "gpg による署名に失敗",
  "1password-agent-error": "1Password の署名エージェントがエラー",
};

const OUTPUT_PATTERNS: ReadonlyArray<[SignFailureLabel, RegExp]> = [
  ["failed-to-write-commit-object", /fatal: failed to write commit object/],
  ["gpg-failed-to-sign", /error: gpg failed to sign the data/],
  ["1password-agent-error", /^error: 1Password: /m],
];

const COMMIT_CREATING_SUBCOMMANDS = new Set([
  "commit",
  "merge",
  "cherry-pick",
  "revert",
  "rebase",
  "pull",
  "am",
]);

/** True when any part of the command can create a commit (or runs `chezmoi update`). */
export function isCommitCreatingCommand(command: string): boolean {
  return splitCommand(command).some((words) => {
    const sub = gitSubcommand(words);
    if (sub !== undefined) return COMMIT_CREATING_SUBCOMMANDS.has(sub);
    return words[0] === "chezmoi" && words[1] === "update";
  });
}

export function isChezmoiUpdateCommand(command: string): boolean {
  return splitCommand(command).some(
    (words) => words[0] === "chezmoi" && words[1] === "update",
  );
}

/** Fixed labels for the signing-failure lines found in `output`; empty when none or not applicable. */
export function detectSignFailure(
  command: string,
  output: unknown,
): SignFailureLabel[] {
  if (typeof output !== "string" || output === "") return [];
  if (!isCommitCreatingCommand(command)) return [];
  return OUTPUT_PATTERNS.filter(([, re]) => re.test(output)).map(
    ([label]) => label,
  );
}

export function buildSignFailureContext(args: {
  labels: SignFailureLabel[];
  isSubagent: boolean;
  isChezmoiUpdate: boolean;
}): string {
  const found = args.labels.map((l) => LABEL_TEXT[l]).join(" / ");
  if (args.isSubagent) {
    return `${HOOK_ID} commit の署名失敗を検知した（${found}）。署名を外して再実行しない。失敗の行をそのまま最終報告に含めて終わる。`;
  }
  const lines = [
    `${HOOK_ID} commit の署名失敗を検知した（${found}）。`,
    "署名を直して再試行できるならしてよい。それで解決せず止まることになるなら、黙って turn を閉じず AskUserQuestion で聞く。回答の前に署名を外さない。",
    "選択肢:",
    "1. 署名を直して再試行（推奨。1Password を起動しロックを解除する）",
    "2. この操作だけ `--no-gpg-sign` で再実行",
    "3. ここで止める",
  ];
  if (args.isChezmoiUpdate) {
    lines.push(
      "`chezmoi update` の rebase 中なら、`dotfiles-sync-doctor fix` で状態を整えてから再試行できる。",
    );
  }
  return lines.join("\n");
}

export const STOP_REASON = `${HOOK_ID} このセッション（subagent を含む）で commit の署名が失敗した記録が残っている。署名を直せず、このまま止まることになるなら、AskUserQuestion で「署名を直して再試行 / この操作だけ --no-gpg-sign で再実行 / ここで止める」を聞く。すでに解決したなら、解決したと書いて終えてよい。`;

// --- marker store ---------------------------------------------------------

const MARKER_MAX_AGE_MS = 24 * 60 * 60 * 1000;
/** Returns false (never throws) when the marker could not be written. */
export function writeMarker(
  dir: string,
  sessionId: string,
  labels: SignFailureLabel[],
  now: Date = new Date(),
): boolean {
  if (!isSafeSessionId(sessionId)) return false;
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const target = join(dir, sessionId);
    const tmp = `${target}.${process.pid}.tmp`;
    writeFileSync(
      tmp,
      JSON.stringify({ detectedAt: now.toISOString(), labels }),
      { mode: 0o600 },
    );
    renameSync(tmp, target);
    return true;
  } catch {
    return false;
  }
}

export function clearMarker(dir: string, sessionId: string): void {
  if (!isSafeSessionId(sessionId)) return;
  try {
    rmSync(join(dir, sessionId), { force: true });
  } catch {
    // best effort
  }
}

/** True when a fresh, well-formed marker exists. Stale or corrupt markers are removed. */
export function hasMarker(
  dir: string,
  sessionId: string,
  now: Date = new Date(),
): boolean {
  if (!isSafeSessionId(sessionId)) return false;
  let raw: string;
  try {
    raw = readFileSync(join(dir, sessionId), "utf8");
  } catch {
    return false;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    const detectedAt =
      typeof parsed === "object" && parsed !== null
        ? (parsed as { detectedAt?: unknown }).detectedAt
        : undefined;
    const at = typeof detectedAt === "string" ? Date.parse(detectedAt) : NaN;
    if (Number.isNaN(at) || now.getTime() - at > MARKER_MAX_AGE_MS) {
      clearMarker(dir, sessionId);
      return false;
    }
    return true;
  } catch {
    clearMarker(dir, sessionId);
    return false;
  }
}
