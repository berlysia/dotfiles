/**
 * Permission Pattern Analyzer
 * 決定ログを分析して許可/拒否パターンの候補を自動抽出
 *
 * 現在の制限:
 * - フックの自動判定結果のみを分析（ユーザーの実際の判断は未記録）
 * - askされたコマンドでユーザーがどう選択したかは不明
 * - passされたコマンドをClaude Codeがどう処理したかは不明
 *
 * 将来の改善案:
 * - ユーザー決定ログ（user-decisions.jsonl）の追加
 * - Claude Code処理結果ログの追加
 * - 実際のユーザー行動に基づく真の統計分析
 */

import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import type { DecisionLogEntry } from "../types/logging-types.ts";

export interface PatternAnalysis {
  pattern: string;
  frequency: number;
  lastSeen: Date;
  firstSeen: Date;
  decisions: {
    allow: number;
    deny: number;
    ask: number;
    pass: number;
  };
  recommendedAction:
    | "add_to_allow"
    | "add_to_deny"
    | "remove_unused"
    | "needs_pattern"
    | "keep_as_is";
  reasoning: string;
  examples: DecisionLogEntry[];
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

  constructor(logPath?: string) {
    this.logPath =
      logPath || join(homedir(), ".claude", "logs", "decisions.jsonl");
  }

  /**
   * ログを読み込んで分析実行
   */
  async analyze(options: AnalysisOptions = {}): Promise<AnalysisResult> {
    const {
      maxEntries = 500,
      minFrequency = 2,
      sinceDate,
      includeTestMode = false,
    } = options;

    const entries = this.loadLogEntries(maxEntries, sinceDate, includeTestMode);
    const patterns = await this.extractPatterns(entries);
    const analyzed = this.analyzePatterns(patterns, minFrequency);

    return {
      allowCandidates: analyzed.filter(
        (p) => p.recommendedAction === "add_to_allow",
      ),
      denyCandidates: analyzed.filter(
        (p) => p.recommendedAction === "add_to_deny",
      ),
      passCandidates: analyzed.filter(
        (p) => p.recommendedAction === "needs_pattern",
      ),
      reviewCandidates: analyzed.filter(
        (p) =>
          p.recommendedAction === "keep_as_is" ||
          p.recommendedAction === "remove_unused",
      ),
      totalAnalyzed: entries.length,
      analysisDate: new Date(),
    };
  }

  /**
   * ログファイルからエントリを読み込み（ローテートされたファイルも含む）
   */
  private loadLogEntries(
    maxEntries: number,
    sinceDate?: Date,
    includeTestMode = false,
  ): DecisionLogEntry[] {
    const logFiles = this.getLogFiles();
    if (logFiles.length === 0) {
      throw new Error(`No log files found at ${this.logPath}`);
    }

    // 全ログファイルからエントリを読み込み、時系列順でソート
    const allEntries: DecisionLogEntry[] = [];

    for (const logFile of logFiles) {
      if (!existsSync(logFile.path)) {
        console.warn(`Log file not found, skipping: ${logFile.path}`);
        continue;
      }

      try {
        const content = readFileSync(logFile.path, "utf-8");
        const lines = content.trim().split("\n").filter(Boolean);

        for (const line of lines) {
          try {
            const entry = JSON.parse(line) as DecisionLogEntry;

            // テストセッションを除外（デフォルト）
            if (!includeTestMode && entry.session_id?.includes("test")) {
              continue;
            }

            if (sinceDate && new Date(entry.timestamp) < sinceDate) {
              continue;
            }

            // 決定ログエントリのみを対象とする
            if ("decision" in entry && "tool_name" in entry) {
              allEntries.push(entry);
            }
          } catch (error) {
            console.warn(
              `Failed to parse log line from ${logFile.path}: ${error}`,
            );
          }
        }
      } catch (error) {
        console.warn(`Failed to read log file ${logFile.path}: ${error}`);
      }
    }

    // 時系列順でソート（最新が最後）
    allEntries.sort(
      (a, b) =>
        new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
    );

    // maxEntriesの制限を適用（最新のエントリを優先）
    const limitedEntries = allEntries.slice(-maxEntries);

    return limitedEntries;
  }

  /**
   * ログファイルの一覧を取得（メインファイル + ローテートされたファイル）
   * 新しいファイルから順番に並べる
   */
  private getLogFiles(): Array<{ path: string; timestamp: Date }> {
    const baseDir = dirname(this.logPath);
    const baseFileName = basename(this.logPath);

    const logFiles: Array<{ path: string; timestamp: Date }> = [];

    // メインログファイルを追加
    if (existsSync(this.logPath)) {
      const stats = lstatSync(this.logPath);
      logFiles.push({
        path: this.logPath,
        timestamp: stats.mtime,
      });
    }

    // ローテートされたログファイルを検索
    if (existsSync(baseDir)) {
      try {
        const files = readdirSync(baseDir);
        const rotatedPattern = new RegExp(
          `^${baseFileName}\\.\\d{4}-\\d{2}-\\d{2}T\\d{2}-\\d{2}-\\d{2}$`,
        );

        for (const file of files) {
          if (rotatedPattern.test(file)) {
            const filePath = join(baseDir, file);
            try {
              const stats = lstatSync(filePath);
              logFiles.push({
                path: filePath,
                timestamp: stats.mtime,
              });
            } catch (error) {
              console.warn(
                `Failed to stat rotated log file ${filePath}: ${error}`,
              );
            }
          }
        }
      } catch (error) {
        console.warn(`Failed to read log directory ${baseDir}: ${error}`);
      }
    }

    // ファイルの更新時刻でソート（古いものから新しいものへ）
    logFiles.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());

    return logFiles;
  }

  /**
   * エントリからパターンを抽出してグループ化
   */
  private async extractPatterns(
    entries: DecisionLogEntry[],
  ): Promise<Map<string, DecisionLogEntry[]>> {
    const patterns = new Map<string, DecisionLogEntry[]>();

    for (const entry of entries) {
      const pattern = await this.extractPattern(entry);
      if (pattern) {
        if (!patterns.has(pattern)) {
          patterns.set(pattern, []);
        }
        patterns.get(pattern)?.push(entry);
      }
    }

    return patterns;
  }

  /**
   * 単一エントリからパターンを抽出
   */
  private async extractPattern(
    entry: DecisionLogEntry,
  ): Promise<string | null> {
    const { tool_name, command, input } = entry;

    if (tool_name === "Bash" && command) {
      // Bashコマンドの場合、実行可能部分を抽出
      const baseCommand = await this.extractBaseCommand(command, entry.cwd);
      return baseCommand ? `Bash(${baseCommand})` : null;
    }

    // その他のツールの場合
    if (
      tool_name &&
      input &&
      typeof input === "object" &&
      "file_path" in input
    ) {
      const filePath = input.file_path as string;
      const pathPattern = this.generalizePath(filePath);
      return `${tool_name}(${pathPattern})`;
    }

    // ファイルパスなしのツール
    if (tool_name && !tool_name.startsWith("mcp__")) {
      return tool_name;
    }

    return null;
  }

  /**
   * Bashコマンドから基本コマンドを抽出（既存パーサーを使用）
   */
  private async extractBaseCommand(
    command: string,
    entryCwd?: string,
  ): Promise<string | null> {
    // 既存のbash-parserを信頼して使用（内部でフォールバック処理済み）
    const { extractCommandsStructured, extractCommandsDetailed } = await import(
      "./bash-parser.ts"
    );
    const { individualCommands } = await extractCommandsStructured(command);
    const commands = individualCommands;

    // sh -c / bash -c / zsh -c / xargs sh -c の場合は安全性を判定して分岐
    const hasShellC =
      /(\bsh|\bbash|\bzsh)\s+-c\b/.test(command) ||
      /\bxargs\b[\s\S]*?\bsh\s+-c\b/.test(command);
    if (hasShellC) {
      const analysis = await this.analyzeShInvocationSafety(
        command,
        commands,
        entryCwd,
        extractCommandsDetailed,
      );
      if (analysis.safe && analysis.firstSafe) {
        return this.generalizeCommand(analysis.firstSafe);
      }
      // 安全でない/判定不能なら pass/review 寄りのパターンにする
      return "sh -c:*";
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
      if (subCommand === "status" && parts.length === 2) {
        return "git status";
      }
      return subCommand ? `git ${subCommand}:*` : "git:*";
    }

    // npx / pnpx / bunx / pnpm dlx / yarn dlx を同等扱いし、パッケージ名ベースに正規化
    const normalizeNpxPackage = (arr: string[], startIndex: number) => {
      for (let i = startIndex; i < arr.length; i++) {
        const tok = arr[i];
        if (!tok || tok.startsWith("-")) continue; // フラグは飛ばす
        // パッケージ@version の場合はパッケージ名のみ抽出
        const pkg = tok.split("@")[0];
        return pkg;
      }
      return "";
    };

    if (cmd === "npx") {
      const pkg = normalizeNpxPackage(parts, 1);
      return pkg ? `npx ${pkg}:*` : "npx:*";
    }

    if (cmd === "pnpx") {
      const pkg = normalizeNpxPackage(parts, 1);
      return pkg ? `npx ${pkg}:*` : "npx:*";
    }

    if (cmd === "bunx") {
      const pkg = normalizeNpxPackage(parts, 1);
      return pkg ? `npx ${pkg}:*` : "npx:*";
    }

    if (cmd === "pnpm" && parts[1] === "dlx") {
      const pkg = normalizeNpxPackage(parts, 2);
      return pkg ? `npx ${pkg}:*` : "npx:*";
    }

    if (cmd === "yarn" && parts[1] === "dlx") {
      const pkg = normalizeNpxPackage(parts, 2);
      return pkg ? `npx ${pkg}:*` : "npx:*";
    }

    // 基本コマンドの場合
    // Treat common utilities as basic, but preserve dangerous variants when possible
    if (cmd === "find") {
      // Highlight destructive variants for deny analysis
      if (parts.includes("-delete")) {
        return "find -delete:*";
      }
      const execIndex = parts.indexOf("-exec");
      if (execIndex !== -1) {
        const next = parts.slice(execIndex + 1).join(" ");
        if (/\brm\b/.test(next)) {
          return "find -exec rm:*";
        }
      }
      return "find:*";
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
    let normalized = filePath.replace(homeDir, "~");

    // 現在のディレクトリの相対パス化
    if (normalized.startsWith(process.cwd())) {
      normalized = normalized.replace(process.cwd(), ".");
    }

    // よくあるパターンの一般化
    if (normalized.includes("node_modules")) {
      return "node_modules/**";
    }

    if (normalized.includes(".git/")) {
      return ".git/**";
    }

    if (normalized.match(/\.(test|spec)\./)) {
      return "**/*.test.*";
    }

    // ディレクトリパターンの抽出
    const parts = normalized.split("/");
    if (parts.length > 2) {
      return `${parts.slice(0, 2).join("/")}/**`;
    }

    return normalized;
  }

  /**
   * パターンを分析して推奨アクションを決定
   */
  private analyzePatterns(
    patterns: Map<string, DecisionLogEntry[]>,
    minFrequency: number,
  ): PatternAnalysis[] {
    const results: PatternAnalysis[] = [];

    for (const [pattern, entries] of patterns) {
      if (entries.length < minFrequency) {
        continue; // 頻度が低いパターンはスキップ
      }

      const analysis = this.analyzePattern(pattern, entries);
      results.push(analysis);
    }

    // 頻度でソート（高頻度なものほど重要）
    return results.sort((a, b) => b.frequency - a.frequency);
  }

  /**
   * 単一パターンの分析（統計ベース）
   */
  private analyzePattern(
    pattern: string,
    entries: DecisionLogEntry[],
  ): PatternAnalysis {
    const decisions = entries.map((e) => e.decision);
    const timestamps = entries.map((e) => new Date(e.timestamp));

    const allowCount = decisions.filter((d) => d === "allow").length;
    const denyCount = decisions.filter((d) => d === "deny").length;
    const askCount = decisions.filter((d) => d === "ask").length;
    const passCount = decisions.filter((d) => d === "pass").length;

    let recommendedAction:
      | "add_to_allow"
      | "add_to_deny"
      | "remove_unused"
      | "needs_pattern"
      | "keep_as_is";
    let reasoning: string;

    const totalCount = entries.length;
    const allowRatio = allowCount / totalCount;
    const denyRatio = denyCount / totalCount;
    const askRatio = askCount / totalCount;

    // 統計ベースの推奨ロジック
    // 注意: 現在の統計はフックの自動判定結果であり、ユーザーの実際の判断ではない
    // - allow: フックが自動許可
    // - deny: フックが自動拒否
    // - ask: フックがユーザーに判断を委ねた（ユーザーがどう選択したかは未記録）
    // - pass: フックが判断せずClaude Codeに委ねた（結果は未記録）

    // 1. 頻繁に拒否されているパターン（フック自動判定ベース）
    if (denyCount >= 2 && denyRatio >= 0.7) {
      recommendedAction = "add_to_deny";
      reasoning = `Frequently auto-denied by hook (${denyCount}/${totalCount}, ${Math.round(denyRatio * 100)}% deny ratio)`;
    }
    // 2. 頻繁に自動許可されているパターン（askが少ない）
    else if (allowCount >= 3 && allowRatio >= 0.8 && askRatio <= 0.2) {
      recommendedAction = "add_to_allow";
      reasoning = `Frequently auto-allowed by hook (${allowCount}/${totalCount}, ${Math.round(allowRatio * 100)}% allow ratio)`;
    }
    // 3. askが多いパターン（ユーザー判断が必要だったが未記録）
    else if (askCount >= 5 && askRatio >= 0.7 && denyCount === 0) {
      recommendedAction = "keep_as_is";
      reasoning = `Frequently required user decision (${askCount} asks, 0 auto-denies) - actual user choices unknown`;
    }
    // 5. プロジェクト依存パターンは keep_as_is または needs_pattern
    else if (this.isProjectDependentPattern(pattern)) {
      recommendedAction = "keep_as_is";
      reasoning = `Project-dependent pattern - manage per-project`;
    }
    // 6. Pass-through パターンは needs_pattern
    else if (this.isPassThroughPattern(pattern, entries)) {
      recommendedAction = "needs_pattern";
      reasoning = `Complex pattern requiring session-by-session evaluation`;
    }
    // 7. 制御構造は安全なので allow
    else if (this.isControlStructurePattern(pattern)) {
      recommendedAction = "add_to_allow";
      reasoning = `Safe control structure keyword`;
    }
    // 8. 削除: 固定的な安全判定は行わない（目視判断に委ねる）
    // 9. データが少ない場合は様子見
    else if (totalCount < 3) {
      recommendedAction = "keep_as_is";
      reasoning = `Insufficient data (${totalCount} occurrences) - need more samples`;
    }
    // 10. その他はレビュー必要
    else {
      recommendedAction = "keep_as_is";
      reasoning = `Mixed results (${allowCount} allows, ${denyCount} denies, ${askCount} asks) - manual review needed`;
    }

    return {
      pattern,
      frequency: totalCount,
      lastSeen: new Date(Math.max(...timestamps.map((t) => t.getTime()))),
      firstSeen: new Date(Math.min(...timestamps.map((t) => t.getTime()))),
      decisions: {
        allow: allowCount,
        deny: denyCount,
        ask: askCount,
        pass: passCount,
      },
      recommendedAction,
      reasoning,
      examples: entries.slice(0, 3), // 最初の3つの例
    };
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
      /\.temp$/,
    ];

    return projectDependentPatterns.some((regex) => regex.test(pattern));
  }

  /**
   * 制御構造パターンの判定
   * Bash制御構造は安全なのでallow対象
   */
  private isControlStructurePattern(pattern: string): boolean {
    const controlPatterns = [
      "Bash(if)",
      "Bash(then)",
      "Bash(else)",
      "Bash(fi)",
      "Bash(while)",
      "Bash(for)",
      "Bash(do)",
      "Bash(done)",
    ];
    return controlPatterns.includes(pattern);
  }

  /**
   * Pass-through パターンの判定
   * セッション中のみ許可すべき一時的・複雑なパターン
   */
  private isPassThroughPattern(
    pattern: string,
    entries: DecisionLogEntry[],
  ): boolean {
    const passThroughPatterns = [
      // 複雑なパイプライン操作（:* 構文のみ）
      "Bash(xargs:*)",
      "Bash(timeout:*)",
      // メタ実行（詳細解析が必要なためセッション限定推奨）
      "Bash(sh -c:*)",
      "Bash(bash -c:*)",
      "Bash(zsh -c:*)",

      // 一時的な探索・分析コマンド（unknown_commandなど）
      "Bash(unknown_command)",
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
    _original: string,
    commands: string[],
    entryCwd: string | undefined,
    parseDetailed: (
      cmd: string,
    ) => Promise<import("./bash-parser.ts").SimpleCommand[]>,
  ): Promise<{ safe: boolean; firstSafe?: string }> {
    if (commands.length === 0) return { safe: false };

    // 危険なシグネチャ（粗め、誤許可を防ぐため保守的）
    const dangerous = [
      /\brm\b/,
      /\bmv\b/,
      /\bchmod\b/,
      /\bchown\b/,
      /\bsudo\b/,
      /\bdd\b/,
      /\bmkfs\b/,
      /\bfdisk\b/,
      /\btee\b/,
      /\bmount\b/,
      /\bumount\b/,
      /\bshutdown\b/,
      /\breboot\b/,
      /find\s+[^\n]*?-delete/,
      /find\s+[^\n]*?-exec\s+[^\n]*?\brm\b/,
      /sed\s+[^\n]*?-i\b/,
    ];

    // 書き込み系リダイレクトの抽出（/dev/null 以外は原則unsafe。ただしワークスペース配下の安全パスは許容）
    const redirRegex = /(\s|^)\d*>>?\s*(["']?)([^\s"'&|;]+)\2/g;

    const isSafeWorkspaceTarget = (target: string): boolean => {
      if (!target || target === "/dev/null") return true;
      // 明らかなFDや特殊ターゲットは不許可
      if (target.startsWith("/dev/") && target !== "/dev/null") return false;
      if (target.startsWith(">&") || target.startsWith("&>")) return false;

      // /tmp 配下は許容
      if (target === "/tmp" || target.startsWith("/tmp/")) return true;

      // 変数展開やコマンド置換が含まれる場合は保守的に不許可
      if (/[`$]/.test(target)) return false;

      const cwd =
        typeof entryCwd === "string" && entryCwd ? entryCwd : process.cwd();
      // 絶対パスはCWD配下のみ許容
      let abs: string;
      if (target.startsWith("/")) {
        abs = target;
        if (!abs.startsWith(`${cwd}/`) && abs !== cwd) return false;
      } else if (target.startsWith("~")) {
        // ホーム直下は対象外（安全側）
        return false;
      } else {
        // 相対パスはCWD基準
        abs = resolve(cwd, target);
      }

      // CWDに対する相対パスで禁止ディレクトリを判定
      const rel = relative(cwd, abs).replace(/\\/g, "/");
      const banned = [
        ".git/",
        "node_modules/",
        "dist/",
        "build/",
        "target/",
        "coverage/",
        ".next/",
      ];
      if (rel === "" || rel === ".") return false; // CWD直書きは許容するか？ 明示的に可とする
      for (const b of banned) {
        if (rel.startsWith(b)) return false;
      }

      // 親ディレクトリがシンボリックリンクでワークスペース外を指す場合を拒否
      try {
        const parent = abs.replace(/\/[^/]*$/, "") || cwd;
        if (existsSync(parent)) {
          const realParent = realpathSync(parent);
          const realCwd = realpathSync(cwd);
          if (!realParent.startsWith(`${realCwd}/`) && realParent !== realCwd) {
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
    const safeUtils =
      /^(ls|cat|head|tail|grep|echo|printf|pwd|which|whoami|date|cut|uniq|tr|column|paste|realpath|readlink|stat|du|df|wc|sort|awk)$/;

    for (const cmdText of commands) {
      const text = (cmdText || "").trim();
      if (!text) continue;

      // まず簡易テキストチェック（早期不許可）
      if (dangerous.some((r) => r.test(text))) return { safe: false };

      // 詳細解析（AST）
      const details = await parseDetailed(text);
      const first = details[0];
      const name = (first?.name || "").trim();
      if (!name || !first) return { safe: false };

      // 安全ユーティリティ以外は不許可
      if (!safeUtils.test(name)) return { safe: false };

      // コマンド固有の危険フラグ
      if (name === "find") {
        const argline = (first.args || []).join(" ");
        if (/\s-delete(\s|$)/.test(argline)) return { safe: false };
        if (/\s-exec\s+[^;]*\brm\b/.test(argline)) return { safe: false };
      }
      if (name === "sed") {
        const argline = (first.args || []).join(" ");
        if (/(^|\s)-i(\b|\s|=)/.test(argline) || /--in-place\b/.test(argline))
          return { safe: false };
      }
      if (name === "tee") {
        const files = (first.args || [])
          .filter((a) => !a.startsWith("-"))
          .map((a) => a.replace(/^['"]|['"]$/g, ""));
        if (files.length === 0) {
          // stdout のみなら安全
          // ただし後続のリダイレクトで書込みがないかは別途チェック済み
        } else {
          for (const f of files) {
            if (!isSafeWorkspaceTarget(f)) return { safe: false };
          }
        }
      }

      // リダイレクト先の検査（ASTで取得したトークン文字列に対して適用）
      const redirs = first.redirections || [];
      for (const r of redirs) {
        let m: RegExpExecArray | null;
        while ((m = redirRegex.exec(r)) !== null) {
          const target = m[3] || "";
          if (!isSafeWorkspaceTarget(target)) return { safe: false };
        }
      }
    }

    const firstCommand = commands[0];
    return firstCommand
      ? { safe: true, firstSafe: firstCommand }
      : { safe: true };
  }
}
