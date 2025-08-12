#!/usr/bin/env bun

import path from 'node:path';
import { execSync } from 'node:child_process';
import { loadDailyUsageData, loadWeeklyUsageData, loadSessionBlockData, loadSessionData } from "ccusage/data-loader";

type DailyData = Awaited<ReturnType<typeof loadDailyUsageData>>;
type WeeklyData = Awaited<ReturnType<typeof loadWeeklyUsageData>>;
type BlockData = Awaited<ReturnType<typeof loadSessionBlockData>>;
type SessionData = Awaited<ReturnType<typeof loadSessionData>>;

// Configuration
const MAX_SESSION_TOKENS = 200000;
const WARNING_THRESHOLD = MAX_SESSION_TOKENS * 0.7;
const CRITICAL_THRESHOLD = MAX_SESSION_TOKENS * 0.9;

interface StatusLineData {
  session_id?: string;
  workspace?: { current_dir?: string };
  cwd?: string;
}

async function readStdinAsJson(): Promise<StatusLineData> {
  let input = '';
  for await (const chunk of process.stdin) {
    input += chunk;
  }
  return JSON.parse(input);
}

function getCurrentBranch(dirPath: string): string | null {
  try {
    const branch = execSync('git rev-parse --abbrev-ref HEAD', {
      cwd: dirPath,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'ignore']
    }).trim();
    return branch;
  } catch {
    return null;
  }
}

function formatTokens(tokens: number): string {
  if (tokens >= 1000000) return `${(tokens / 1000000).toFixed(1)}M`;
  if (tokens >= 1000) return `${(tokens / 1000).toFixed(1)}K`;
  return tokens.toString();
}

function formatCost(cost: number): string {
  return cost >= 0.01 ? `$${cost.toFixed(2)}` : `$${(cost * 100).toFixed(1)}c`;
}

async function getAllUsageData(sessionId: string) {
  const todayStr = new Date().toISOString().split('T')[0]?.replace(/-/g, '') ?? ''; // Convert to YYYYMMDD format

  const [sessionData, dailyData, weeklyData, blockData] = await Promise.all([
    loadSessionData({ offline: true }),
    loadDailyUsageData({ offline: true, since: todayStr, until: todayStr }),
    loadWeeklyUsageData({ offline: true, startOfWeek: "monday" }),
    loadSessionBlockData({ offline: true })
  ]);

  return { sessionData, dailyData, weeklyData, blockData };
}

function calcSumOfTokens(tokens: { inputTokens: number; outputTokens: number; }) {
  return tokens.inputTokens || 0 + (tokens.outputTokens || 0);
}

function getSessionTokensFromData(sessionData: SessionData, sessionId: string): number {
  try {
    if (sessionData && Array.isArray(sessionData)) {
      let session = null;

      // Try with provided session ID first
      if (sessionId) {
        session = sessionData.find(s => s.sessionId === sessionId);
      }

      // If no session ID provided or not found, use the most recently active session
      if (!session && sessionData.length > 0) {
        // Sessions are typically ordered by activity, so take the first one
        session = sessionData[0];
      }

      if (session) {
        const tokens = calcSumOfTokens(session);
        return tokens;
      }
    }
  } catch (error) {
    console.error('Failed to process session data:', error);
  }
  return 0;
}

function getDailyUsageFromData(dailyData: DailyData): string {
  try {
    if (dailyData && Array.isArray(dailyData) && dailyData.length > 0) {
      const today = dailyData[dailyData.length - 1];
      if (today) {
        return `Daily ${formatCost(today.totalCost || 0)}|${formatTokens(calcSumOfTokens(today))}`;
      }
    }
  } catch (error) {
    console.error('Failed to process daily usage:', error);
  }
  return "";
}

function getWeeklyUsageFromData(weeklyData: WeeklyData): string {
  try {
    if (weeklyData && Array.isArray(weeklyData) && weeklyData.length > 0) {
      const thisWeek = weeklyData[weeklyData.length - 1];
      if (thisWeek) {
        return `Weekly ${formatCost(thisWeek.totalCost || 0)}|${formatTokens(calcSumOfTokens(thisWeek))}`;
      }
    }
  } catch (error) {
    console.error('Failed to process weekly usage:', error);
  }
  return "";
}

const HOUR = 60 * 60 * 1000; // 1 hour in milliseconds
const MINUTE = 60 * 1000; // 1 minute in milliseconds
function formatDuration(milliseconds: number) {
  const hours = Math.floor(milliseconds / HOUR);
  const minutes = Math.floor((milliseconds % HOUR) / MINUTE);
  const seconds = Math.floor((milliseconds % MINUTE) / 1000);
  return `${hours}:${minutes.toFixed().padStart(2, "0")}:${seconds.toFixed().padStart(2, "0")}`;
}

function getBlockUsageFromData(blockData: BlockData): string {
  try {
    if (blockData && Array.isArray(blockData) && blockData.length > 0) {
      const activeBlock = blockData.find(b => b.isActive);
      if (activeBlock) {
        const tokens = calcSumOfTokens(activeBlock.tokenCounts);
        const remaining = Math.round((activeBlock.endTime.getTime() - Date.now()));
        return `Block ${formatCost(activeBlock.costUSD || 0)}|${formatTokens(tokens)}|${formatDuration(remaining)}`;
      }
    }
  } catch (error) {
    console.error('Failed to process block usage:', error);
  }
  return "";
}

function generateUsageStatusline(dailyData: DailyData, weeklyData: WeeklyData, blockData: BlockData): string | null {
  const daily = getDailyUsageFromData(dailyData);
  const weekly = getWeeklyUsageFromData(weeklyData);
  const block = getBlockUsageFromData(blockData);

  const parts: string[] = [];

  if (daily) {
    parts.push(daily);
  }

  if (weekly) {
    parts.push(weekly);
  }

  if (block) {
    parts.push(block);
  }

  return parts.length > 0 ? parts.join(' | ') : null;
}

function getSessionUsageColor(tokens: number): string {
  if (tokens >= CRITICAL_THRESHOLD) return '\x1b[31m'; // Red
  if (tokens >= WARNING_THRESHOLD) return '\x1b[33m'; // Yellow
  return '\x1b[32m'; // Green
}

async function generateStatusline(data: StatusLineData): Promise<string> {
  const currentDirPath = data.workspace?.current_dir || data.cwd || '.';
  const currentDir = path.basename(currentDirPath);
  const branch = getCurrentBranch(currentDirPath);
  const sessionId = data.session_id;

  // Get all usage data in single parallel call
  const { sessionData, dailyData, weeklyData, blockData } = await getAllUsageData(sessionId || '');

  // Process all data synchronously
  const sessionTokens = getSessionTokensFromData(sessionData, sessionId || '');
  const usageStatusline = generateUsageStatusline(dailyData, weeklyData, blockData);
  const sessionPercentage = Math.min(100, Math.round((sessionTokens / MAX_SESSION_TOKENS) * 100));

  // Build status line components
  const dirDisplay = branch ? `${currentDir}[${branch}]` : currentDir;
  const sessionDisplay = `🪙 ${formatTokens(sessionTokens)}/${formatTokens(MAX_SESSION_TOKENS)}`;
  const usageColor = getSessionUsageColor(sessionTokens);
  const percentageDisplay = `${usageColor}${sessionPercentage}%\x1b[0m`;

  // Combine all parts
  const parts = [
    `📁 ${dirDisplay}`,
    usageStatusline,
    `${sessionDisplay}`,
    percentageDisplay
  ].filter(Boolean);

  return parts.join(' | ');
}

async function main(): Promise<void> {
  try {
    const data = await readStdinAsJson();
    const statusLine = await generateStatusline(data);
    console.log(statusLine);
  } catch (error) {
    console.log('[Error] 📁 . | 🪙 0 | 0%');
  }
}

main();
