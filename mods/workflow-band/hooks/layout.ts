import type { WorkflowFailure, WorkflowSnapshot } from "../types";
import {
  arePlansReady,
  isComplete,
  isIdle,
  planNumber,
  shortName,
  truncate,
} from "./parse";

export type Segment = {
  text: string;
  color?: "cyan" | "green" | "red" | "yellow";
  bold?: boolean;
  dim?: boolean;
};

/**
 * The band as rows of styled text, or null when it has nothing to draw.
 * Free of the engine on purpose: the session turns these rows into components
 * and `preview.ts` into ANSI, so the two cannot show different things.
 */
export function layoutBand(
  current: WorkflowSnapshot | WorkflowFailure | null,
  { columns, maxRows }: { columns: number; maxRows: number },
): Segment[][] | null {
  if (current === null) return null;
  if ("error" in current) {
    return [[{ text: truncate(`WF ${current.error}`, columns), color: "red" }]];
  }
  if (isIdle(current)) return null;

  // With every condition met the checklist collapses to one mark. In
  // two-layer mode a green spec.md does not mean writes are allowed, so
  // the plan-N.md side is drawn next to it and `Next:` stays until those
  // clear too. A warning always gets its line.
  const complete = isComplete(current);
  const plansReady = arePlansReady(current);
  const settled = complete && (!current.twoLayer || plansReady);

  const first: Segment[] = [
    { text: "WF ", color: "cyan", bold: true },
    { text: `${current.doc} ` },
  ];
  if (current.source === "env") {
    first.push({ text: "[pinned] ", color: "yellow" });
  }
  if (complete) {
    first.push({ text: "✓ ", color: "green" });
  } else {
    for (const check of current.checks) {
      first.push({
        text: `${check.ok ? "✓" : "✗"}${shortName(check.name)} `,
        color: check.ok ? "green" : "red",
      });
    }
  }
  if (current.twoLayer) {
    first.push({ text: "· plan ", dim: true });
    if (current.plans.length === 0) {
      first.push({ text: "none yet", dim: true });
    } else if (plansReady) {
      first.push({ text: `✓${current.plans.length}`, color: "green" });
    } else {
      for (const plan of current.plans) {
        first.push({
          text: `${planNumber(plan.name)}${plan.blockedBy ? `✗${shortName(plan.blockedBy)}` : "✓"} `,
          color: plan.blockedBy ? "red" : "green",
        });
      }
    }
  }

  const rows = [first];
  if (maxRows >= 2) {
    if (current.warning) {
      rows.push([
        { text: truncate(`⚠ ${current.warning}`, columns), color: "yellow" },
      ]);
    } else if (current.next && !settled) {
      rows.push([
        { text: truncate(`Next: ${current.next}`, columns), dim: true },
      ]);
    }
  }
  return rows;
}
