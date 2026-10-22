import { strictEqual } from "node:assert";
import { EventEmitter } from "node:events";
import { describe, it } from "node:test";
import {
  readStdinLimited,
  type ReadableLike,
} from "../../lib/read-stdin-limited.ts";

class FakeStream extends EventEmitter {
  destroyed = false;
  destroy() {
    this.destroyed = true;
  }
}
const asStream = (s: FakeStream) => s as unknown as ReadableLike;

describe("readStdinLimited", () => {
  it("returns the text when the stream ends within the limit", async () => {
    const s = new FakeStream();
    const p = readStdinLimited(100, 1000, asStream(s));
    s.emit("data", Buffer.from("he"));
    s.emit("data", Buffer.from("llo"));
    s.emit("end");
    strictEqual(await p, "hello");
    strictEqual(s.destroyed, false);
  });
  it("returns null and destroys the stream over the limit", async () => {
    const s = new FakeStream();
    const p = readStdinLimited(4, 1000, asStream(s));
    s.emit("data", Buffer.from("12345"));
    strictEqual(await p, null);
    strictEqual(s.destroyed, true);
  });
  it("returns null when the stream never closes (watchdog)", async () => {
    const s = new FakeStream();
    // The watchdog timer is unref'd, and the fake stream holds no handle, so
    // nothing keeps the loop alive: Node 22's test runner cancels the test
    // when the loop drains. A ref'd timer stands in for the real stdin.
    const keepAlive = setTimeout(() => {}, 1000);
    try {
      strictEqual(await readStdinLimited(100, 20, asStream(s)), null);
      strictEqual(s.destroyed, true);
    } finally {
      clearTimeout(keepAlive);
    }
  });
  it("returns null on a stream error", async () => {
    const s = new FakeStream();
    const p = readStdinLimited(100, 1000, asStream(s));
    s.emit("error", new Error("boom"));
    strictEqual(await p, null);
  });
});
