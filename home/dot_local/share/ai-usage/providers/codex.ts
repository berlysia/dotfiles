import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { type FetchOpts, isRecord } from "../lib.ts";

const CLIENT_INFO = {
  name: "ai_usage_cli",
  title: "AI Usage CLI",
  version: "0.1.0",
} as const;

type JsonRpcMessage =
  | { id: number; result: unknown }
  | { id: number; error: { code?: number; message?: string } }
  | { method?: string };

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
    for (const [, pending] of this.pending) pending.reject(error);
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

export async function fetchCodexUsage(
  opts: FetchOpts,
): Promise<Record<string, unknown>> {
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

    if (opts.details) {
      out.tokenUsage = await client.request("account/usage/read");
    }
    return out;
  } finally {
    client.dispose();
  }
}
