import { strictEqual } from "node:assert";
import { it } from "node:test";
import { stripInvisible } from "../../lib/invisible-chars.ts";
for (const keepNewlines of [true, false]) {
  it(`strips invisible characters repeatedly (keepNewlines=${keepNewlines})`, () => {
    for (let i = 0; i < 2; i++) {
      strictEqual(
        stripInvisible("a\u200bb\u202ec\u{e0041}d", { keepNewlines }),
        "abcd",
      );
      strictEqual(
        stripInvisible("a\r\nb\tc", { keepNewlines }),
        keepNewlines ? "a\nb\tc" : "abc",
      );
    }
  });
}
