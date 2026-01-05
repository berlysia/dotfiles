import { $ } from "dax";

/**
 * Git Context Service - Repository Information Management
 *
 * Provides unified repository context extraction with comprehensive
 * fallback mechanisms and type-safe interfaces.
 */

// 型定義
export interface GitContextInfo {
  name: string;
  isRepository: boolean;
  hasRemote: boolean;
  containerType: "リポジトリ" | "ディレクトリ";
}

export interface GitRemoteInfo {
  url: string;
  name: string | null;
}

/**
 * Extract repository name from remote URL
 * Supports various URL formats (HTTPS, SSH, GitHub, GitLab, etc.)
 */
function extractRepoNameFromRemoteUrl(remoteUrl: string): string | null {
  const patterns = [
    /\/([^/]+)\.git$/, // Standard: .../repo.git
    /\/([^/]+)$/, // No .git suffix
    /:([^/]+)\.git$/, // SSH: git@host:repo.git
    /:([^/]+)$/, // SSH without .git
    /\/([^/]+)\.git\//, // With trailing path
  ];

  for (const pattern of patterns) {
    const match = remoteUrl.match(pattern);
    if (match?.[1]) {
      return match[1];
    }
  }

  return null;
}

/**
 * Get current directory name as fallback
 */
async function getCurrentDirectoryName(): Promise<string> {
  try {
    const pwdResult = await $`pwd`.text();
    if (pwdResult) {
      const pathParts = pwdResult.trim().split("/");
      return pathParts[pathParts.length - 1] || "unknown";
    }
    return "unknown";
  } catch {
    return "unknown";
  }
}

/**
 * Get remote repository information
 */
async function getRemoteInfo(): Promise<GitRemoteInfo | null> {
  try {
    const remoteUrl = await $`git remote get-url origin`.text();
    if (!remoteUrl || !remoteUrl.trim()) {
      return null;
    }

    const cleanUrl = remoteUrl.trim();
    const repoName = extractRepoNameFromRemoteUrl(cleanUrl);

    return {
      url: cleanUrl,
      name: repoName,
    };
  } catch {
    return null;
  }
}

/**
 * Get repository name from git root directory
 */
async function getRepoNameFromGitRoot(): Promise<string | null> {
  try {
    const gitRootPath = await $`git rev-parse --show-toplevel`.text();
    if (gitRootPath?.trim()) {
      const pathParts = gitRootPath.trim().split("/");
      return pathParts[pathParts.length - 1] || null;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Check if current directory is inside a git repository
 */
async function isInsideGitRepository(): Promise<boolean> {
  try {
    const result = await $`git rev-parse --is-inside-work-tree`
      .quiet()
      .noThrow();
    return result.code === 0;
  } catch {
    return false;
  }
}

/**
 * Get comprehensive git context information
 *
 * Provides repository name, type classification, and remote status
 * with multiple fallback mechanisms for robustness.
 */
export async function getGitContext(): Promise<GitContextInfo> {
  let repoName = "";
  let isRepository = false;
  let hasRemote = false;

  try {
    // Get directory name as ultimate fallback
    const dirName = await getCurrentDirectoryName();

    // Check if we're in a git repository
    isRepository = await isInsideGitRepository();

    if (isRepository) {
      // Try to get repository name from remote origin
      const remoteInfo = await getRemoteInfo();
      if (remoteInfo?.name) {
        repoName = remoteInfo.name;
        hasRemote = true;
      } else {
        // Fallback to git root directory name
        const gitRootName = await getRepoNameFromGitRoot();
        if (gitRootName) {
          repoName = gitRootName;
        }
      }
    }

    // Final fallback to directory name
    if (!repoName || repoName.trim() === "") {
      repoName = dirName;
    }

    const finalName = repoName.trim() || "unknown";

    // Determine container type:
    // Repository = git repo with remote
    // Directory = git repo without remote OR non-git directory
    const containerType: "リポジトリ" | "ディレクトリ" =
      isRepository && hasRemote ? "リポジトリ" : "ディレクトリ";

    return {
      name: finalName,
      isRepository,
      hasRemote,
      containerType,
    };
  } catch (_error) {
    // Ultimate fallback
    return {
      name: "unknown",
      isRepository: false,
      hasRemote: false,
      containerType: "ディレクトリ",
    };
  }
}

/**
 * Get repository name only (simplified interface)
 * For backward compatibility with existing code
 */
export async function getRepoName(): Promise<string> {
  const context = await getGitContext();
  return context.name;
}

/**
 * Create localized message with repository context
 */
export function createContextMessage(
  context: GitContextInfo,
  action: "confirm" | "complete" | "error",
): string {
  const actionMessages = {
    confirm: "操作の確認が必要です",
    complete: "処理が完了しました",
    error: "エラーが発生しました",
  };

  return `${context.name} ${context.containerType}で${actionMessages[action]}`;
}
