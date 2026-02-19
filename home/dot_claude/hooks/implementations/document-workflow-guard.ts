#!/usr/bin/env -S bun run --silent

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { defineHook } from "cc-hooks-ts";
import { extractCommandsStructured } from "../lib/bash-parser.ts";
import { getCommandFromToolInput } from "../lib/command-parsing.ts";
import { createDenyResponse } from "../lib/context-helpers.ts";
import { expandTilde } from "../lib/path-utils.ts";
import "../types/tool-schemas.ts";

const PLAN_PATH = ".tmp/plan.md";
const RESEARCH_PATH = ".tmp/research.md";
const STATE_PATH = ".tmp/workflow-state.json";
const APPROVAL_REGEX = /^- Status:\s*approved\s*$/m;
const GUARDED_TOOLS = new Set([
  "Write",
  "Edit",
  "MultiEdit",
  "NotebookEdit",
  "Bash",
]);

interface WriteAnalysis {
  isWriteLike: boolean;
  targets: string[];
}

interface WorkflowState {
  mode?: string;
  approved?: boolean;
}

const hook = defineHook({
  trigger: { PreToolUse: true },
  run: async (context) => {
    const { tool_name, tool_input } = context.input;
    if (!GUARDED_TOOLS.has(tool_name)) {
      return context.success({});
    }

    const cwd = getWorkingDirectory();
    const state = readWorkflowState(cwd);
    const workflowActive = isWorkflowActive(cwd, state);
    if (!workflowActive) {
      return context.success({});
    }

    const warnOnly = process.env.DOCUMENT_WORKFLOW_WARN_ONLY === "1";
    const approved = hasApprovedPlan(cwd, state);
    const researched = hasResearchArtifact(cwd);
    const denyReason =
      "Document workflow gate: implementation is blocked until `.tmp/research.md` exists and `.tmp/plan.md` has `- Status: approved`.";

    if (tool_name === "Bash") {
      const command = getCommandFromToolInput("Bash", tool_input) || "";
      const analysis = await analyzeBashWrite(command);
      if (!analysis.isWriteLike) {
        return context.success({});
      }

      if (areAllTargetsDocumentPaths(cwd, analysis.targets)) {
        return context.success({});
      }

      if (approved && researched) {
        return context.success({});
      }

      if (warnOnly) {
        console.error(
          `[document-workflow-guard][would-block] Bash: ${command}`,
        );
        return context.success({});
      }

      return context.json(createDenyResponse(denyReason));
    }

    const targetPath = getTargetFilePath(tool_name, tool_input);
    if (!targetPath) {
      return context.success({});
    }

    if (isDocumentPath(cwd, targetPath)) {
      return context.success({});
    }

    if (approved && researched) {
      return context.success({});
    }

    if (warnOnly) {
      console.error(
        `[document-workflow-guard][would-block] ${tool_name}: ${targetPath}`,
      );
      return context.success({});
    }

    return context.json(createDenyResponse(denyReason));
  },
});

function getWorkingDirectory(): string {
  return process.env.CLAUDE_TEST_CWD || process.cwd();
}

function normalizePathFromCwd(cwd: string, path: string): string {
  const expanded = expandTilde(path);
  return resolve(cwd, expanded);
}

function getPlanAbsolutePath(cwd: string): string {
  return normalizePathFromCwd(cwd, PLAN_PATH);
}

function getResearchAbsolutePath(cwd: string): string {
  return normalizePathFromCwd(cwd, RESEARCH_PATH);
}

function getStateAbsolutePath(cwd: string): string {
  return normalizePathFromCwd(cwd, STATE_PATH);
}

function isDocumentPath(cwd: string, path: string): boolean {
  const normalized = normalizePathFromCwd(cwd, path);
  return (
    normalized === getPlanAbsolutePath(cwd) ||
    normalized === getResearchAbsolutePath(cwd)
  );
}

function areAllTargetsDocumentPaths(cwd: string, targets: string[]): boolean {
  if (targets.length === 0) {
    return false;
  }
  return targets.every((target) => isDocumentPath(cwd, target));
}

function readWorkflowState(cwd: string): WorkflowState | null {
  const statePath = getStateAbsolutePath(cwd);
  if (!existsSync(statePath)) {
    return null;
  }

  try {
    const content = readFileSync(statePath, "utf-8");
    const parsed = JSON.parse(content) as WorkflowState;
    return parsed;
  } catch {
    return null;
  }
}

function isWorkflowActive(cwd: string, state: WorkflowState | null): boolean {
  if (state?.mode === "document-workflow") {
    return true;
  }
  return existsSync(getPlanAbsolutePath(cwd)) || existsSync(getResearchAbsolutePath(cwd));
}

function hasApprovedPlan(cwd: string, state: WorkflowState | null): boolean {
  if (state?.approved === true) {
    return true;
  }

  const planPath = getPlanAbsolutePath(cwd);
  if (!existsSync(planPath)) {
    return false;
  }

  try {
    const content = readFileSync(planPath, "utf-8");
    return APPROVAL_REGEX.test(content);
  } catch {
    return false;
  }
}

function hasResearchArtifact(cwd: string): boolean {
  return existsSync(getResearchAbsolutePath(cwd));
}

function getTargetFilePath(tool_name: string, tool_input: unknown): string | null {
  if (!isRecord(tool_input)) {
    return null;
  }

  if (
    (tool_name === "Write" ||
      tool_name === "Edit" ||
      tool_name === "MultiEdit") &&
    typeof tool_input.file_path === "string"
  ) {
    return tool_input.file_path;
  }

  if (tool_name === "NotebookEdit" && typeof tool_input.notebook_path === "string") {
    return tool_input.notebook_path;
  }

  return null;
}

async function analyzeBashWrite(command: string): Promise<WriteAnalysis> {
  const result = await extractCommandsStructured(command);
  const commands = result.individualCommands;

  const targets: string[] = [];
  let isWriteLike = false;

  for (const cmd of commands) {
    const analysis = analyzeSingleCommand(cmd);
    if (analysis.isWriteLike) {
      isWriteLike = true;
      targets.push(...analysis.targets);
    }
  }

  return {
    isWriteLike,
    targets: dedupe(targets),
  };
}

function analyzeSingleCommand(command: string): WriteAnalysis {
  const words = splitShellWords(command);
  if (words.length === 0) {
    return { isWriteLike: false, targets: [] };
  }

  const redirectionTargets = extractRedirectionTargets(words);
  const main = extractMainCommand(words);
  if (!main) {
    if (redirectionTargets.length > 0) {
      return { isWriteLike: true, targets: redirectionTargets };
    }
    return { isWriteLike: false, targets: [] };
  }

  const { name, args } = main;
  const lower = name.toLowerCase();
  const commandTargets: string[] = [];
  let isWriteLike = redirectionTargets.length > 0;

  if (lower === "tee") {
    const files = args.filter((arg) => !arg.startsWith("-"));
    if (files.length > 0) {
      isWriteLike = true;
      commandTargets.push(...files);
    }
  } else if (["touch", "mkdir", "rm", "rmdir", "truncate"].includes(lower)) {
    const files = args.filter((arg) => !arg.startsWith("-"));
    if (files.length > 0) {
      isWriteLike = true;
      commandTargets.push(...files);
    }
  } else if (["cp", "mv", "install"].includes(lower)) {
    const positional = args.filter((arg) => !arg.startsWith("-"));
    if (positional.length >= 2) {
      isWriteLike = true;
      commandTargets.push(positional[positional.length - 1] || "");
    }
  } else if (lower === "sed" || lower === "perl") {
    if (args.some((arg) => arg === "-i" || arg.startsWith("-i"))) {
      const positional = args.filter((arg) => !arg.startsWith("-"));
      const last = positional[positional.length - 1];
      if (last) {
        isWriteLike = true;
        commandTargets.push(last);
      }
    }
  }

  if (!isWriteLike) {
    return { isWriteLike: false, targets: [] };
  }

  return {
    isWriteLike: true,
    targets: dedupe([...redirectionTargets, ...commandTargets]).filter(
      (target) => target.length > 0,
    ),
  };
}

function extractMainCommand(words: string[]): { name: string; args: string[] } | null {
  let index = 0;
  while (index < words.length) {
    const token = words[index];
    if (!token) {
      index += 1;
      continue;
    }
    if (isVariableAssignment(token)) {
      index += 1;
      continue;
    }
    return {
      name: token,
      args: words.slice(index + 1),
    };
  }
  return null;
}

function isVariableAssignment(token: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*=/.test(token);
}

function extractRedirectionTargets(words: string[]): string[] {
  const targets: string[] = [];

  for (let i = 0; i < words.length; i++) {
    const token = words[i];
    if (!token) {
      continue;
    }

    if (isRedirectionToken(token)) {
      const next = words[i + 1];
      if (next && !next.startsWith("&")) {
        targets.push(next);
      }
      continue;
    }

    const inline = token.match(/^(?:\d*>>?|\d*>\|)(.+)$/);
    if (inline?.[1] && !inline[1].startsWith("&")) {
      targets.push(inline[1]);
    }
  }

  return targets;
}

function isRedirectionToken(token: string): boolean {
  return /^(?:\d*>>?|\d*>\|)$/.test(token);
}

function splitShellWords(command: string): string[] {
  const matches = command.match(/"[^"]*"|'[^']*'|\S+/g) || [];
  return matches.map((word) => stripQuotes(word));
}

function stripQuotes(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}

export default hook;

if (import.meta.main) {
  const { runHook } = await import("cc-hooks-ts");
  await runHook(hook);
}
