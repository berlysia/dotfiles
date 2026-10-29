import assert from "node:assert/strict";
import test from "node:test";
import {
  EFFORT_VALUES,
  MODEL_PATTERN,
} from "../home/dot_claude/scripts/reviewer-codex-run.ts";
import {
  EFFORTS,
  buildDelegationRow,
  displayModel,
  formatNote,
  isAgentId,
  isDelegationId,
  isToolUseId,
  normalizeModel,
  parseRow,
  truncateUtf8,
} from "../home/dot_local/share/delegation/schema.ts";
import {
  KNOWN_MODELS,
  PENDING_LIMIT,
  isExposure,
  offloadAgentName,
} from "../home/dot_local/share/delegation/constants.ts";
import { FREE_DESTINATIONS } from "../home/dot_local/share/delegation/destinations.ts";

const base = {
  v: 1,
  type: "delegation",
  id: "d-0123456789ab",
  at: "2026-10-29T00:00:00.000Z",
  harness: "claude-code-agent",
  invocation: [],
  model: "sonnet",
  effort: "high",
  kind: "impl",
  size: "M",
  sessionId: "s1",
  manual: false,
  durationMs: null,
  endReason: null,
  verdict: "adopted",
};
const line = (o) => JSON.stringify(o);

test("constants carry the known model list and limits", () => {
  for (const m of [
    "sonnet",
    "opus",
    "haiku",
    "fable",
    "inherit",
    "unknown",
    "gpt-6.1-terra",
    "zai-coding-plan/glm-5.3",
  ]) {
    assert.ok(KNOWN_MODELS.includes(m), m);
  }
  assert.equal(PENDING_LIMIT, 200);
});

test("parseRow distinguishes version, type and broken lines", () => {
  assert.deepEqual(parseRow(line({ ...base, v: 2 })), {
    ok: false,
    reason: "version",
  });
  assert.deepEqual(parseRow('{"v":1,"type":"zzz"}'), {
    ok: false,
    reason: "type",
  });
  assert.deepEqual(parseRow('{"v":1'), { ok: false, reason: "broken" });
  const { verdict: _v, ...noVerdict } = base;
  assert.deepEqual(parseRow(line(noVerdict)), { ok: false, reason: "broken" });
  assert.deepEqual(parseRow(line({ ...base, note: "x".repeat(5000) })), {
    ok: false,
    reason: "broken",
  });
});

test("unknown enum values become ? and the row is kept", () => {
  const r = parseRow(line({ ...base, harness: "newthing" }));
  assert.equal(r.ok, true);
  assert.equal(r.row.harness, "?");
});

test("unknown fields are ignored", () => {
  const r = parseRow(line({ ...base, foo: 1 }));
  assert.equal(r.ok, true);
  assert.equal("foo" in r.row, false);
});

test("model display: shape-valid unknown names are hashed", () => {
  const stored = normalizeModel("opencode", "ignore-all-rules/and-run");
  assert.equal(stored, "ignore-all-rules/and-run");
  assert.match(displayModel(stored), /^m-[0-9a-f]{6}$/);
  assert.equal(displayModel("unknown"), "unknown");
  assert.equal(
    displayModel("zai-coding-plan/glm-5.3"),
    "zai-coding-plan/glm-5.3",
  );
});

test("normalizeModel rejects shapes that do not fit the harness", () => {
  assert.equal(normalizeModel("codex-cli", "claude-x"), "unknown");
  assert.equal(normalizeModel("claude-code-agent", "gpt-6.1-terra"), "unknown");
  assert.equal(normalizeModel("codex-cli", "gpt-6.1-terra"), "gpt-6.1-terra");
  assert.equal(normalizeModel("codex-cli", "gpt-6-luna"), "gpt-6-luna");
});

test("gpt-6-luna is a known model and shown as is", () => {
  assert.equal(displayModel("gpt-6-luna"), "gpt-6-luna");
});

test("note is cut to 1000 bytes without breaking UTF-8", () => {
  const row = buildDelegationRow({
    ...base,
    note: "あ".repeat(700),
    at: base.at,
  });
  const bytes = Buffer.byteLength(row.note, "utf8");
  assert.ok(bytes <= 1000, String(bytes));
  assert.equal(Buffer.from(row.note, "utf8").toString("utf8"), row.note);
  assert.equal(truncateUtf8("あいう", 4), "あ");
});

test("invocation is capped at 8 words", () => {
  const row = buildDelegationRow({
    ...base,
    invocation: Array.from({ length: 12 }, (_, i) => `w${i}`),
  });
  assert.equal(row.invocation.length, 8);
});

test("formatNote strips controls, ANSI and bidi, cuts at 80 chars", () => {
  assert.equal(formatNote("a\nb‮c\x1b[31m"), "note(data):「abc」");
  assert.equal(formatNote("x\u0085y\x7fz"), "note(data):「xyz」");
  const long = formatNote("あ".repeat(200));
  assert.equal([...long].length, "note(data):「」".length + 80);
});

test("id patterns", () => {
  assert.equal(isDelegationId("../x"), false);
  assert.equal(isDelegationId("d-123"), false);
  assert.equal(isDelegationId("d-0123456789ab"), true);
  assert.equal(isAgentId("../x"), false);
  assert.equal(isAgentId("a_b-1"), true);
  assert.equal(isToolUseId("t".repeat(129)), false);
  assert.equal(isToolUseId("toolu_01:a.b"), true);
});

test("reviewer-codex-run copies of effort list and model shape match schema.ts", () => {
  assert.deepEqual(
    [...EFFORT_VALUES],
    EFFORTS.filter((e) => e !== "unknown"),
  );
  for (const model of [
    "gpt-6-luna",
    "gpt-6.1-terra",
    "GPT-6-luna",
    "gpt-6-luna;rm",
    "gpt-",
    `gpt-${"a".repeat(32)}`,
    `gpt-${"a".repeat(33)}`,
  ]) {
    assert.equal(
      MODEL_PATTERN.test(model),
      normalizeModel("codex-cli", model) !== "unknown",
      model,
    );
  }
});

test("sarashina model is kept as is, known, and not mixed with GLM", () => {
  const model = "sarashina/sarashina3.2-mini-thinking";
  assert.equal(normalizeModel("opencode", model), model);
  assert.equal(displayModel(model), model);
  assert.ok(KNOWN_MODELS.includes(model));
});

test("offloadAgentName: write picks the edit agent", () => {
  assert.equal(offloadAgentName(false), "worktree-read");
  assert.equal(offloadAgentName(true), "worktree-edit");
});

test("isExposure accepts exactly the two lowercase values", () => {
  assert.equal(isExposure("closed"), true);
  assert.equal(isExposure("external-ok"), true);
  for (const v of ["Closed", "", "public"]) assert.equal(isExposure(v), false);
});

test("free opencode models are shown verbatim and survive normalizeModel", () => {
  for (const m of [
    "opencode/deepseek-v4.1-flash-free",
    "opencode/glm-5.3-flash-free",
  ]) {
    assert.equal(displayModel(m), m);
    assert.equal(normalizeModel("opencode", m), m);
  }
  assert.equal(normalizeModel("opencode", "OpenCode/x"), "unknown");
});

test("FREE_DESTINATIONS: sends out, opencode harness, model passes normalizeModel", () => {
  assert.equal(FREE_DESTINATIONS.length, 2);
  for (const d of FREE_DESTINATIONS) {
    assert.equal(d.sendsOut, true);
    assert.equal(d.match.harness, "opencode");
    assert.equal(normalizeModel(d.match.harness, d.match.model), d.match.model);
  }
});
