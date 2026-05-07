#!/usr/bin/env -S bun test

import { ok, strictEqual } from "node:assert";
import {
  appendFileSync,
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  buildLlmPayload,
  evaluateStageBGate,
  hashInsight,
  hashSessionId,
  normalize,
  parseProposalYaml,
  selectStageBInputs,
  type StageBQueryFn,
  type StageBQueryMessage,
  type DistillState,
  type InsightRecord,
  writePayloadDump,
} from "../../lib/insight-digest.ts";
import { runStageB } from "../../../scripts/distill-insights.ts";

interface SandboxPaths {
  dir: string;
  jsonl: string;
  stamp: string;
  digest: string;
  payloadDump: string;
}

function makeSandbox(): SandboxPaths {
  const dir = mkdtempSync(join(tmpdir(), "distill-llm-test-"));
  return {
    dir,
    jsonl: join(dir, "insights.jsonl"),
    stamp: join(dir, ".last-distill-insights-llm"),
    digest: join(dir, "insight-digest.md"),
    payloadDump: join(dir, "insight-llm-payload.last.json"),
  };
}

function appendRecord(
  jsonlPath: string,
  body: string,
  opts: { sessionId?: string; timestamp?: string } = {},
): InsightRecord {
  const sessionId = opts.sessionId ?? `session-${Math.random()}`;
  const timestamp = opts.timestamp ?? new Date().toISOString();
  const record: InsightRecord = {
    hash: hashInsight(normalize(body)),
    session_id_hash: hashSessionId(sessionId),
    project: "test",
    cwd: "/tmp/test",
    timestamp,
    text: body,
  };
  appendFileSync(jsonlPath, `${JSON.stringify(record)}\n`);
  return record;
}

function writeDigestPlaceholder(path: string): void {
  const placeholder = [
    "# Insight Digest",
    "",
    "## Top Recurring Topics (heuristic)",
    "",
    "| count | sessions | last_seen | preview |",
    "|-------|----------|-----------|---------|",
    "| 1 | 1 | 2026-05-07 | sample |",
    "",
    "## Distillation (LLM)",
    "",
    "<!-- llm: not yet enabled. Stage B will populate this section. -->",
    "",
  ].join("\n");
  writeFileSync(path, placeholder, { mode: 0o600 });
}

function fakeQuery(json: string): StageBQueryFn {
  return () => {
    const result = `~~~json\n${json}\n~~~`;
    return (async function* () {
      const msg: StageBQueryMessage = {
        type: "result",
        subtype: "success",
        result,
      };
      yield msg;
    })();
  };
}

function throwingQuery(): StageBQueryFn {
  return () => {
    throw new Error("simulated network failure");
  };
}

const VALID_JSON = JSON.stringify(
  [
    {
      cluster_id: 1,
      theme: "chezmoi run_after stamp pattern",
      proposal_type: "skill",
      target_path: ".skills/example/SKILL.md",
      suggested_title: "Example skill",
      suggested_body: "step 1\nstep 2",
      rationale: "repeated 3 times",
      evidence: [
        { session_id_hash: "abc123def456", excerpt: "use stamp file" },
      ],
    },
  ],
  null,
  2,
);

const EMPTY_JSON = "[]";

describe("evaluateStageBGate", () => {
  it("returns gate_count when since_last_ack < threshold", () => {
    const sandbox = makeSandbox();
    const state: DistillState = { total: 5, since_last_ack: 5 };
    const result = evaluateStageBGate(state, sandbox.stamp);
    strictEqual(result.ok, false);
    if (!result.ok) strictEqual(result.reason, "gate_count");
  });

  it("returns gate_age when stamp is fresh and count is enough", () => {
    const sandbox = makeSandbox();
    writeFileSync(sandbox.stamp, String(Date.now() - 3600_000));
    const state: DistillState = { total: 50, since_last_ack: 50 };
    const result = evaluateStageBGate(state, sandbox.stamp);
    strictEqual(result.ok, false);
    if (!result.ok) strictEqual(result.reason, "gate_age");
  });

  it("returns gate_both when both fail", () => {
    const sandbox = makeSandbox();
    writeFileSync(sandbox.stamp, String(Date.now() - 3600_000));
    const state: DistillState = { total: 5, since_last_ack: 5 };
    const result = evaluateStageBGate(state, sandbox.stamp);
    strictEqual(result.ok, false);
    if (!result.ok) strictEqual(result.reason, "gate_both");
  });

  it("returns ok when both pass", () => {
    const sandbox = makeSandbox();
    const state: DistillState = { total: 50, since_last_ack: 50 };
    const result = evaluateStageBGate(state, sandbox.stamp);
    strictEqual(result.ok, true);
  });
});

describe("selectStageBInputs", () => {
  it("applies sanitizer twice and counts extra hits", () => {
    const sandbox = makeSandbox();
    appendRecord(sandbox.jsonl, "leaked SECRET-123 inside body");
    const set = selectStageBInputs({
      force: true,
      sinceLastAck: 1,
      redactPatterns: [/SECRET-\d+/g],
      jsonlPath: sandbox.jsonl,
    });
    ok(set.extraHits >= 1);
    ok(!set.inputs[0]?.text.includes("SECRET-123"));
  });

  it("truncates by maxInputChars and records truncated hashes", () => {
    const sandbox = makeSandbox();
    const long = "x".repeat(80);
    const a = appendRecord(sandbox.jsonl, `${long} alpha`, {
      timestamp: "2026-05-07T10:00:00Z",
    });
    const b = appendRecord(sandbox.jsonl, `${long} beta`, {
      timestamp: "2026-05-07T11:00:00Z",
    });
    const c = appendRecord(sandbox.jsonl, `${long} gamma`, {
      timestamp: "2026-05-07T12:00:00Z",
    });
    const set = selectStageBInputs({
      force: true,
      sinceLastAck: 3,
      maxInputChars: 100,
      jsonlPath: sandbox.jsonl,
    });
    ok(set.truncated);
    ok(set.truncatedHashes.length >= 1);
    const inputHashes = new Set(set.inputs.map((i) => i.hash));
    for (const t of set.truncatedHashes) {
      ok(!inputHashes.has(t));
    }
    ok([a.hash, b.hash, c.hash].includes(set.inputs[0]?.hash ?? ""));
  });
});

describe("writePayloadDump", () => {
  it("writes JSON with mode 0o600", () => {
    const sandbox = makeSandbox();
    const set = selectStageBInputs({
      force: true,
      sinceLastAck: 0,
      jsonlPath: sandbox.jsonl,
    });
    const payload = buildLlmPayload(set, { model: "haiku" });
    writePayloadDump(payload, sandbox.payloadDump);
    const stat = statSync(sandbox.payloadDump);
    strictEqual(stat.mode & 0o777, 0o600);
    const parsed = JSON.parse(readFileSync(sandbox.payloadDump, "utf8"));
    strictEqual(parsed.model, "haiku");
    ok(Array.isArray(parsed.truncated_hashes));
  });
});

describe("parseProposalYaml", () => {
  it("returns parse_error when JSON is invalid", () => {
    const result = parseProposalYaml("~~~json\n{not valid}\n~~~");
    strictEqual(result.ok, false);
    if (!result.ok) strictEqual(result.reason, "yaml_error");
  });

  it("returns size_cap when raw exceeds 256KB", () => {
    const big = "a".repeat(260_000);
    const result = parseProposalYaml(big);
    strictEqual(result.ok, false);
    if (!result.ok) strictEqual(result.reason, "size_cap");
  });
});

describe("runStageB", () => {
  it("bypasses gate with --force --llm", async () => {
    const sandbox = makeSandbox();
    writeDigestPlaceholder(sandbox.digest);
    appendRecord(sandbox.jsonl, "force test insight body");
    const outcome = await runStageB({
      force: true,
      state: { total: 1, since_last_ack: 1 },
      tStart: Date.now(),
      queryFn: fakeQuery(VALID_JSON),
      paths: sandbox,
    });
    strictEqual(outcome.kind, "ok");
  });

  it("inserts proposals table and updates stamp on success", async () => {
    const sandbox = makeSandbox();
    writeDigestPlaceholder(sandbox.digest);
    appendRecord(sandbox.jsonl, "valid run insight body");
    const tStart = Date.now();
    const outcome = await runStageB({
      force: true,
      state: { total: 1, since_last_ack: 1 },
      tStart,
      queryFn: fakeQuery(VALID_JSON),
      paths: sandbox,
    });
    strictEqual(outcome.kind, "ok");
    if (outcome.kind === "ok") strictEqual(outcome.proposals.length, 1);
    const digest = readFileSync(sandbox.digest, "utf8");
    ok(digest.includes("Example skill"));
    ok(digest.includes("<!-- llm: ok proposals=1"));
    const stamp = Number(readFileSync(sandbox.stamp, "utf8"));
    ok(stamp > 0 && stamp <= tStart);
  });

  it("updates stamp even when proposals=0 (raw=0)", async () => {
    const sandbox = makeSandbox();
    writeDigestPlaceholder(sandbox.digest);
    appendRecord(sandbox.jsonl, "empty proposals body");
    const outcome = await runStageB({
      force: true,
      state: { total: 1, since_last_ack: 1 },
      tStart: Date.now(),
      queryFn: fakeQuery(EMPTY_JSON),
      paths: sandbox,
    });
    strictEqual(outcome.kind, "ok");
    if (outcome.kind === "ok") strictEqual(outcome.rawProposalCount, 0);
    const digest = readFileSync(sandbox.digest, "utf8");
    ok(digest.includes("<!-- llm: ok proposals=0 raw=0"));
    const stamp = Number(readFileSync(sandbox.stamp, "utf8"));
    ok(stamp > 0);
  });

  it("returns llm_error and leaves stamp unchanged when queryFn throws", async () => {
    const sandbox = makeSandbox();
    writeDigestPlaceholder(sandbox.digest);
    appendRecord(sandbox.jsonl, "throw test body");
    const outcome = await runStageB({
      force: true,
      state: { total: 1, since_last_ack: 1 },
      tStart: Date.now(),
      queryFn: throwingQuery(),
      paths: sandbox,
    });
    strictEqual(outcome.kind, "llm_error");
    let stampExists = true;
    try {
      statSync(sandbox.stamp);
    } catch {
      stampExists = false;
    }
    strictEqual(stampExists, false);
    const digest = readFileSync(sandbox.digest, "utf8");
    ok(digest.includes("<!-- llm: skipped reason=llm_error"));
  });

  it("returns parse_error when YAML is malformed", async () => {
    const sandbox = makeSandbox();
    writeDigestPlaceholder(sandbox.digest);
    appendRecord(sandbox.jsonl, "parse error body");
    const malformed = (() => {
      const fn: StageBQueryFn = () => {
        return (async function* () {
          const msg: StageBQueryMessage = {
            type: "result",
            subtype: "success",
            result: "~~~json\n{not valid}\n~~~",
          };
          yield msg;
        })();
      };
      return fn;
    })();
    const outcome = await runStageB({
      force: true,
      state: { total: 1, since_last_ack: 1 },
      tStart: Date.now(),
      queryFn: malformed,
      paths: sandbox,
    });
    strictEqual(outcome.kind, "parse_error");
    let stampExists = true;
    try {
      statSync(sandbox.stamp);
    } catch {
      stampExists = false;
    }
    strictEqual(stampExists, false);
  });

  it("keeps a single Distillation header when run twice (idempotent)", async () => {
    const sandbox = makeSandbox();
    writeDigestPlaceholder(sandbox.digest);
    appendRecord(sandbox.jsonl, "idempotent run body");
    const baseOpts = {
      force: true,
      state: { total: 1, since_last_ack: 1 },
      tStart: Date.now(),
      queryFn: fakeQuery(VALID_JSON),
      paths: sandbox,
    };
    await runStageB(baseOpts);
    await runStageB(baseOpts);
    const digest = readFileSync(sandbox.digest, "utf8");
    const matches = digest.match(/^## Distillation \(LLM\)/gm);
    strictEqual(matches?.length, 1);
  });
});
