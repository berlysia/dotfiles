// os.userInfo().homedir は bun では HOME を読むため使わない。HOME を差し替えられると
// spool の場所が動く。passwd を直接引く。
export type HomeResult =
  | { ok: true; home: string }
  | { ok: false; reason: string };
export type RunCommand = (
  file: string,
  args: readonly string[],
  env: Readonly<Record<string, string>>,
) => { code: number | null; stdout: string };

// PATH の差し替えで偽物を呼ばせないため、環境は固定する。
const FIXED_ENV: Readonly<Record<string, string>> = {
  PATH: "/usr/bin:/bin",
  LANG: "C",
};

function absolutePath(value: string): string | null {
  return value.startsWith("/") && !/[\0\r\n]/.test(value) ? value : null;
}

export function parseGetentHome(output: string): string | null {
  const lines = output.replace(/\n$/, "").split("\n");
  if (lines.length !== 1) return null;
  const fields = (lines[0] ?? "").split(":");
  if (fields.length !== 7) return null;
  return absolutePath(fields[5] ?? "");
}

export function parseDsclHome(output: string): string | null {
  for (const line of output.split("\n")) {
    const match = /^NFSHomeDirectory: (.+)$/.exec(line);
    if (match) return absolutePath(match[1] ?? "");
  }
  return null;
}

export function resolvePasswdHome(
  run: RunCommand,
  platform: string,
  uid: number,
): HomeResult {
  if (platform === "linux") {
    const result = run("/usr/bin/getent", ["passwd", String(uid)], FIXED_ENV);
    const home = result.code === 0 ? parseGetentHome(result.stdout) : null;
    return home
      ? { ok: true, home }
      : { ok: false, reason: "passwd からホームを取得できない (getent)" };
  }
  if (platform === "darwin") {
    const named = run("/usr/bin/id", ["-un"], FIXED_ENV);
    const name = named.stdout.trim();
    if (named.code !== 0 || name === "" || name.includes("/"))
      return { ok: false, reason: "ユーザー名を取得できない (id)" };
    const result = run(
      "/usr/bin/dscl",
      [".", "-read", `/Users/${name}`, "NFSHomeDirectory"],
      FIXED_ENV,
    );
    const home = result.code === 0 ? parseDsclHome(result.stdout) : null;
    return home
      ? { ok: true, home }
      : {
          ok: false,
          reason: "ディレクトリサービスからホームを取得できない (dscl)",
        };
  }
  return { ok: false, reason: `未対応のプラットフォーム: ${platform}` };
}
