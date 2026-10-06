import { ok, strictEqual } from "node:assert";
import { describe, it } from "node:test";
import { checkDangerousCommand } from "../../lib/command-parsing.ts";

describe("Command Parsing Library", () => {
  describe("checkDangerousCommand", () => {
    // Issue #219: these shapes took tens of seconds with the regex versions.
    for (const [name, cmd] of [
      [
        "a long blank run inside rm -r -f",
        "rm " + " ".repeat(5000) + "-r -f x",
      ],
      [
        "a long blank run after git push",
        "git push " + " ".repeat(100000) + "x",
      ],
      ["a repeated dd word", "dd if ".repeat(16667)],
    ] as const) {
      it(`judges ${name} in linear time`, () => {
        const start = performance.now();
        strictEqual(checkDangerousCommand(cmd).isDangerous, false);
        ok(performance.now() - start < 1000);
      });
    }
  });
});
