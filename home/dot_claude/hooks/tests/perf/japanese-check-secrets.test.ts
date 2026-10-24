// Upper bounds only. Behaviour is covered in unit/japanese-check-secrets.test.ts.
import { ok } from "node:assert";
import { describe, it } from "node:test";
import { scanSecrets } from "../../../japanese-check/secrets.ts";

describe("secret shape scan time", () => {
  it("scans hostile 256 KB lines within two seconds each", () => {
    const size = 256 * 1024;
    const rep = (unit: string) => unit.repeat(Math.ceil(size / unit.length));
    const inputs: Record<string, string> = {
      a: "a".repeat(size),
      "password-": rep("password-"),
      "password -": rep("password -"),
      "eyJ-": rep("eyJ-"),
      eyJ: rep("eyJ"),
      "sk-": rep("sk-"),
      password: rep("password"),
      "token=": rep("token= "),
      "://": rep("://"),
      begin: rep("-----BEGIN "),
      "eyJ long": `eyJ${"A".repeat(size)}`,
      "token= spaces": `token=${" ".repeat(size)}`,
      İ: rep("İ api_key ").slice(0, size),
    };
    for (const [name, text] of Object.entries(inputs)) {
      const started = performance.now();
      scanSecrets(text);
      const elapsed = performance.now() - started;
      ok(elapsed < 2000, `${name}: ${elapsed} ms`);
    }
  });
});
