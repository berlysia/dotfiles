#!/usr/bin/env bun
/**
 * Unified usage CLI for Claude / Codex / Cursor / OpenCode (Z.ai Coding Plan).
 *
 *   ai-usage                 fetch every provider (partial failures OK)
 *   ai-usage claude|codex|cursor|opencode
 *   claude-usage|codex-usage|…  thin wrappers that pin the provider
 */

import { type FetchOpts } from "./lib.ts";
import { fetchClaudeUsage } from "./providers/claude.ts";
import { fetchCodexUsage } from "./providers/codex.ts";
import { fetchCursorUsage } from "./providers/cursor.ts";
import { fetchOpencodeUsage } from "./providers/opencode.ts";

export const PROVIDERS = ["claude", "codex", "cursor", "opencode"] as const;
export type ProviderId = (typeof PROVIDERS)[number];

type CliOptions = FetchOpts & {
  help: boolean;
  providers: ProviderId[] | "all";
};

const FETCHERS: Record<
  ProviderId,
  (opts: FetchOpts) => Promise<Record<string, unknown>>
> = {
  claude: fetchClaudeUsage,
  codex: fetchCodexUsage,
  cursor: fetchCursorUsage,
  opencode: fetchOpencodeUsage,
};

function printHelp(): void {
  process.stdout.write(`Usage: ai-usage [provider...] [options]

Fetch account usage JSON for Claude, Codex, Cursor, and/or OpenCode.

Providers (default: all):
  claude     Anthropic OAuth /usage (5h + weekly)
  codex      Codex app-server account/rateLimits/read
  cursor     Cursor DashboardService period usage
  opencode   Z.ai Coding Plan quota (via OpenCode auth)

Options:
  --details            Codex: also token activity; OpenCode: also 24h model/tool
  --timeout <seconds>  Per-request timeout (default: 20)
  --verbose            Codex: keep app-server stderr
  --auth-file <path>   Override credentials path for the selected provider
  -h, --help           Show this help

When one provider is selected, stdout is that provider's payload.
When several (or all) are selected, stdout is:
  { "fetchedAt", "providers": { "<id>": { "ok": true, "data": ... }
                              | { "ok": false, "error": "..." } } }
Exit 0 if every selected provider succeeds; 1 if any fail; 2 on bad args.
`);
}

function isProviderId(value: string): value is ProviderId {
  return (PROVIDERS as readonly string[]).includes(value);
}

function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = {
    timeoutMs: 20_000,
    verbose: false,
    details: false,
    help: false,
    providers: "all",
  };
  const selected: ProviderId[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) continue;
    if (arg === "-h" || arg === "--help") {
      opts.help = true;
    } else if (arg === "--details" || arg === "--usage") {
      // --usage kept as alias for former codex-usage flag
      opts.details = true;
    } else if (arg === "--verbose") {
      opts.verbose = true;
    } else if (arg === "--auth-file") {
      const path = argv[++i];
      if (!path) throw new Error("--auth-file needs a path");
      opts.authFile = path;
    } else if (arg.startsWith("--auth-file=")) {
      opts.authFile = arg.slice("--auth-file=".length);
    } else if (arg === "--timeout") {
      const raw = argv[++i];
      const seconds = Number(raw);
      if (!Number.isFinite(seconds) || seconds <= 0) {
        throw new Error(
          `--timeout needs a positive number of seconds, got ${raw}`,
        );
      }
      opts.timeoutMs = Math.round(seconds * 1000);
    } else if (arg.startsWith("--timeout=")) {
      const seconds = Number(arg.slice("--timeout=".length));
      if (!Number.isFinite(seconds) || seconds <= 0) {
        throw new Error(
          `--timeout needs a positive number of seconds, got ${arg}`,
        );
      }
      opts.timeoutMs = Math.round(seconds * 1000);
    } else if (arg === "all") {
      opts.providers = "all";
    } else if (isProviderId(arg)) {
      selected.push(arg);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }

  if (selected.length > 0) opts.providers = selected;
  return opts;
}

async function fetchOne(
  id: ProviderId,
  opts: FetchOpts,
): Promise<
  | { provider: ProviderId; ok: true; data: Record<string, unknown> }
  | { provider: ProviderId; ok: false; error: string }
> {
  try {
    const data = await FETCHERS[id](opts);
    return { provider: id, ok: true, data };
  } catch (error) {
    return {
      provider: id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function main(): Promise<void> {
  let opts: CliOptions;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 2;
    return;
  }

  if (opts.help) {
    printHelp();
    return;
  }

  const ids: ProviderId[] =
    opts.providers === "all" ? [...PROVIDERS] : opts.providers;
  const fetchOpts: FetchOpts = {
    timeoutMs: opts.timeoutMs,
    verbose: opts.verbose,
    details: opts.details,
    ...(opts.authFile !== undefined ? { authFile: opts.authFile } : {}),
  };

  const results = await Promise.all(ids.map((id) => fetchOne(id, fetchOpts)));

  if (ids.length === 1) {
    const only = results[0];
    if (!only) {
      process.exitCode = 1;
      return;
    }
    if (!only.ok) {
      process.stderr.write(`ai-usage: ${only.provider}: ${only.error}\n`);
      process.exitCode = 1;
      return;
    }
    process.stdout.write(`${JSON.stringify(only.data, null, 2)}\n`);
    return;
  }

  const providers: Record<string, unknown> = {};
  let anyFail = false;
  for (const result of results) {
    if (result.ok) {
      providers[result.provider] = { ok: true, data: result.data };
    } else {
      anyFail = true;
      providers[result.provider] = { ok: false, error: result.error };
      process.stderr.write(`ai-usage: ${result.provider}: ${result.error}\n`);
    }
  }

  process.stdout.write(
    `${JSON.stringify({ fetchedAt: new Date().toISOString(), providers }, null, 2)}\n`,
  );
  if (anyFail) process.exitCode = 1;
}

await main();
