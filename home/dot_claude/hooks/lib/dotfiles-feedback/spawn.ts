import { spawn, type SpawnOptions } from "node:child_process";

export function flushArgv(cliPath: string): string[] {
  return [process.execPath, cliPath, "flush"];
}
export function refreshArgv(cliPath: string): string[] {
  return [process.execPath, cliPath, "refresh"];
}
type SpawnImpl = (
  file: string,
  args: string[],
  options: SpawnOptions,
) => {
  unref(): void;
  once(event: string, listener: () => void): object;
};
// SessionStart の hook から呼ぶので、spawn も error も来ないときに待ち続けない。
const SPAWN_TIMEOUT_MS = 1000;
export async function spawnDetached(
  argv: readonly string[],
  spawnImpl: SpawnImpl = spawn,
): Promise<boolean> {
  if (!argv[0]) return false;
  try {
    const child = spawnImpl(argv[0], argv.slice(1), {
      detached: true,
      stdio: "ignore",
      shell: false,
    });
    return await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        // 遅れて起動した子が親の終了を引き止めないようにする。
        child.unref();
        resolve(false);
      }, SPAWN_TIMEOUT_MS);
      child.once("error", () => {
        clearTimeout(timer);
        resolve(false);
      });
      child.once("spawn", () => {
        clearTimeout(timer);
        child.unref();
        resolve(true);
      });
    });
  } catch {
    return false;
  }
}
