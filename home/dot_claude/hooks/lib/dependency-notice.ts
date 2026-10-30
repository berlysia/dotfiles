import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { findMountsUnder } from "./claude-worktree.ts";

type PackageManager = "pnpm" | "bun" | "npm" | "yarn";

export type DependencyNoticeFileSystem = {
  statSync(path: string): { isDirectory(): boolean; isFile(): boolean };
  readdirSync(path: string): string[];
  readFileSync(path: string, encoding: "utf8"): string;
};

export type DependencyNoticeOptions = {
  audience?: "session" | "subagent";
  mountinfo?: string;
  vmMarkerPath?: string | null;
};

type InstallResolution =
  | {
      kind: "install";
      manager: PackageManager;
      command: string;
      wouldWriteLockfile: boolean;
    }
  | { kind: "conflict"; lockfiles: string[] };

const fileSystem: DependencyNoticeFileSystem = {
  statSync,
  readdirSync,
  readFileSync,
};
const DEFAULT_VM_MARKER = "/etc/agent-vm";
const MOUNTINFO_PATH = "/proc/self/mountinfo";

const lockfiles = [
  { name: "pnpm-lock.yaml", manager: "pnpm" },
  { name: "bun.lock", manager: "bun" },
  { name: "bun.lockb", manager: "bun" },
  { name: "package-lock.json", manager: "npm" },
  { name: "npm-shrinkwrap.json", manager: "npm" },
  { name: "yarn.lock", manager: "yarn" },
] as const satisfies readonly { name: string; manager: PackageManager }[];

const commands: Record<PackageManager, { locked: string; unlocked: string }> = {
  pnpm: {
    locked: "pnpm install --frozen-lockfile",
    unlocked: "pnpm install",
  },
  bun: {
    locked: "bun install --frozen-lockfile",
    unlocked: "bun install",
  },
  npm: { locked: "npm ci", unlocked: "npm install" },
  yarn: { locked: "yarn install", unlocked: "yarn install" },
};

function isPackageManager(value: string | undefined): value is PackageManager {
  return (
    value === "pnpm" || value === "bun" || value === "npm" || value === "yarn"
  );
}

function readDeclaredManager(
  packageJsonPath: string,
  fs: DependencyNoticeFileSystem,
): PackageManager | null {
  let manifest: unknown;
  try {
    manifest = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
  } catch (error) {
    if (error instanceof SyntaxError) return null;
    throw error;
  }
  if (
    manifest === null ||
    typeof manifest !== "object" ||
    Array.isArray(manifest)
  ) {
    return null;
  }

  const value = "packageManager" in manifest ? manifest.packageManager : null;
  if (typeof value !== "string") return null;
  const manager = /^([a-z]+)@/.exec(value)?.[1];
  return isPackageManager(manager) ? manager : null;
}

function installResolution(
  manager: PackageManager,
  hasLockfile: boolean,
): InstallResolution {
  return {
    kind: "install",
    manager,
    command: hasLockfile
      ? commands[manager].locked
      : commands[manager].unlocked,
    wouldWriteLockfile: !hasLockfile,
  };
}

export function resolveInstall(
  dir: string,
  fs: DependencyNoticeFileSystem = fileSystem,
): InstallResolution | null {
  const packageJsonPath = join(dir, "package.json");
  if (!isExistingFile(packageJsonPath, fs)) return null;

  const declaredManager = readDeclaredManager(packageJsonPath, fs);
  if (declaredManager) {
    const hasLockfile = lockfiles.some(
      (lockfile) =>
        lockfile.manager === declaredManager &&
        isExistingFile(join(dir, lockfile.name), fs),
    );
    return installResolution(declaredManager, hasLockfile);
  }

  const foundLockfiles = lockfiles.filter((lockfile) =>
    isExistingFile(join(dir, lockfile.name), fs),
  );
  const managers = new Set(foundLockfiles.map((lockfile) => lockfile.manager));
  if (managers.size === 0) return null;
  if (managers.size > 1) {
    return {
      kind: "conflict",
      lockfiles: foundLockfiles.map((lockfile) => lockfile.name),
    };
  }

  const manager = foundLockfiles[0]?.manager;
  return manager ? installResolution(manager, true) : null;
}

function isExistingFile(path: string, fs: DependencyNoticeFileSystem): boolean {
  return readPathStat(path, fs)?.isFile() ?? false;
}

function readPathStat(
  path: string,
  fs: DependencyNoticeFileSystem,
): { isDirectory(): boolean; isFile(): boolean } | null {
  try {
    return fs.statSync(path);
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error.code === "ENOENT" || error.code === "ENOTDIR")
    ) {
      return null;
    }
    throw error;
  }
}

function containsControlCharacters(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f)) {
      return true;
    }
  }
  return false;
}

export function buildDependencyNotice(
  dir: string,
  fs: DependencyNoticeFileSystem = fileSystem,
  options: DependencyNoticeOptions = {},
): string | null {
  // Advice only: the origin branch's package.json scripts can run during install (ADR-0033 D5).
  try {
    if (containsControlCharacters(dir)) return null;
    if (!isExistingFile(join(dir, "package.json"), fs)) return null;

    const nodeModules = join(dir, "node_modules");
    const incompleteMarker = join(nodeModules, ".git-worktree-deps-incomplete");
    const incomplete = readPathStat(incompleteMarker, fs) !== null;
    const nodeModulesStat = readPathStat(nodeModules, fs);
    if (
      !incomplete &&
      nodeModulesStat !== null &&
      (!nodeModulesStat.isDirectory() || fs.readdirSync(nodeModules).length > 0)
    ) {
      return null;
    }

    // Silent without a manager: a package.json with no lockfile often has nothing to install.
    const resolution = resolveInstall(dir, fs);
    if (!resolution) return null;
    const prefix = `[deps] Dependencies are not installed in ${JSON.stringify(dir)}; tests and typecheck will fail.`;
    if (incomplete) {
      const retry = `git-worktree-deps ${shellQuote(dir)}`;
      const instruction = `The previous install did not finish; rerun \`${retry}\` to prepare dependencies.`;
      return `${prefix} ${
        options.audience === "subagent"
          ? `When you need to run tests or typecheck, ${instruction}`
          : instruction
      }`;
    }

    const vmMarkerPath =
      options.vmMarkerPath === undefined
        ? process.env.AGENT_VM_MARKER || DEFAULT_VM_MARKER
        : options.vmMarkerPath;
    if (vmMarkerPath !== null && readPathStat(vmMarkerPath, fs) !== null) {
      let mountinfo: string;
      try {
        mountinfo =
          options.mountinfo !== undefined
            ? options.mountinfo
            : fs.readFileSync(MOUNTINFO_PATH, "utf8");
      } catch {
        mountinfo = "";
      }
      if (findMountsUnder(mountinfo, [nodeModules]) !== "mounted") {
        const attach = `agent-vm-node-modules attach ${shellQuote(dir)}`;
        return `${prefix} Do not install until \`${attach}\` succeeds; the VM node_modules mount is not confirmed.`;
      }
    }

    const lead =
      options.audience === "subagent"
        ? "When you need to run tests or typecheck, "
        : "";
    if (resolution.kind === "conflict") {
      return `${prefix} ${lead}Conflicting lockfiles found: ${resolution.lockfiles.join(", ")}; install with the project's package manager.`;
    }
    if (resolution.wouldWriteLockfile) {
      return `${prefix} ${lead}No ${resolution.manager} lockfile is present; \`${resolution.command}\` would write a lockfile.`;
    }
    return `${prefix} ${lead}${options.audience === "subagent" ? "run" : "Run"} \`${resolution.command}\`.`;
  } catch {
    return null;
  }
}

function shellQuote(text: string): string {
  return `'${text.replace(/'/g, `'\\''`)}'`;
}
