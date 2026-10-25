// The one place that starts child processes. Policy lives here rather than in
// each adapter: argument arrays only (no shell), a fresh process group so a
// timeout can kill grandchildren too, output caps, and a minimal environment.
import { spawn } from "node:child_process";
import { RUN } from "./codes.mjs";

const STDOUT_LIMIT_BYTES = 1024 * 1024;
const STDERR_LIMIT_BYTES = 64 * 1024;
// A grandchild that kept the pipes open must not make us wait forever once the
// child itself has exited and its group has been killed.
const STREAM_CLOSE_WAIT_MS = 500;

const BASE_ENV = ["PATH", "LANG"];
// Callers may add only these (TLC's launcher needs JAVA_HOME). A name outside
// the list is ignored, so a caller cannot widen what the model sees.
const EXTRA_ENV_ALLOWED = ["JAVA_HOME"];

const live = new Set();
let shuttingDown = false;

const failure = (code, message) => ({ ok: false, error: { code, message } });

export function buildEnv(extraEnv = {}, parentEnv = process.env) {
  const env = {};
  for (const name of BASE_ENV)
    if (parentEnv[name] !== undefined) env[name] = parentEnv[name];
  for (const name of EXTRA_ENV_ALLOWED) {
    if (extraEnv[name] !== undefined) env[name] = extraEnv[name];
  }
  return env;
}

function killGroup(child) {
  try {
    // Negative pid: the whole group the (detached) child leads.
    process.kill(-child.pid, "SIGKILL");
  } catch {
    // already gone
  }
}

// Kills every live child's group. Failures are ignored on purpose: all of them
// must be tried even if one is already dead.
export function killAllChildren() {
  for (const child of live) killGroup(child);
}

// For signal handlers: also refuses children spawned after this point, so work
// racing with the cleanup cannot leave a process behind.
export function shutdown() {
  shuttingDown = true;
  killAllChildren();
}

// Resolves with {ok: true, exitCode, signal, stdout, stderr} when the child
// ran to an exit, or {ok: false, error} for timeout, oversized stdout and
// spawn failure. A non-zero exit is not an error here: TLC's exit codes carry
// meaning, so the caller decides.
export function runChild({ command, args, extraEnv, timeoutMs, cwd, onSpawn }) {
  return new Promise((resolve) => {
    if (shuttingDown) {
      resolve(
        failure(
          RUN.INTERRUPTED,
          "the harness is shutting down; the child was not started",
        ),
      );
      return;
    }
    let child;
    try {
      child = spawn(command, args, {
        cwd,
        env: buildEnv(extraEnv),
        stdio: ["ignore", "pipe", "pipe"],
        detached: true,
      });
    } catch (error) {
      resolve(
        failure(
          RUN.CHILD_EXIT_NONZERO,
          `cannot start ${command}: ${error.message}`,
        ),
      );
      return;
    }
    live.add(child);
    onSpawn?.(child.pid);

    const out = [];
    const err = [];
    let outBytes = 0;
    let errBytes = 0;
    let tooLarge = false;
    let timedOut = false;
    let settled = false;

    const settle = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      live.delete(child);
      resolve(result);
    };

    const closed = Promise.all(
      [child.stdout, child.stderr].map(
        (stream) => new Promise((done) => stream.once("close", done)),
      ),
    );
    child.stdout.on("data", (chunk) => {
      if (tooLarge) return;
      outBytes += chunk.length;
      if (outBytes > STDOUT_LIMIT_BYTES) {
        tooLarge = true;
        killGroup(child);
        return;
      }
      out.push(chunk);
    });
    child.stderr.on("data", (chunk) => {
      if (errBytes >= STDERR_LIMIT_BYTES) return;
      err.push(chunk.subarray(0, STDERR_LIMIT_BYTES - errBytes));
      errBytes += chunk.length;
    });

    const timer = setTimeout(() => {
      timedOut = true;
      killGroup(child);
    }, timeoutMs);

    child.once("error", (error) => {
      settle(
        failure(
          RUN.CHILD_EXIT_NONZERO,
          `cannot start ${command}: ${error.message}`,
        ),
      );
    });
    child.once("exit", async (exitCode, signal) => {
      // The child is gone; whatever is left in its group is not ours to keep.
      killGroup(child);
      await Promise.race([
        closed,
        new Promise((r) => setTimeout(r, STREAM_CLOSE_WAIT_MS)),
      ]);
      child.stdout.destroy();
      child.stderr.destroy();
      if (timedOut)
        settle(failure(RUN.TIMEOUT, `timed out after ${timeoutMs} ms`));
      else if (tooLarge) {
        settle(
          failure(
            RUN.CHILD_OUTPUT_TOO_LARGE,
            `stdout exceeded ${STDOUT_LIMIT_BYTES} bytes`,
          ),
        );
      } else {
        settle({
          ok: true,
          exitCode,
          signal,
          stdout: Buffer.concat(out).toString("utf8"),
          stderr: Buffer.concat(err).toString("utf8"),
        });
      }
    });
  });
}
