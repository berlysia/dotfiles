/**
 * Command parsing utilities for auto-approve hook
 * Shared between implementation and tests
 */

// Meta commands that can execute other commands
const META_COMMANDS = {
  'sh': [/-c\s+['"](.+?)['"]/, /(.+)/],
  'bash': [/-c\s+['"](.+?)['"]/, /(.+)/],
  'zsh': [/-c\s+['"](.+?)['"]/, /(.+)/],
  'bun': [/-e\s+['"](.+?)['"]/, /(.+)/], // Handle bun -e "script" patterns
  'node': [/-e\s+['"](.+?)['"]/, /(.+)/], // Handle node -e "script" patterns
  'xargs': [/sh\s+-c\s+['"](.+?)['"]/, /-I\s+\S+\s+(.+)/, /(.+)/],
  'timeout': [/\d+\s+(.+)/],
  'time': [/(.+)/],
  'env': [/(?:\w+=\w+\s+)*(.+)/],
  'cat': [/(.+)/], // Handle cat commands in pipelines
  'head': [/(-\d+\s+)?(.+)/], // Handle head -n file patterns  
  'tail': [/(-\d+\s+)?(.+)/]  // Handle tail -n file patterns
};

// Control structure keywords that should be processed transparently
const CONTROL_KEYWORDS = ['for', 'do', 'done', 'if', 'then', 'else', 'fi', 'while'];

/**
 * Extract individual commands from compound commands, meta commands, and control structures
 */
export function extractCommandsFromCompound(command: string): string[] {
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
    .filter(cmd => !CONTROL_KEYWORDS.includes(cmd)); // Filter out control keywords
  
  commands.push(...basicCommands);
  
  return [...new Set(commands)]; // Remove duplicates
}

function extractMetaCommands(command: string, commands: string[], processed: Set<string>) {
  for (const [metaCmd, patterns] of Object.entries(META_COMMANDS)) {
    if (command.includes(metaCmd)) {
      for (const pattern of patterns) {
        const regex = new RegExp(`\\b${metaCmd}\\s+${pattern.source}`, 'g');
        let match;
        while ((match = regex.exec(command)) !== null) {
          const extractedCommand = match[1] || match[2] || match[3]; // Handle multiple capture groups
          if (extractedCommand && extractedCommand.trim()) {
            processed.add(command);
            // Recursively extract nested commands
            const nestedCommands = extractCommandsFromCompound(extractedCommand);
            commands.push(...nestedCommands);
            break; // Found a match, no need to try other patterns for this meta command
          }
        }
      }
    }
  }
}

function extractFromControlStructures(command: string, commands: string[], processed: Set<string>) {
  // Handle for loops: "for x in ...; do ...; done"
  const forLoopMatch = command.match(/for\s+\w+\s+in\s+[^;]+;\s*do\s+(.*?);\s*done/s);
  if (forLoopMatch && forLoopMatch[1]) {
    processed.add(command);
    const loopBody = forLoopMatch[1];
    // Split loop body commands and recursively extract
    const bodyCommands = loopBody.split(/\s*;\s*/)
      .map(cmd => cmd.trim())
      .filter(Boolean)
      .filter(cmd => !CONTROL_KEYWORDS.includes(cmd));
    
    commands.push(...bodyCommands);
  }
}

/**
 * Check if a command is potentially dangerous and requires review
 */
export function checkDangerousCommand(cmd: string): { isDangerous: boolean; requiresManualReview: boolean; reason: string } {
  const dangerousPatterns = [
    { pattern: /rm\s+-rf\s+\//, reason: "Dangerous system deletion", requiresReview: false },
    { pattern: /sudo\s+rm/, reason: "Sudo deletion command", requiresReview: false },
    { pattern: /dd\s+.*\/dev\//, reason: "Disk operation", requiresReview: false },
    { pattern: /mkfs/, reason: "Filesystem creation", requiresReview: false },
    { pattern: /curl.*\|\s*sh/, reason: "Piped shell execution", requiresReview: true },
    { pattern: /wget.*\|\s*sh/, reason: "Piped shell execution", requiresReview: true },
  ];

  for (const { pattern, reason, requiresReview } of dangerousPatterns) {
    if (pattern.test(cmd)) {
      return { isDangerous: true, requiresManualReview: requiresReview, reason };
    }
  }

  return { isDangerous: false, requiresManualReview: false, reason: "" };
}

/**
 * Check if a command matches a pattern (for Bash commands)
 */
export function checkCommandPattern(pattern: string, cmd: string): boolean {
  // Extract command from Bash(command:*) format
  const match = pattern.match(/^Bash\(([^)]+)\)$/);
  if (!match) return false;

  const cmdPattern = match[1];
  if (!cmdPattern) return false;

  // Simple wildcard matching - can be enhanced
  if (cmdPattern.endsWith(":*")) {
    const prefix = cmdPattern.slice(0, -2);
    return cmd.startsWith(prefix);
  }

  return cmd === cmdPattern;
}

/**
 * Get file path from tool input based on tool type
 */
export function getFilePathFromToolInput(tool_name: string, tool_input: unknown): string | undefined {
  const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

  if (!isObj(tool_input)) return undefined;

  const filePath = ((): string | undefined => {
    if ('file_path' in tool_input && typeof tool_input.file_path === 'string') return tool_input.file_path;
    if ('path' in tool_input && typeof tool_input.path === 'string') return tool_input.path;
    if ('notebook_path' in tool_input && typeof tool_input.notebook_path === 'string') return tool_input.notebook_path;
    return undefined;
  })();

  if (tool_name === "Write" || tool_name === "Edit" || tool_name === "MultiEdit") {
    return filePath;
  } else if (tool_name === "Read") {
    return filePath;
  } else if (tool_name === "NotebookEdit" || tool_name === "NotebookRead") {
    return filePath;
  } else if (tool_name === "Grep") {
    // Grep can work with optional path parameter or no path (current directory)
    return (('path' in tool_input && typeof tool_input.path === 'string') ? tool_input.path : undefined) || "**";
  }
  return undefined;
}

/**
 * Tools that don't use parentheses in pattern matching
 */
export const NO_PAREN_TOOL_NAMES = [
  "TodoRead",
  "TodoWrite", 
  "Task",
  "BashOutput",
  "KillBash",
  "Glob",
  "ExitPlanMode",
  "WebSearch",
  "ListMcpResourcesTool",
  "ReadMcpResourceTool",
];

/**
 * Control structure keywords that should be processed transparently
 */
export const CONTROL_STRUCTURE_KEYWORDS = CONTROL_KEYWORDS;
