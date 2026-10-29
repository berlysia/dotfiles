import { deepStrictEqual, ok, strictEqual } from "node:assert";
import { createHash } from "node:crypto";
import { it } from "node:test";
import {
  MAX_VM_FILE_BYTES,
  SCHEMA_VERSION,
} from "../../lib/dotfiles-feedback/constants.ts";
import { validateItem } from "../../lib/dotfiles-feedback/item.ts";
import {
  decodeVmBytes,
  isMachineName,
  rewriteVmItem,
  vmItemId,
} from "../../lib/dotfiles-feedback/vm-item.ts";

const now = new Date("2026-10-29T10:00:00.123Z");
const bytesOf = (value: unknown) => Buffer.from(JSON.stringify(value));
const claimed = (overrides: Record<string, unknown> = {}) => ({
  schemaVersion: 1,
  id: "20261029T090000Z-0123456789ab",
  createdAt: "2026-10-29T09:00:00Z",
  title: "title",
  target: "target",
  kind: "bug",
  body: "body",
  source: {
    agent: "claude",
    repoKey: "github.com/berlysia/dotfiles",
    host: "vm-host",
    vm: true,
  },
  ...overrides,
});

it("vmItemId hashes the machine name, a NUL and the bytes", () => {
  const bytes = Buffer.from("payload");
  const expected = createHash("sha256")
    .update(Buffer.concat([Buffer.from("m"), Buffer.from([0]), bytes]))
    .digest("hex")
    .slice(0, 24);
  strictEqual(vmItemId("m", bytes), `vm-${expected}`);
  ok(vmItemId("m", bytes) !== vmItemId("n", bytes));
  ok(vmItemId("m", bytes) !== vmItemId("m", Buffer.from("payloae")));
});
it("rewrites a valid item: ids, time and source come from the host", () => {
  const bytes = bytesOf(claimed());
  const result = rewriteVmItem(bytes, "agent-x-000000", now);
  strictEqual(result.kind, "ok");
  if (result.kind !== "ok") return;
  strictEqual(result.item.id, vmItemId("agent-x-000000", bytes));
  strictEqual(result.item.createdAt, "2026-10-29T10:00:00Z");
  deepStrictEqual(result.item.source, {
    agent: "unknown",
    reportedAgent: "claude",
    host: "agent-x-000000",
    vm: true,
    repoKey: "github.com/berlysia/dotfiles",
  });
  strictEqual(validateItem(result.item).kind, "ok");
});
it("ignores the claimed id and createdAt, whatever they are", () => {
  for (const createdAt of ["2000-01-01T00:00:00Z", "2999-01-01T00:00:00Z", 7]) {
    const result = rewriteVmItem(
      bytesOf(claimed({ createdAt, id: "vm-000000000000000000000000" })),
      "m",
      now,
    );
    strictEqual(result.kind, "ok");
    if (result.kind === "ok")
      strictEqual(result.item.createdAt, "2026-10-29T10:00:00Z");
  }
});
it("omits a reportedAgent outside the enumeration and nulls a bad repoKey", () => {
  const result = rewriteVmItem(
    bytesOf(
      claimed({
        source: { agent: "root", repoKey: "a\nb", host: "h", vm: true },
      }),
    ),
    "m",
    now,
  );
  strictEqual(result.kind, "ok");
  if (result.kind !== "ok") return;
  strictEqual("reportedAgent" in result.item.source, false);
  strictEqual(result.item.source.repoKey, null);
  strictEqual(result.item.source.agent, "unknown");
});
it("rejects items that fail the K2 checks without throwing", () => {
  const cases: unknown[] = [
    claimed({ title: "" }),
    claimed({ kind: "other" }),
    claimed({ body: "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8s9T0" }),
    claimed({ title: "a\nb" }),
    claimed({ extra: 1 }),
    claimed({ source: { agent: "claude", repoKey: null, host: "h", x: 1 } }),
    claimed({ source: null }),
    claimed({ source: [] }),
    [],
    null,
    "text",
    7,
  ];
  for (const value of cases)
    deepStrictEqual(rewriteVmItem(bytesOf(value), "m", now), {
      kind: "invalid",
    });
  deepStrictEqual(rewriteVmItem(Buffer.from("{"), "m", now), {
    kind: "invalid",
  });
});
it("rejects deeply nested arrays that fit in 16KB without throwing", () => {
  const depth = 8000;
  const bytes = Buffer.from("[".repeat(depth) + "]".repeat(depth));
  ok(bytes.length <= MAX_VM_FILE_BYTES);
  deepStrictEqual(rewriteVmItem(bytes, "m", now), { kind: "invalid" });
});
it("rejects more than 16KB even when the JSON is valid", () => {
  const exact = bytesOf(claimed());
  const padded = Buffer.concat([
    exact,
    Buffer.alloc(MAX_VM_FILE_BYTES + 1 - exact.length, 0x20),
  ]);
  strictEqual(padded.length, MAX_VM_FILE_BYTES + 1);
  deepStrictEqual(rewriteVmItem(padded, "m", now), { kind: "invalid" });
  strictEqual(
    rewriteVmItem(
      Buffer.concat([
        exact,
        Buffer.alloc(MAX_VM_FILE_BYTES - exact.length, 0x20),
      ]),
      "m",
      now,
    ).kind,
    "ok",
  );
});
it("rejects invalid UTF-8 and keeps a BOM so the JSON fails", () => {
  strictEqual(decodeVmBytes(Buffer.from([0x7b, 0xff, 0x7d])), null);
  strictEqual(decodeVmBytes(Buffer.from("ok")), "ok");
  strictEqual(decodeVmBytes(Buffer.from("﻿{}")), "﻿{}");
  const bom = Buffer.concat([
    Buffer.from([0xef, 0xbb, 0xbf]),
    bytesOf(claimed()),
  ]);
  deepStrictEqual(rewriteVmItem(bom, "m", now), { kind: "invalid" });
  deepStrictEqual(rewriteVmItem(Buffer.from([0x7b, 0xff, 0x7d]), "m", now), {
    kind: "invalid",
  });
});
it("reports a newer schemaVersion as unsupported-version", () => {
  deepStrictEqual(
    rewriteVmItem(
      bytesOf(claimed({ schemaVersion: SCHEMA_VERSION + 1 })),
      "m",
      now,
    ),
    { kind: "unsupported-version" },
  );
  strictEqual(
    rewriteVmItem(bytesOf(claimed({ schemaVersion: 0 })), "m", now).kind,
    "invalid",
  );
});
it("isMachineName accepts the agent-vm names only", () => {
  strictEqual(isMachineName("agent-x-000000"), true);
  strictEqual(isMachineName("x.y"), true);
  for (const bad of ["../x", "A", "a".repeat(64), "", "-a", "a/b", "a b"])
    strictEqual(isMachineName(bad), false, bad);
  strictEqual(rewriteVmItem(bytesOf(claimed()), "../x", now).kind, "invalid");
});
