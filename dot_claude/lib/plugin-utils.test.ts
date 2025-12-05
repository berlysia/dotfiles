/**
 * Unit tests for plugin-utils.ts
 * Run: node --test dot_claude/lib/plugin-utils.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  parsePluginKey,
  makePluginKey,
  findMissingPlugins,
  findUntrackedPlugins,
  type PluginDependency,
} from "./plugin-utils.ts";

describe("parsePluginKey", () => {
  it("should parse standard plugin key", () => {
    const result = parsePluginKey("my-plugin@marketplace-name");
    assert.deepEqual(result, {
      name: "my-plugin",
      marketplace: "marketplace-name",
    });
  });

  it("should handle plugin name with hyphens", () => {
    const result = parsePluginKey("my-cool-plugin@some-marketplace");
    assert.deepEqual(result, {
      name: "my-cool-plugin",
      marketplace: "some-marketplace",
    });
  });

  it("should handle key without @ symbol", () => {
    const result = parsePluginKey("standalone-plugin");
    assert.deepEqual(result, {
      name: "standalone-plugin",
      marketplace: "",
    });
  });

  it("should handle empty string", () => {
    const result = parsePluginKey("");
    assert.deepEqual(result, {
      name: "",
      marketplace: "",
    });
  });

  it("should use lastIndexOf for @ (handle multiple @)", () => {
    // Edge case: plugin name contains @
    const result = parsePluginKey("plugin@v2@marketplace");
    assert.deepEqual(result, {
      name: "plugin@v2",
      marketplace: "marketplace",
    });
  });

  it("should handle key starting with @", () => {
    const result = parsePluginKey("@marketplace");
    assert.deepEqual(result, {
      name: "",
      marketplace: "marketplace",
    });
  });

  it("should handle key ending with @", () => {
    const result = parsePluginKey("plugin-name@");
    assert.deepEqual(result, {
      name: "plugin-name",
      marketplace: "",
    });
  });
});

describe("makePluginKey", () => {
  it("should create plugin key from name and marketplace", () => {
    const result = makePluginKey("my-plugin", "marketplace-name");
    assert.equal(result, "my-plugin@marketplace-name");
  });

  it("should handle empty marketplace", () => {
    const result = makePluginKey("my-plugin", "");
    assert.equal(result, "my-plugin@");
  });

  it("should handle empty name", () => {
    const result = makePluginKey("", "marketplace");
    assert.equal(result, "@marketplace");
  });

  it("should handle both empty", () => {
    const result = makePluginKey("", "");
    assert.equal(result, "@");
  });
});

describe("parsePluginKey and makePluginKey roundtrip", () => {
  it("should roundtrip standard key", () => {
    const original = "my-plugin@marketplace";
    const parsed = parsePluginKey(original);
    const reconstructed = makePluginKey(parsed.name, parsed.marketplace);
    assert.equal(reconstructed, original);
  });

  it("should roundtrip key with multiple @", () => {
    const original = "plugin@v2@marketplace";
    const parsed = parsePluginKey(original);
    const reconstructed = makePluginKey(parsed.name, parsed.marketplace);
    assert.equal(reconstructed, original);
  });
});

describe("findMissingPlugins", () => {
  const sampleDependencies: PluginDependency[] = [
    { name: "plugin-a", marketplace: "market1", purpose: "Purpose A" },
    { name: "plugin-b", marketplace: "market2", purpose: "Purpose B" },
    { name: "plugin-c", marketplace: "market1", purpose: "Purpose C" },
  ];

  it("should return all plugins when none installed", () => {
    const installed = new Set<string>();
    const result = findMissingPlugins(sampleDependencies, installed);
    assert.equal(result.length, 3);
    assert.deepEqual(result, sampleDependencies);
  });

  it("should return empty array when all installed", () => {
    const installed = new Set([
      "plugin-a@market1",
      "plugin-b@market2",
      "plugin-c@market1",
    ]);
    const result = findMissingPlugins(sampleDependencies, installed);
    assert.equal(result.length, 0);
  });

  it("should return only missing plugins", () => {
    const installed = new Set(["plugin-a@market1", "plugin-c@market1"]);
    const result = findMissingPlugins(sampleDependencies, installed);
    assert.equal(result.length, 1);
    assert.equal(result[0].name, "plugin-b");
  });

  it("should handle empty dependencies", () => {
    const installed = new Set(["some-plugin@market"]);
    const result = findMissingPlugins([], installed);
    assert.equal(result.length, 0);
  });

  it("should match by full key (name@marketplace)", () => {
    // Same name but different marketplace should be considered missing
    const installed = new Set(["plugin-a@different-market"]);
    const result = findMissingPlugins(sampleDependencies, installed);
    assert.equal(result.length, 3);
  });
});

describe("findUntrackedPlugins", () => {
  const sampleDependencies: PluginDependency[] = [
    { name: "tracked-a", marketplace: "market1", purpose: "Purpose A" },
    { name: "tracked-b", marketplace: "market2", purpose: "Purpose B" },
  ];

  it("should return empty array when all installed are tracked", () => {
    const installedKeys = ["tracked-a@market1", "tracked-b@market2"];
    const result = findUntrackedPlugins(sampleDependencies, installedKeys);
    assert.equal(result.length, 0);
  });

  it("should return untracked plugins", () => {
    const installedKeys = [
      "tracked-a@market1",
      "tracked-b@market2",
      "untracked-c@market3",
    ];
    const result = findUntrackedPlugins(sampleDependencies, installedKeys);
    assert.equal(result.length, 1);
    assert.equal(result[0], "untracked-c@market3");
  });

  it("should return all when no dependencies defined", () => {
    const installedKeys = ["plugin-a@market1", "plugin-b@market2"];
    const result = findUntrackedPlugins([], installedKeys);
    assert.equal(result.length, 2);
  });

  it("should handle empty installed list", () => {
    const result = findUntrackedPlugins(sampleDependencies, []);
    assert.equal(result.length, 0);
  });

  it("should distinguish by marketplace", () => {
    // Same name but different marketplace is untracked
    const installedKeys = ["tracked-a@different-market"];
    const result = findUntrackedPlugins(sampleDependencies, installedKeys);
    assert.equal(result.length, 1);
    assert.equal(result[0], "tracked-a@different-market");
  });
});
