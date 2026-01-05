#!/usr/bin/env bun

/**
 * Command Statistics Generator - TypeScript Version
 * Processes command execution logs and generates usage statistics
 */

import * as fs from "node:fs";

interface LogEntry {
  timestamp: string;
  command_id: string;
  timing_ms: string;
  command: string;
  description: string;
}

interface CommandStats {
  count: number;
  totalTime: number;
  averageTime: number;
}

interface CommandFrequency {
  command: string;
  count: number;
}

class CommandStatsGenerator {
  private logFile: string;

  constructor(logFile?: string) {
    this.logFile = logFile || ".claude/log/command_execution.log";
  }

  /**
   * Parse log file and extract entries
   */
  parseLogFile(): LogEntry[] {
    try {
      if (!fs.existsSync(this.logFile)) {
        console.error(`Error: Log file not found: ${this.logFile}`);
        process.exit(1);
      }

      const content = fs.readFileSync(this.logFile, "utf-8");
      const lines = content.split("\n").filter((line) => line.trim() !== "");

      const entries: LogEntry[] = [];
      for (const line of lines) {
        const parts = line.split("|");
        if (parts.length >= 5) {
          entries.push({
            timestamp: parts[0] || "",
            command_id: parts[1] || "",
            timing_ms: parts[2] || "",
            command: parts[3] || "",
            description: parts[4] || "",
          });
        }
      }

      return entries;
    } catch (error) {
      console.error(`Error reading log file: ${error}`);
      process.exit(1);
    }
  }

  /**
   * Extract base command from full command string
   */
  extractBaseCommand(fullCommand: string): string {
    return fullCommand.trim().split(/\s+/)[0] || "";
  }

  /**
   * Parse timing value and extract milliseconds
   */
  parseTimingMs(timingStr: string): number {
    const match = timingStr.match(/(\d+)ms/);
    return match?.[1] ? parseInt(match[1], 10) : 0;
  }

  /**
   * Generate command frequency statistics
   */
  generateFrequencyStats(entries: LogEntry[]): CommandFrequency[] {
    const frequencyMap = new Map<string, number>();

    for (const entry of entries) {
      if (entry.command) {
        const baseCommand = this.extractBaseCommand(entry.command);
        if (baseCommand) {
          frequencyMap.set(
            baseCommand,
            (frequencyMap.get(baseCommand) || 0) + 1,
          );
        }
      }
    }

    return Array.from(frequencyMap.entries())
      .map(([command, count]) => ({ command, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);
  }

  /**
   * Generate average execution time statistics
   */
  generateTimingStats(entries: LogEntry[]): Map<string, CommandStats> {
    const timingMap = new Map<string, CommandStats>();

    for (const entry of entries) {
      if (entry.command && entry.timing_ms && entry.timing_ms.includes("ms")) {
        const baseCommand = this.extractBaseCommand(entry.command);
        const timeMs = this.parseTimingMs(entry.timing_ms);

        if (baseCommand && timeMs > 0) {
          const existing = timingMap.get(baseCommand);
          if (existing) {
            existing.count++;
            existing.totalTime += timeMs;
            existing.averageTime = Math.round(
              existing.totalTime / existing.count,
            );
          } else {
            timingMap.set(baseCommand, {
              count: 1,
              totalTime: timeMs,
              averageTime: timeMs,
            });
          }
        }
      }
    }

    return timingMap;
  }

  /**
   * Format date for display
   */
  formatDate(): string {
    return new Date().toLocaleString();
  }

  /**
   * Generate and display complete statistics report
   */
  generateReport(): void {
    const entries = this.parseLogFile();

    console.log("# Command Execution Statistics");
    console.log(`Generated: ${this.formatDate()}`);
    console.log("");

    console.log(`## Total Commands: ${entries.length}`);
    console.log("");

    // Most frequent commands
    console.log("## Most Frequent Commands:");
    const frequencyStats = this.generateFrequencyStats(entries);

    if (frequencyStats.length === 0) {
      console.log("No command data available");
    } else {
      for (const { command, count } of frequencyStats) {
        console.log(`${count.toString().padStart(6)} ${command}`);
      }
    }

    console.log("");

    // Average execution times
    console.log("## Average Execution Times by Command:");
    const timingStats = this.generateTimingStats(entries);

    if (timingStats.size === 0) {
      console.log("No timing data available");
    } else {
      // Convert to array and sort by average time
      const sortedTiming = Array.from(timingStats.entries()).sort(
        ([, a], [, b]) => a.averageTime - b.averageTime,
      );

      for (const [command, stats] of sortedTiming) {
        const commandPadded = command.padEnd(20);
        console.log(
          `${commandPadded} ${stats.averageTime} ms (avg from ${stats.count} executions)`,
        );
      }
    }
  }
}

// Main execution
function main() {
  const args = process.argv.slice(2);
  const logFile = args[0];

  const generator = new CommandStatsGenerator(logFile);
  generator.generateReport();
}

// Execute if run directly
if (require.main === module) {
  main();
}

export { CommandStatsGenerator };
export type { LogEntry, CommandStats, CommandFrequency };
