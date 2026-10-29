import type { Stats } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import type { FeedbackError } from "./cache.ts";

export type GhResult =
  | { ok: true; stdout: string; stderr: string; exitCode: number }
  | {
      ok: false;
      stdout: string;
      stderr: string;
      exitCode: number | null;
      error: FeedbackError;
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
  ): Promise<GhResult>;
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
