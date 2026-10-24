import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, it } from "node:test";
import { scanSecrets } from "../../../japanese-check/secrets.ts";
import type { SecretKind } from "../../../japanese-check/secrets.ts";

const kindsOf = (text: string): SecretKind[] =>
  scanSecrets(text).map((hit) => hit.kind);

describe("secret shape scan", () => {
  it("reports the line and a fixed kind for each shape", () => {
    const cases: Array<[string, SecretKind]> = [
      ["key: sk-" + "Zq9".repeat(8), "openai-key"],
      ["key: sk-ant-" + "Zq9".repeat(8), "anthropic-key"],
      ["id: AKIA" + "Q7ZX".repeat(4), "aws-key"],
      ["k: AIza" + "Qz1_".repeat(8) + "Qz1", "google-key"],
      ["t: ghp_" + "Qz1".repeat(12), "github-token"],
      ["t: github_pat_" + "Qz1_".repeat(6), "github-token"],
      ["t: glpat-" + "Qz1_".repeat(5), "gitlab-token"],
      ["t: xoxb-" + "Qz1".repeat(5), "slack-token"],
      ["t: eyJ" + "Qz1".repeat(5) + "." + "Qz1".repeat(5), "jwt"],
      ["Authorization: Bearer abcdef", "authorization-header"],
      ["authorization:basic dXNlcjpwYXNz", "authorization-header"],
      ["https://user:hunter2@example.com/path", "url-credentials"],
      ["password = 'correct-horse-battery'", "assignment"],
    ];
    for (const [text, kind] of cases) {
      assert.deepEqual(
        scanSecrets(`一行目\n${text}\n`),
        [{ line: 2, kind }],
        text,
      );
    }
  });

  it("never carries a match into the result", () => {
    const marker = "ZZ9QMARKER" + "x".repeat(30);
    const hits = scanSecrets(`token = "${marker}"\nsk-${marker}\n`);
    assert.ok(hits.length >= 2);
    assert.ok(!JSON.stringify(hits).includes("MARKER"));
  });

  it("does not report ordinary words, addresses or empty assignments", () => {
    for (const text of [
      "task-force",
      "risk-based approach",
      "xoxo",
      "token の扱いを説明する",
      "token: 説明",
      "token=",
      "user@example.com",
      "git@github.com:a/b",
      "ssh://git@github.com:22/a/b",
    ]) {
      assert.deepEqual(scanSecrets(text), [], text);
    }
  });

  it("recognises assignments by a word inside the name, with quotes and wide separators", () => {
    for (const text of [
      'OPENAI_API_KEY="abc12345"',
      '"api_key" : "x"',
      "client_secret：abcdefgh12",
      "access_token = " + "abcdefgh" + "12345",
    ]) {
      assert.deepEqual(kindsOf(text), ["assignment"], text);
    }
  });

  it("reports every line from BEGIN to the end of the file when END is missing", () => {
    const text = ["前", "-----BEGIN PRIVATE KEY-----", "a", "b", "c", "d"].join(
      "\n",
    );
    assert.deepEqual(
      scanSecrets(text).map((hit) => hit.line),
      [2, 3, 4, 5, 6],
    );
    const closed = [
      "-----BEGIN CERTIFICATE-----",
      "x",
      "-----END CERTIFICATE-----",
      "後",
    ].join("\n");
    assert.deepEqual(
      scanSecrets(closed).map((hit) => hit.line),
      [1, 2, 3],
    );
  });

  it("counts a CR as a line-end character, not a line break", () => {
    assert.deepEqual(scanSecrets("a\r\nAuthorization: Bearer abcdef\r\n"), [
      { line: 2, kind: "authorization-header" },
    ]);
  });

  it("finishes on hostile 256 KB lines and still finds a trailing secret", () => {
    const size = 256 * 1024;
    const rep = (unit: string) => unit.repeat(Math.ceil(size / unit.length));
    for (const filler of [
      "a",
      rep("password-"),
      rep("password -"),
      rep("eyJ-"),
      rep("sk-"),
      rep("://"),
      rep("İ api_key "),
    ]) {
      const hits = scanSecrets(`${filler}\nAuthorization: Bearer abcdef\n`);
      assert.ok(
        hits.some(
          (hit) => hit.line === 2 && hit.kind === "authorization-header",
        ),
      );
    }
  });
});

describe("secrets subcommand", () => {
  const root = mkdtempSync(join(tmpdir(), "japanese-check-secrets-"));
  after(() => rmSync(root, { recursive: true, force: true }));
  const source = fileURLToPath(
    new URL("../../../japanese-check/", import.meta.url),
  );
  const copy = join(root, "japanese-check");
  cpSync(source, copy, { recursive: true });
  const cli = join(copy, "cli.ts");
  const home = join(root, "home");
  mkdirSync(home);

  function run(args: string[]) {
    return spawnSync(process.execPath, [cli, "secrets", ...args], {
      encoding: "utf8",
      env: { ...process.env, HOME: home },
    });
  }

  it("prints only lines and kinds, exits 0 on a match and leaves the state directory alone", () => {
    const file = join(root, "doc.md");
    writeFileSync(file, "前置き\npassword = 'CANARYCANARYCANARY'\n");
    const before = readdirSync(home);
    const result = run([file]);
    assert.equal(result.status, 0);
    assert.deepEqual(JSON.parse(result.stdout), {
      secrets: [{ line: 2, kind: "assignment" }],
    });
    assert.ok(!(result.stdout + result.stderr).includes("CANARY"));
    assert.deepEqual(readdirSync(home), before);
  });

  it("works in a copy that has no node_modules", () => {
    const file = join(root, "plain.md");
    writeFileSync(file, "ただの文章。\n");
    const result = run([file]);
    assert.equal(result.status, 0);
    assert.deepEqual(JSON.parse(result.stdout), { secrets: [] });
  });

  it("exits with 2 for a symlink, a directory, an oversized file and a dash", () => {
    const target = join(root, "target.md");
    writeFileSync(target, "x\n");
    symlinkSync(target, join(root, "link.md"));
    mkdirSync(join(root, "adir"));
    const big = join(root, "big.md");
    writeFileSync(big, "a".repeat(256 * 1024 + 1));
    for (const path of [join(root, "link.md"), join(root, "adir"), big, "-"]) {
      assert.equal(run([path]).status, 2, path);
    }
  });
});
