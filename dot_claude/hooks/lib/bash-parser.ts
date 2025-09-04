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
  'node': [/-e\s+['"](.+?)['"]/, /(.+)/],
  'xargs': [/sh\s+-c\s+['"](.+?)['"]/, /-I\s+\S+\s+(.+)/, /(.+)/],
  'timeout': [/\d+\s+(.+)/],
  'time': [/(.+)/],
  'env': [/(?:\w+=\w+\s+)*(.+)/]
  // Removed 'cat', 'head', 'tail' - these are file reading commands, not meta commands
  // Removed 'bun' - bun run/test/install are direct commands, not meta commands
};

// Control structure keywords that should be processed transparently
const CONTROL_KEYWORDS = ['for', 'do', 'done', 'if', 'then', 'else', 'fi', 'while'];

// Tree-sitter state
let treeSitterInitialized = false;
let bashParser: any = null;
let TreeSitter: any = null;

// Simple command line splitter that respects quoted strings and redirections
function splitCommandLine(command: string): string[] {
  const parts: string[] = [];
  let current = '';
  let inQuotes = false;
  let quoteChar = '';
  
  for (let i = 0; i < command.length; i++) {
    const char = command[i];
    const nextChar = command[i + 1] ?? '';
    
    if (!inQuotes && (char === '"' || char === "'")) {
      inQuotes = true;
      quoteChar = char;
      current += char;
    } else if (inQuotes && char === quoteChar) {
      inQuotes = false;
      quoteChar = '';
      current += char;
    } else if (!inQuotes && /\s/.test(char)) {
      if (current) {
        parts.push(current);
        current = '';
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

// Smart pipeline and operator splitter that handles redirections properly  
function splitPipelineAndOperators(command: string): string[] {
  const parts: string[] = [];
  let current = '';
  let inQuotes = false;
  let quoteChar = '';
  let i = 0;
  
  while (i < command.length) {
    const char = command[i] ?? '';
    const nextChar = command[i + 1] ?? '';
    
    if (!inQuotes && (char === '"' || char === "'")) {
      inQuotes = true;
      quoteChar = char;
      current += char;
    } else if (inQuotes && char === quoteChar) {
      inQuotes = false;
      quoteChar = '';
      current += char;
    } else if (!inQuotes && (char === ';' || (char === '&' && nextChar === '&') || (char === '|' && nextChar !== '&'))) {
      // Handle operators
      if (current.trim()) {
        parts.push(current.trim());
        current = '';
      }
      
      // Skip compound operators
      if ((char === '&' && nextChar === '&') || (char === '|' && nextChar === '|')) {
        i++; // Skip the second character
      }
    } else {
      current += char;
    }
    
    i++;
  }
  
  if (current.trim()) {
    parts.push(current.trim());
  }
  
  return parts;
}

// Helper function to check if a token is a redirection
function isRedirection(token: string): boolean {
  return /^(\d*[><]+|\d*>&\d*|&\d+)/.test(token);
}

// Extract commands from tree-sitter AST
function extractCommandsFromTreeSitter(tree: any, sourceText: string): SimpleCommand[] {
  const commands: SimpleCommand[] = [];
  
  function traverse(node: any, commandIndex: number = 0): number {
    let currentIndex = commandIndex;
    
    // Handle different node types
    switch (node.type) {
      case 'program':
      case 'list':
        for (const child of node.children) {
          currentIndex = traverse(child, currentIndex);
        }
        break;
        
      case 'pipeline':
        for (const child of node.children) {
          if (child.type === 'command') {
            currentIndex = traverse(child, currentIndex);
          }
        }
        break;
        
      case 'command':
      case 'simple_command':
        const cmd = parseSimpleCommandFromNode(node, sourceText, currentIndex);
        if (cmd) {
          commands.push(cmd);
          currentIndex++;
        }
        break;
        
      case 'for_statement':
      case 'while_statement':
      case 'if_statement':
        // Process body of control structures
        for (const child of node.children) {
          currentIndex = traverse(child, currentIndex);
        }
        break;
        
      default:
        // Recursively traverse unknown nodes
        for (const child of node.children || []) {
          currentIndex = traverse(child, currentIndex);
        }
        break;
    }
    
    return currentIndex;
  }
  
  traverse(tree.rootNode, 0);
  return commands;
}

// Parse a simple command from tree-sitter node
function parseSimpleCommandFromNode(node: any, sourceText: string, index: number): SimpleCommand | null {
  const startByte = node.startIndex ?? 0;
  const endByte = node.endIndex ?? sourceText.length;
  const text = sourceText.slice(startByte, endByte).trim();
  
  if (!text) return null;
  
  const assignments: string[] = [];
  const redirections: string[] = [];
  const args: string[] = [];
  let commandName: string | null = null;
  
  // Parse children nodes
  for (const child of node.children || []) {
    switch (child.type) {
      case 'variable_assignment':
        assignments.push(sourceText.slice(child.startIndex ?? 0, child.endIndex ?? 0));
        break;
        
      case 'file_redirect':
      case 'heredoc_redirect':
      case 'redirection':
        redirections.push(sourceText.slice(child.startIndex ?? 0, child.endIndex ?? 0));
        break;
        
      case 'word':
        const wordText = sourceText.slice(child.startIndex ?? 0, child.endIndex ?? 0);
        if (!commandName) {
          commandName = wordText;
        } else {
          args.push(wordText);
        }
        break;
    }
  }
  
  return {
    name: commandName,
    args,
    assignments,
    redirections,
    path: [`tree-sitter#${index}`],
    range: { start: startByte, end: endByte },
    text
  };
}

// Try tree-sitter parsing first, fallback to regex-based parsing
export async function parseBashCommand(command: string, silent = false): Promise<BashParsingResult> {
  try {
    return await parseWithTreeSitter(command);
  } catch (error) {
    if (!silent) {
      console.warn(`Tree-sitter parsing failed, using fallback: ${error}`);
    }
    return parseWithFallback(command);
  }
}

async function parseWithTreeSitter(command: string): Promise<BashParsingResult> {
  if (!treeSitterInitialized) {
    // Lazy init web-tree-sitter and bash language
    // Defer to runtime resolution to avoid bundler issues
    const ParserMod: any = await import('web-tree-sitter');
    const Parser = ParserMod.Parser || ParserMod;
    if (typeof Parser.init === 'function') {
      await Parser.init();
    }

    // Resolve WASM path from installed package
    const wasmPath = `${process.cwd()}/node_modules/tree-sitter-bash/tree-sitter-bash.wasm`;
    const Language = (ParserMod.Language || Parser.Language);
    const BashLang = await Language.load(wasmPath);
    bashParser = new Parser();
    bashParser.setLanguage(BashLang);
    treeSitterInitialized = true;
  }

  try {
    // If meta-execution is present (sh -c, xargs sh -c, etc.), prefer the existing
    // meta extractor to pull out nested commands for safety analysis
    const metaOnly = extractMetaCommands(command, new Set<string>());
    if (metaOnly.length > 0) {
      const mapped = metaOnly.map((t, i) => parseSimpleCommandFallback(t, i, command)).filter(Boolean) as SimpleCommand[];
      return { commands: mapped, errors: [], parsingMethod: 'tree-sitter' };
    }

    const tree = bashParser.parse(command);
    const cmds = extractCommandsFromTreeSitter(tree, command);
    return {
      commands: cmds,
      errors: [],
      parsingMethod: 'tree-sitter'
    };
  } catch (e) {
    // Surface to caller to trigger fallback
    throw e;
  }
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

  // Extract commands from meta commands first
  const metaExtracted = extractMetaCommands(command, processed);
  if (metaExtracted.length > 0) {
    return metaExtracted; // If meta commands found, return only those
  }
  
  // Extract from control structures (for loops, etc.)
  const controlExtracted = extractFromControlStructures(command, processed);
  if (controlExtracted.length > 0) {
    return controlExtracted; // If control structures found, return only those
  }
  
  // Traditional split on ; && || |
  const basicCommands = splitPipelineAndOperators(command)
    .map(cmd => cmd.trim())
    .filter(Boolean)
    .filter(cmd => !CONTROL_KEYWORDS.includes(cmd.split(/\s+/)[0])); // Check only first word
  
  return basicCommands;
}

function extractMetaCommands(command: string, processed: Set<string>): string[] {
  const commands: string[] = [];
  
  // First check if this is a pipeline with meta commands
  const pipelineParts = splitPipelineAndOperators(command);
  
  // Process each part of the pipeline for meta commands
  for (let partIndex = 0; partIndex < pipelineParts.length; partIndex++) {
    const part = pipelineParts[partIndex] ?? "";
    
    for (const [metaCmd, patterns] of Object.entries(META_COMMANDS)) {
      if (part.includes(metaCmd)) {
        for (const pattern of patterns) {
          const regex = new RegExp(`\\b${metaCmd}\\s+${pattern.source}`, 'g');
          let match;
          while ((match = regex.exec(part)) !== null) {
            const extractedCommand = match[1] || match[2] || match[3]; // Handle multiple capture groups
            if (extractedCommand && extractedCommand.trim()) {
              processed.add(command);
              
              // Extract commands from the nested command, including backticks
              let nestedCommands = extractCommandsFromCompoundFallback(extractedCommand);
              
              // Also check for command substitutions (backticks) in the nested commands
              nestedCommands = nestedCommands.flatMap(cmd => extractCommandSubstitutions(cmd));
              
              // Add pipeline parts before the meta command
              for (let i = 0; i < partIndex; i++) {
                const prevPart = pipelineParts[i];
                if (prevPart && prevPart.trim()) commands.push(prevPart);
              }
              
              // Add nested commands
              commands.push(...nestedCommands);
              
              // Add pipeline parts after the meta command
              for (let i = partIndex + 1; i < pipelineParts.length; i++) {
                const nextPart = pipelineParts[i];
                if (nextPart && nextPart.trim()) commands.push(nextPart);
              }
              
              return commands;
            }
          }
        }
      }
    }
  }
  
  return commands;
}

// Extract commands from backtick command substitutions
function extractCommandSubstitutions(command: string): string[] {
  const commands: string[] = [];
  let match;

  // Backtick substitutions: `...`
  const backtickRegex = /`([^`]+)`/g;
  while ((match = backtickRegex.exec(command)) !== null) {
    const substitutedCommand = match[1];
    if (substitutedCommand && substitutedCommand.trim()) {
      const subCommands = extractCommandsFromCompoundFallback(substitutedCommand);
      commands.push(...subCommands);
    }
  }

  // Command substitutions: $(...)
  // Single-level only (non-nested) to keep it simple
  const dollarParenRegex = /\$\(([^()]+)\)/g;
  while ((match = dollarParenRegex.exec(command)) !== null) {
    const substitutedCommand = match[1];
    if (substitutedCommand && substitutedCommand.trim()) {
      const subCommands = extractCommandsFromCompoundFallback(substitutedCommand);
      commands.push(...subCommands);
    }
  }

  // If no substitutions found, return the original command
  if (commands.length === 0) {
    commands.push(command);
  }

  return commands;
}

function extractFromControlStructures(command: string, processed: Set<string>): string[] {
  const commands: string[] = [];
  
  // Handle for loops: "for x in ...; do ...; done"
  const forLoopMatch = command.match(/for\s+\w+\s+in\s+[^;]+;\s*do\s+(.*?);\s*done/s);
  if (forLoopMatch && forLoopMatch[1]) {
    processed.add(command);
    const loopBody = forLoopMatch[1];
    // Split loop body commands 
    const bodyCommands = loopBody.split(/\s*;\s*/)
      .map(cmd => cmd.trim())
      .filter(Boolean)
      .filter(cmd => !CONTROL_KEYWORDS.includes(cmd.split(/\s+/)[0])); // Check only first word
    
    commands.push(...bodyCommands);
  }
  
  return commands;
}

function parseSimpleCommandFallback(cmdText: string, index: number, originalCommand: string): SimpleCommand | null {
  const trimmed = cmdText.trim();
  if (!trimmed) return null;

  // Simple parsing - split on whitespace while respecting quotes
  const parts: string[] = splitCommandLine(trimmed);
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
    
    // Check if this is a redirection
    if (isRedirection(part)) {
      // Handle standalone redirections like ">" followed by "file"
      if (part.match(/^(\d*[><]+|&?\d+|&?\d*>&\d*?)$/) && i + 1 < parts.length && !isRedirection(parts[i + 1] ?? "")) {
        // Redirection operator followed by target - combine without space
        const next = parts[i + 1] ?? "";
        redirections.push(part + next);
        i++; // Skip the target
      } else {
        // Complete redirection in one part or complex redirection
        redirections.push(part);
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
    const result = await parseBashCommand(command, true); // Silent mode
    return result.commands.map(cmd => cmd.text);
  } catch (error) {
    // Fallback to simple splitting if parsing fails
    console.warn(`Bash parsing failed, falling back to simple splitting: ${error}`);
    return command.split(/[;&|]{1,2}/)
      .map(cmd => cmd.trim())
      .filter(Boolean);
  }
}
