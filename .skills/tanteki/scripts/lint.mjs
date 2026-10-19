#!/usr/bin/env node
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { TextlintKernelDescriptor } from "@textlint/kernel";
import { moduleInterop } from "@textlint/module-interop";
import { createLinter, loadLinterFormatter } from "textlint";
import markdownPlugin from "@textlint/textlint-plugin-markdown";
import textPlugin from "@textlint/textlint-plugin-text";
import presetJapanese from "textlint-rule-preset-japanese";
import noAiJargon from "../rules/no-ai-jargon.mjs";
import noOpaqueCompound from "../rules/no-opaque-compound.mjs";
import noVagueAction from "../rules/no-vague-action.mjs";
import stockBoundary from "../rules/stock-boundary.mjs";
import tableCellLength from "../rules/table-cell-length.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const configPath = resolve(root, ".textlintrc.json");
const types = new Set(["design-doc", "prd", "adr", "rfc", "stock", "flow", "record"]);
const stockTypes = new Set(["design-doc", "prd", "adr", "rfc", "stock"]);
const customRules = {
  "no-ai-jargon": noAiJargon,
  "no-opaque-compound": noOpaqueCompound,
  "no-vague-action": noVagueAction,
  "stock-boundary": stockBoundary,
  "table-cell-length": tableCellLength
};

function settingOptions(setting) {
  return setting && typeof setting === "object" && !Array.isArray(setting) ? setting : {};
}

export function readSkillConfig() {
  return JSON.parse(readFileSync(configPath, "utf8"));
}

export function parseArguments(args) {
  let type;
  let format = "pretty-error";
  const files = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--type" || arg === "--format") {
      const value = args[++index];
      if (!value || value.startsWith("--")) throw new Error(`${arg} の値を指定してください。`);
      if (arg === "--type") type = value;
      else format = value;
    } else if (arg.startsWith("--")) {
      throw new Error(`不明なオプション: ${arg}`);
    } else {
      files.push(arg);
    }
  }
  if (!type || !types.has(type)) throw new Error("--type は design-doc|prd|adr|rfc|stock|flow|record のいずれかを指定してください。");
  if (format !== "pretty-error" && format !== "json") throw new Error("--format は pretty-error または json を指定してください。");
  if (files.length === 0) throw new Error("入力ファイルを1つ以上指定してください。");
  return { type, format, files };
}

export function resolveInputFiles(files, cwd = process.cwd()) {
  return files.map((file) => {
    const path = resolve(cwd, file);
    if (!existsSync(path)) throw new Error(`入力ファイルがありません: ${file}`);
    if (statSync(path).isDirectory()) throw new Error(`入力ファイルではありません: ${file}`);
    if (extname(path) !== ".md") throw new Error(`未対応の拡張子です: ${file}（.md を指定してください）`);
    return path;
  });
}

export async function createDescriptor(type, config = readSkillConfig()) {
  const rulesConfig = config.rules ?? {};
  const rules = [];
  if (rulesConfig["preset-japanese"] !== false) {
    for (const [ruleId, rule] of Object.entries(presetJapanese.rules)) {
      const override = settingOptions(rulesConfig["preset-japanese"])[ruleId];
      if (override === false) continue;
      rules.push({ ruleId, rule: moduleInterop(rule), options: override ?? presetJapanese.rulesConfig[ruleId] });
    }
  }
  for (const [ruleId, rule] of Object.entries(customRules)) {
    if (ruleId === "stock-boundary" && !stockTypes.has(type)) continue;
    const setting = rulesConfig[ruleId];
    if (setting === false) continue;
    rules.push({ ruleId, rule: moduleInterop(rule), options: settingOptions(setting) });
  }
  return new TextlintKernelDescriptor({
    rules,
    filterRules: [],
    plugins: [
      { pluginId: "@textlint/textlint-plugin-text", plugin: moduleInterop(textPlugin), options: true },
      { pluginId: "@textlint/textlint-plugin-markdown", plugin: moduleInterop(markdownPlugin), options: true }
    ],
    configBaseDir: root
  });
}

export async function lintFiles(type, files, config) {
  const descriptor = await createDescriptor(type, config);
  return createLinter({ descriptor }).lintFiles(files);
}

export async function run(args, { cwd = process.cwd(), write = console.log, error = console.error } = {}) {
  try {
    const { type, format, files } = parseArguments(args);
    const results = await lintFiles(type, resolveInputFiles(files, cwd));
    const formatter = await loadLinterFormatter({ formatterName: format });
    const output = formatter.format(results);
    if (output) write(output);
    return results.some((result) => result.messages.length > 0) ? 1 : 0;
  } catch (caught) {
    error(caught instanceof Error ? caught.message : String(caught));
    return 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await run(process.argv.slice(2));
}
