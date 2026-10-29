import { strictEqual, rejects } from "node:assert";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { it } from "node:test";
import {
  openRetry,
  type RetryDeps,
} from "../../lib/dotfiles-feedback/retry.ts";

const id = "20261029T100000Z-0123456789ab";
const now = new Date("2026-10-29T10:00:00Z");
for (const scenario of [
  "schedule",
  "corrupt",
  "reset",
  "busy",
  "invalid",
] as const) {
  it(`retry: ${scenario}`, async () => {
    const root = await fs.mkdtemp(
      join(import.meta.dirname, ".feedback-retry-"),
    );
    const deps: RetryDeps = {
      fs,
      now: () => now,
      pid: 1,
      randomBytes: (size) => new Uint8Array(size),
      isPidAlive: () => true,
      getPidStartTime: async () => "start",
    };
    try {
      await fs.mkdir(join(root, "state"));
      const retry = openRetry(root, deps);
      if (scenario === "corrupt") {
        for (const text of [
          "{",
          "null",
          '{"v":1,"items":[]}',
          `{"v":1,"items":{"${id}":{"attempts":-1,"nextAt":"bad"}}}`,
        ]) {
          await fs.writeFile(join(root, "state/retry.json"), text);
          strictEqual(await retry.isDue(id, now), true);
        }
        strictEqual((await retry.recordFailure(id, now)).attempts, 1);
      } else if (scenario === "busy") {
        await fs.writeFile(
          join(root, "state/retry.lock"),
          JSON.stringify({
            v: 1,
            pid: 1,
            startTime: "start",
            acquiredAt: now.toISOString(),
          }),
        );
        await rejects(retry.recordFailure(id, now), /busy/);
      } else if (scenario === "invalid") {
        await rejects(retry.reset("../x"), /invalid id/);
        await rejects(retry.isDue("x", now), /invalid id/);
      } else if (scenario === "reset") {
        await retry.recordFailure(id, now);
        await retry.reset(id);
        strictEqual(await retry.isDue(id, now), true);
        strictEqual((await retry.recordFailure(id, now)).attempts, 1);
      } else {
        strictEqual(await retry.isDue(id, now), true);
        for (let attempt = 1; attempt <= 20; attempt++) {
          const result = await retry.recordFailure(id, now);
          strictEqual(result.attempts, attempt);
          strictEqual(result.exhausted, attempt === 20);
          strictEqual(
            Date.parse(result.nextAt) - now.getTime(),
            Math.min(2 ** attempt * 60000, 6 * 3600000),
          );
          strictEqual(await retry.isDue(id, now), false);
          strictEqual(await retry.isDue(id, new Date(result.nextAt)), true);
        }
        strictEqual(
          (await fs.lstat(join(root, "state/retry.json"))).mode & 0o777,
          0o600,
        );
      }
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
}
