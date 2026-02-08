#!/usr/bin/env -S bun run --silent
/**
 * sed -i コマンド引数パーサー
 *
 * sed -i の構文パターンをパースして、対象ファイルパスを抽出する。
 * グロブパターンの検出も行い、自動承認の可否を判定する。
 */

export interface SedInPlaceParseResult {
  /** sed -i コマンドかどうか */
  isSedInPlace: boolean;

  /** 対象ファイルパスのリスト */
  targetFiles: string[];

  /** グロブパターンを含むかどうか（含む場合は自動承認対象外） */
  containsGlob: boolean;

  /** パース失敗の理由（成功時はnull） */
  parseError: string | null;

  /** バックアップ拡張子（-i.bak の .bak 部分、ない場合はnull） */
  backupExtension: string | null;
}

/**
 * クォートで囲まれた文字列を考慮してコマンドラインを分割
 * bash-parser.tsのsplitCommandLine()と同等のロジック
 */
function splitCommandLine(command: string): string[] {
  const parts: string[] = [];
  let current = "";
  let inQuotes = false;
  let quoteChar = "";

  for (let i = 0; i < command.length; i++) {
    const char = command[i];
    const prevChar = i > 0 ? command[i - 1] : "";
    const _nextChar = i < command.length - 1 ? command[i + 1] : "";

    // エスケープされた文字はそのまま追加
    if (prevChar === "\\" && (char === "'" || char === '"' || char === " ")) {
      current += char;
      continue;
    }

    if (!inQuotes && (char === '"' || char === "'")) {
      inQuotes = true;
      quoteChar = char;
      current += char;
    } else if (inQuotes && char === quoteChar && prevChar !== "\\") {
      inQuotes = false;
      quoteChar = "";
      current += char;
    } else if (!inQuotes && char && /\s/.test(char)) {
      if (current) {
        parts.push(current);
        current = "";
      }
    } else {
      current += char;
    }
  }

  if (current) {
    parts.push(current);
  }

  return parts;
}

/**
 * グロブパターンを含むかチェック
 *
 * 注意: この関数は removeQuotes() 適用後のファイルパスをチェックする。
 * シェルの動作として、クォートされたパターンはグロブ展開されないが、
 * このパーサーではクォートを除去した後にチェックするため、
 * 元々クォートされていたかどうかの情報は失われている。
 *
 * セキュリティ上の理由から、グロブパターンが含まれている場合は
 * 保守的に「グロブあり」として扱う。
 */
function containsGlobPattern(arg: string): boolean {
  // グロブパターン: *, ?, [...], {...}
  return /[*?[\]{}]/.test(arg);
}

/**
 * クォートを除去
 */
function removeQuotes(arg: string): string {
  if (
    (arg.startsWith('"') && arg.endsWith('"')) ||
    (arg.startsWith("'") && arg.endsWith("'"))
  ) {
    return arg.slice(1, -1);
  }
  return arg;
}

/**
 * sed -i コマンドをパースして対象ファイルを抽出
 *
 * @param command - 解析するコマンド文字列
 * @returns パース結果
 *
 * @example
 * ```typescript
 * parseSedInPlace("sed -i 's/foo/bar/' file.txt")
 * // => { isSedInPlace: true, targetFiles: ["file.txt"], containsGlob: false, ... }
 *
 * parseSedInPlace("sed -i.bak 's/foo/bar/' file1.txt file2.txt")
 * // => { isSedInPlace: true, targetFiles: ["file1.txt", "file2.txt"], backupExtension: ".bak", ... }
 *
 * parseSedInPlace("sed -i 's/foo/bar/' *.txt")
 * // => { isSedInPlace: true, targetFiles: ["*.txt"], containsGlob: true, ... }
 * ```
 */
export function parseSedInPlace(command: string): SedInPlaceParseResult {
  const defaultResult: SedInPlaceParseResult = {
    isSedInPlace: false,
    targetFiles: [],
    containsGlob: false,
    parseError: null,
    backupExtension: null,
  };

  const trimmed = command.trim();
  if (!trimmed) {
    return { ...defaultResult, parseError: "Empty command" };
  }

  const parts = splitCommandLine(trimmed);

  // 最初の要素がsedでなければ対象外
  if (parts.length === 0 || parts[0] !== "sed") {
    return defaultResult;
  }

  let i = 1;
  let hasInPlaceFlag = false;
  let backupExtension: string | null = null;
  const targetFiles: string[] = [];
  let usedEFlag = false; // -e フラグが使用されたかどうか

  // オプションフラグの解析
  while (i < parts.length) {
    const part = parts[i];
    if (!part) break;

    // -i フラグのチェック
    if (part === "-i") {
      hasInPlaceFlag = true;
      i++;
      // 次の要素がバックアップ拡張子の可能性（-i '' や -i .bak）
      const next = parts[i];
      if (next) {
        // 空文字列（macOS形式: -i ''）の場合
        if (next === "''" || next === '""' || next === "''") {
          backupExtension = "";
          i++;
        }
        // sedスクリプトっぽい場合はバックアップ拡張子ではない
        else if (
          next.startsWith("'") ||
          next.startsWith('"') ||
          next.startsWith("s/") ||
          next.startsWith("/")
        ) {
          // これはスクリプトなのでスキップしない
          // 何もせずに continue
        }
        // 拡張子が指定されている場合（-i .bak）
        else if (!next.startsWith("-")) {
          backupExtension = next;
          i++;
        }
      }
      continue;
    }

    // -i.bak や -i.backup 形式
    if (part.startsWith("-i")) {
      hasInPlaceFlag = true;
      const extension = part.slice(2); // "-i" を除去
      if (extension) {
        backupExtension = extension;
      }
      i++;
      continue;
    }

    // -e フラグ（複数の編集コマンド）
    if (part === "-e") {
      usedEFlag = true; // -e が使われたことを記録
      i++; // -e フラグをスキップ
      // 次の要素が編集スクリプトなのでスキップ
      if (i < parts.length) {
        i++;
      }
      continue;
    }

    // その他のオプション（-n, -r, -E など）
    if (part.startsWith("-") && part !== "-") {
      i++;
      continue;
    }

    // オプションが終わったら残りはスクリプトとファイル
    break;
  }

  // -i フラグがなければ対象外
  if (!hasInPlaceFlag) {
    return defaultResult;
  }

  // 残りの要素を解析（スクリプトとファイル）
  // -e フラグが使用されている場合、スクリプトは既に処理済み
  let foundScript = usedEFlag;

  while (i < parts.length) {
    const part = parts[i];
    if (!part) {
      i++;
      continue;
    }

    // -e フラグを使用していない場合、最初の非オプション要素はスクリプト
    if (!foundScript) {
      // スクリプトの可能性が高い要素:
      // - クォートで始まる ('...' または "...")
      // - s/ で始まる (置換コマンド)
      // - / で始まる (パターンマッチング)
      // - その他の sed コマンド文字
      if (
        part.startsWith("'") ||
        part.startsWith('"') ||
        part.startsWith("s/") ||
        part.startsWith("/") ||
        /^[acdginpqxy]/.test(part) // sed コマンド文字
      ) {
        foundScript = true;
        i++;
        continue;
      }
      // 上記以外でも、最初の要素はスクリプトと見なす
      foundScript = true;
      i++;
      continue;
    }

    // スクリプトの後はすべてファイル名
    const cleanedPath = removeQuotes(part);
    targetFiles.push(cleanedPath);
    i++;
  }

  // ファイルが見つからない場合はエラー
  if (targetFiles.length === 0) {
    return {
      isSedInPlace: true,
      targetFiles: [],
      containsGlob: false,
      parseError: "No target files found in sed -i command",
      backupExtension,
    };
  }

  // グロブパターンの検出
  const containsGlob = targetFiles.some(containsGlobPattern);

  return {
    isSedInPlace: true,
    targetFiles,
    containsGlob,
    parseError: null,
    backupExtension,
  };
}
