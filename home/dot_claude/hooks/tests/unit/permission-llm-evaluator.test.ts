#!/usr/bin/env node --test

import { deepStrictEqual, strictEqual } from "node:assert";
import { describe, it } from "node:test";
import { parseLLMResponse } from "../../implementations/permission-llm-evaluator.ts";

describe("parseLLMResponse", () => {
  it("returns allow variant when JSON says allow: true", () => {
    const result = parseLLMResponse(
      '{"allow": true, "reason": "read-only command"}',
    );
    deepStrictEqual(result, {
      kind: "allow",
      reason: "read-only command",
    });
  });

  it("returns deny variant with confidence when JSON says allow: false", () => {
    const result = parseLLMResponse(
      '{"allow": false, "reason": "potential rm -rf", "confidence": "high"}',
    );
    deepStrictEqual(result, {
      kind: "deny",
      reason: "potential rm -rf",
      confidence: "high",
    });
  });

  it("defaults confidence to medium when missing on deny", () => {
    const result = parseLLMResponse('{"allow": false, "reason": "suspicious"}');
    deepStrictEqual(result, {
      kind: "deny",
      reason: "suspicious",
      confidence: "medium",
    });
  });

  it("defaults confidence to medium when invalid value supplied", () => {
    const result = parseLLMResponse(
      '{"allow": false, "reason": "x", "confidence": "extreme"}',
    );
    deepStrictEqual(result, {
      kind: "deny",
      reason: "x",
      confidence: "medium",
    });
  });

  it("returns parse-error when response is not JSON", () => {
    const raw = "I cannot comply with this request.";
    const result = parseLLMResponse(raw);
    strictEqual(result.kind, "parse-error");
    if (result.kind === "parse-error") {
      strictEqual(result.rawText, raw);
    }
  });

  it("returns parse-error when JSON fragment is malformed", () => {
    const result = parseLLMResponse("{allow: yes");
    strictEqual(result.kind, "parse-error");
  });

  it("returns parse-error when allow field is absent", () => {
    const result = parseLLMResponse('{"reason": "no decision"}');
    strictEqual(result.kind, "parse-error");
  });

  it("tolerates extra prose around the JSON block", () => {
    const result = parseLLMResponse(
      'Here is my decision:\n{"allow": true, "reason": "ok"}\nThanks.',
    );
    deepStrictEqual(result, { kind: "allow", reason: "ok" });
  });

  it("returns empty reason when reason is missing but allow is boolean", () => {
    const result = parseLLMResponse('{"allow": true}');
    deepStrictEqual(result, { kind: "allow", reason: "" });
  });
});
