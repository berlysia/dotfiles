/**
 * Permission Pattern Analyzer
 * 決定ログを分析して許可/拒否パターンの候補を自動抽出
 */

import { readFileSync, existsSync, realpathSync, lstatSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, relative } from "node:path";
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
    // npx/tsx はメタ実行のため safe 扱いしない
    /^Bash\((tsc):\*\)$/,
    
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
      const baseCommand = await this.extractBaseCommand(command, (entry as any).cwd);
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
  private async extractBaseCommand(command: string, entryCwd?: string): Promise<string | null> {
    // 既存のbash-parserを信頼して使用（内部でフォールバック処理済み）
    const { extractCommandsFromCompound, extractCommandsDetailed } = await import("./bash-parser.js");
    const commands = await extractCommandsFromCompound(command);

    // sh -c / bash -c / zsh -c / xargs sh -c の場合は安全性を判定して分岐
    const hasShellC = /(\bsh|\bbash|\bzsh)\s+-c\b/.test(command) || /\bxargs\b[\s\S]*?\bsh\s+-c\b/.test(command);
    if (hasShellC) {
      const analysis = await this.analyzeShInvocationSafety(command, commands, entryCwd, extractCommandsDetailed);
      if (analysis.safe && analysis.firstSafe) {
        return this.generalizeCommand(analysis.firstSafe);
      }
      // 安全でない/判定不能なら pass/review 寄りのパターンにする
      return 'sh -c:*';
    }

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

    // npx / bunx / pnpm dlx / yarn dlx を同等扱いし、パッケージ名ベースに正規化
    const normalizeNpxPackage = (arr: string[], startIndex: number) => {
      for (let i = startIndex; i < arr.length; i++) {
        const tok = arr[i];
        if (!tok || tok.startsWith('-')) continue; // フラグは飛ばす
        // パッケージ@version の場合はパッケージ名のみ抽出
        const pkg = tok.split('@')[0];
        return pkg;
      }
      return '';
    };

    if (cmd === 'npx') {
      const pkg = normalizeNpxPackage(parts, 1);
      return pkg ? `npx ${pkg}:*` : 'npx:*';
    }

    if (cmd === 'bunx') {
      const pkg = normalizeNpxPackage(parts, 1);
      return pkg ? `npx ${pkg}:*` : 'npx:*';
    }

    if (cmd === 'pnpm' && parts[1] === 'dlx') {
      const pkg = normalizeNpxPackage(parts, 2);
      return pkg ? `npx ${pkg}:*` : 'npx:*';
    }

    if (cmd === 'yarn' && parts[1] === 'dlx') {
      const pkg = normalizeNpxPackage(parts, 2);
      return pkg ? `npx ${pkg}:*` : 'npx:*';
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
      // メタ実行（詳細解析が必要なためセッション限定推奨）
      'Bash(sh -c:*)',
      'Bash(bash -c:*)',
      'Bash(zsh -c:*)',
      
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
  
  /**
   * sh -c / bash -c の安全性を簡易判定
   * - commands: ネスト抽出された個々のコマンドテキスト（単純分割ベース）
   */
  private async analyzeShInvocationSafety(
    original: string,
    commands: string[],
    entryCwd: string | undefined,
    parseDetailed: (cmd: string) => Promise<import('./bash-parser.js').SimpleCommand[]>
  ): Promise<{ safe: boolean; firstSafe?: string }> {
    if (commands.length === 0) return { safe: false };

    // 危険なシグネチャ（粗め、誤許可を防ぐため保守的）
    const dangerous = [
      /\brm\b/, /\bmv\b/, /\bchmod\b/, /\bchown\b/, /\bsudo\b/, /\bdd\b/, /\bmkfs\b/, /\bfdisk\b/,
      /\btee\b/, /\bmount\b/, /\bumount\b/, /\bshutdown\b/, /\breboot\b/,
      /find\s+[^\n]*?-delete/, /find\s+[^\n]*?-exec\s+[^\n]*?\brm\b/,
      /sed\s+[^\n]*?-i\b/
    ];

    // 書き込み系リダイレクトの抽出（/dev/null 以外は原則unsafe。ただしワークスペース配下の安全パスは許容）
    const redirRegex = /(\s|^)\d*>>?\s*(["']?)([^\s"'&|;]+)\2/g;

    const isSafeWorkspaceTarget = (target: string): boolean => {
      if (!target || target === '/dev/null') return true;
      // 明らかなFDや特殊ターゲットは不許可
      if (target.startsWith('/dev/') && target !== '/dev/null') return false;
      if (target.startsWith('>&') || target.startsWith('&>')) return false;

      // /tmp 配下は許容
      if (target === '/tmp' || target.startsWith('/tmp/')) return true;

      // 変数展開やコマンド置換が含まれる場合は保守的に不許可
      if (/[`$]/.test(target)) return false;

      const cwd = (typeof entryCwd === 'string' && entryCwd) ? entryCwd : process.cwd();
      // 絶対パスはCWD配下のみ許容
      let abs: string;
      if (target.startsWith('/')) {
        abs = target;
        if (!abs.startsWith(cwd + '/') && abs !== cwd) return false;
      } else if (target.startsWith('~')) {
        // ホーム直下は対象外（安全側）
        return false;
      } else {
        // 相対パスはCWD基準
        abs = resolve(cwd, target);
      }

      // CWDに対する相対パスで禁止ディレクトリを判定
      const rel = relative(cwd, abs).replace(/\\/g, '/');
      const banned = ['.git/', 'node_modules/', 'dist/', 'build/', 'target/', 'coverage/', '.next/'];
      if (rel === '' || rel === '.') return false; // CWD直書きは許容するか？ 明示的に可とする
      for (const b of banned) {
        if (rel.startsWith(b)) return false;
      }

      // 親ディレクトリがシンボリックリンクでワークスペース外を指す場合を拒否
      try {
        const parent = abs.replace(/\/[^/]*$/, '') || cwd;
        if (existsSync(parent)) {
          const realParent = realpathSync(parent);
          const realCwd = realpathSync(cwd);
          if (!realParent.startsWith(realCwd + '/') && realParent !== realCwd) {
            return false;
          }
        }
      } catch {
        // realpath取得に失敗した場合は保守的に不許可
        return false;
      }
      return true;
    };

    // 許容する安全ユーティリティ
    const safeUtils = /^(ls|cat|head|tail|grep|echo|printf|pwd|which|whoami|date|cut|uniq|tr|column|paste|realpath|readlink|stat|du|df|wc|sort|awk)$/;

    for (const cmdText of commands) {
      const text = (cmdText || '').trim();
      if (!text) continue;

      // まず簡易テキストチェック（早期不許可）
      if (dangerous.some(r => r.test(text))) return { safe: false };

      // 詳細解析（AST）
      const details = await parseDetailed(text);
      const first = details[0];
      const name = (first?.name || '').trim();
      if (!name) return { safe: false };

      // 安全ユーティリティ以外は不許可
      if (!safeUtils.test(name)) return { safe: false };

      // コマンド固有の危険フラグ
      if (name === 'find') {
        const argline = (first.args || []).join(' ');
        if (/\s-delete(\s|$)/.test(argline)) return { safe: false };
        if (/\s-exec\s+[^;]*\brm\b/.test(argline)) return { safe: false };
      }
      if (name === 'sed') {
        const argline = (first.args || []).join(' ');
        if (/(^|\s)-i(\b|\s|=)/.test(argline) || /--in-place\b/.test(argline)) return { safe: false };
      }
      if (name === 'tee') {
        // tee は書込み系。/tmp や安全ワークスペースのみ許容も検討できるが一旦不許可
        return { safe: false };
      }

      // リダイレクト先の検査（ASTで取得したトークン文字列に対して適用）
      const redirs = first.redirections || [];
      for (const r of redirs) {
        let m: RegExpExecArray | null;
        while ((m = redirRegex.exec(r)) !== null) {
          const target = m[3] || '';
          if (!isSafeWorkspaceTarget(target)) return { safe: false };
        }
      }
    }

    return { safe: true, firstSafe: commands[0] };
  }
}
