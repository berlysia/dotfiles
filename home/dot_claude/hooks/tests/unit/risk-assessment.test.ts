#!/usr/bin/env -S bun test

import { strict as assert } from "node:assert";
import { describe, test } from "node:test";
import {
  combineRiskLevels,
  evaluateOperationRisk,
  evaluateScopeRisk,
  evaluateTargetRisk,
  RiskLevel,
  shouldAutoApprove,
} from "../../lib/risk-assessment.ts";

// ==== テスト群 ====

describe("RiskLevel enum", () => {
  test("should have all expected risk levels", () => {
    assert.equal(RiskLevel.MINIMAL, "minimal");
    assert.equal(RiskLevel.LOW, "low");
    assert.equal(RiskLevel.MEDIUM, "medium");
    assert.equal(RiskLevel.HIGH, "high");
    assert.equal(RiskLevel.CRITICAL, "critical");
  });
});

describe("Scope Risk Assessment", () => {
  test("should evaluate path traversal to system directory as CRITICAL", () => {
    const result = evaluateScopeRisk("Read(../../etc/passwd)", "/home/user");

    assert.equal(result.level, RiskLevel.CRITICAL);
    assert(result.reason.includes("システムディレクトリ"));
  });

  test("should evaluate safe relative path traversal as LOW", () => {
    const result = evaluateScopeRisk(
      "Read(src/../lib/utils.ts)",
      "/home/user/project",
    );

    assert.equal(result.level, RiskLevel.LOW);
    assert(result.reason.includes("プロジェクト内"));
  });

  test("should evaluate relative path patterns as LOW (project scope)", () => {
    const cwd = "/home/user/project";
    const result1 = evaluateScopeRisk("Read(src/**)", cwd);
    const result2 = evaluateScopeRisk("Read(./**)", cwd);
    const result3 = evaluateScopeRisk("Edit(test/*.test.ts)", cwd);

    assert.equal(result1.level, RiskLevel.LOW);
    assert(result1.reason.includes("プロジェクト内"));

    assert.equal(result2.level, RiskLevel.LOW);
    assert(result2.reason.includes("プロジェクト内"));

    assert.equal(result3.level, RiskLevel.LOW);
    assert(result3.reason.includes("プロジェクト内"));
  });

  test("should evaluate home directory pattern as CRITICAL", () => {
    const result = evaluateScopeRisk("Read(~/**)");

    assert.equal(result.level, RiskLevel.CRITICAL);
    assert.equal(result.category, "scope");
    assert(result.reason.includes("ホームディレクトリ"));
    assert.equal(result.mitigationPossible, false);
  });

  test("should evaluate system directory pattern as CRITICAL", () => {
    const result = evaluateScopeRisk("Edit(/etc/**)");

    assert.equal(result.level, RiskLevel.CRITICAL);
    assert.equal(result.category, "scope");
    assert(result.reason.includes("システムディレクトリ"));
    assert.equal(result.mitigationPossible, false);
  });

  test("should evaluate workspace-wide pattern as HIGH", () => {
    const cwd = "/home/user/project";
    const result = evaluateScopeRisk("Read(~/workspace/**)", cwd);

    assert.equal(result.level, RiskLevel.HIGH);
    assert.equal(result.category, "scope");
    assert(result.reason.includes("全ワークスペース"));
    assert.equal(result.mitigationPossible, true);
  });

  test("should evaluate specific project pattern as MEDIUM", () => {
    const cwd = "/home/user/project";
    const result = evaluateScopeRisk("Read(~/workspace/my-project/**)", cwd);

    assert.equal(result.level, RiskLevel.MEDIUM);
    assert.equal(result.category, "scope");
    assert(result.reason.includes("特定プロジェクト"));
    assert.equal(result.mitigationPossible, true);
  });

  test("should evaluate specific file as MINIMAL", () => {
    const cwd = "/home/user/project";
    const result = evaluateScopeRisk(
      "Read(~/workspace/project/README.md)",
      cwd,
    );

    assert.equal(result.level, RiskLevel.MINIMAL);
    assert.equal(result.category, "scope");
    assert(result.reason.includes("特定ファイル"));
    assert.equal(result.mitigationPossible, false);
  });

  test("should evaluate limited scope with wildcards as LOW", () => {
    const cwd = "/home/user/project";
    const result = evaluateScopeRisk("Read(~/workspace/project/src/*.ts)", cwd);

    assert.equal(result.level, RiskLevel.LOW);
    assert.equal(result.category, "scope");
    assert(result.reason.includes("限定的"));
    assert.equal(result.mitigationPossible, false);
  });
});

describe("Target Risk Assessment", () => {
  test("should evaluate SSH private key as CRITICAL", () => {
    const result = evaluateTargetRisk("Read(~/.ssh/id_rsa)");

    assert.equal(result.level, RiskLevel.CRITICAL);
    assert.equal(result.category, "target");
    assert(result.reason.includes("SSH秘密鍵"));
    assert.equal(result.mitigationPossible, false);
  });

  test("should evaluate AWS credentials as CRITICAL", () => {
    const result = evaluateTargetRisk("Read(~/.aws/credentials)");

    assert.equal(result.level, RiskLevel.CRITICAL);
    assert.equal(result.category, "target");
    assert(result.reason.includes("AWS認証情報"));
    assert.equal(result.mitigationPossible, false);
  });

  test("should evaluate .env file as HIGH", () => {
    const result = evaluateTargetRisk("Read(~/project/.env)");

    assert.equal(result.level, RiskLevel.HIGH);
    assert.equal(result.category, "target");
    assert(result.reason.includes("環境変数"));
    assert.equal(result.mitigationPossible, true);
  });

  test("should evaluate private key file as CRITICAL", () => {
    const result = evaluateTargetRisk("Read(~/certs/private.key)");

    assert.equal(result.level, RiskLevel.CRITICAL);
    assert.equal(result.category, "target");
    assert(result.reason.includes("秘密鍵ファイル"));
    assert.equal(result.mitigationPossible, false);
  });

  test("should evaluate GPG directory as CRITICAL", () => {
    const result = evaluateTargetRisk("Read(~/.gnupg/secring.gpg)");

    assert.equal(result.level, RiskLevel.CRITICAL);
    assert.equal(result.category, "target");
    assert(result.reason.includes("GPG秘密鍵"));
    assert.equal(result.mitigationPossible, false);
  });

  test("should evaluate regular project file as MINIMAL", () => {
    const result = evaluateTargetRisk("Read(~/workspace/project/src/index.ts)");

    assert.equal(result.level, RiskLevel.MINIMAL);
    assert.equal(result.category, "target");
    assert(result.reason.includes("通常ファイル"));
    assert.equal(result.mitigationPossible, false);
  });

  test("should evaluate system password file as CRITICAL", () => {
    const result = evaluateTargetRisk("Read(/etc/shadow)");

    assert.equal(result.level, RiskLevel.CRITICAL);
    assert.equal(result.category, "target");
    assert(result.reason.includes("システムパスワード"));
    assert.equal(result.mitigationPossible, false);
  });
});

describe("Operation Risk Assessment", () => {
  test("should evaluate Read operations as MINIMAL", () => {
    const result = evaluateOperationRisk("Read(~/workspace/file.txt)");

    assert.equal(result.level, RiskLevel.MINIMAL);
    assert.equal(result.category, "operation");
    assert(result.reason.includes("読み取り専用"));
    assert.equal(result.mitigationPossible, false);
  });

  test("should evaluate Glob operations as MINIMAL", () => {
    const result = evaluateOperationRisk("Glob(./**)");

    assert.equal(result.level, RiskLevel.MINIMAL);
    assert.equal(result.category, "operation");
    assert(result.reason.includes("読み取り専用"));
    assert.equal(result.mitigationPossible, false);
  });

  test("should evaluate Edit operations as MEDIUM", () => {
    const result = evaluateOperationRisk("Edit(~/file.txt)");

    assert.equal(result.level, RiskLevel.MEDIUM);
    assert.equal(result.category, "operation");
    assert(result.reason.includes("ファイル編集"));
    assert.equal(result.mitigationPossible, true);
  });

  test("should evaluate Write operations as HIGH", () => {
    const result = evaluateOperationRisk("Write(~/file.txt)");

    assert.equal(result.level, RiskLevel.HIGH);
    assert.equal(result.category, "operation");
    assert(result.reason.includes("ファイル作成"));
    assert.equal(result.mitigationPossible, true);
  });

  test("should evaluate destructive Bash commands as CRITICAL", () => {
    const result = evaluateOperationRisk("Bash(rm -rf *)");

    assert.equal(result.level, RiskLevel.CRITICAL);
    assert.equal(result.category, "operation");
    assert(result.reason.includes("破壊的"));
    assert.equal(result.mitigationPossible, false);
  });

  test("should evaluate safe Bash commands as LOW", () => {
    const result = evaluateOperationRisk("Bash(ls *)");

    assert.equal(result.level, RiskLevel.LOW);
    assert.equal(result.category, "operation");
    assert(result.reason.includes("安全な読み取り"));
    assert.equal(result.mitigationPossible, false);
  });

  test("should evaluate test commands as LOW", () => {
    const result = evaluateOperationRisk("Bash(npm test *)");

    assert.equal(result.level, RiskLevel.LOW);
    assert.equal(result.category, "operation");
    assert(result.reason.includes("テスト実行"));
    assert.equal(result.mitigationPossible, false);
  });

  test("should evaluate unknown operations as MEDIUM", () => {
    const result = evaluateOperationRisk("UnknownTool(something)");

    assert.equal(result.level, RiskLevel.MEDIUM);
    assert.equal(result.category, "operation");
    assert(result.reason.includes("未分類"));
    assert.equal(result.mitigationPossible, false);
  });
});

describe("Combined Risk Assessment", () => {
  test("should return CRITICAL when any component is CRITICAL", () => {
    const result = combineRiskLevels(
      RiskLevel.CRITICAL, // scope
      RiskLevel.LOW, // operation
      RiskLevel.MINIMAL, // target
    );

    assert.equal(result, RiskLevel.CRITICAL);
  });

  test("should return CRITICAL when two components are HIGH", () => {
    const result = combineRiskLevels(
      RiskLevel.HIGH, // scope
      RiskLevel.HIGH, // operation
      RiskLevel.LOW, // target
    );

    assert.equal(result, RiskLevel.CRITICAL);
  });

  test("should return HIGH when one component is HIGH", () => {
    const result = combineRiskLevels(
      RiskLevel.HIGH, // scope
      RiskLevel.LOW, // operation
      RiskLevel.MINIMAL, // target
    );

    assert.equal(result, RiskLevel.HIGH);
  });

  test("should return HIGH when two components are MEDIUM", () => {
    const result = combineRiskLevels(
      RiskLevel.MEDIUM, // scope
      RiskLevel.MEDIUM, // operation
      RiskLevel.LOW, // target
    );

    assert.equal(result, RiskLevel.HIGH);
  });

  test("should return MEDIUM when one component is MEDIUM", () => {
    const result = combineRiskLevels(
      RiskLevel.MEDIUM, // scope
      RiskLevel.LOW, // operation
      RiskLevel.MINIMAL, // target
    );

    assert.equal(result, RiskLevel.MEDIUM);
  });

  test("should return LOW for all low-risk components", () => {
    const result = combineRiskLevels(
      RiskLevel.LOW, // scope
      RiskLevel.MINIMAL, // operation
      RiskLevel.LOW, // target
    );

    assert.equal(result, RiskLevel.LOW);
  });
});

describe("Auto-approval Decision", () => {
  test("should auto-approve MINIMAL risk", () => {
    const result = shouldAutoApprove(RiskLevel.MINIMAL);
    assert.equal(result, true);
  });

  test("should auto-approve LOW risk", () => {
    const result = shouldAutoApprove(RiskLevel.LOW);
    assert.equal(result, true);
  });

  test("should NOT auto-approve MEDIUM risk", () => {
    const result = shouldAutoApprove(RiskLevel.MEDIUM);
    assert.equal(result, false);
  });

  test("should NOT auto-approve HIGH risk", () => {
    const result = shouldAutoApprove(RiskLevel.HIGH);
    assert.equal(result, false);
  });

  test("should NOT auto-approve CRITICAL risk", () => {
    const result = shouldAutoApprove(RiskLevel.CRITICAL);
    assert.equal(result, false);
  });
});
