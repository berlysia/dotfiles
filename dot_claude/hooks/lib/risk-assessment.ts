/**
 * Risk Assessment System
 * Enum-based risk evaluation for permission patterns
 */

import { resolve } from 'node:path';
import { homedir } from 'node:os';

function resolvePatternPath(pattern: string, cwd: string): string {
  const path = pattern.match(/[^(]+\(([^)]+)\)/)?.[1] || '';

  const pathWithoutGlob = path.replace(/\/?\*+.*$/, '');

  if (pathWithoutGlob.startsWith('~/')) {
    return resolve(homedir(), pathWithoutGlob.slice(2));
  }

  if (pathWithoutGlob.startsWith('/')) {
    return pathWithoutGlob;
  }

  return resolve(cwd, pathWithoutGlob);
}

export const RiskLevel = {
  MINIMAL: 'minimal',
  LOW: 'low',
  MEDIUM: 'medium',
  HIGH: 'high',
  CRITICAL: 'critical'
} as const;

export type RiskLevel = typeof RiskLevel[keyof typeof RiskLevel];

export interface RiskAssessment {
  level: RiskLevel;
  category: string;
  reason: string;
  mitigationPossible: boolean;
}

export function evaluateTargetRisk(pattern: string): RiskAssessment {
  const path = pattern.match(/[^(]+\(([^)]+)\)/)?.[1] || '';

  if (path.includes('/.ssh/') || path.endsWith('/id_rsa') || path.endsWith('/id_dsa') || path.endsWith('/id_ecdsa') || path.endsWith('/id_ed25519')) {
    return {
      level: RiskLevel.CRITICAL,
      category: "target",
      reason: "SSH秘密鍵ファイルへのアクセス",
      mitigationPossible: false
    };
  }

  if (path.includes('/.aws/credentials') || path.includes('/.aws/config')) {
    return {
      level: RiskLevel.CRITICAL,
      category: "target",
      reason: "AWS認証情報ファイルへのアクセス",
      mitigationPossible: false
    };
  }

  if (path.includes('/.gnupg/')) {
    return {
      level: RiskLevel.CRITICAL,
      category: "target",
      reason: "GPG秘密鍵ディレクトリへのアクセス",
      mitigationPossible: false
    };
  }

  if (path === '/etc/shadow' || path === '/etc/passwd') {
    return {
      level: RiskLevel.CRITICAL,
      category: "target",
      reason: "システムパスワードファイルへのアクセス",
      mitigationPossible: false
    };
  }

  if (path.endsWith('.key') || path.endsWith('.pem') || path.endsWith('.pfx') || path.endsWith('.p12')) {
    return {
      level: RiskLevel.CRITICAL,
      category: "target",
      reason: "秘密鍵ファイル拡張子",
      mitigationPossible: false
    };
  }

  if (path.endsWith('.env') || path.includes('/.env.')) {
    return {
      level: RiskLevel.HIGH,
      category: "target",
      reason: "環境変数ファイルへのアクセス",
      mitigationPossible: true
    };
  }

  return {
    level: RiskLevel.MINIMAL,
    category: "target",
    reason: "通常ファイル",
    mitigationPossible: false
  };
}

export function evaluateScopeRisk(pattern: string, cwd = process.cwd()): RiskAssessment {
  const resolvedPath = resolvePatternPath(pattern, cwd);
  const homeDir = homedir();

  if (resolvedPath.startsWith('/etc/') || resolvedPath.startsWith('/usr/') || resolvedPath === '/etc' || resolvedPath === '/usr') {
    return {
      level: RiskLevel.CRITICAL,
      category: "scope",
      reason: "システムディレクトリへのアクセス",
      mitigationPossible: false
    };
  }

  if (resolvedPath === homeDir || pattern.includes('~/**')) {
    return {
      level: RiskLevel.CRITICAL,
      category: "scope",
      reason: "ホームディレクトリ全体への無制限アクセス",
      mitigationPossible: false
    };
  }

  const workspacePath = homeDir + '/workspace';
  if ((resolvedPath === workspacePath || resolvedPath.startsWith(workspacePath + '/')) && pattern.includes('**')) {
    if (resolvedPath === workspacePath) {
      return {
        level: RiskLevel.HIGH,
        category: "scope",
        reason: "全ワークスペースへのアクセス",
        mitigationPossible: true
      };
    } else {
      return {
        level: RiskLevel.MEDIUM,
        category: "scope",
        reason: "特定プロジェクト全体へのアクセス",
        mitigationPossible: true
      };
    }
  }

  if (resolvedPath.startsWith(cwd + '/') || resolvedPath === cwd) {
    return {
      level: RiskLevel.LOW,
      category: "scope",
      reason: "プロジェクト内の相対パス",
      mitigationPossible: false
    };
  }

  if (!pattern.includes('*')) {
    return {
      level: RiskLevel.MINIMAL,
      category: "scope",
      reason: "特定ファイルのみ",
      mitigationPossible: false
    };
  }

  return {
    level: RiskLevel.LOW,
    category: "scope",
    reason: "限定的なスコープ",
    mitigationPossible: false
  };
}

export function evaluateOperationRisk(pattern: string): RiskAssessment {
  const toolName = pattern.match(/^([^(]+)/)?.[1] || '';

  // 読み取り専用操作
  if (toolName === 'Read' || toolName === 'Glob' || toolName === 'LS' || toolName === 'Grep') {
    return {
      level: RiskLevel.MINIMAL,
      category: "operation",
      reason: "読み取り専用操作",
      mitigationPossible: false
    };
  }

  // 編集操作
  if (toolName === 'Edit' || toolName === 'MultiEdit') {
    return {
      level: RiskLevel.MEDIUM,
      category: "operation",
      reason: "ファイル編集操作",
      mitigationPossible: true
    };
  }

  // 書き込み操作
  if (toolName === 'Write') {
    return {
      level: RiskLevel.HIGH,
      category: "operation",
      reason: "ファイル作成/上書き操作",
      mitigationPossible: true
    };
  }

  // Bashコマンド
  if (toolName === 'Bash') {
    const command = pattern.match(/Bash\(([^)]+)\)/)?.[1] || '';

    // 破壊的コマンド
    if (command.match(/^(rm -rf|sudo|dd|mkfs)/)) {
      return {
        level: RiskLevel.CRITICAL,
        category: "operation",
        reason: "破壊的コマンド実行",
        mitigationPossible: false
      };
    }

    // 安全な読み取りコマンド
    if (command.match(/^(ls|pwd|echo|cat|head|tail|grep|rg|find|fd):/)) {
      return {
        level: RiskLevel.LOW,
        category: "operation",
        reason: "安全な読み取りコマンド",
        mitigationPossible: false
      };
    }

    // Git読み取り専用コマンド
    if (command.match(/^git (status|log|diff|show|branch):/)) {
      return {
        level: RiskLevel.LOW,
        category: "operation",
        reason: "Git読み取り専用コマンド",
        mitigationPossible: false
      };
    }

    // npm/pnpm情報取得コマンド
    if (command.match(/^(npm view|pnpm view):/)) {
      return {
        level: RiskLevel.LOW,
        category: "operation",
        reason: "パッケージ情報取得コマンド",
        mitigationPossible: false
      };
    }

    // テスト実行コマンド
    if (command.match(/^(npm test|pnpm test|bun test|jest|vitest):/)) {
      return {
        level: RiskLevel.LOW,
        category: "operation",
        reason: "テスト実行コマンド",
        mitigationPossible: false
      };
    }

    // ビルド・型チェックコマンド（副作用あるが安全性が高い）
    if (command.match(/^(pnpm (build|typecheck|run)|npm run|bun run):/)) {
      return {
        level: RiskLevel.MEDIUM,
        category: "operation",
        reason: "ビルド・スクリプト実行コマンド",
        mitigationPossible: true
      };
    }

    // パッケージ管理コマンド（変更を伴うが制御可能）
    if (command.match(/^(pnpm (add|remove|install|update)|npm (install|uninstall)):/)) {
      return {
        level: RiskLevel.MEDIUM,
        category: "operation",
        reason: "パッケージ管理コマンド",
        mitigationPossible: true
      };
    }

    // その他のBashコマンド
    return {
      level: RiskLevel.HIGH,
      category: "operation",
      reason: "一般的なシェルコマンド実行",
      mitigationPossible: true
    };
  }

  // 未知のツール
  return {
    level: RiskLevel.MEDIUM,
    category: "operation",
    reason: "未分類の操作",
    mitigationPossible: false
  };
}

export function combineRiskLevels(scope: RiskLevel, operation: RiskLevel, target: RiskLevel): RiskLevel {
  const levels = [scope, operation, target];

  // いずれかがCRITICALなら全体もCRITICAL
  if (levels.includes(RiskLevel.CRITICAL)) {
    return RiskLevel.CRITICAL;
  }

  // HIGHが2つ以上ならCRITICAL
  if (levels.filter(l => l === RiskLevel.HIGH).length >= 2) {
    return RiskLevel.CRITICAL;
  }

  // HIGHが1つあればHIGH
  if (levels.includes(RiskLevel.HIGH)) {
    return RiskLevel.HIGH;
  }

  // MEDIUMが2つ以上ならHIGH
  if (levels.filter(l => l === RiskLevel.MEDIUM).length >= 2) {
    return RiskLevel.HIGH;
  }

  // MEDIUMが1つあればMEDIUM
  if (levels.includes(RiskLevel.MEDIUM)) {
    return RiskLevel.MEDIUM;
  }

  // それ以外はLOW
  return RiskLevel.LOW;
}

export function shouldAutoApprove(riskLevel: RiskLevel): boolean {
  switch (riskLevel) {
    case RiskLevel.MINIMAL:
    case RiskLevel.LOW:
      return true;
    case RiskLevel.MEDIUM:
    case RiskLevel.HIGH:
    case RiskLevel.CRITICAL:
      return false;
  }
}