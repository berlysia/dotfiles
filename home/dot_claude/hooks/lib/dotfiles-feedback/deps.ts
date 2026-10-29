import type { Stats } from "node:fs";
import type { FileHandle } from "node:fs/promises";

export type GhRunResult = {
  code: number | null;
  stdout: string;
  stderr: string;
  spawnError?: string;
  timedOut?: boolean;
};

export type FeedbackFs = {
  mkdir(
    path: string,
    options: { mode: number; recursive: true },
  ): Promise<string | undefined>;
  open(
    path: string,
    flags: number | string,
    mode?: number,
  ): Promise<FileHandle>;
  rename(from: string, to: string): Promise<void>;
  link(from: string, to: string): Promise<void>;
  unlink(path: string): Promise<void>;
  readFile(path: string, encoding: "utf8"): Promise<string>;
  lstat(path: string): Promise<Stats>;
  readdir(path: string): Promise<string[]>;
  utimes(path: string, atime: Date, mtime: Date): Promise<void>;
};

export type FeedbackDeps = {
  root: string;
  home: string;
  uid: number;
  fs: FeedbackFs;
  repo: string;
  runGh(
    argv: readonly string[],
    options: {
      stdin?: string;
      timeoutMs: number;
      env: Readonly<Record<string, string>>;
    },
  ): Promise<GhRunResult>;
  spawnFlush(): Promise<boolean>;
  now(): Date;
  randomBytes(size: number): Uint8Array;
  hostname(): string;
  pid: number;
  isPidAlive(pid: number): boolean | null;
  getPidStartTime(pid: number): Promise<string | null>;
  isVm: boolean;
  readStdin(): Promise<string>;
  envNames: readonly string[];
  resolveRepoKey(cwd: string): Promise<string | null>;
};

// 対話や端末に触れる部品。triage と CLI だけが受ける。gh・spool・flush などは参照しない。
export type InteractiveDeps = {
  cwd: string;
  stdinIsTty: boolean;
  stdoutIsTty: boolean;
  editor: string | undefined;
  runEditor(argv: readonly string[]): Promise<number | null>;
  makeTempDir(): Promise<string>;
  removeTree(path: string): Promise<void>;
  confirm(text: string): Promise<boolean>;
  spawnRefresh(): Promise<boolean>;
  resolveToplevel(cwd: string): Promise<string | null>;
  realpath(path: string): Promise<string>;
};
