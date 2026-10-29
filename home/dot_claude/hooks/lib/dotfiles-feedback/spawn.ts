import { spawn, type SpawnOptions } from "node:child_process";

export function flushArgv(cliPath: string): string[] {
  return [process.execPath, cliPath, "flush"];
}
type SpawnImpl = (
  file: string,
  args: string[],
  options: SpawnOptions,
) => {
  unref(): void;
  once(event: string, listener: () => void): object;
};
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
      child.once("error", () => resolve(false));
      child.once("spawn", () => {
        child.unref();
        resolve(true);
      });
    });
  } catch {
    return false;
  }
}
