import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import {
  currentRoot,
  isUnderManagedRoot,
  legacyRoot,
  repoName,
} from "../../lib/worktree-locations.ts";
import {
  formatMarkerFailure,
  judgeMarker,
  type MarkerDecision,
} from "../../lib/worktree-marker.ts";

type PathCase = {
  name: string;
  commonDir: string;
  home: string;
  error?: "unsupported";
  repoName?: string;
  currentRoot?: string;
  legacyRoot?: string;
};

type ManagedCase = {
  name: string;
  path: string;
  commonDir: string;
  home: string;
  expected: boolean;
};

type MarkerCase = {
  name: string;
  rootState:
    | "missing"
    | "empty"
    | "temporary-file"
    | "marker"
    | "marker-symlink"
    | "other-file";
  markerContent:
    | "none"
    | "self-lf"
    | "self-crlf"
    | "self-no-lf"
    | "self-first-line"
    | "empty"
    | "other"
    | "missing"
    | "invalid";
  expected: MarkerDecision["kind"];
};

type SharedCases = {
  pathCases: PathCase[];
  managedCases: ManagedCase[];
  markerCases: MarkerCase[];
};

const cases = JSON.parse(
  readFileSync(
    new URL(
      "../../../../../tests/git-worktree-create/location-cases.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as SharedCases;
const tempPaths: string[] = [];
after(() => {
  for (const path of tempPaths) rmSync(path, { recursive: true, force: true });
});

function makeMarkerFixture(testCase: MarkerCase): {
  commonDir: string;
  home: string;
  root: string;
  externalFile: string;
} {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "worktree-location-")));
  tempPaths.push(base);
  const commonDir = join(base, "source", "proj", ".git");
  const home = join(base, "home");
  const root = currentRoot(commonDir, home);
  const externalDir = join(base, "external", "repo", ".git");
  const externalFile = join(base, "outside.txt");
  mkdirSync(commonDir, { recursive: true });
  writeFileSync(join(commonDir, "HEAD"), "ref: refs/heads/main\n");

  if (testCase.rootState !== "missing") mkdirSync(root, { recursive: true });
  if (testCase.rootState === "temporary-file") {
    writeFileSync(join(root, ".common-dir.tmp.123"), "partial\n");
  } else if (testCase.rootState === "other-file") {
    writeFileSync(join(root, "README"), "unmarked\n");
  } else if (testCase.rootState === "marker") {
    let markerValue: string;
    if (testCase.markerContent === "empty") {
      markerValue = "";
    } else if (testCase.markerContent === "other") {
      mkdirSync(externalDir, { recursive: true });
      writeFileSync(join(externalDir, "HEAD"), "ref: refs/heads/main\n");
      markerValue = `${realpathSync(externalDir)}\n`;
    } else if (testCase.markerContent === "missing") {
      markerValue = `${join(base, "missing", "repo", ".git")}\n`;
    } else if (testCase.markerContent === "invalid") {
      markerValue = "token=abc\n";
    } else if (testCase.markerContent === "self-crlf") {
      markerValue = `${realpathSync(commonDir)}\r\n`;
    } else if (testCase.markerContent === "self-no-lf") {
      markerValue = realpathSync(commonDir);
    } else if (testCase.markerContent === "self-first-line") {
      markerValue = `${realpathSync(commonDir)}\n${join(base, "other", ".git")}\n`;
    } else {
      markerValue = `${realpathSync(commonDir)}\n`;
    }
    writeFileSync(join(root, ".common-dir"), markerValue);
  } else if (testCase.rootState === "marker-symlink") {
    writeFileSync(externalFile, "outside marker target\n");
    symlinkSync(externalFile, join(root, ".common-dir"));
  }

  return { commonDir, home, root, externalFile };
}

describe("worktree locations shared cases", () => {
  for (const testCase of cases.pathCases) {
    it(`path: ${testCase.name}`, () => {
      if (testCase.error === "unsupported") {
        assert.throws(
          () => repoName(testCase.commonDir),
          /unsupported common dir/,
        );
        assert.throws(
          () => currentRoot(testCase.commonDir, testCase.home),
          /unsupported common dir/,
        );
        return;
      }
      assert.equal(repoName(testCase.commonDir), testCase.repoName);
      assert.equal(
        currentRoot(testCase.commonDir, testCase.home),
        testCase.currentRoot,
      );
      assert.equal(legacyRoot(testCase.commonDir), testCase.legacyRoot);
    });
  }

  for (const testCase of cases.managedCases) {
    it(`managed root: ${testCase.name}`, () => {
      assert.equal(
        isUnderManagedRoot(testCase.path, testCase.commonDir, testCase.home),
        testCase.expected,
      );
    });
  }

  for (const testCase of cases.markerCases) {
    it(`marker judgement: ${testCase.name}`, () => {
      const fixture = makeMarkerFixture(testCase);
      const decision = judgeMarker(fixture.commonDir, fixture.home);
      assert.equal(decision.kind, testCase.expected);
      if (testCase.rootState === "marker-symlink") {
        assert.equal(
          readFileSync(fixture.externalFile, "utf8"),
          "outside marker target\n",
        );
      }
      if (testCase.markerContent === "invalid") {
        assert.equal(decision.kind, "stale");
        assert.doesNotMatch(
          formatMarkerFailure(decision, fixture.commonDir, fixture.home),
          /token=abc/u,
        );
      }
    });
  }
});
