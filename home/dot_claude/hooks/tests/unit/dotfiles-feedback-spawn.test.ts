import { deepStrictEqual, strictEqual } from "node:assert";
import { EventEmitter } from "node:events";
import { it, mock } from "node:test";
import {
  flushArgv,
  refreshArgv,
  spawnDetached,
} from "../../lib/dotfiles-feedback/spawn.ts";
it("spawn: fixed argv and detached process with ignored stdio", async () => {
  const argv = flushArgv("/cli.ts");
  deepStrictEqual(argv, [process.execPath, "/cli.ts", "flush"]);
  let unrefs = 0;
  strictEqual(
    await spawnDetached(argv, (file, args, options) => {
      strictEqual(file, process.execPath);
      deepStrictEqual(args, ["/cli.ts", "flush"]);
      deepStrictEqual(options, {
        detached: true,
        stdio: "ignore",
        shell: false,
      });
      const child = Object.assign(new EventEmitter(), {
        unref: () => {
          unrefs++;
        },
      });
      queueMicrotask(() => child.emit("spawn"));
      return child;
    }),
    true,
  );
  strictEqual(unrefs, 1);
});
it("spawn: synchronous and asynchronous failures return false", async () => {
  strictEqual(
    await spawnDetached(["missing"], () => {
      throw new Error("missing");
    }),
    false,
  );
  strictEqual(
    await spawnDetached(["missing"], () => {
      const child = Object.assign(new EventEmitter(), { unref: () => {} });
      queueMicrotask(() => child.emit("error", new Error("ENOENT")));
      return child;
    }),
    false,
  );
  strictEqual(await spawnDetached([]), false);
});
it("spawn: refreshArgv has the same shape as flushArgv", () =>
  deepStrictEqual(refreshArgv("/x/cli.ts"), [
    process.execPath,
    "/x/cli.ts",
    "refresh",
  ]));
it("spawn: gives up after one second when neither spawn nor error arrives", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    let unrefs = 0;
    let settled: boolean | undefined;
    const pending = spawnDetached(["x"], () =>
      Object.assign(new EventEmitter(), {
        unref: () => {
          unrefs++;
        },
      }),
    ).then((value) => (settled = value));
    await Promise.resolve();
    mock.timers.tick(999);
    await Promise.resolve();
    strictEqual(settled, undefined);
    mock.timers.tick(1);
    await pending;
    strictEqual(settled, false);
    // 遅れて起動した子が hook の終了を引き止めないようにする。
    strictEqual(unrefs, 1);
  } finally {
    mock.timers.reset();
  }
});
