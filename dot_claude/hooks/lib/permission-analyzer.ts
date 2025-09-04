/**
 * Permission Pattern Analyzer
 * 決定ログを分析して許可/拒否パターンの候補を自動抽出
 */

import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { DecisionLogEntry } from "../types/logging-types.ts";

export interface PatternAnalysis {
  pattern: string;
  frequency: number;
  lastSeen: Date;
  firstSeen: Date;
  riskScore: number;
  recommendedAction: 'allow' | 'deny' | 'pass' | 'review';
  reasoning: string;
  examples: DecisionLogEntry[];
  confidence: number; // 0-100
}

export interface AnalysisResult {
  allowCandidates: PatternAnalysis[];
  denyCandidates: PatternAnalysis[];
  passCandidates: PatternAnalysis[];
  reviewCandidates: PatternAnalysis[];
  totalAnalyzed: number;
  analysisDate: Date;
}

export interface AnalysisOptions {
  maxEntries?: number;
  minFrequency?: number;
  sinceDate?: Date;
  includeTestMode?: boolean;
}

/**
 * 決定ログを分析してパターン候補を抽出
 */
export class PermissionAnalyzer {
  private readonly logPath: string;
  private readonly dangerousPatterns = [
    /rm\s+-rf?\s+[\/~]/,
    /sudo\s+/,
    /dd\s+/,
    /mkfs/,
    /fdisk/,
    /chmod\s+777/,
    /chown\s+root/,
    />\s*\/dev\//,
    /\/etc\/passwd/,
    /\/etc\/shadow/,
    /\.ssh\/id_/
  ];

  private readonly safePatterns = [
    // Bashコマンドパターン
    /^Bash\((git|npm|pnpm|yarn|bun)(\s+[\w-]+)?:\*\)$/,
    /^Bash\((ls|cat|head|tail|grep|find|echo|printf|pwd|whoami|date|mkdir|touch|cd):\*\)$/,
    /^Bash\((git status)\)$/,
    /^Bash\((tsc|tsx|node|npx):\*\)$/,
    
    // ファイルツールパターン（非システムディレクトリ）
    /^(Read|Glob|Grep)\(/,
    /^Edit\(~\/workspace\/\*\*\)$/,
    /^Edit\(\.\*\*\)$/,
    /^Write\(~\/workspace\/\*\*\)$/,
    /^Write\(\.\*\*\)$/
  ];

  constructor(logPath?: string) {
    this.logPath = logPath || join(homedir(), ".claude", "logs", "decisions.jsonl");
  }

  /**
   * ログを読み込んで分析実行
   */
  async analyze(options: AnalysisOptions = {}): Promise<AnalysisResult> {
    const {
      maxEntries = 500,
      minFrequency = 2,
      sinceDate,
      includeTestMode = false
    } = options;

    const entries = this.loadLogEntries(maxEntries, sinceDate, includeTestMode);
    const patterns = await this.extractPatterns(entries);
    const analyzed = this.analyzePatterns(patterns, minFrequency);

    return {
      allowCandidates: analyzed.filter(p => p.recommendedAction === 'allow'),
      denyCandidates: analyzed.filter(p => p.recommendedAction === 'deny'),  
      passCandidates: analyzed.filter(p => p.recommendedAction === 'pass'),
      reviewCandidates: analyzed.filter(p => p.recommendedAction === 'review'),
      totalAnalyzed: entries.length,
      analysisDate: new Date()
    };
  }

  /**
   * ログファイルからエントリを読み込み
   */
  private loadLogEntries(maxEntries: number, sinceDate?: Date, includeTestMode = false): DecisionLogEntry[] {
    if (!existsSync(this.logPath)) {
      throw new Error(`Log file not found: ${this.logPath}`);
    }

    const content = readFileSync(this.logPath, 'utf-8');
    const lines = content.trim().split('\n').filter(Boolean);
    
    // 最新のエントリから取得
    const recentLines = lines.slice(-maxEntries);
    
    const entries: DecisionLogEntry[] = [];
    for (const line of recentLines) {
      try {
        const entry = JSON.parse(line) as DecisionLogEntry;
        
        // フィルタリング条件をチェック
        if (!includeTestMode && entry.session_id?.includes('test')) {
          continue;
        }
        
        if (sinceDate && new Date(entry.timestamp) < sinceDate) {
          continue;
        }

        // 決定ログエントリのみを対象とする
        if ('decision' in entry && 'tool_name' in entry) {
          entries.push(entry);
        }
      } catch (error) {
        console.warn(`Failed to parse log line: ${error}`);
      }
    }

    return entries.reverse(); // 時系列順にソート
  }

  /**
   * エントリからパターンを抽出してグループ化
   */
  private async extractPatterns(entries: DecisionLogEntry[]): Promise<Map<string, DecisionLogEntry[]>> {
    const patterns = new Map<string, DecisionLogEntry[]>();

    for (const entry of entries) {
      const pattern = await this.extractPattern(entry);
      if (pattern) {
        if (!patterns.has(pattern)) {
          patterns.set(pattern, []);
        }
        patterns.get(pattern)!.push(entry);
      }
    }

    return patterns;
  }

  /**
   * 単一エントリからパターンを抽出
   */
  private async extractPattern(entry: DecisionLogEntry): Promise<string | null> {
    const { tool_name, command, input } = entry;

    if (tool_name === 'Bash' && command) {
      // Bashコマンドの場合、実行可能部分を抽出
      const baseCommand = await this.extractBaseCommand(command);
      return baseCommand ? `Bash(${baseCommand})` : null;
    }

    // その他のツールの場合
    if (tool_name && input && typeof input === 'object' && 'file_path' in input) {
      const filePath = input.file_path as string;
      const pathPattern = this.generalizePath(filePath);
      return `${tool_name}(${pathPattern})`;
    }

    // ファイルパスなしのツール
    if (tool_name && !tool_name.startsWith('mcp__')) {
      return tool_name;
    }

    return null;
  }

  /**
   * Bashコマンドから基本コマンドを抽出（既存パーサーを使用）
   */
  private async extractBaseCommand(command: string): Promise<string | null> {
    // 既存のbash-parserを信頼して使用（内部でフォールバック処理済み）
    const { extractCommandsFromCompound } = await import("./bash-parser.js");
    const commands = await extractCommandsFromCompound(command);
    
    // 最初のコマンドを取得して一般化
    const firstCommand = commands[0];
    if (!firstCommand) return null;

    return this.generalizeCommand(firstCommand);
  }

  /**
   * コマンドを一般化してパターン化
   */
  private generalizeCommand(command: string): string {
    const parts = command.trim().split(/\s+/);
    const cmd = parts[0];
    
    if (!cmd) return command;

    // よくあるパターンに基づいて一般化
    if (cmd.match(/^(npm|pnpm|yarn|bun)$/)) {
      const subCommand = parts[1];
      return subCommand ? `${cmd} ${subCommand}:*` : `${cmd}:*`;
    }

    if (cmd.match(/^git$/)) {
      const subCommand = parts[1];
      if (subCommand === 'status' && parts.length === 2) {
        return 'git status';
      }
      return subCommand ? `git ${subCommand}:*` : 'git:*';
    }

    // npx系コマンドの特別処理
    if (cmd === 'npx') {
      const subCommand = parts[1];
      return subCommand ? `npx ${subCommand}:*` : 'npx:*';
    }

    // 基本コマンドの場合
    // Treat common utilities as basic, but preserve dangerous variants when possible
    if (cmd === 'find') {
      // Highlight destructive variants for deny analysis
      if (parts.includes('-delete')) {
        return 'find -delete:*';
      }
      const execIndex = parts.indexOf('-exec');
      if (execIndex !== -1) {
        const next = parts.slice(execIndex + 1).join(' ');
        if (/\brm\b/.test(next)) {
          return 'find -exec rm:*';
        }
      }
      return 'find:*';
    }

    if (cmd.match(/^(ls|cat|head|tail|grep|echo|printf|pwd|mkdir|touch|cd)$/)) {
      return `${cmd}:*`;
    }

    return `${cmd}:*`;
  }

  /**
   * ファイルパスを一般化してパターン化
   */
  private generalizePath(filePath: string): string {
    // ホームディレクトリの置換
    const homeDir = homedir();
    let normalized = filePath.replace(homeDir, '~');

    // 現在のディレクトリの相対パス化
    if (normalized.startsWith(process.cwd())) {
      normalized = normalized.replace(process.cwd(), '.');
    }

    // よくあるパターンの一般化
    if (normalized.includes('node_modules')) {
      return 'node_modules/**';
    }

    if (normalized.includes('.git/')) {
      return '.git/**';
    }

    if (normalized.match(/\.(test|spec)\./)) {
      return '**/*.test.*';
    }

    // ディレクトリパターンの抽出
    const parts = normalized.split('/');
    if (parts.length > 2) {
      return parts.slice(0, 2).join('/') + '/**';
    }

    return normalized;
  }

  /**
   * パターンを分析して推奨アクションを決定
   */
  private analyzePatterns(patterns: Map<string, DecisionLogEntry[]>, minFrequency: number): PatternAnalysis[] {
    const results: PatternAnalysis[] = [];

    for (const [pattern, entries] of patterns) {
      if (entries.length < minFrequency) {
        continue; // 頻度が低いパターンはスキップ
      }

      const analysis = this.analyzePattern(pattern, entries);
      results.push(analysis);
    }

    // 信頼度でソート
    return results.sort((a, b) => b.confidence - a.confidence);
  }

  /**
   * 単一パターンの分析
   */
  private analyzePattern(pattern: string, entries: DecisionLogEntry[]): PatternAnalysis {
    const decisions = entries.map(e => e.decision);
    const timestamps = entries.map(e => new Date(e.timestamp));
    
    const allowCount = decisions.filter(d => d === 'allow').length;
    const denyCount = decisions.filter(d => d === 'deny').length;
    const askCount = decisions.filter(d => d === 'ask').length;

    const riskScore = this.calculateRiskScore(pattern, entries);
    const confidence = this.calculateConfidence(entries.length, decisions);
    
    let recommendedAction: 'allow' | 'deny' | 'pass' | 'review';
    let reasoning: string;

    // 危険パターンの検出
    if (this.isDangerousPattern(pattern)) {
      recommendedAction = 'deny';
      reasoning = 'Potentially dangerous system operation';
    }
    // 明確に拒否されているパターン（十分な頻度と比率、かつ基本ユーティリティ除外）
    else if (
      denyCount >= 2 &&
      denyCount >= allowCount &&
      (denyCount / entries.length) >= 0.6 &&
      !this.isBasicUtilityPattern(pattern)
    ) {
      recommendedAction = 'deny';
      reasoning = `Frequently denied (${denyCount}/${entries.length}) with high ratio`;
    }
    // プロジェクト依存パターン（テストファイル等）の検出
    else if (this.isProjectDependentPattern(pattern)) {
      recommendedAction = 'pass';
      reasoning = `Project-dependent pattern - should be managed per-project/session`;
    }
    // Pass-through パターン（セッション限定許可）の検出
    else if (this.isPassThroughPattern(pattern, entries)) {
      recommendedAction = 'pass';
      reasoning = `Session-only approval recommended - temporary or complex pipeline command`;
    }
    // 制御構造は安全なので allow
    else if (this.isControlStructurePattern(pattern)) {
      recommendedAction = 'allow';
      reasoning = `Safe control structure keyword`;
    }
    // 安全で頻繁に許可されているパターン
    else if (this.isSafePattern(pattern) && (allowCount > askCount * 2)) {
      recommendedAction = 'allow';
      reasoning = `Safe operation frequently approved (${allowCount}/${entries.length})`;
    }
    // 頻繁にaskになっているが安全そうなパターン
    else if (askCount > 2 && riskScore <= 3 && denyCount === 0 && !this.isProjectDependentPattern(pattern)) {
      recommendedAction = 'allow';
      reasoning = `Low-risk pattern frequently requiring manual approval (${askCount} times)`;
    }
    // その他はレビュー必要
    else {
      recommendedAction = 'review';
      reasoning = `Inconsistent pattern or insufficient data`;
    }

    return {
      pattern,
      frequency: entries.length,
      lastSeen: new Date(Math.max(...timestamps.map(t => t.getTime()))),
      firstSeen: new Date(Math.min(...timestamps.map(t => t.getTime()))),
      riskScore,
      recommendedAction,
      reasoning,
      examples: entries.slice(0, 3), // 最初の3つの例
      confidence
    };
  }

  /**
   * リスクスコアの計算（1-10）
   */
  private calculateRiskScore(pattern: string, entries: DecisionLogEntry[]): number {
    let score = 5; // 中央値から開始

    // 危険パターンのチェック
    if (this.isDangerousPattern(pattern)) {
      score = Math.max(score, 8);
    }

    // 安全パターンのチェック
    if (this.isSafePattern(pattern)) {
      score = Math.min(score, 3);
    }

    // システムディレクトリへのアクセス
    if (pattern.includes('/etc/') || pattern.includes('/usr/') || pattern.includes('/var/')) {
      score = Math.max(score, 7);
    }

    // 設定ファイルの操作
    if (pattern.includes('.ssh/') || pattern.includes('id_rsa') || pattern.includes('password')) {
      score = Math.max(score, 9);
    }

    // 拒否された回数に基づく調整
    const denyCount = entries.filter(e => e.decision === 'deny').length;
    if (denyCount > 0) {
      score = Math.max(score, 6 + denyCount);
    }

    return Math.min(10, Math.max(1, score));
  }

  /**
   * 信頼度の計算（0-100）
   */
  private calculateConfidence(frequency: number, decisions: string[]): number {
    const uniqueDecisions = new Set(decisions).size;
    
    // 基本信頼度：頻度ベース
    let confidence = Math.min(90, frequency * 10);
    
    // 一貫性ボーナス：同じ決定が多い場合
    if (uniqueDecisions === 1) {
      confidence += 10;
    }
    
    // 低頻度パターンの調整（3回未満は10ポイント減点に軽減）
    if (frequency < 3) {
      confidence = Math.max(50, confidence - 10); // 最低50%は保証
    }

    return Math.min(100, Math.max(0, confidence));
  }

  /**
   * 危険パターンの判定
   */
  private isDangerousPattern(pattern: string): boolean {
    return this.dangerousPatterns.some(regex => regex.test(pattern));
  }

  /**
   * 安全パターンの判定
   */
  private isSafePattern(pattern: string): boolean {
    return this.safePatterns.some(regex => regex.test(pattern));
  }

  /**
   * 基本ユーティリティコマンドの判定（過剰なdeny提案を避ける）
   */
  private isBasicUtilityPattern(pattern: string): boolean {
    const basicUtility = [/^Bash\((ls|cat|head|tail|grep|find|printf|echo|awk|sed|cut|sort|uniq|xargs|tr):\*\)$/];
    return basicUtility.some(r => r.test(pattern));
  }

  /**
   * プロジェクト依存パターンの判定
   * これらはプロジェクトやセッションごとに判断すべきパターン
   */
  private isProjectDependentPattern(pattern: string): boolean {
    const projectDependentPatterns = [
      // テストファイル関連
      /\*\*\/\*\.test\./,
      /\*\*\/\*\.spec\./,
      /\/test\//,
      /\/tests\//,
      /\/spec\//,
      /\/__tests__\//,
      
      // 設定・環境ファイル
      /\.env/,
      /\.config/,
      /package\.json/,
      /tsconfig\.json/,
      /\.eslintrc/,
      /\.prettierrc/,
      
      // ビルド成果物（プロジェクトによって扱いが異なる）
      /\/dist\//,
      /\/build\//,
      /\/coverage\//,
      /\/target\//,
      
      // プロジェクト固有のディレクトリパターン
      /\/src\/.*\.test\./,
      /\/lib\/.*\.spec\./,
      
      // 開発用一時ファイル
      /\/tmp\//,
      /\/temp\//,
      /\.tmp$/,
      /\.temp$/
    ];

    return projectDependentPatterns.some(regex => regex.test(pattern));
  }

  /**
   * 制御構造パターンの判定
   * Bash制御構造は安全なのでallow対象
   */
  private isControlStructurePattern(pattern: string): boolean {
    const controlPatterns = [
      'Bash(if)', 'Bash(then)', 'Bash(else)', 'Bash(fi)',
      'Bash(while)', 'Bash(for)', 'Bash(do)', 'Bash(done)'
    ];
    return controlPatterns.includes(pattern);
  }

  /**
   * Pass-through パターンの判定
   * セッション中のみ許可すべき一時的・複雑なパターン
   */
  private isPassThroughPattern(pattern: string, entries: DecisionLogEntry[]): boolean {
    const passThroughPatterns = [
      // 複雑なパイプライン操作（:* 構文のみ）
      'Bash(xargs:*)',
      'Bash(timeout:*)',
      
      // テスト・デバッグ用途
      'Bash(echo test)',
      
      // 一時的な探索・分析コマンド（unknown_commandなど）
      'Bash(unknown_command)'
    ];

    // 高頻度の場合はallowに分類すべきかもしれない
    const frequency = entries.length;
    if (frequency > 10) {
      return false; // 頻繁なら永続設定が適切
    }

    return passThroughPatterns.includes(pattern);
  }
}
