import { randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { currentRoot } from "./worktree-locations.ts";

const TEMP_PREFIX = ".common-dir.tmp.";

export type MarkerDecision =
  | { kind: "ok-same" }
  | { kind: "ok-new" }
  | { kind: "conflict"; path: string }
  | { kind: "stale"; path: string }
  | { kind: "unmarked"; entries: number }
  | { kind: "unsafe-path"; path: string }
  | { kind: "reservation-failed" };

type ReservationOptions = {
  randomSuffix?: (attempt: number) => string;
};

function hasCode(error: Error, code: string): boolean {
  return "code" in error && error.code === code;
}

function lstatOrMissing(path: string): ReturnType<typeof lstatSync> | null {
  try {
    return lstatSync(path);
  } catch (error) {
    if (error instanceof Error && hasCode(error, "ENOENT")) return null;
    throw error;
  }
}

function withinRoot(root: string, path: string): boolean {
  const child = relative(resolve(root), resolve(path));
  return (
    child !== "" &&
    child !== ".." &&
    !child.startsWith(`..${sep}`) &&
    !isAbsolute(child)
  );
}

function checkSafeTarget(
  commonDir: string,
  home: string,
  targetPath: string,
): MarkerDecision | null {
  const root = currentRoot(commonDir, home);
  const worktreesDir = join(home, "worktrees");
  let worktreesStat: ReturnType<typeof lstatSync> | null;
  try {
    worktreesStat = lstatOrMissing(worktreesDir);
  } catch {
    return { kind: "unsafe-path", path: worktreesDir };
  }
  if (worktreesStat?.isSymbolicLink()) {
    return { kind: "unsafe-path", path: worktreesDir };
  }
  if (worktreesStat && !worktreesStat.isDirectory()) {
    return { kind: "unsafe-path", path: worktreesDir };
  }
  if (resolve(targetPath) !== resolve(root) && !withinRoot(root, targetPath)) {
    return { kind: "unsafe-path", path: targetPath };
  }

  const paths = [resolve(root)];
  const child = relative(resolve(root), resolve(targetPath));
  if (child !== "") {
    let current = resolve(root);
    for (const segment of child.split(sep)) {
      current = join(current, segment);
      paths.push(current);
    }
  }
  for (const path of paths) {
    let stat: ReturnType<typeof lstatSync> | null;
    try {
      stat = lstatOrMissing(path);
    } catch {
      return { kind: "unsafe-path", path };
    }
    if (stat?.isSymbolicLink()) return { kind: "unsafe-path", path };
  }
  return null;
}

function unmarkedEntries(root: string): number | null {
  let names: string[];
  try {
    names = readdirSync(root);
  } catch (error) {
    if (error instanceof Error && hasCode(error, "ENOENT")) return 0;
    return null;
  }
  let count = 0;
  for (const name of names) {
    if (name.startsWith(TEMP_PREFIX)) {
      let stat: ReturnType<typeof lstatSync> | null;
      try {
        stat = lstatOrMissing(join(root, name));
      } catch {
        count += 1;
        continue;
      }
      // A concurrent reservation removes its temp file after linking; a name
      // that vanished between readdir and lstat is not a leftover entry.
      if (!stat) continue;
      if (stat.isFile() && !stat.isSymbolicLink()) continue;
    }
    count += 1;
  }
  return count;
}

function unmarkedDecision(root: string): MarkerDecision {
  const entries = unmarkedEntries(root);
  return entries === null
    ? { kind: "unsafe-path", path: root }
    : { kind: "unmarked", entries };
}

function firstLine(contents: string): string {
  const line = contents.split("\n", 1)[0] ?? "";
  return line.endsWith("\r") ? line.slice(0, -1) : line;
}

export function judgeMarker(commonDir: string, home: string): MarkerDecision {
  const root = currentRoot(commonDir, home);
  const unsafePath = checkSafeTarget(commonDir, home, root);
  if (unsafePath) return unsafePath;

  let ownCommonDir: string;
  try {
    ownCommonDir = realpathSync(commonDir);
  } catch {
    return { kind: "unsafe-path", path: commonDir };
  }

  let rootStat: ReturnType<typeof lstatSync> | null;
  try {
    rootStat = lstatOrMissing(root);
  } catch {
    return { kind: "unsafe-path", path: root };
  }
  if (!rootStat) return { kind: "ok-new" };
  if (rootStat.isSymbolicLink()) return { kind: "unsafe-path", path: root };
  if (!rootStat.isDirectory()) return { kind: "unmarked", entries: 1 };

  const markerPath = join(root, ".common-dir");
  let markerStat: ReturnType<typeof lstatSync> | null;
  try {
    markerStat = lstatOrMissing(markerPath);
  } catch {
    return { kind: "unsafe-path", path: markerPath };
  }
  if (!markerStat) {
    const entries = unmarkedEntries(root);
    if (entries === null) return { kind: "unsafe-path", path: root };
    if (entries === 0) return { kind: "ok-new" };
    // A concurrent reservation may have linked the marker after the lstat
    // above; the entry we counted is then the marker, so judge it instead.
    try {
      markerStat = lstatOrMissing(markerPath);
    } catch {
      return { kind: "unsafe-path", path: markerPath };
    }
    if (!markerStat) return { kind: "unmarked", entries };
  }
  if (markerStat.isSymbolicLink() || !markerStat.isFile()) {
    return unmarkedDecision(root);
  }

  let fd: number;
  try {
    fd = openSync(
      markerPath,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } catch {
    return unmarkedDecision(root);
  }
  let markerValue: string;
  try {
    if (!fstatSync(fd).isFile()) return unmarkedDecision(root);
    markerValue = firstLine(readFileSync(fd, "utf8"));
  } catch {
    return unmarkedDecision(root);
  } finally {
    closeSync(fd);
  }

  if (markerValue === ownCommonDir) return { kind: "ok-same" };
  if (
    markerValue !== "" &&
    isAbsolute(markerValue) &&
    !hasControlCharacters(markerValue) &&
    existsSync(join(markerValue, "HEAD"))
  ) {
    let physicalMarkerDir = markerValue;
    try {
      physicalMarkerDir = realpathSync(markerValue);
    } catch {
      return { kind: "stale", path: markerValue };
    }
    if (physicalMarkerDir === ownCommonDir) return { kind: "ok-same" };
    return { kind: "conflict", path: physicalMarkerDir };
  }
  return { kind: "stale", path: markerValue };
}

function displayableMarkerValue(value: string): boolean {
  return (
    value === "" ||
    (isAbsolute(value) &&
      Buffer.byteLength(value, "utf8") <= 4096 &&
      !hasControlCharacters(value))
  );
}

function quoteShellArgument(value: string): string {
  const escaped = [...value]
    .map((character) => {
      const code = character.charCodeAt(0);
      if (character === "\\") return "\\\\";
      if (character === "'") return "\\'";
      if (code < 0x20 || code === 0x7f) {
        return `\\x${code.toString(16).padStart(2, "0")}`;
      }
      return character;
    })
    .join("");
  return `$'${escaped}'`;
}

function hasControlCharacters(value: string): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code < 0x20 || (code >= 0x7f && code <= 0x9f);
  });
}

export function formatMarkerFailure(
  decision: MarkerDecision,
  commonDir: string,
  home: string,
): string {
  const root = currentRoot(commonDir, home);
  const markerPath = join(root, ".common-dir");
  switch (decision.kind) {
    case "conflict":
      return displayableMarkerValue(decision.path)
        ? `Worktree location belongs to ${decision.path}; its path cannot be changed.`
        : "Worktree location conflicts with another repository; its path cannot be changed.";
    case "stale":
      return displayableMarkerValue(decision.path)
        ? `Stale marker ${JSON.stringify(decision.path)}; inspect it, then run rm -- ${quoteShellArgument(markerPath)} in a terminal.`
        : `Stale marker content is invalid; inspect it, then run rm -- ${quoteShellArgument(markerPath)} in a terminal.`;
    case "unmarked":
      return `Worktree location has ${decision.entries} unmarked entries; inspect them, then create the marker or move ${JSON.stringify(root)}.`;
    case "unsafe-path":
      return `Worktree location is unsafe at ${JSON.stringify(decision.path)}; remove the symlink or fix the path, then retry.`;
    case "reservation-failed":
      return `Could not reserve the worktree marker at ${JSON.stringify(markerPath)}; inspect the location and retry.`;
    case "ok-same":
    case "ok-new":
      return "";
  }
}

function unlinkIfPresent(path: string): void {
  try {
    unlinkSync(path);
  } catch (error) {
    if (error instanceof Error && hasCode(error, "ENOENT")) return;
    throw error;
  }
}

export function reserveMarker(
  commonDir: string,
  home: string,
  targetPath = currentRoot(commonDir, home),
  options: ReservationOptions = {},
): MarkerDecision {
  const fail = (decision: MarkerDecision): MarkerDecision => {
    process.stderr.write(`${formatMarkerFailure(decision, commonDir, home)}\n`);
    return decision;
  };
  const unsafePath = checkSafeTarget(commonDir, home, targetPath);
  if (unsafePath) return fail(unsafePath);

  const initial = judgeMarker(commonDir, home);
  if (initial.kind === "ok-same") return initial;
  if (initial.kind !== "ok-new") return fail(initial);

  const root = currentRoot(commonDir, home);
  const markerPath = join(root, ".common-dir");
  let ownCommonDir: string;
  try {
    ownCommonDir = realpathSync(commonDir);
  } catch {
    return fail({ kind: "unsafe-path", path: commonDir });
  }
  try {
    mkdirSync(root, { recursive: true });
  } catch {
    return fail({ kind: "reservation-failed" });
  }
  const afterMkdirUnsafe = checkSafeTarget(commonDir, home, targetPath);
  if (afterMkdirUnsafe) return fail(afterMkdirUnsafe);

  let tempPath = "";
  let fd: number | null = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const suffix =
      options.randomSuffix?.(attempt) ?? randomBytes(8).toString("hex");
    if (!/^[A-Za-z0-9_-]+$/u.test(suffix)) {
      return fail({ kind: "reservation-failed" });
    }
    tempPath = join(root, `${TEMP_PREFIX}${process.pid}.${suffix}`);
    try {
      fd = openSync(
        tempPath,
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_EXCL |
          constants.O_NOFOLLOW,
        0o600,
      );
      break;
    } catch (error) {
      if (
        error instanceof Error &&
        (hasCode(error, "EEXIST") || hasCode(error, "ELOOP"))
      ) {
        continue;
      }
      return fail({ kind: "reservation-failed" });
    }
  }
  if (fd === null) return fail({ kind: "reservation-failed" });

  let result: MarkerDecision = { kind: "reservation-failed" };
  try {
    writeFileSync(fd, `${ownCommonDir}\n`, "utf8");
    closeSync(fd);
    fd = null;

    const beforeLinkUnsafe = checkSafeTarget(commonDir, home, targetPath);
    if (beforeLinkUnsafe) {
      result = beforeLinkUnsafe;
    } else {
      try {
        linkSync(tempPath, markerPath);
        const markerStat = lstatOrMissing(markerPath);
        if (markerStat?.isSymbolicLink()) {
          unlinkIfPresent(markerPath);
          result = { kind: "unsafe-path", path: markerPath };
        } else if (!markerStat?.isFile()) {
          result = { kind: "reservation-failed" };
        } else {
          result = judgeMarker(commonDir, home);
        }
      } catch {
        const afterLinkDecision = judgeMarker(commonDir, home);
        result =
          afterLinkDecision.kind === "ok-new"
            ? { kind: "reservation-failed" }
            : afterLinkDecision;
      }
    }
  } catch {
    result = { kind: "reservation-failed" };
  } finally {
    if (fd !== null) closeSync(fd);
    unlinkIfPresent(tempPath);
  }
  return result.kind === "ok-same" ? result : fail(result);
}
