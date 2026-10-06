import type {
  GateCheck,
  PlanState,
  WfDirSource,
  WorkflowSnapshot,
} from "../types";

// The text formats come from workflow-gate.ts `formatGateChecklist` and
// cli/workflow.ts `cmdStatus` / `cmdDir`. Lines this parser does not know are
// skipped, so a new line in the CLI's output degrades to "not shown".
const HEADER =
  /^Document workflow gate( \(two-layer\))?: conditions on `([^`]+)`:/;
const CHECK = /^\s+([✓✗]) (.+?)(?: \((.*)\))?$/;
const PLAN = /^plan: (plan-[0-9]+\.md) (?:✓|✗ (.+))$/;

export function parseStatus(
  stdout: string,
): Omit<WorkflowSnapshot, "source" | "wfDir" | "warning"> | null {
  let doc: string | undefined;
  let twoLayer = false;
  const checks: GateCheck[] = [];
  const plans: PlanState[] = [];
  let note: string | undefined;
  let next: string | undefined;
  let tripwire: string | undefined;

  for (const line of stdout.split("\n")) {
    const header = HEADER.exec(line);
    if (header) {
      twoLayer = header[1] !== undefined;
      doc = header[2];
      continue;
    }
    const check = CHECK.exec(line);
    if (check?.[2]) {
      checks.push({
        name: check[2],
        ok: check[1] === "✓",
        ...(check[3] ? { detail: check[3] } : {}),
      });
      continue;
    }
    const plan = PLAN.exec(line);
    if (plan?.[1]) {
      plans.push({
        name: plan[1],
        ...(plan[2] ? { blockedBy: plan[2] } : {}),
      });
      continue;
    }
    if (line.startsWith("  note: ")) note = line.slice("  note: ".length);
    else if (line.startsWith("Next: ")) next = line.slice("Next: ".length);
    else if (line.startsWith("tripwire: "))
      tripwire = line.slice("tripwire: ".length);
  }

  if (doc === undefined || checks.length === 0) return null;
  return { doc, twoLayer, checks, plans, note, next, tripwire };
}

export function parseDir(stdout: string): {
  wfDir?: string;
  source: WfDirSource;
} {
  const wfDir = /^wfDir=(.*)$/m.exec(stdout)?.[1];
  const raw = /^source=(.*)$/m.exec(stdout)?.[1];
  const source: WfDirSource =
    raw === "derived" || raw === "env" || raw === "override" ? raw : "unknown";
  return { wfDir, source };
}

/** Nothing has been written into the workflow dir yet: the band has nothing to say. */
export function isIdle(snapshot: WorkflowSnapshot): boolean {
  return snapshot.checks.every((check) => !check.ok);
}

/** Every condition holds: the individual checks no longer tell the reader anything. */
export function isComplete(snapshot: WorkflowSnapshot): boolean {
  return snapshot.checks.every((check) => check.ok);
}

/** Two-layer mode with at least one plan-N.md, none of them held back. */
export function arePlansReady(snapshot: WorkflowSnapshot): boolean {
  return (
    snapshot.plans.length > 0 && snapshot.plans.every((plan) => !plan.blockedBy)
  );
}

/** `plan-12.md` → `12`, the label a plan gets in the band. */
export function planNumber(name: string): string {
  return /^plan-([0-9]+)\.md$/.exec(name)?.[1] ?? name;
}

const SHORT_NAMES: Record<string, string> = {
  "parent-spec-hash": "parent",
  "research.md": "research",
  "Plan Status": "plan",
  "Review Status": "review",
  "Approval Status": "approval",
  "marker verdict": "verdict",
  "hash match": "hash",
  approval: "ledger",
};

export function shortName(name: string): string {
  return SHORT_NAMES[name] ?? name;
}

export function truncate(text: string, columns: number): string {
  if (columns <= 1) return "";
  return text.length <= columns ? text : `${text.slice(0, columns - 1)}…`;
}
