#!/usr/bin/env -S bun run --silent

/**
 * Update Auto-Approve Command Implementation
 * 決定ログに基づく許可/拒否設定の自動最適化
 */

import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  type AnalysisOptions,
  type AnalysisResult,
  type PatternAnalysis,
  PermissionAnalyzer,
} from "../hooks/lib/permission-analyzer.ts";
import {
  combineRiskLevels,
  evaluateOperationRisk,
  evaluateScopeRisk,
  evaluateTargetRisk,
  shouldAutoApprove,
} from "../hooks/lib/risk-assessment.ts";

interface PermissionsConfig {
  allow?: string[];
  deny?: string[];
}

interface CommandOptions {
  dryRun?: boolean;
  since?: string;
  autoApproveSafe?: boolean;
  verbose?: boolean;
}

class AutoApproveUpdater {
  private analyzer: PermissionAnalyzer;
  private projectPermissionsPath: string;
  private options: CommandOptions;

  constructor(options: CommandOptions = {}) {
    this.analyzer = new PermissionAnalyzer();
    this.projectPermissionsPath = join(
      process.cwd(),
      "dot_claude",
      ".settings.permissions.json",
    );
    this.options = options;
  }

  async run(): Promise<void> {
    console.log("🔍 Analyzing permission patterns from decision logs...\n");

    try {
      // 分析実行
      const analysisOptions: AnalysisOptions = {
        includeTestMode: false,
      };

      if (this.options.since) {
        analysisOptions.sinceDate = this.parseSinceDate(this.options.since);
      }

      const result = await this.analyzer.analyze(analysisOptions);

      if (this.options.verbose) {
        this.printAnalysisSummary(result);
      }

      if (
        result.allowCandidates.length === 0 &&
        result.denyCandidates.length === 0
      ) {
        console.log(
          "✅ No new permission patterns to update. Current settings appear optimal.\n",
        );
        return;
      }

      // 既存設定の読み込み
      const projectPermissions = this.loadPermissions(
        this.projectPermissionsPath,
      );

      // 重複チェックと候補フィルタリング
      const filteredResult = this.filterDuplicates(result, projectPermissions);

      if (this.options.dryRun) {
        // dry-runでも自動承認の候補を表示
        if (this.options.autoApproveSafe) {
          console.log("🔍 Dry Run Results - Auto-approval analysis:\n");
          this.autoApproveSafePatterns(filteredResult);
        } else {
          this.printDryRunResults(filteredResult);
        }
        return;
      }

      // インタラクティブレビューまたは自動承認
      const approved = this.options.autoApproveSafe
        ? this.autoApproveSafePatterns(filteredResult)
        : await this.interactiveReview(filteredResult);

      if (
        approved.allowPatterns.length > 0 ||
        approved.denyPatterns.length > 0
      ) {
        await this.updatePermissions(approved, projectPermissions);
        console.log("\n✅ Permission settings updated successfully!");
      } else {
        console.log("\n✅ No changes made to permission settings.");
      }
    } catch (error) {
      console.error(
        `❌ Error: ${error instanceof Error ? error.message : String(error)}`,
      );
      process.exit(1);
    }
  }

  private printAnalysisSummary(result: AnalysisResult): void {
    console.log(`📊 Analysis Summary:`);
    console.log(`├─ Total entries analyzed: ${result.totalAnalyzed}`);
    console.log(`├─ Allow candidates: ${result.allowCandidates.length}`);
    console.log(`├─ Deny candidates: ${result.denyCandidates.length}`);
    console.log(`└─ Review candidates: ${result.reviewCandidates.length}\n`);
  }

  private filterDuplicates(
    result: AnalysisResult,
    projectPermissions: PermissionsConfig,
  ): AnalysisResult {
    const existingAllow = new Set(projectPermissions.allow || []);
    const existingDeny = new Set(projectPermissions.deny || []);

    const allowCandidates = result.allowCandidates.filter(
      (candidate) => !existingAllow.has(candidate.pattern),
    );

    const denyCandidates = result.denyCandidates.filter(
      (candidate) => !existingDeny.has(candidate.pattern),
    );

    return {
      ...result,
      allowCandidates,
      denyCandidates,
    };
  }

  private async interactiveReview(
    result: AnalysisResult,
  ): Promise<{ allowPatterns: string[]; denyPatterns: string[] }> {
    const approved = {
      allowPatterns: [] as string[],
      denyPatterns: [] as string[],
    };

    console.log("━━━ Interactive Permission Review ━━━\n");

    // レビューが必要なパターンを分類
    const allPatterns = [
      ...result.allowCandidates,
      ...result.denyCandidates,
      ...result.passCandidates,
      ...result.reviewCandidates,
    ];

    const userDecisionPatterns = allPatterns.filter((candidate) => {
      const decisions = candidate.decisions || {
        allow: 0,
        deny: 0,
        ask: 0,
        pass: 0,
      };
      return decisions.ask > 0 || decisions.pass > 0;
    });

    const overAllowedPatterns = allPatterns.filter((candidate) => {
      const decisions = candidate.decisions || {
        allow: 0,
        deny: 0,
        ask: 0,
        pass: 0,
      };
      return (
        decisions.allow >= 10 && decisions.deny === 0 && decisions.ask === 0
      );
    });

    const overDeniedPatterns = allPatterns.filter((candidate) => {
      const decisions = candidate.decisions || {
        allow: 0,
        deny: 0,
        ask: 0,
        pass: 0,
      };
      return decisions.deny >= 5 && decisions.allow === 0;
    });

    const allReviewPatterns = [
      ...userDecisionPatterns,
      ...overAllowedPatterns,
      ...overDeniedPatterns,
    ];

    if (allReviewPatterns.length > 0) {
      console.log(
        `📝 Reviewing ${allReviewPatterns.length} patterns requiring attention:\n`,
      );

      for (let i = 0; i < allReviewPatterns.length; i++) {
        const candidate = allReviewPatterns[i];
        if (!candidate) continue;

        const decisions = candidate.decisions || {
          allow: 0,
          deny: 0,
          ask: 0,
          pass: 0,
        };

        // パターンのタイプを判定
        let patternType = "";
        if (decisions.ask > 0 || decisions.pass > 0) {
          patternType = "🤔 User decision pattern";
        } else if (
          decisions.allow >= 10 &&
          decisions.deny === 0 &&
          decisions.ask === 0
        ) {
          patternType = "⚠️  Over-permissive pattern";
        } else if (decisions.deny >= 5 && decisions.allow === 0) {
          patternType = "🚫 Over-restrictive pattern";
        }

        let action: "allow" | "deny";
        const recAction = candidate.recommendedAction as string;
        if (recAction === "add_to_allow") {
          action = "allow";
        } else {
          action = "deny"; // デフォルトでdeny候補として扱う
        }

        console.log(`\n${patternType}: ${candidate.pattern}`);
        const reviewResult = await this.reviewCandidate(
          candidate,
          i + 1,
          allReviewPatterns.length,
          action,
        );

        if (reviewResult.action === "approve") {
          const pattern = reviewResult.updatedPattern || candidate.pattern;
          if (action === "allow") {
            approved.allowPatterns.push(pattern);
          } else if (action === "deny") {
            approved.denyPatterns.push(pattern);
          }
        } else if (reviewResult.action === "quit") {
          break;
        }
      }
    } else {
      console.log("✅ No patterns requiring review found.\n");
      console.log("Current hook configuration appears balanced.\n");
    }

    return approved;
  }

  private async reviewCandidate(
    candidate: PatternAnalysis,
    current: number,
    total: number,
    type: "allow" | "deny",
  ): Promise<{ action: "approve" | "skip" | "quit"; updatedPattern?: string }> {
    const emoji = type === "allow" ? "✅" : "🚫";
    const action = type === "allow" ? "Allow" : "Deny";

    console.log(
      `[${current}/${total}] ${emoji} ${action} Candidate: ${candidate.pattern}`,
    );
    console.log(`┌─ Frequency: ${candidate.frequency} times`);
    const decisions = candidate.decisions || {
      allow: 0,
      deny: 0,
      ask: 0,
      pass: 0,
    };
    console.log(
      `├─ Hook decisions: Allow=${decisions.allow}, Deny=${decisions.deny}, Ask=${decisions.ask}, Pass=${decisions.pass}`,
    );
    console.log(`├─ Reasoning: ${candidate.reasoning}`);

    if (candidate.examples.length > 0 && candidate.examples[0]) {
      const example = candidate.examples[0];
      const exampleCommand =
        example.input &&
        typeof example.input === "object" &&
        "command" in example.input
          ? String(example.input.command)
          : "N/A";
      console.log(`├─ Example: ${exampleCommand}`);
    }

    console.log(`└─ Action: [A]pprove / [S]kip / [E]dit / [Q]uit`);

    const choice = await this.prompt("Your choice: ");
    console.log();

    switch (choice.toLowerCase()) {
      case "a":
      case "approve":
        return { action: "approve" };
      case "s":
      case "skip":
        return { action: "skip" };
      case "e":
      case "edit": {
        const editResult = await this.editPattern(candidate);
        if (editResult) {
          return { action: "approve", updatedPattern: editResult };
        } else {
          return { action: "skip" };
        }
      }
      case "q":
      case "quit":
        return { action: "quit" };
      default:
        console.log("Invalid choice. Skipping...\n");
        return { action: "skip" };
    }
  }

  private autoApproveSafePatterns(result: AnalysisResult): {
    allowPatterns: string[];
    denyPatterns: string[];
  } {
    const approved = {
      allowPatterns: [] as string[],
      denyPatterns: [] as string[],
    };

    console.log("🔍 Risk-based auto-approval analysis:");

    const safeAllowCandidates = result.allowCandidates.filter((candidate) => {
      const scopeRisk = evaluateScopeRisk(candidate.pattern);
      const operationRisk = evaluateOperationRisk(candidate.pattern);
      const targetRisk = evaluateTargetRisk(candidate.pattern);
      const combinedRisk = combineRiskLevels(
        scopeRisk.level,
        operationRisk.level,
        targetRisk.level,
      );

      const isSafe = shouldAutoApprove(combinedRisk);
      const allowCount = candidate.decisions?.allow || 0;
      const denyCount = candidate.decisions?.deny || 0;

      console.log(
        `  • ${candidate.pattern}:`,
        `\n    Risk: ${combinedRisk} (scope=${scopeRisk.level}, op=${operationRisk.level}, target=${targetRisk.level})`,
        `\n    Usage: allow=${allowCount}, deny=${denyCount}, freq=${candidate.frequency}`,
        `\n    Decision: ${isSafe ? "✅ AUTO-APPROVE" : "❌ NEEDS REVIEW"}`,
      );

      return isSafe && candidate.frequency >= 2;
    });

    const existingAllow = new Set<string>([]);
    try {
      const projectPermissions = this.loadPermissions(
        this.projectPermissionsPath,
      );
      for (const p of projectPermissions.allow || []) {
        existingAllow.add(p);
      }
    } catch {}

    const dangerousDenyCandidates = result.denyCandidates.filter(
      (candidate) => {
        const scopeRisk = evaluateScopeRisk(candidate.pattern);
        const operationRisk = evaluateOperationRisk(candidate.pattern);
        const targetRisk = evaluateTargetRisk(candidate.pattern);
        const combinedRisk = combineRiskLevels(
          scopeRisk.level,
          operationRisk.level,
          targetRisk.level,
        );

        const isHighRisk =
          combinedRisk === "high" || combinedRisk === "critical";
        const denyCount = candidate.decisions?.deny || 0;
        const meetsFrequency = candidate.frequency >= 2;
        const conflictsWithAllow = existingAllow.has(candidate.pattern);

        console.log(
          `  🚫 ${candidate.pattern}:`,
          `\n    Risk: ${combinedRisk} (scope=${scopeRisk.level}, op=${operationRisk.level}, target=${targetRisk.level})`,
          `\n    Usage: deny=${denyCount}, freq=${candidate.frequency}`,
          `\n    Decision: ${isHighRisk && meetsFrequency && !conflictsWithAllow ? "✅ AUTO-DENY" : "❌ SKIP"}`,
        );

        return isHighRisk && meetsFrequency && !conflictsWithAllow;
      },
    );

    approved.allowPatterns = safeAllowCandidates.map((c) => c.pattern);
    approved.denyPatterns = dangerousDenyCandidates.map((c) => c.pattern);

    if (approved.allowPatterns.length > 0 || approved.denyPatterns.length > 0) {
      console.log("\n🤖 Auto-approved patterns based on intrinsic risk:");
      for (const p of approved.allowPatterns) {
        console.log(`  ✅ Allow: ${p}`);
      }
      for (const p of approved.denyPatterns) {
        console.log(`  🚫 Deny: ${p}`);
      }
      console.log();
    } else {
      console.log("\n🤖 No patterns met auto-approval criteria.");
      console.log();
    }

    return approved;
  }

  private async updatePermissions(
    approved: { allowPatterns: string[]; denyPatterns: string[] },
    projectPermissions: PermissionsConfig,
  ): Promise<void> {
    // バックアップの作成
    this.createBackup(this.projectPermissionsPath);

    // プロジェクト設定の更新
    const updatedPermissions = { ...projectPermissions };

    if (approved.allowPatterns.length > 0) {
      updatedPermissions.allow = [
        ...(updatedPermissions.allow || []),
        ...approved.allowPatterns,
      ];
    }

    if (approved.denyPatterns.length > 0) {
      updatedPermissions.deny = [
        ...(updatedPermissions.deny || []),
        ...approved.denyPatterns,
      ];
    }

    this.savePermissions(this.projectPermissionsPath, updatedPermissions);

    console.log(
      `📝 Updated project permissions: ${this.projectPermissionsPath}`,
    );
    if (approved.allowPatterns.length > 0) {
      console.log(`  ➕ Added ${approved.allowPatterns.length} allow patterns`);
    }
    if (approved.denyPatterns.length > 0) {
      console.log(`  ➕ Added ${approved.denyPatterns.length} deny patterns`);
    }
  }

  private loadPermissions(path: string): PermissionsConfig {
    if (!existsSync(path)) {
      return {};
    }

    try {
      const content = readFileSync(path, "utf-8");
      return JSON.parse(content);
    } catch (error) {
      console.warn(
        `Warning: Failed to parse permissions file ${path}: ${error}`,
      );
      return {};
    }
  }

  private savePermissions(path: string, permissions: PermissionsConfig): void {
    try {
      const content = JSON.stringify(permissions, null, 2);
      writeFileSync(path, content, "utf-8");
    } catch (error) {
      throw new Error(`Failed to save permissions to ${path}: ${error}`);
    }
  }

  private printDryRunResults(result: AnalysisResult): void {
    console.log("🔍 Dry Run Results - No changes will be made:\n");

    // 意味のあるパターンを抽出
    const allPatterns = [
      ...result.allowCandidates,
      ...result.denyCandidates,
      ...result.passCandidates,
      ...result.reviewCandidates,
    ];

    // 1. ask/passがあるパターン（ユーザー判断が関わった）
    const userDecisionPatterns = allPatterns.filter((candidate) => {
      const decisions = candidate.decisions || {
        allow: 0,
        deny: 0,
        ask: 0,
        pass: 0,
      };
      return decisions.ask > 0 || decisions.pass > 0;
    });

    // 2. 過剰にauto-allowされているパターン（見直し候補）
    const overAllowedPatterns = allPatterns.filter((candidate) => {
      const decisions = candidate.decisions || {
        allow: 0,
        deny: 0,
        ask: 0,
        pass: 0,
      };
      return (
        decisions.allow >= 10 && decisions.deny === 0 && decisions.ask === 0
      );
    });

    // 3. 過剰にauto-denyされているパターン（緩和候補）
    const overDeniedPatterns = allPatterns.filter((candidate) => {
      const decisions = candidate.decisions || {
        allow: 0,
        deny: 0,
        ask: 0,
        pass: 0,
      };
      return decisions.deny >= 5 && decisions.allow === 0;
    });

    // ユーザー判断が関わったパターン
    if (userDecisionPatterns.length > 0) {
      console.log("🤔 Patterns requiring attention (had ask/pass decisions):");
      userDecisionPatterns.forEach((candidate) => {
        const decisions = candidate.decisions || {
          allow: 0,
          deny: 0,
          ask: 0,
          pass: 0,
        };
        const status =
          decisions.ask > 0
            ? "❓ User decisions needed"
            : "🔄 Delegated to Claude Code";
        console.log(`  • ${candidate.pattern}`);
        console.log(
          `    ${status} - ask=${decisions.ask}, pass=${decisions.pass}, auto-allow=${decisions.allow}, auto-deny=${decisions.deny}`,
        );
        console.log(
          `    Recommendation: ${candidate.recommendedAction} - ${candidate.reasoning}`,
        );
        console.log();
      });
    }

    // 過剰にallowされているパターン
    if (overAllowedPatterns.length > 0) {
      console.log(
        "⚠️  Potentially over-permissive patterns (frequent auto-allow, no user involvement):",
      );
      overAllowedPatterns.forEach((candidate) => {
        const decisions = candidate.decisions || {
          allow: 0,
          deny: 0,
          ask: 0,
          pass: 0,
        };
        console.log(`  • ${candidate.pattern}`);
        console.log(
          `    🤖 Auto-allowed ${decisions.allow} times with no user input or denies`,
        );
        console.log(
          `    💡 Consider: Is this pattern too broad? Should it be more specific?`,
        );
        console.log();
      });
    }

    // 過剰にdenyされているパターン
    if (overDeniedPatterns.length > 0) {
      console.log(
        "🚫 Potentially over-restrictive patterns (frequent auto-deny):",
      );
      overDeniedPatterns.forEach((candidate) => {
        const decisions = candidate.decisions || {
          allow: 0,
          deny: 0,
          ask: 0,
          pass: 0,
        };
        console.log(`  • ${candidate.pattern}`);
        console.log(
          `    🛑 Auto-denied ${decisions.deny} times with no allows`,
        );
        console.log(
          `    💡 Consider: Is this pattern blocking legitimate use? Should it be relaxed?`,
        );
        console.log();
      });
    }

    if (
      userDecisionPatterns.length === 0 &&
      overAllowedPatterns.length === 0 &&
      overDeniedPatterns.length === 0
    ) {
      console.log("✅ No patterns requiring attention found.\n");
      console.log("Current hook configuration appears balanced.\n");
    }
  }

  private createBackup(path: string): void {
    if (!existsSync(path)) return;

    const timestamp = new Date()
      .toISOString()
      .replace(/[:.]/g, "-")
      .slice(0, 19);
    const backupPath = `${path}.backup-${timestamp}`;

    try {
      copyFileSync(path, backupPath);
      console.log(`💾 Backup created: ${backupPath}`);
    } catch (error) {
      console.warn(`Warning: Failed to create backup: ${error}`);
    }
  }

  private parseSinceDate(since: string): Date {
    const now = new Date();

    if (since.endsWith("d")) {
      const days = parseInt(since.slice(0, -1), 10);
      return new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
    }

    if (since.endsWith("h")) {
      const hours = parseInt(since.slice(0, -1), 10);
      return new Date(now.getTime() - hours * 60 * 60 * 1000);
    }

    // ISO日付として解析を試行
    return new Date(since);
  }

  private async editPattern(
    candidate: PatternAnalysis,
  ): Promise<string | null> {
    console.log(`\n━━━ Edit Pattern ━━━`);
    console.log(`Current: ${candidate.pattern}`);
    const decisions = candidate.decisions || {
      allow: 0,
      deny: 0,
      ask: 0,
      pass: 0,
    };
    console.log(
      `Stats: Allow=${decisions.allow}, Deny=${decisions.deny}, Ask=${decisions.ask}, Pass=${decisions.pass}`,
    );
    console.log();

    while (true) {
      console.log("📝 Enter new pattern (or press Enter to cancel):");
      const newPattern = await this.prompt("New pattern: ");

      if (!newPattern.trim()) {
        console.log("✅ Edit cancelled.\n");
        return null;
      }

      // バリデーション
      const validationResult = this.validatePattern(newPattern.trim());
      if (!validationResult.isValid) {
        console.log(`❌ Invalid pattern: ${validationResult.reason}`);
        console.log("Please try again or press Enter to cancel.\n");
        continue;
      }

      if (validationResult.hasWarning) {
        console.log(`⚠️  Warning: ${validationResult.warning}`);
        const confirm = await this.prompt(
          "Continue with this pattern? [y/N]: ",
        );
        if (confirm.toLowerCase() !== "y" && confirm.toLowerCase() !== "yes") {
          continue;
        }
      }

      console.log(`✅ Pattern updated: ${newPattern.trim()}\n`);
      return newPattern.trim();
    }
  }

  private validatePattern(pattern: string): {
    isValid: boolean;
    reason?: string;
    hasWarning?: boolean;
    warning?: string;
  } {
    // 空文字チェック
    if (!pattern || pattern.trim().length === 0) {
      return { isValid: false, reason: "Pattern cannot be empty" };
    }

    // 危険なパターンの検出
    const dangerousPatterns = [
      /^rm\s+.*-rf/i,
      /^sudo\s+rm/i,
      /^chmod\s+777/i,
      /^dd\s+if=/i,
      />\s*\/dev\/s[dr]/,
      /\/\*$/,
      /^\*/,
    ];

    for (const dangerous of dangerousPatterns) {
      if (dangerous.test(pattern)) {
        return {
          isValid: true,
          hasWarning: true,
          warning:
            "This pattern may grant access to potentially dangerous commands",
        };
      }
    }

    // 過度に広範囲なパターンの警告
    if (pattern === "*" || pattern === "**" || pattern === "*:*") {
      return {
        isValid: true,
        hasWarning: true,
        warning:
          "This pattern is very broad and may grant excessive permissions",
      };
    }

    // 基本的な構文チェック
    try {
      // パターンがglob風の場合の簡易チェック
      if (pattern.includes("[") && !pattern.includes("]")) {
        return { isValid: false, reason: "Unclosed bracket in pattern" };
      }
      if (pattern.includes("{") && !pattern.includes("}")) {
        return { isValid: false, reason: "Unclosed brace in pattern" };
      }
    } catch {
      return { isValid: false, reason: "Invalid pattern syntax" };
    }

    return { isValid: true };
  }

  private async prompt(question: string): Promise<string> {
    process.stdout.write(question);

    return new Promise((resolve) => {
      const stdin = process.stdin;
      stdin.setRawMode(true);
      stdin.resume();
      stdin.setEncoding("utf8");

      let input = "";

      const onData = (chunk: string) => {
        if (chunk === "\r" || chunk === "\n") {
          stdin.removeListener("data", onData);
          stdin.setRawMode(false);
          stdin.pause();
          process.stdout.write("\n");
          resolve(input.trim());
        } else if (chunk === "\u0003") {
          // Ctrl+C
          process.exit(0);
        } else if (chunk === "\u007f") {
          // Backspace
          if (input.length > 0) {
            input = input.slice(0, -1);
            process.stdout.write("\b \b");
          }
        } else {
          input += chunk;
          process.stdout.write(chunk);
        }
      };

      stdin.on("data", onData);
    });
  }
}

// コマンドライン引数の解析
function parseArgs(): CommandOptions {
  const args = process.argv.slice(2);
  const options: CommandOptions = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    switch (arg) {
      case "--dry-run":
        options.dryRun = true;
        break;
      case "--since": {
        i++;
        const sinceValue = args[i];
        if (i < args.length && sinceValue) {
          options.since = sinceValue;
        }
        break;
      }
      case "--auto-approve-safe":
        options.autoApproveSafe = true;
        break;
      case "--verbose":
        options.verbose = true;
        break;
      case "--help":
        printHelp();
        process.exit(0);
        break; // unreachable but satisfies linter
      default:
        console.error(`Unknown option: ${arg}`);
        process.exit(1);
    }
  }

  return options;
}

function printHelp(): void {
  console.log(`
Usage: update-auto-approve [options]

Options:
  --dry-run                Show what would be changed without making changes
  --since <time>          Analyze logs since specified time (e.g., '7d', '24h', '2024-09-01')
  --auto-approve-safe     Automatically approve low-risk patterns (no interaction)
  --verbose               Show detailed analysis information
  --help                  Show this help message

Examples:
  update-auto-approve                    # Interactive review of all patterns
  update-auto-approve --dry-run          # Preview changes without applying
  update-auto-approve --since 7d         # Analyze last 7 days only
  update-auto-approve --auto-approve-safe # Auto-approve safe patterns only
`);
}

// メイン実行
if (import.meta.main) {
  const options = parseArgs();
  const updater = new AutoApproveUpdater(options);
  await updater.run();
}
