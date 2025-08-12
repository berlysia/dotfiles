#!/usr/bin/env bun

import path from 'node:path';
import { execSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { loadDailyUsageData, loadWeeklyUsageData, loadSessionBlockData } from "ccusage/data-loader";

type DailyData = Awaited<ReturnType<typeof loadDailyUsageData>>;
type WeeklyData = Awaited<ReturnType<typeof loadWeeklyUsageData>>;
type BlockData = Awaited<ReturnType<typeof loadSessionBlockData>>;

// Configuration
const MAX_SESSION_TOKENS = 200000;
const WARNING_THRESHOLD = MAX_SESSION_TOKENS * 0.7;
const CRITICAL_THRESHOLD = MAX_SESSION_TOKENS * 0.9;

interface StatusLineData {
  session_id?: string;
  transcript_path?: string;
  workspace?: {
    current_dir?: string;
    project_dir?: string;
  };
  cwd?: string;
  model?: {
    id?: string;
    display_name?: string;
  };
  version?: string;
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

function getGitRootDir(dirPath: string): string | null {
  try {
    const gitRoot = execSync('git rev-parse --show-toplevel', {
      cwd: dirPath,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'ignore']
    }).trim();
    return gitRoot;
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

async function getAllUsageData() {
  const todayStr = new Date().toISOString().split('T')[0]?.replace(/-/g, '') ?? ''; // Convert to YYYYMMDD format

  const [dailyData, weeklyData, blockData] = await Promise.all([
    loadDailyUsageData({ offline: true, since: todayStr, until: todayStr }),
    loadWeeklyUsageData({ offline: true, startOfWeek: "monday" }),
    loadSessionBlockData({ offline: true })
  ]);

  return { dailyData, weeklyData, blockData };
}

async function calculateCurrentContextTokens(transcriptPath: string): Promise<number> {
  try {
    if (!transcriptPath) return 0;

    const content = await fs.readFile(transcriptPath, 'utf8');
    const lines = content.trim().split('\n');
    let totalTokens = 0;

    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        // Check for usage information in Claude Code transcript format
        if (entry.message && entry.message.usage) {
          const usage = entry.message.usage;
          totalTokens += (usage.input_tokens || 0) + (usage.output_tokens || 0);
        }
      } catch (e) {
        // Skip invalid JSON lines
        continue;
      }
    }

    return totalTokens;
  } catch (error) {
    return 0;
  }
}

function calcSumOfTokens(tokens: {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens?: number;
  cacheReadTokens?: number;
}) {
  return (tokens.inputTokens || 0) + (tokens.outputTokens || 0) +
    (tokens.cacheCreationTokens || 0) + (tokens.cacheReadTokens || 0);
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
  return `${hours}:${minutes.toFixed().padStart(2, "0")}`;
}

function getBlockUsageFromData(blockData: BlockData): string {
  try {
    if (blockData && Array.isArray(blockData) && blockData.length > 0) {
      const activeBlock = blockData.find(b => b.isActive);
      if (activeBlock) {
        const tokens = calcSumOfTokens(activeBlock.tokenCounts);
        const now = new Date();
        const remaining = Math.round((activeBlock.endTime.getTime() - now.getTime()));
        const currentTime = now.toLocaleTimeString('ja-JP', {
          hour: '2-digit',
          minute: '2-digit',
          hour12: false
        });
        return `Block ${formatCost(activeBlock.costUSD || 0)}|${formatTokens(tokens)}| ${currentTime} (${formatDuration(remaining)} remains)`;
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
  const model = data.model?.display_name || 'Unknown';

  // Determine the best directory to use, prioritizing project_dir > current_dir > git root > cwd
  let projectPath = data.workspace?.project_dir;

  if (!projectPath) {
    const workingDir = data.workspace?.current_dir || data.cwd || '.';
    const gitRoot = getGitRootDir(workingDir);
    projectPath = gitRoot || workingDir;
  }

  const currentDir = path.basename(projectPath);
  const branch = getCurrentBranch(projectPath);

  // Get all usage data in single parallel call
  const { dailyData, weeklyData, blockData } = await getAllUsageData();

  // Calculate current context tokens from transcript (compaction progress)
  const displayTokens = data.transcript_path
    ? await calculateCurrentContextTokens(data.transcript_path)
    : 0;

  const usageStatusline = generateUsageStatusline(dailyData, weeklyData, blockData);
  const sessionPercentage = Math.min(100, Math.round((displayTokens / MAX_SESSION_TOKENS) * 100));

  // Build status line components
  const dirDisplay = branch ? `${currentDir}[${branch}]` : currentDir;
  const sessionDisplay = `🪙 ${formatTokens(displayTokens)}/${formatTokens(MAX_SESSION_TOKENS)}`;
  const usageColor = getSessionUsageColor(displayTokens);
  const percentageDisplay = `${usageColor}${sessionPercentage}%\x1b[0m`;

  // Combine all parts
  const parts = [
    `[${model}]`,
    `📁 ${dirDisplay}`,
    usageStatusline,
    sessionDisplay,
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
