import { runModelChild } from "../model-host.mjs";

// Parent side of kind "enumerate": run(check, ctx) -> envelope.
export function run(check, ctx) {
  return runModelChild({
    kind: "enumerate",
    model: check.model.abs,
    imports: check.imports.map((file) => file.abs),
    timeoutMs: ctx.timeoutMs,
  });
}
