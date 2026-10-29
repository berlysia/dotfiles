import type { Stats } from "node:fs";
import type { FileHandle } from "node:fs/promises";

export type GhRunResult = {
  code: number | null;
  stdout: string;
  stderr: string;
  spawnError?: string;
  timedOut?: boolean;
};

// VM が置いたファイルの名前は UTF-8 とは限らない。文字列に直すと実体を引けなくなるので、
// 置き場に触れる操作は Buffer のパスも受ける。
export type FsPath = string | Buffer;

export type FeedbackFs = {
  mkdir(
    path: string,
    options: { mode: number; recursive: true },
  ): Promise<string | undefined>;
  open(
    path: FsPath,
    flags: number | string,
    mode?: number,
  ): Promise<FileHandle>;
  rename(from: FsPath, to: FsPath): Promise<void>;
  link(from: string, to: string): Promise<void>;
  unlink(path: FsPath): Promise<void>;
  rmdir(path: FsPath): Promise<void>;
  readFile(path: string, encoding: "utf8"): Promise<string>;
  lstat(path: FsPath): Promise<Stats>;
  readdir(path: string): Promise<string[]>;
  // bun 1.4.4 では opendir の encoding: "buffer" で Dirent.name が undefined になるため、一覧は readdir で読む。
  readdirBuffer(path: FsPath): Promise<Buffer[]>;
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
  // VM の中の send が書く outbox のディレクトリ。
  vmOutboxDir: string;
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
