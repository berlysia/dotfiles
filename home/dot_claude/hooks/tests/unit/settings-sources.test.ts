import { deepStrictEqual } from "node:assert";
import { describe, it } from "node:test";
import { listSettingsSources } from "../../lib/settings-sources.ts";

const roots = { user: "/home/u/.claude", project: "/started/here" };

describe("listSettingsSources", () => {
  it("pairs each settings file with the directory its /path rules anchor at", () => {
    deepStrictEqual(listSettingsSources(roots, "/repo"), [
      {
        kind: "user",
        path: "/home/u/.claude/settings.json",
        settingsRoot: "/home/u/.claude",
      },
      {
        kind: "project",
        path: "/repo/.claude/settings.json",
        settingsRoot: "/started/here",
      },
      {
        kind: "local",
        path: "/repo/.claude/settings.local.json",
        settingsRoot: "/started/here",
      },
    ]);
  });
  it("lists only the user settings when there is no workspace root", () => {
    deepStrictEqual(
      listSettingsSources(roots, undefined).map((source) => source.kind),
      ["user"],
    );
  });
});
