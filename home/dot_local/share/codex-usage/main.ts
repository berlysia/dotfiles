#!/usr/bin/env bun
/**
 * Start `codex app-server` over stdio, read account usage, print JSON, exit.
 *
 * Default: account/rateLimits/read (5h / weekly windows, plan, credits).
 * --usage: also account/usage/read (token activity summary + daily buckets).
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";

const CLIENT_INFO = {
  name: "codex_usage_cli",
  title: "Codex Usage CLI",
  version: "0.1.0",
} as const;

type JsonRpcSuccess = { id: number; result: unknown };
type JsonRpcError = {
  id: number;
  error: { code?: number; message?: string; data?: unknown };
};
type JsonRpcMessage = JsonRpcSuccess | JsonRpcError | { method?: string };

type CliOptions = {
  includeTokenUsage: boolean;
  timeoutMs: number;
  verbose: boolean;
  help: boolean;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function printHelp(): void {
  process.stdout.write(`Usage: codex-usage [options]

Start Codex app-server over stdio, fetch account usage, print JSON, exit.

Options:
  --usage              Also fetch account/usage/read (token activity)
  --timeout <seconds>  Per-RPC and startup timeout (default: 20)
  --verbose            Keep app-server stderr
  -h, --help           Show this help

Output (stdout): JSON with fetchedAt plus account/rateLimits/read fields
(and tokenUsage when --usage is set). Errors on stderr; exit 0 on success.
`);
}

function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = {
    includeTokenUsage: false,
    timeoutMs: 20_000,
    verbose: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) continue;
    if (arg === "-h" || arg === "--help") {
      opts.help = true;
    } else if (arg === "--usage") {
      opts.includeTokenUsage = true;
    } else if (arg === "--verbose") {
      opts.verbose = true;
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
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return opts;
}

class CodexAppServerClient {
  private child: ChildProcessWithoutNullStreams | undefined;
  private nextId = 1;
  private readonly pending = new Map<
    number,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
    }
  >();
  private exitError: Error | undefined;
  private readonly timeoutMs: number;
  private readonly verbose: boolean;

  constructor(timeoutMs: number, verbose: boolean) {
    this.timeoutMs = timeoutMs;
    this.verbose = verbose;
  }

  async start(): Promise<void> {
    const child = spawn("codex", ["app-server", "--listen", "stdio://"], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;

    await new Promise<void>((resolve, reject) => {
      const startupTimeout = setTimeout(() => {
        reject(
          new Error(
            `Timed out after ${Math.round(this.timeoutMs / 1000)}s starting codex app-server.`,
          ),
        );
      }, this.timeoutMs);

      child.once("spawn", () => {
        clearTimeout(startupTimeout);
        resolve();
      });
      child.once("error", (error) => {
        clearTimeout(startupTimeout);
        reject(new Error(`Failed to start codex app-server: ${error.message}`));
      });
    });

    child.once("exit", (code, signal) => {
      this.exitError = new Error(
        `codex app-server exited before completing the request (code ${code ?? "unknown"}, signal ${signal ?? "none"}).`,
      );
      this.rejectAll(this.exitError);
    });

    if (this.verbose) {
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => {
        process.stderr.write(chunk);
      });
    } else {
      child.stderr.resume();
    }

    const lines = createInterface({ input: child.stdout });
    lines.on("line", (line) => this.handleLine(line));
  }

  private handleLine(line: string): void {
    let message: JsonRpcMessage;
    try {
      message = JSON.parse(line) as JsonRpcMessage;
    } catch {
      return;
    }
    if (!("id" in message) || message.id == null) return;
    const id = Number(message.id);
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    if ("error" in message && message.error) {
      pending.reject(
        new Error(
          message.error.message ??
            `codex app-server error ${message.error.code ?? "unknown"}`,
        ),
      );
      return;
    }
    if ("result" in message) {
      pending.resolve(message.result);
      return;
    }
    pending.reject(new Error(`Unexpected app-server response for id ${id}`));
  }

  private rejectAll(error: Error): void {
    for (const [, pending] of this.pending) {
      pending.reject(error);
    }
    this.pending.clear();
  }

  request(method: string, params?: unknown): Promise<unknown> {
    const child = this.child;
    if (!child?.stdin.writable) {
      throw new Error("codex app-server is not running.");
    }
    if (this.exitError) throw this.exitError;

    const id = this.nextId++;
    const payload =
      params === undefined ? { method, id } : { method, id, params };

    const response = new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new Error(
            `Timed out after ${Math.round(this.timeoutMs / 1000)}s waiting for ${method}.`,
          ),
        );
      }, this.timeoutMs);

      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timeout);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timeout);
          reject(error);
        },
      });
    });

    child.stdin.write(`${JSON.stringify(payload)}\n`);
    return response;
  }

  notify(method: string, params: Record<string, unknown> = {}): void {
    const child = this.child;
    if (!child?.stdin.writable) return;
    child.stdin.write(`${JSON.stringify({ method, params })}\n`);
  }

  dispose(): void {
    for (const [id, pending] of this.pending) {
      pending.reject(new Error(`codex app-server request ${id} cancelled.`));
      this.pending.delete(id);
    }
    const child = this.child;
    if (!child) return;
    this.child = undefined;
    try {
      child.stdin.end();
    } catch {
      // ignore
    }
    child.kill("SIGKILL");
  }
}

async function fetchUsage(opts: CliOptions): Promise<Record<string, unknown>> {
  const client = new CodexAppServerClient(opts.timeoutMs, opts.verbose);
  try {
    await client.start();
    await client.request("initialize", {
      clientInfo: CLIENT_INFO,
      capabilities: {
        experimentalApi: false,
        requestAttestation: false,
        optOutNotificationMethods: [],
      },
    });
    client.notify("initialized");

    const rateLimits = await client.request("account/rateLimits/read");
    const out: Record<string, unknown> = {
      fetchedAt: new Date().toISOString(),
      ...(isRecord(rateLimits) ? rateLimits : { rateLimits }),
    };

    if (opts.includeTokenUsage) {
      out.tokenUsage = await client.request("account/usage/read");
    }
    return out;
  } finally {
    client.dispose();
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

  try {
    const payload = await fetchUsage(opts);
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(
      `codex-usage: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}

await main();
