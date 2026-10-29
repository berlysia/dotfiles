// Turns the output of `claude-sessions --json` into what the /sessions pane
// draws. The CLI decides who is addressable and which names repeat (ADR-0059);
// this module trusts those verdicts and only shapes them. The one thing it
// re-checks is the text that reaches the prompt, because that is the last exit
// of another session's strings.

export type ListView =
  | {
      kind: "ok";
      rows: { label: string; isSelf: boolean; fillText: string | null }[];
      notes: string[];
    }
  | { kind: "unavailable"; message: string };

type Run = { exitCode: number; stdout: string } | "spawn-failed";

// The CLI lowercases ids. Narrower than its own check is fine: a row this
// rejects just gets no button.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const NAME = /^[A-Za-z0-9._-]{1,40}$/;
const VERSION = /^[0-9A-Za-z.+-]{1,20}$/;
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g;
const LABEL_MAX = 120;

const STATUSES = ["busy", "idle", "waiting", "unknown"];
const LIVENESS = ["alive", "unknown"];
const REPO_STATUSES = ["git", "not-git", "error"];

const SELF_FLAG_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function buildArgv(sessionId: string): string[] {
  const argv = ["claude-sessions", "--json"];
  if (SELF_FLAG_UUID.test(sessionId)) argv.push("--self", sessionId);
  return argv;
}

const unavailable = (message: string): ListView => ({
  kind: "unavailable",
  message,
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const known = (value: unknown, set: string[], fallback: string): string =>
  typeof value === "string" && set.includes(value) ? value : fallback;

const clean = (value: unknown): string =>
  typeof value === "string"
    ? value.replace(CONTROL, "").slice(0, LABEL_MAX)
    : "-";

function fillTextOf(row: Record<string, unknown>): string | null {
  if (row.isSelf === true) return null;
  const id = row.sessionId;
  if (typeof id !== "string" || !UUID.test(id)) return null;
  if (row.duplicateName === true) return ` [session: ${id}] `;
  if (row.addressable !== true) return null;
  const name = row.name;
  if (typeof name !== "string" || !NAME.test(name)) return null;
  return ` [session: ${name} ${id.slice(0, 8)}] `;
}

function labelOf(row: Record<string, unknown>): string {
  const name =
    typeof row.name === "string" && row.name !== ""
      ? clean(row.name)
      : "(名前なし)";
  const id8 =
    typeof row.sessionId === "string" ? clean(row.sessionId.slice(0, 8)) : "-";
  const liveness = known(row.liveness, LIVENESS, "unknown");
  const repoStatus = known(row.repoStatus, REPO_STATUSES, "error");
  const parts = [
    row.isSelf === true ? "*" : " ",
    name,
    known(row.status, STATUSES, "unknown"),
    ...(liveness === "alive" ? [] : [liveness]),
    ...(repoStatus === "error" ? [repoStatus] : []),
    id8,
    clean(row.branch),
    clean(row.worktree),
  ];
  return parts.join(" ");
}

function notesOf(
  list: Record<string, unknown>,
  selfRequested: boolean,
): string[] {
  const notes: string[] = [];
  const { skipped, shapeSuspect, selfFound, runningVersion, verifiedWith } =
    list;
  if (typeof skipped === "number" && Number.isFinite(skipped) && skipped > 0) {
    notes.push(`読めなかったファイル ${Math.floor(skipped)} 件`);
  }
  if (shapeSuspect === true) notes.push("sessions の形が変わった疑い");
  if (selfRequested && selfFound === false)
    notes.push("自分の行が見つからない");
  if (
    typeof runningVersion === "string" &&
    typeof verifiedWith === "string" &&
    VERSION.test(runningVersion) &&
    VERSION.test(verifiedWith) &&
    runningVersion !== verifiedWith
  ) {
    notes.push(`契約は ${verifiedWith} で確かめた。今は ${runningVersion}`);
  }
  return notes;
}

export function readList(run: Run, selfRequested: boolean): ListView {
  if (run === "spawn-failed")
    return unavailable("一覧を取得できない（起動できない）");
  if (run.exitCode !== 0) {
    return unavailable(`一覧を取得できない（終了コード ${run.exitCode}）`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(run.stdout);
  } catch {
    return unavailable("一覧を取得できない（出力を読めない）");
  }
  if (!isRecord(parsed))
    return unavailable("一覧を取得できない（出力を読めない）");
  if (parsed.schemaVersion !== 1) {
    return unavailable(
      "取得できない（版違い）。引数なしの `chezmoi apply` の後に Mod の再読み込みかセッションの再起動",
    );
  }
  if (!Array.isArray(parsed.sessions)) {
    return unavailable("一覧を取得できない（出力を読めない）");
  }
  const rows = parsed.sessions.filter(isRecord).map((row) => ({
    label: labelOf(row),
    isSelf: row.isSelf === true,
    fillText: fillTextOf(row),
  }));
  return { kind: "ok", rows, notes: notesOf(parsed, selfRequested) };
}
