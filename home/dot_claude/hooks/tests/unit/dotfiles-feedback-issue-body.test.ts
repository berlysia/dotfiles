import { deepStrictEqual, ok, strictEqual, throws } from "node:assert";
import { it } from "node:test";
import {
  classifyIssue,
  countOpenTargets,
  findPublicUrl,
  findTriageMarker,
  neutralizeMentions,
  parseOriginId,
  parsePublicUrlMarker,
  parseTriageMarker,
  parseMarker,
  renderIssue,
  renderOriginMarker,
  renderPublicUrlMarker,
  renderTriageMarker,
  type IssueSummary,
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

// plan-3 T2: 対象の判定と振り分けのマーカー
const owned = (overrides: Partial<IssueSummary> = {}): IssueSummary => ({
  number: 1,
  state: "open",
  title: "t",
  body: renderIssue(item()).body,
  user: "berlysia",
  labels: ["dotfiles-feedback"],
  updatedAt: "2026-10-29T00:00:00Z",
  pullRequest: false,
  ...overrides,
});
it("classifyIssue: target, unreadable and not-target", () => {
  strictEqual(classifyIssue(owned()).kind, "target");
  const newer = owned({
    body: `<!-- dotfiles-feedback id=${item().id} v=2 {} -->`,
  });
  strictEqual(classifyIssue(newer).kind, "unreadable");
  strictEqual(classifyIssue(owned({ body: "no marker" })).kind, "unreadable");
  strictEqual(classifyIssue(owned({ user: "other" })).kind, "not-target");
  strictEqual(classifyIssue(owned({ labels: [] })).kind, "not-target");
  strictEqual(classifyIssue(owned({ pullRequest: true })).kind, "not-target");
  const target = classifyIssue(owned());
  if (target.kind === "target") strictEqual(target.id, item().id);
});
it("countOpenTargets counts unreadable markers and ignores foreign issues", () => {
  const newer = owned({
    body: `<!-- dotfiles-feedback id=${item().id} v=2 {} -->`,
  });
  deepStrictEqual(
    countOpenTargets([
      owned(),
      owned({ number: 2 }),
      newer,
      owned({ body: "x" }),
      owned({ user: "other" }),
      owned({ state: "closed" }),
    ]),
    { targets: 2, unreadable: 2 },
  );
});
it("triage marker round-trips and tolerates one trailing CR", () => {
  for (const to of ["issue", "plan", "reject"] as const)
    for (const actor of ["agent", "human"] as const) {
      const text = renderTriageMarker(to, actor);
      deepStrictEqual(parseTriageMarker(`${text}\n理由: x`), { to, actor });
      deepStrictEqual(parseTriageMarker(`${text}\r\n理由`), { to, actor });
    }
  const text = renderTriageMarker("plan", "agent");
  strictEqual(parseTriageMarker(` ${text}`), null);
  strictEqual(parseTriageMarker(`x\n${text}`), null);
  strictEqual(
    parseTriageMarker("<!-- dotfiles-feedback-triage to=x actor=agent -->"),
    null,
  );
  strictEqual(parseTriageMarker(`${text}\r\r\nbody`), null);
});
it("findTriageMarker uses the oldest owner comment, ties by smaller id", () => {
  const c = (
    id: number,
    createdAt: string,
    to: "plan" | "reject",
    user = "berlysia",
  ) => ({
    id,
    user,
    createdAt,
    body: renderTriageMarker(to, "agent"),
  });
  strictEqual(
    findTriageMarker([
      c(5, "2026-10-29T02:00:00Z", "reject"),
      c(9, "2026-10-29T01:00:00Z", "plan"),
      c(1, "2026-10-29T00:00:00Z", "reject", "other"),
    ])?.to,
    "plan",
  );
  strictEqual(
    findTriageMarker([
      c(9, "2026-10-29T01:00:00Z", "plan"),
      c(2, "2026-10-29T01:00:00Z", "reject"),
    ])?.to,
    "reject",
  );
  strictEqual(findTriageMarker([]), null);
});
it("public url marker round-trips and findPublicUrl requires the owner", () => {
  const url = "https://github.com/berlysia/dotfiles/issues/12";
  strictEqual(parsePublicUrlMarker(`${renderPublicUrlMarker(url)}\r\n`), url);
  strictEqual(
    parsePublicUrlMarker(
      "<!-- dotfiles-feedback-public url=https://github.com/other/x/issues/1 -->",
    ),
    null,
  );
  const body = renderPublicUrlMarker(url);
  strictEqual(
    findPublicUrl([{ id: 1, user: "other", createdAt: "x", body }]),
    null,
  );
  strictEqual(
    findPublicUrl([{ id: 1, user: "berlysia", createdAt: "x", body }]),
    url,
  );
});
it("origin marker is recognized only as the last non-blank line", () => {
  const marker = renderOriginMarker(item().id);
  strictEqual(parseOriginId(`本文\n\n${marker}`), item().id);
  strictEqual(parseOriginId(`本文\r\n${marker}\r\n`), item().id);
  strictEqual(parseOriginId(`本文\n${marker}\n\n  \n`), item().id);
  strictEqual(parseOriginId(`本文\n${marker}\nあとに続く`), null);
  strictEqual(parseOriginId(`${marker} x`), null);
});
it("neutralizeMentions is exported", () =>
  strictEqual(neutralizeMentions("@octocat a@ b"), "＠octocat a@ b"));
