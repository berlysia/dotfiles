import { strictEqual } from "node:assert";
import { describe, it } from "node:test";
import { isDangerousWritePath } from "../../lib/dangerous-write-paths.ts";

describe("isDangerousWritePath", () => {
  const cases: Array<[string, boolean]> = [
    ["/etc/hosts", true],
    ["/usr/local/x", true],
    ["/bin/sh", true],
    ["/sbin/x", true],
    ["/home/u/.ssh/config", true],
    ["/home/u/.gnupg/x", true],
    ["/home/u/p/.aws/config", true],
    ["/home/u/p/credentials.json", true],
    ["/home/u/p/.env", true],
    ["/home/u/p/.env.example", true],
    ["/home/u/p/src/a.ts", false],
    ["/home/u/p/environment.ts", false],
    [".env", false], // no leading slash in the raw value; the caller also checks the resolved path
  ];
  for (const [path, expected] of cases) {
    it(`${path} -> ${expected}`, () => {
      strictEqual(isDangerousWritePath(path), expected);
    });
  }
});
