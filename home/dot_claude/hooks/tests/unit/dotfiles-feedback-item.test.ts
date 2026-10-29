import { deepStrictEqual, ok, strictEqual } from "node:assert";
import { it, mock } from "node:test";
import {
  newLocalId,
  normalizeField,
  parseItem,
  validateItem,
} from "../../lib/dotfiles-feedback/item.ts";
import type { FeedbackItemV1 } from "../../lib/dotfiles-feedback/item.ts";

function item(): FeedbackItemV1 {
  return {
    schemaVersion: 1,
    id: "20261029T000000Z-012345abcdef",
    createdAt: "2026-10-29T00:00:00Z",
    title: "不具合",
    target: "hook",
    kind: "bug",
    body: "本文\n\tコード",
    source: {
      agent: "codex",
      repoKey: "github.com/owner/repo",
      host: "machine",
      vm: false,
    },
  };
}
for (const field of ["body", "title", "target"] as const) {
  for (const secret of [
    `ghp_${"A".repeat(36)}`,
    "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signature",
    "-----BEGIN PRIVATE KEY-----secret-----END PRIVATE KEY-----",
    "API_KEY=xyz",
  ]) {
    it(`redacts ${secret.slice(0, 12)} in ${field}`, () => {
      const result = normalizeField(secret, field);
      ok(result.ok);
      strictEqual(result.value, "[REDACTED]");
      strictEqual(result.redacted, true);
    });
  }
}
for (const field of [
  "title",
  "target",
  "body",
  "reason",
  "repoKey",
  "host",
] as const) {
  it(`normalizes ${field} idempotently and rejects unknown secrets`, () => {
    const result = normalizeField("Ａ\u200b文\u202e\u{e0041}", field);
    ok(result.ok);
    deepStrictEqual(result, { ok: true, value: "A文", redacted: false });
    deepStrictEqual(normalizeField(result.value, field), result);
    strictEqual(normalizeField("Ab9c".repeat(10), field).ok, false);
    strictEqual(normalizeField("", field).ok, false);
    if (field !== "body") {
      strictEqual(normalizeField("a\nb", field).ok, false);
      strictEqual(normalizeField("a\rb", field).ok, false);
    }
  });
}
for (const [field, limit] of [
  ["title", 80],
  ["target", 200],
  ["reason", 500],
  ["repoKey", 200],
  ["host", 100],
] as const) {
  it(`enforces the ${field} length without truncating`, () => {
    strictEqual(normalizeField("あ".repeat(limit), field).ok, true);
    strictEqual(normalizeField("あ".repeat(limit + 1), field).ok, false);
  });
}
it("enforces body bytes after normalization and redaction", () => {
  strictEqual(normalizeField("a".repeat(8192), "body").ok, true);
  strictEqual(normalizeField("a".repeat(8193), "body").ok, false);
  strictEqual(normalizeField(`${"あ".repeat(2730)}ab`, "body").ok, true);
  strictEqual(normalizeField("あ".repeat(2731), "body").ok, false);
  const result = normalizeField("a\r\nb\tc", "body");
  ok(result.ok);
  strictEqual(result.value, "a\nb\tc");
});
it("accepts normalized local and VM items", () => {
  deepStrictEqual(validateItem(item()), { kind: "ok", item: item() });
  const vm = item();
  vm.id = `vm-${"a".repeat(24)}`;
  vm.source.vm = true;
  vm.source.agent = "unknown";
  vm.source.reportedAgent = "opencode";
  vm.source.repoKey = null;
  strictEqual(validateItem(vm).kind, "ok");
});
it("rejects non-normalized data in every text field", () => {
  for (const field of ["title", "target", "body"] as const) {
    deepStrictEqual(
      validateItem({ ...item(), [field]: `ghp_${"A".repeat(36)}` }),
      { kind: "invalid", reason: "not-normalized" },
    );
  }
  for (const field of ["host", "repoKey"] as const) {
    deepStrictEqual(
      validateItem({ ...item(), source: { ...item().source, [field]: "Ａ" } }),
      { kind: "invalid", reason: "not-normalized" },
    );
  }
});
for (const [name, value] of [
  ["unknown field", { ...item(), extra: true }],
  ["source extra", { ...item(), source: { ...item().source, x: true } }],
  ["missing title", { ...item(), title: undefined }],
  ["missing source", { ...item(), source: undefined }],
  ["bad source", { ...item(), source: [] }],
  [
    "missing repoKey",
    { ...item(), source: { agent: "codex", host: "host", vm: false } },
  ],
  ["bad agent", { ...item(), source: { ...item().source, agent: "x" } }],
  [
    "bad reportedAgent",
    { ...item(), source: { ...item().source, reportedAgent: "x" } },
  ],
  ["bad kind", { ...item(), kind: "x" }],
  ["bad id", { ...item(), id: "../x" }],
  ["bad date", { ...item(), createdAt: "2026-13-45T00:00:00Z" }],
  ["nonexistent date", { ...item(), createdAt: "2026-02-30T00:00:00Z" }],
  ["millisecond date", { ...item(), createdAt: "2026-10-29T00:00:00.000Z" }],
  ["VM mismatch", { ...item(), id: `vm-${"a".repeat(24)}` }],
  ["local mismatch", { ...item(), source: { ...item().source, vm: true } }],
  ["null", null],
  ["array", []],
] as const) {
  it(`rejects ${name}`, () => strictEqual(validateItem(value).kind, "invalid"));
}
it("parses versions and malformed input without throwing", () => {
  deepStrictEqual(parseItem(JSON.stringify(item())), {
    kind: "ok",
    item: item(),
  });
  deepStrictEqual(parseItem('{"schemaVersion":2,"extra":true}'), {
    kind: "newer",
  });
  for (const raw of [
    "{",
    "null",
    "1",
    '"text"',
    "[]",
    '{"schemaVersion":1.5}',
    '{"schemaVersion":"2"}',
    '{"schemaVersion":0}',
  ])
    strictEqual(parseItem(raw).kind, "invalid");
});
it("creates an id with the UTC second and six random bytes", () => {
  let requested = 0;
  strictEqual(
    newLocalId(new Date("2026-10-29T12:34:56.789Z"), (size) => {
      requested = size;
      return Uint8Array.from([0, 1, 2, 0xab, 0xcd, 0xef]);
    }),
    "20261029T123456Z-000102abcdef",
  );
  strictEqual(requested, 6);
});

it("re-normalizes characters joined by invisible removal", () => {
  for (const field of [
    "title",
    "target",
    "body",
    "reason",
    "repoKey",
    "host",
  ] as const) {
    const result = normalizeField("A\u200b\u030a", field);
    ok(result.ok);
    strictEqual(result.value, "Å");
    strictEqual(normalizeField(result.value, field).ok, true);
    deepStrictEqual(normalizeField(result.value, field), result);
  }
});

it("rejects sanitize exceptions", () => {
  const replacement = mock.method(globalThis, "RegExp", function () {
    throw new Error("sanitize unavailable");
  });
  try {
    deepStrictEqual(normalizeField("text", "body"), {
      ok: false,
      reason: "body: sanitize",
    });
  } finally {
    replacement.mock.restore();
  }
});
