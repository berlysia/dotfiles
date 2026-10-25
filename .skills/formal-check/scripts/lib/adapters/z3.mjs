import { runModelChild } from "../model-host.mjs";

// The solver stops itself at this share of the check's timeout, so it can
// report unknown (solver-unknown) before the parent kills the child.
const DEADLINE_SHARE = 0.85;

// The deadline starts at the moment the child is launched, not inside the
// child: node start-up and the WASM initialisation also count against the
// child's timeout.
export function buildExtraArgs({ runtimeDir, timeoutMs, now }) {
  return [
    "--runtime-dir",
    runtimeDir,
    "--deadline",
    String(Math.floor(now + timeoutMs * DEADLINE_SHARE)),
  ];
}

// Parent side of kind "z3": run(check, ctx) -> envelope.
export function run(check, ctx) {
  if (ctx.runtime.dir === null)
    throw new Error("z3 needs a resolved runtime dir");
  return runModelChild({
    kind: "z3",
    model: check.model.abs,
    imports: check.imports.map((file) => file.abs),
    extraArgs: buildExtraArgs({
      runtimeDir: ctx.runtime.dir,
      timeoutMs: ctx.timeoutMs,
      now: Date.now(),
    }),
    timeoutMs: ctx.timeoutMs,
  });
}
