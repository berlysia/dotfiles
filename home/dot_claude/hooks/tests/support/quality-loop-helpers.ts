import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const tempDirs: string[] = [];

/** Removes every dir makeDir created; register with after() in each test file. */
export function cleanupTempDirs(): void {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
}

export function makeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ql-"));
  tempDirs.push(dir);
  return dir;
}

export function writeFile(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

export function installBin(root: string, tool: string, script: string): string {
  const bin = join(root, "node_modules", ".bin", tool);
  writeFile(bin, `#!/bin/sh\n${script}\n`);
  chmodSync(bin, 0o755);
  return bin;
}

export function setupFormatRepo(): { root: string; file: string } {
  const root = makeDir();
  const file = join(root, "a.ts");
  writeFile(file, "const a=1\n");
  return { root, file };
}
