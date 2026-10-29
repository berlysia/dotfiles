import { deepStrictEqual, strictEqual } from "node:assert";
import { it } from "node:test";
import {
  parseDsclHome,
  parseGetentHome,
  resolvePasswdHome,
  type RunCommand,
} from "../../lib/dotfiles-feedback/home.ts";

const FIXED = { PATH: "/usr/bin:/bin", LANG: "C" };

function recorder(outputs: Record<string, string>) {
  const calls: { file: string; args: readonly string[]; env: object }[] = [];
  const run: RunCommand = (file, args, env) => {
    calls.push({ file, args, env });
    return { code: 0, stdout: outputs[file] ?? "" };
  };
  return { calls, run };
}

it("parses a getent line", () => {
  strictEqual(parseGetentHome("u:x:1000:1000::/home/u:/bin/zsh\n"), "/home/u");
});
it("rejects malformed getent lines", () => {
  for (const line of [
    "",
    "u:x:1000:1000:/home/u:/bin/zsh",
    "u:x:1000:1000::home/u:/bin/zsh",
    "u:x:1000:1000:::/bin/zsh",
    "a:x:1:1::/a:/b\nc:x:2:2::/c:/d",
  ])
    strictEqual(parseGetentHome(line), null, line);
});
it("parses dscl output", () => {
  strictEqual(parseDsclHome("NFSHomeDirectory: /Users/u\n"), "/Users/u");
});
it("rejects malformed dscl output", () => {
  for (const out of ["NFSHomeDirectory:", "RealName: u", "NFSHomeDirectory: u"])
    strictEqual(parseDsclHome(out), null, out);
});
it("calls getent by absolute path with a fixed environment on linux", () => {
  const { calls, run } = recorder({
    "/usr/bin/getent": "u:x:1000:1000::/home/u:/bin/zsh\n",
  });
  deepStrictEqual(resolvePasswdHome(run, "linux", 1000), {
    ok: true,
    home: "/home/u",
  });
  deepStrictEqual(calls, [
    { file: "/usr/bin/getent", args: ["passwd", "1000"], env: FIXED },
  ]);
});
it("calls id then dscl on darwin", () => {
  const { calls, run } = recorder({
    "/usr/bin/id": "u\n",
    "/usr/bin/dscl": "NFSHomeDirectory: /Users/u\n",
  });
  deepStrictEqual(resolvePasswdHome(run, "darwin", 501), {
    ok: true,
    home: "/Users/u",
  });
  deepStrictEqual(calls, [
    { file: "/usr/bin/id", args: ["-un"], env: FIXED },
    {
      file: "/usr/bin/dscl",
      args: [".", "-read", "/Users/u", "NFSHomeDirectory"],
      env: FIXED,
    },
  ]);
});
it("does not call dscl when id output is empty or has a slash", () => {
  for (const name of ["", "\n", "a/b\n"]) {
    const { calls, run } = recorder({ "/usr/bin/id": name });
    strictEqual(resolvePasswdHome(run, "darwin", 501).ok, false);
    strictEqual(calls.length, 1);
  }
});
it("fails on a non-zero exit and on unknown platforms", () => {
  strictEqual(
    resolvePasswdHome(() => ({ code: 2, stdout: "u:x:1:1::/h:/s" }), "linux", 1)
      .ok,
    false,
  );
  strictEqual(
    resolvePasswdHome(() => ({ code: 0, stdout: "" }), "win32", 1).ok,
    false,
  );
});
