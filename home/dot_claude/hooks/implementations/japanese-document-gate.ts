#!/usr/bin/env -S bun run --silent

import { faultOutput, gate } from "../lib/japanese-document-gate/gate.ts";
import {
  gitDocumentCandidates,
  spawnGit,
} from "../lib/japanese-document-gate/discovery.ts";
import { object } from "../lib/japanese-document-gate/shared.ts";
import { readStdinLimited } from "../lib/read-stdin-limited.ts";

if (import.meta.main) {
  let input: unknown;
  try {
    const raw = await readStdinLimited(1024 * 1024, 2000);
    if (raw === null) throw new Error("フック入力を読めませんでした。");
    input = JSON.parse(raw);
    const output = gate(input, {
      candidates: (cwd) => gitDocumentCandidates(cwd, spawnGit),
      now: Date.now,
    });
    if (output) process.stdout.write(`${JSON.stringify(output)}\n`);
    else if (object(input) && input.hook_event_name === "Stop")
      process.stdout.write("{}\n");
  } catch (error) {
    // Never block or deny on a fault; announce it instead (the user can
    // always end the turn).
    const event =
      object(input) && typeof input.hook_event_name === "string"
        ? input.hook_event_name
        : "";
    process.stdout.write(`${JSON.stringify(faultOutput(event, error))}\n`);
  }
}
