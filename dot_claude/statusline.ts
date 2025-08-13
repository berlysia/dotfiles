#!/usr/bin/env bun

import path, { resolve } from 'node:path';
import { execSync } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { loadDailyUsageData, loadSessionBlockData } from "ccusage/data-loader";
import { writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';

type DailyData = Awaited<ReturnType<typeof loadDailyUsageData>>;
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

  const [dailyData, blockData] = await Promise.all([
    loadDailyUsageData({ offline: true, since: todayStr, until: todayStr }),
    loadSessionBlockData({ offline: true })
  ]);

  return { dailyData, blockData };
}

// Claude Code transcript JSONL format type definitions

interface BaseTranscriptEntry {
  parentUuid: string | null;
  isSidechain: boolean;
  cwd: string;
  sessionId: string;
  gitBranch: string;
  timestamp: string;
  type: "user" | "assistant" | "system";
}

interface UserTranscriptEntry extends BaseTranscriptEntry {
  type: "user";
  isMeta?: boolean;
  message: {
    role: "user";
    content: string;
  };
  isCompactSummary?: boolean;
  userType?: "external";
  version?: string;
  uuid?: string;
}

interface AssistantTranscriptEntry extends BaseTranscriptEntry {
  type: "assistant";
  message: {
    id: string;
    role: "assistant";
    content: string;
    model: string;
    type: string;
    stop_reason: string;
    stop_sequence: string | null;
    usage: {
      input_tokens: number;
      output_tokens: number;
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
    };
  };
  requestId?: string;
  userType?: string;
  uuid: string;
  version?: string;
}

interface SystemTranscriptEntry extends BaseTranscriptEntry {
  type: "system";
  content: string;
  level: string;
  isMeta?: boolean;
}

type TranscriptEntry = UserTranscriptEntry | AssistantTranscriptEntry | SystemTranscriptEntry;

async function calculateCurrentContextTokens(sessionId: string, transcriptPath: string): Promise<number> {
  try {
    if (!transcriptPath) return 0;

    const fileStream = createReadStream(transcriptPath, { encoding: 'utf8' });
    const rl = createInterface({
      input: fileStream,
      crlfDelay: Infinity // Handle \r\n properly
    });

    let lastUsage = null;

    for await (const line of rl) {
      if (!line.trim()) continue; // Skip empty lines

      try {
        const entry = JSON.parse(line) as TranscriptEntry;
        if (entry.sessionId !== sessionId) continue; // Filter by session ID

        // Check for usage information in Claude Code transcript format
        if (entry.type === "assistant" && entry.message.usage) {
          lastUsage = entry.message.usage;
        }
      } catch (e) {
        // Skip invalid JSON lines
        continue;
      }
    }

    if (lastUsage) {
      return (lastUsage.input_tokens || 0) + 
             (lastUsage.output_tokens || 0) + 
             (lastUsage.cache_creation_input_tokens || 0) + 
             (lastUsage.cache_read_input_tokens || 0);
    }

    return 0;
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

function generateUsageStatusline(dailyData: DailyData, blockData: BlockData): string | null {
  const daily = getDailyUsageFromData(dailyData);
  const block = getBlockUsageFromData(blockData);

  const parts: string[] = [];

  if (daily) {
    parts.push(daily);
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
  const { dailyData, blockData } = await getAllUsageData();

  // Calculate current context tokens from transcript (compaction progress)
  const displayTokens = data.session_id && data.transcript_path
    ? await calculateCurrentContextTokens(data.session_id, data.transcript_path)
    : 0;

  const usageStatusline = generateUsageStatusline(dailyData, blockData);
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
    await writeFile(resolve(homedir(), ".claude/latestStatusLineSeed.json"), JSON.stringify(data, null, 2));
    const statusLine = await generateStatusline(data);
    console.log(statusLine);
  } catch (error) {
    console.log('[Error] Failed to generate status line:', (error as Error).message);
  }
}

main();
