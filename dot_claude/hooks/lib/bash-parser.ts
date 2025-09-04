#!/usr/bin/env -S bun run --silent

export interface SimpleCommand {
  name: string | null;
  args: string[];
  assignments: string[];
  redirections: string[];
  path: string[];
  range: { start: number; end: number };
  text: string;
}

export interface BashParsingResult {
  commands: SimpleCommand[];
  errors: Array<{ message: string; range?: { start: number; end: number } }>;
  parsingMethod: "tree-sitter" | "fallback";
}

// Meta commands that can execute other commands (from original implementation)
const META_COMMANDS = {
  'sh': [/-c\s+['"](.+?)['"]/, /(.+)/],
  'bash': [/-c\s+['"](.+?)['"]/, /(.+)/],
  'zsh': [/-c\s+['"](.+?)['"]/, /(.+)/],
  'bun': [/-e\s+['"](.+?)['"]/, /(.+)/],
  'node': [/-e\s+['"](.+?)['"]/, /(.+)/],
  'xargs': [/sh\s+-c\s+['"](.+?)['"]/, /-I\s+\S+\s+(.+)/, /(.+)/],
  'timeout': [/\d+\s+(.+)/],
  'time': [/(.+)/],
  'env': [/(?:\w+=\w+\s+)*(.+)/],
  'cat': [/(.+)/],
  'head': [/(-\d+\s+)?(.+)/],
  'tail': [/(-\d+\s+)?(.+)/]
};

// Control structure keywords that should be processed transparently
const CONTROL_KEYWORDS = ['for', 'do', 'done', 'if', 'then', 'else', 'fi', 'while'];

// Try tree-sitter parsing first, fallback to regex-based parsing
export async function parseBashCommand(command: string): Promise<BashParsingResult> {
  try {
    return await parseWithTreeSitter(command);
  } catch (error) {
    console.warn(`Tree-sitter parsing failed, using fallback: ${error}`);
    return parseWithFallback(command);
  }
}

async function parseWithTreeSitter(command: string): Promise<BashParsingResult> {
  // This will be implemented once we solve the web-tree-sitter initialization issue
  throw new Error("Tree-sitter parsing not yet available");
}

function parseWithFallback(command: string): BashParsingResult {
  const commands: SimpleCommand[] = [];
  const errors: Array<{ message: string; range?: { start: number; end: number } }> = [];
  
  try {
    const extractedCommands = extractCommandsFromCompoundFallback(command);
    
    for (let i = 0; i < extractedCommands.length; i++) {
      const cmdText = extractedCommands[i] ?? "";
      const cmd = parseSimpleCommandFallback(cmdText, i, command);
      if (cmd) {
        commands.push(cmd);
      }
    }
  } catch (error) {
    errors.push({
      message: `Fallback parsing error: ${error}`,
      range: { start: 0, end: command.length }
    });
  }

  return {
    commands,
    errors,
    parsingMethod: "fallback"
  };
}

function extractCommandsFromCompoundFallback(command: string): string[] {
  const commands: string[] = [];
  const processed = new Set<string>();

  // Extract commands from meta commands
  extractMetaCommands(command, commands, processed);
  
  // Extract from control structures (for loops, etc.)
  extractFromControlStructures(command, commands, processed);
  
  // Traditional split on ; && ||
  const basicCommands = command.split(/[;&|]{1,2}/)
    .map(cmd => cmd.trim())
    .filter(Boolean)
    .filter(cmd => !processed.has(cmd))
    .filter(cmd => !CONTROL_KEYWORDS.includes(cmd));
  
  commands.push(...basicCommands);
  
  return [...new Set(commands)]; // Remove duplicates
}

function extractMetaCommands(command: string, commands: string[], processed: Set<string>) {
  for (const [metaCmd, patterns] of Object.entries(META_COMMANDS)) {
    if (command.includes(metaCmd)) {
      for (const pattern of patterns) {
        const regex = new RegExp(`${metaCmd}\\s+${pattern.source}`, 'g');
        let match;
        while ((match = regex.exec(command)) !== null) {
          if (match[1]) {
            processed.add(command);
            const nestedCommands = extractCommandsFromCompoundFallback(match[1]);
            commands.push(...nestedCommands);
          }
        }
      }
    }
  }
}

function extractFromControlStructures(command: string, commands: string[], processed: Set<string>) {
  const forLoopMatch = command.match(/for\s+\w+\s+in\s+[^;]+;\s*do\s+(.*?);\s*done/s);
  if (forLoopMatch && forLoopMatch[1]) {
    processed.add(command);
    const loopBody = forLoopMatch[1];
    const bodyCommands = loopBody.split(/\s*;\s*/)
      .map(cmd => cmd.trim())
      .filter(Boolean)
      .filter(cmd => !CONTROL_KEYWORDS.includes(cmd));
    
    commands.push(...bodyCommands);
  }
}

function parseSimpleCommandFallback(cmdText: string, index: number, originalCommand: string): SimpleCommand | null {
  const trimmed = cmdText.trim();
  if (!trimmed) return null;

  // Simple parsing - split on whitespace and identify basic components
  const parts: string[] = trimmed.split(/\s+/);
  const assignments: string[] = [];
  const redirections: string[] = [];
  const args: string[] = [];
  let commandName: string | null = null;

  let i = 0;
  // Handle variable assignments at the beginning
  while (i < parts.length) {
    const p = parts[i] ?? "";
    if (p.includes('=') && !p.startsWith('=')) {
      assignments.push(p);
      i++;
      continue;
    }
    break;
  }

  // Get command name
  if (i < parts.length) {
    commandName = parts[i] ?? null;
    i++;
  }

  // Process remaining arguments and redirections
  while (i < parts.length) {
    const part = parts[i] ?? "";
    if (part.startsWith('>') || part.startsWith('<') || part.startsWith('2>')) {
      // Handle redirection
      if (part.length > 1) {
        redirections.push(part);
      } else if (i + 1 < parts.length) {
        const next = parts[i + 1] ?? "";
        redirections.push(part + next);
        i++;
      }
    } else {
      args.push(part);
    }
    i++;
  }

  const startIndex = Math.max(0, originalCommand.indexOf(trimmed));
  const endIndex = startIndex + trimmed.length;

  return {
    name: commandName,
    args,
    assignments,
    redirections,
    path: [`fallback#${index}`],
    range: { start: startIndex, end: endIndex },
    text: trimmed
  };
}

// Legacy compatibility function - replaces extractCommandsFromCompound
export async function extractCommandsFromCompound(command: string): Promise<string[]> {
  try {
    const result = await parseBashCommand(command);
    return result.commands.map(cmd => cmd.text);
  } catch (error) {
    // Fallback to simple splitting if parsing fails
    console.warn(`Bash parsing failed, falling back to simple splitting: ${error}`);
    return command.split(/[;&|]{1,2}/)
      .map(cmd => cmd.trim())
      .filter(Boolean);
  }
}
