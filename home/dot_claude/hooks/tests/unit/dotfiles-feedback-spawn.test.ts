import { deepStrictEqual, strictEqual } from "node:assert";
import { EventEmitter } from "node:events";
import { it } from "node:test";
import { flushArgv, spawnDetached } from "../../lib/dotfiles-feedback/spawn.ts";
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
