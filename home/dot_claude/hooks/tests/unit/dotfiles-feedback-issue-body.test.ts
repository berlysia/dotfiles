import { deepStrictEqual, ok, strictEqual, throws } from "node:assert";
import { it } from "node:test";
import {
  parseMarker,
  renderIssue,
} from "../../lib/dotfiles-feedback/issue-body.ts";
import type { FeedbackItemV1 } from "../../lib/dotfiles-feedback/item.ts";

function item(): FeedbackItemV1 {
  return {
    schemaVersion: 1,
    id: "20261029T000000Z-012345abcdef",
    createdAt: "2026-10-29T00:00:00Z",
    title: "不具合",
    target: "hook",
    kind: "bug",
    body: "本文",
    source: { agent: "codex", repoKey: null, host: "machine", vm: false },
  };
}
function marker(meta: object, id = item().id, version = 1): string {
  return `<!-- dotfiles-feedback id=${id} v=${version} ${JSON.stringify(meta)} -->`;
}
it("renders an escaped single comment and round-trips metadata", () => {
  const value = { ...item(), target: "--><script>&" };
  const rendered = renderIssue(value);
  deepStrictEqual(rendered.labels, ["dotfiles-feedback", "kind:bug"]);
  strictEqual(rendered.title, value.title);
  const firstLine = rendered.body.split("\n")[0] ?? "";
  strictEqual((firstLine.match(/<!--/g) ?? []).length, 1);
  strictEqual((firstLine.match(/-->/g) ?? []).length, 1);
  ok(
    firstLine.includes("\\u003c") &&
      firstLine.includes("\\u003e") &&
      firstLine.includes("\\u0026"),
  );
  deepStrictEqual(parseMarker(rendered.body), {
    status: "ok",
    id: value.id,
    v: 1,
    meta: { kind: value.kind, target: value.target, source: value.source },
  });
});
it("only reads the first line even if later lines contain markers", () => {
  const first = renderIssue(item()).body;
  const later = renderIssue({ ...item(), id: `vm-${"a".repeat(24)}` }).body;
  const result = parseMarker(`${first}\n${later}`);
  ok(result.status === "ok");
  strictEqual(result.id, item().id);
  strictEqual(parseMarker(`text\n${first}`).status, "unreadable");
});
it("neutralizes mentions in titles, targets and bodies without changing the item", () => {
  const text = "@someone (@u) a@b @org/team @-user @_name @ @あ";
  const value = { ...item(), title: text, target: text, body: text };
  const original = structuredClone(value);
  const rendered = renderIssue(value);
  const expected = "＠someone (＠u) a＠b ＠org/team ＠-user ＠_name @ @あ";
  strictEqual(rendered.title, expected);
  ok(rendered.body.includes(`対象: ${expected}\n\n${expected}`));
  strictEqual(/@[A-Za-z0-9_-]/.test(rendered.body), false);
  deepStrictEqual(value, original);
  strictEqual(parseMarker(rendered.body).status, "ok");
});
it("preserves cross references, links and images", () => {
  const body =
    "#123 owner/repo#456 [link](https://example.com) ![image](x.png)";
  ok(renderIssue({ ...item(), body }).body.endsWith(body));
});
it("ignores unknown metadata and source fields", () => {
  const value = item();
  deepStrictEqual(
    parseMarker(
      marker({
        kind: value.kind,
        target: value.target,
        source: { ...value.source, extra: "future" },
        extra: true,
      }),
    ),
    {
      status: "ok",
      id: value.id,
      v: 1,
      meta: { kind: value.kind, target: value.target, source: value.source },
    },
  );
});
it("extracts newer ids without interpreting unknown metadata", () => {
  deepStrictEqual(parseMarker(marker({}, item().id, 2)), {
    status: "newer",
    id: item().id,
    v: 2,
  });
  deepStrictEqual(parseMarker(marker({}, `vm-${"a".repeat(24)}`, 3)), {
    status: "newer",
    id: `vm-${"a".repeat(24)}`,
    v: 3,
  });
});
for (const [name, raw] of [
  ["broken", "<!-- dotfiles-feedback"],
  ["bad JSON", `<!-- dotfiles-feedback id=${item().id} v=1 {x} -->`],
  ["path id", marker({}, "../x")],
  ["bad newer id", marker({}, "../x", 2)],
  ["zero version", marker({}, item().id, 0)],
  ["bad kind", marker({ kind: "x", target: "hook", source: item().source })],
  [
    "long target",
    marker({ kind: "bug", target: "a".repeat(201), source: item().source }),
  ],
  ["empty target", marker({ kind: "bug", target: "", source: item().source })],
  ["missing source", marker({ kind: "bug", target: "hook" })],
  [
    "bad source agent",
    marker({
      kind: "bug",
      target: "hook",
      source: { ...item().source, agent: "x" },
    }),
  ],
  [
    "bad reported agent",
    marker({
      kind: "bug",
      target: "hook",
      source: { ...item().source, reportedAgent: "x" },
    }),
  ],
  [
    "long repoKey",
    marker({
      kind: "bug",
      target: "hook",
      source: { ...item().source, repoKey: "a".repeat(201) },
    }),
  ],
  [
    "long host",
    marker({
      kind: "bug",
      target: "hook",
      source: { ...item().source, host: "a".repeat(101) },
    }),
  ],
  [
    "bad vm",
    marker({
      kind: "bug",
      target: "hook",
      source: { ...item().source, vm: "false" },
    }),
  ],
] as const) {
  it(`rejects ${name}`, () =>
    strictEqual(parseMarker(raw).status, "unreadable"));
}
it("rejects invalid ids when rendering", () =>
  throws(() => renderIssue({ ...item(), id: "../x" })));

it("round-trips Unicode line separators that are not LF or CR", () => {
  const value = { ...item(), target: "a\u2028b\u2029c" };
  const result = parseMarker(renderIssue(value).body);
  ok(result.status === "ok");
  strictEqual(result.meta.target, value.target);
});
