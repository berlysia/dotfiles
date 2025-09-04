#!/usr/bin/env -S bun run --silent

/**
 * Update Auto-Approve Command Implementation
 * 決定ログに基づく許可/拒否設定の自動最適化
 */

import { existsSync, readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { PermissionAnalyzer, type AnalysisResult, type PatternAnalysis } from "../hooks/lib/permission-analyzer.ts";

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
    this.projectPermissionsPath = join(process.cwd(), "dot_claude", "permissions.json");
    this.options = options;
  }

  async run(): Promise<void> {
    console.log("🔍 Analyzing permission patterns from decision logs...\n");

    try {
      // 分析実行
      const analysisOptions: any = {
        includeTestMode: false
      };
      
      if (this.options.since) {
        analysisOptions.sinceDate = this.parseSinceDate(this.options.since);
      }

      const result = await this.analyzer.analyze(analysisOptions);
      
      if (this.options.verbose) {
        this.printAnalysisSummary(result);
      }

      if (result.allowCandidates.length === 0 && result.denyCandidates.length === 0) {
        console.log("✅ No new permission patterns to update. Current settings appear optimal.\n");
        return;
      }

      // 既存設定の読み込み
      const projectPermissions = this.loadPermissions(this.projectPermissionsPath);

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

      if (approved.allowPatterns.length > 0 || approved.denyPatterns.length > 0) {
        await this.updatePermissions(approved, projectPermissions);
        console.log("\n✅ Permission settings updated successfully!");
      } else {
        console.log("\n✅ No changes made to permission settings.");
      }

    } catch (error) {
      console.error(`❌ Error: ${error instanceof Error ? error.message : String(error)}`);
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
    projectPermissions: PermissionsConfig
  ): AnalysisResult {
    const existingAllow = new Set(projectPermissions.allow || []);
    const existingDeny = new Set(projectPermissions.deny || []);

    const allowCandidates = result.allowCandidates.filter(
      candidate => !existingAllow.has(candidate.pattern)
    );

    const denyCandidates = result.denyCandidates.filter(
      candidate => !existingDeny.has(candidate.pattern)
    );

    return {
      ...result,
      allowCandidates,
      denyCandidates
    };
  }

  private async interactiveReview(result: AnalysisResult): Promise<{ allowPatterns: string[], denyPatterns: string[] }> {
    const approved = { allowPatterns: [] as string[], denyPatterns: [] as string[] };
    
    console.log("━━━ Interactive Permission Review ━━━\n");

    // Allow候補のレビュー
    if (result.allowCandidates.length > 0) {
      console.log(`📝 Reviewing ${result.allowCandidates.length} allow candidates:\n`);
      
      for (let i = 0; i < result.allowCandidates.length; i++) {
        const candidate = result.allowCandidates[i];
        if (!candidate) continue;
        
        const reviewResult = await this.reviewCandidate(candidate, i + 1, result.allowCandidates.length, 'allow');
        
        if (reviewResult.action === 'approve') {
          approved.allowPatterns.push(reviewResult.updatedPattern || candidate.pattern);
        } else if (reviewResult.action === 'quit') {
          break;
        }
      }
    }

    // Deny候補のレビュー  
    if (result.denyCandidates.length > 0) {
      console.log(`\n🚫 Reviewing ${result.denyCandidates.length} deny candidates:\n`);
      
      for (let i = 0; i < result.denyCandidates.length; i++) {
        const candidate = result.denyCandidates[i];
        if (!candidate) continue;
        
        const reviewResult = await this.reviewCandidate(candidate, i + 1, result.denyCandidates.length, 'deny');
        
        if (reviewResult.action === 'approve') {
          approved.denyPatterns.push(reviewResult.updatedPattern || candidate.pattern);
        } else if (reviewResult.action === 'quit') {
          break;
        }
      }
    }

    return approved;
  }

  private async reviewCandidate(
    candidate: PatternAnalysis, 
    current: number, 
    total: number, 
    type: 'allow' | 'deny'
  ): Promise<{ action: 'approve' | 'skip' | 'quit'; updatedPattern?: string }> {
    const emoji = type === 'allow' ? '✅' : '🚫';
    const action = type === 'allow' ? 'Allow' : 'Deny';
    
    console.log(`[${current}/${total}] ${emoji} ${action} Candidate: ${candidate.pattern}`);
    console.log(`┌─ Frequency: ${candidate.frequency} times`);
    console.log(`├─ Risk Score: ${candidate.riskScore}/10 (${this.getRiskLevel(candidate.riskScore)})`);
    console.log(`├─ Confidence: ${candidate.confidence}%`);
    console.log(`├─ Reasoning: ${candidate.reasoning}`);
    
    if (candidate.examples.length > 0 && candidate.examples[0]) {
      console.log(`├─ Example: ${candidate.examples[0].command || 'N/A'}`);
    }
    
    console.log(`└─ Action: [A]pprove / [S]kip / [E]dit / [Q]uit`);
    
    const choice = await this.prompt("Your choice: ");
    console.log();
    
    switch (choice.toLowerCase()) {
      case 'a':
      case 'approve':
        return { action: 'approve' };
      case 's':
      case 'skip':
        return { action: 'skip' };
      case 'e':
      case 'edit':
        const editResult = await this.editPattern(candidate);
        if (editResult) {
          return { action: 'approve', updatedPattern: editResult };
        } else {
          return { action: 'skip' };
        }
      case 'q':
      case 'quit':
        return { action: 'quit' };
      default:
        console.log("Invalid choice. Skipping...\n");
        return { action: 'skip' };
    }
  }

  private autoApproveSafePatterns(result: AnalysisResult): { allowPatterns: string[], denyPatterns: string[] } {
    const approved = { allowPatterns: [] as string[], denyPatterns: [] as string[] };

    console.log("🔍 Auto-approval analysis:");
    result.allowCandidates.forEach(candidate => {
      const isLowRisk = candidate.riskScore <= 3;
      const isHighConfidence = candidate.confidence >= 80;
      console.log(`  • ${candidate.pattern}: risk=${candidate.riskScore}/10, confidence=${candidate.confidence}%, eligible=${isLowRisk && isHighConfidence ? 'YES' : 'NO'}`);
    });

    // 低リスク（スコア1-3）かつ高信頼度（80%以上）のallow候補を自動承認
    let safeAllowCandidates = result.allowCandidates.filter(
      candidate => candidate.riskScore <= 3 && candidate.confidence >= 80
    );

    // npx系はホワイトリストのパッケージのみ自動承認
    const npxWhitelist = new Set<string>([
      'vitest','jest','biome','dpdm','madge','tailwindcss','unocss','playwright','eslint','tsc','tsgo'
    ]);
    safeAllowCandidates = safeAllowCandidates.filter(c => {
      const m = c.pattern.match(/^Bash\(npx\s+(\S+):\*\)$/);
      if (!m) return true;
      const pkg = m[1];
      return npxWhitelist.has(pkg);
    });

    // 高リスク（スコア8-10）のdeny候補の自動承認は、以下を満たす場合のみ
    // - 信頼度80%以上、頻度3回以上
    // - 基本ユーティリティコマンドではない（例: find/grep/awkなど）
    // - パターンが広い既存Allowと衝突しない（単純チェック）
    const basicUtility = /^Bash\((ls|cat|head|tail|grep|find|printf|echo|awk|sed|cut|sort|uniq|xargs|tr):\*\)$/;
    const existingAllow = new Set<string>([]);
    // 既存許可（広範囲）を読み込んで衝突除外
    try {
      const projectPermissions = this.loadPermissions(this.projectPermissionsPath);
      (projectPermissions.allow || []).forEach(p => existingAllow.add(p));
    } catch {}

    const dangerousDenyCandidates = result.denyCandidates.filter(candidate => {
      const meetsRisk = candidate.riskScore >= 8;
      const meetsConfidence = candidate.confidence >= 80;
      const meetsFrequency = (candidate as any).frequency ? (candidate as any).frequency >= 3 : true; // frequencyありなら3以上
      const notBasicUtility = !basicUtility.test(candidate.pattern);
      const conflictsWithAllow = existingAllow.has(candidate.pattern);
      return meetsRisk && meetsConfidence && meetsFrequency && notBasicUtility && !conflictsWithAllow;
    });

    approved.allowPatterns = safeAllowCandidates.map(c => c.pattern);
    approved.denyPatterns = dangerousDenyCandidates.map(c => c.pattern);

    if (approved.allowPatterns.length > 0 || approved.denyPatterns.length > 0) {
      console.log("🤖 Auto-approved safe patterns:");
      approved.allowPatterns.forEach(p => console.log(`  ✅ Allow: ${p}`));
      approved.denyPatterns.forEach(p => console.log(`  🚫 Deny: ${p}`));
      console.log();
    } else {
      console.log("🤖 No patterns met auto-approval criteria.");
      console.log();
    }

    return approved;
  }

  private async updatePermissions(
    approved: { allowPatterns: string[], denyPatterns: string[] },
    projectPermissions: PermissionsConfig
  ): Promise<void> {
    // バックアップの作成
    this.createBackup(this.projectPermissionsPath);

    // プロジェクト設定の更新
    const updatedPermissions = { ...projectPermissions };
    
    if (approved.allowPatterns.length > 0) {
      updatedPermissions.allow = [
        ...(updatedPermissions.allow || []),
        ...approved.allowPatterns
      ];
    }
    
    if (approved.denyPatterns.length > 0) {
      updatedPermissions.deny = [
        ...(updatedPermissions.deny || []),
        ...approved.denyPatterns
      ];
    }

    this.savePermissions(this.projectPermissionsPath, updatedPermissions);
    
    console.log(`📝 Updated project permissions: ${this.projectPermissionsPath}`);
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
      const content = readFileSync(path, 'utf-8');
      return JSON.parse(content);
    } catch (error) {
      console.warn(`Warning: Failed to parse permissions file ${path}: ${error}`);
      return {};
    }
  }

  private savePermissions(path: string, permissions: PermissionsConfig): void {
    try {
      const content = JSON.stringify(permissions, null, 2);
      writeFileSync(path, content, 'utf-8');
    } catch (error) {
      throw new Error(`Failed to save permissions to ${path}: ${error}`);
    }
  }

  private printDryRunResults(result: AnalysisResult): void {
    console.log("🔍 Dry Run Results - No changes will be made:\n");

    if (result.allowCandidates.length > 0) {
      console.log("✅ Allow candidates:");
      result.allowCandidates.forEach(candidate => {
        console.log(`  • ${candidate.pattern} (frequency: ${candidate.frequency}, risk: ${candidate.riskScore}/10)`);
      });
      console.log();
    }

    if (result.denyCandidates.length > 0) {
      console.log("🚫 Deny candidates:");
      result.denyCandidates.forEach(candidate => {
        console.log(`  • ${candidate.pattern} (frequency: ${candidate.frequency}, risk: ${candidate.riskScore}/10)`);
      });
      console.log();
    }

    if (result.allowCandidates.length === 0 && result.denyCandidates.length === 0) {
      console.log("No actionable patterns found.\n");
    }
  }


  private createBackup(path: string): void {
    if (!existsSync(path)) return;

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const backupPath = `${path}.backup-${timestamp}`;
    
    try {
      copyFileSync(path, backupPath);
      console.log(`💾 Backup created: ${backupPath}`);
    } catch (error) {
      console.warn(`Warning: Failed to create backup: ${error}`);
    }
  }

  private getWorkspaceRoot(): string | null {
    try {
      const result = execSync('git rev-parse --show-toplevel', {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore']
      });
      return result.trim();
    } catch {
      return null;
    }
  }

  private parseSinceDate(since: string): Date {
    const now = new Date();
    
    if (since.endsWith('d')) {
      const days = parseInt(since.slice(0, -1));
      return new Date(now.getTime() - (days * 24 * 60 * 60 * 1000));
    }
    
    if (since.endsWith('h')) {
      const hours = parseInt(since.slice(0, -1));
      return new Date(now.getTime() - (hours * 60 * 60 * 1000));
    }

    // ISO日付として解析を試行
    return new Date(since);
  }

  private getRiskLevel(score: number): string {
    if (score <= 3) return 'Low';
    if (score <= 6) return 'Medium';
    return 'High';
  }

  private async editPattern(candidate: PatternAnalysis): Promise<string | null> {
    console.log(`\n━━━ Edit Pattern ━━━`);
    console.log(`Current: ${candidate.pattern}`);
    console.log(`Type: ${candidate.riskScore <= 5 ? 'Allow' : 'Deny'} pattern`);
    console.log();
    
    while (true) {
      console.log('📝 Enter new pattern (or press Enter to cancel):');
      const newPattern = await this.prompt('New pattern: ');
      
      if (!newPattern.trim()) {
        console.log('✅ Edit cancelled.\n');
        return null;
      }
      
      // バリデーション
      const validationResult = this.validatePattern(newPattern.trim());
      if (!validationResult.isValid) {
        console.log(`❌ Invalid pattern: ${validationResult.reason}`);
        console.log('Please try again or press Enter to cancel.\n');
        continue;
      }
      
      if (validationResult.hasWarning) {
        console.log(`⚠️  Warning: ${validationResult.warning}`);
        const confirm = await this.prompt('Continue with this pattern? [y/N]: ');
        if (confirm.toLowerCase() !== 'y' && confirm.toLowerCase() !== 'yes') {
          continue;
        }
      }
      
      console.log(`✅ Pattern updated: ${newPattern.trim()}\n`);
      return newPattern.trim();
    }
  }

  private validatePattern(pattern: string): { isValid: boolean; reason?: string; hasWarning?: boolean; warning?: string } {
    // 空文字チェック
    if (!pattern || pattern.trim().length === 0) {
      return { isValid: false, reason: 'Pattern cannot be empty' };
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
          warning: 'This pattern may grant access to potentially dangerous commands' 
        };
      }
    }
    
    // 過度に広範囲なパターンの警告
    if (pattern === '*' || pattern === '**' || pattern === '*:*') {
      return { 
        isValid: true, 
        hasWarning: true, 
        warning: 'This pattern is very broad and may grant excessive permissions' 
      };
    }
    
    // 基本的な構文チェック
    try {
      // パターンがglob風の場合の簡易チェック
      if (pattern.includes('[') && !pattern.includes(']')) {
        return { isValid: false, reason: 'Unclosed bracket in pattern' };
      }
      if (pattern.includes('{') && !pattern.includes('}')) {
        return { isValid: false, reason: 'Unclosed brace in pattern' };
      }
    } catch (error) {
      return { isValid: false, reason: 'Invalid pattern syntax' };
    }
    
    return { isValid: true };
  }

  private async prompt(question: string): Promise<string> {
    process.stdout.write(question);
    
    return new Promise((resolve) => {
      const stdin = process.stdin;
      stdin.setRawMode(true);
      stdin.resume();
      stdin.setEncoding('utf8');
      
      let input = '';
      
      const onData = (chunk: string) => {
        if (chunk === '\r' || chunk === '\n') {
          stdin.removeListener('data', onData);
          stdin.setRawMode(false);
          stdin.pause();
          process.stdout.write('\n');
          resolve(input.trim());
        } else if (chunk === '\u0003') {
          // Ctrl+C
          process.exit(0);
        } else if (chunk === '\u007f') {
          // Backspace
          if (input.length > 0) {
            input = input.slice(0, -1);
            process.stdout.write('\b \b');
          }
        } else {
          input += chunk;
          process.stdout.write(chunk);
        }
      };
      
      stdin.on('data', onData);
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
      case '--dry-run':
        options.dryRun = true;
        break;
      case '--since':
        i++;
        if (i < args.length && args[i]) {
          options.since = args[i]!;
        }
        break;
      case '--auto-approve-safe':
        options.autoApproveSafe = true;
        break;
      case '--verbose':
        options.verbose = true;
        break;
      case '--help':
        printHelp();
        process.exit(0);
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
