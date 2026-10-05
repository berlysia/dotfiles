#!/usr/bin/env -S bun run --silent
/**
 * ファイル権限推論ロジック
 *
 * Bashコマンド（特にsed -i）の対象ファイルが、Edit/MultiEditツールの
 * 許可パターンにマッチするかを判定する。
 */

import {
  matchGitignorePattern,
  ruleContext,
  type SourcedRule,
} from "./pattern-matcher.ts";
import type { MatchContext } from "./path-utils.ts";

export interface FilePermissionCheckResult {
  /** 全ファイルが許可されているか */
  allFilesPermitted: boolean;

  /** ファイルごとの詳細結果 */
  fileResults: FileCheckDetail[];

  /** 最初に許可されなかったファイル（allFilesPermitted=falseの場合） */
  firstDeniedFile?: string | undefined;
}

interface FileCheckDetail {
  /** チェック対象のファイルパス */
  filePath: string;

  /** 許可されているか */
  permitted: boolean;

  /** マッチしたパターン（許可された場合） */
  matchedPattern?: string;

  /** 許可されなかった理由 */
  deniedReason?: string;
}

/**
 * ファイルパスが許可パターンにマッチするかチェック
 *
 * @param filePath - チェック対象のファイルパス
 * @param allowPatterns - 許可パターンのリスト。各規則は、/path の基準（settingsRoot）と組になっている
 * @returns チェック結果
 */
function checkSingleFile(
  filePath: string,
  allowPatterns: SourcedRule[],
  ctx: MatchContext,
): FileCheckDetail {
  // Edit() または MultiEdit() パターンを抽出
  const editPatterns = allowPatterns.filter(
    ({ rule }) => rule.startsWith("Edit(") || rule.startsWith("MultiEdit("),
  );

  // パターンがない場合は拒否
  if (editPatterns.length === 0) {
    return {
      filePath,
      permitted: false,
      deniedReason: "No Edit/MultiEdit patterns in allow list",
    };
  }

  // 各パターンに対してマッチングを試みる
  for (const sourced of editPatterns) {
    // "Edit(" または "MultiEdit(" を除去して内部のパターンを取得
    const match =
      sourced.rule.match(/^Edit\((.+)\)$/) ||
      sourced.rule.match(/^MultiEdit\((.+)\)$/);
    if (!match || !match[1]) continue;

    const pathPattern = match[1];

    try {
      // The input is the Edit allow list, so a match always widens permission.
      if (
        matchGitignorePattern(
          filePath,
          pathPattern,
          ruleContext(ctx, sourced),
          "grant",
        )
      ) {
        return {
          filePath,
          permitted: true,
          matchedPattern: sourced.rule,
        };
      }
    } catch {}
  }

  // どのパターンにもマッチしなかった
  return {
    filePath,
    permitted: false,
    deniedReason: "File does not match any Edit/MultiEdit patterns",
  };
}

/**
 * 複数ファイルのパーミッションチェック
 *
 * @param filePaths - チェック対象のファイルパスリスト
 * @param allowPatterns - 許可パターンのリスト
 * @returns チェック結果
 *
 * @example
 * ```typescript
 * const result = checkFilePermissions(
 *   ["src/utils.ts", "src/index.ts"],
 *   ["Edit(./**\/*.ts)", "Edit(src/**)", "Bash(git *)"]
 * );
 * console.log(result.allFilesPermitted); // true
 * ```
 */
export function checkFilePermissions(
  filePaths: string[],
  allowPatterns: SourcedRule[],
  ctx: MatchContext,
): FilePermissionCheckResult {
  const fileResults: FileCheckDetail[] = [];
  let allFilesPermitted = true;
  let firstDeniedFile: string | undefined;

  for (const filePath of filePaths) {
    const result = checkSingleFile(filePath, allowPatterns, ctx);
    fileResults.push(result);

    if (!result.permitted) {
      allFilesPermitted = false;
      if (!firstDeniedFile) {
        firstDeniedFile = filePath;
      }
    }
  }

  return {
    allFilesPermitted,
    fileResults,
    firstDeniedFile,
  };
}

/**
 * sedコマンドの対象ファイルが許可されているかチェック（簡易版）
 *
 * @param filePaths - sedコマンドの対象ファイルパス
 * @param allowPatterns - 許可パターンのリスト
 * @returns 全ファイルが許可されている場合true
 */
export function canApproveSedTargets(
  filePaths: string[],
  allowPatterns: SourcedRule[],
  ctx: MatchContext,
): boolean {
  const result = checkFilePermissions(filePaths, allowPatterns, ctx);
  return result.allFilesPermitted;
}
