#!/usr/bin/env bun

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { spawn } from 'node:child_process';
import { execSync } from 'node:child_process';

// Constants
const MAX_TOKEN = 200000;
const COMPACTION_THRESHOLD = MAX_TOKEN * 0.8;
const HOME_DIR = process.env.HOME || '~';

async function readStdinAsJson(): Promise<any> {
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

async function generateStatusline(data: any): Promise<string> {
  // Extract values
  const currentDirPath = data.workspace?.current_dir || data.cwd || '.';
  const currentDir = path.basename(currentDirPath);
  const branch = getCurrentBranch(currentDirPath);
  const sessionId = data.session_id;

  // Calculate token usage for current session
  let totalTokens = 0;

  if (sessionId) {
    // Find all transcript files
    const projectsDir = path.join(HOME_DIR, '.claude', 'projects');

    if (fs.existsSync(projectsDir)) {
      // Get all project directories
      const projectDirs = fs.readdirSync(projectsDir)
        .map(dir => path.join(projectsDir, dir))
        .filter(dir => fs.statSync(dir).isDirectory());

      // Search for the current session's transcript file
      for (const projectDir of projectDirs) {
        const transcriptFile = path.join(projectDir, `${sessionId}.jsonl`);

        if (fs.existsSync(transcriptFile)) {
          totalTokens = await calculateTokensFromTranscript(transcriptFile);
          break;
        }
      }
    }
  }

  // Calculate percentage
  const percentage = Math.min(100, Math.round((totalTokens / COMPACTION_THRESHOLD) * 100));

  // Format token display
  const tokenDisplay = formatTokenCount(totalTokens);

  // Color coding for percentage
  let percentageColor = '\x1b[32m'; // Green
  if (percentage >= 70) percentageColor = '\x1b[33m'; // Yellow
  if (percentage >= 90) percentageColor = '\x1b[31m'; // Red

  // Get ccusage statusline
  const ccusageOutput = await getCcusageStatusline(data);

  // Build status line
  const dirDisplay = branch ? `${currentDir}[${branch}]` : currentDir;
  return `${ccusageOutput ? `${ccusageOutput} | ` : ''}📁 ${dirDisplay} | 🪙 ${tokenDisplay} / ${formatTokenCount(MAX_TOKEN)} | ${percentageColor}${percentage}%\x1b[0m`;
}

async function main(): Promise<void> {
  try {
    const data = await readStdinAsJson();
    const statusLine = await generateStatusline(data);
    console.log(statusLine);
  } catch (error) {
    // Fallback status line on error
    console.log('[Error] 📁 . | 🪙 0 | 0%');
  }
}

main();

async function calculateTokensFromTranscript(filePath: string): Promise<number> {
  let lastUsage = null;

  const fileStream = fs.createReadStream(filePath);
  const rl = readline.createInterface({
    input: fileStream,
    crlfDelay: Infinity
  });

  try {
    for await (const line of rl) {
      try {
        const entry = JSON.parse(line);

        // Check if this is an assistant message with usage data
        if (entry.type === 'assistant' && entry.message?.usage) {
          lastUsage = entry.message.usage;
        }
      } catch (e) {
        // Skip invalid JSON lines
      }
    }

    if (lastUsage) {
      // The last usage entry contains cumulative tokens
      const totalTokens = (lastUsage.input_tokens || 0) +
        (lastUsage.output_tokens || 0) +
        (lastUsage.cache_creation_input_tokens || 0) +
        (lastUsage.cache_read_input_tokens || 0);
      return totalTokens;
    } else {
      return 0;
    }
  } finally {
    rl.close();
  }
}

async function getCcusageStatusline(data: any): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      const ccusage = spawn('bun', ['x', 'ccusage', 'statusline'], {
        stdio: ['pipe', 'pipe', 'pipe']
      });

      let output = '';
      let errorOutput = '';

      ccusage.stdout?.on('data', (chunk) => {
        output += chunk.toString();
      });

      ccusage.stderr?.on('data', (chunk) => {
        errorOutput += chunk.toString();
      });

      ccusage.on('close', (code) => {
        if (code === 0 && output.trim()) {
          resolve(output.trim());
        } else {
          resolve(null);
        }
      });

      ccusage.on('error', () => {
        resolve(null);
      });

      // Send input data
      ccusage.stdin?.write(JSON.stringify(data));
      ccusage.stdin?.end();
    } catch {
      resolve(null);
    }
  });
}

function formatTokenCount(tokens: number): string {
  if (tokens >= 1000000) {
    return `${(tokens / 1000000).toFixed(1)}M`;
  } else if (tokens >= 1000) {
    return `${(tokens / 1000).toFixed(1)}K`;
  }
  return tokens.toString();
}