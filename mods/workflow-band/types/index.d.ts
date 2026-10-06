export type GateCheck = {
  /** The condition's name as workflow-cli prints it, e.g. `Review Status`. */
  name: string;
  ok: boolean;
  /** The parenthesised `found: ...; expected: ...` text of a failing check. */
  detail?: string;
};

export type PlanState = {
  /** `plan-N.md`. */
  name: string;
  /** The first condition the plan does not meet, as workflow-cli names it; absent when it clears. */
  blockedBy?: string;
};

/** Where workflow-cli took the workflow dir from (`workflow-cli dir`'s `source=`). */
export type WfDirSource = "derived" | "env" | "override" | "unknown";

export type WorkflowSnapshot = {
  /** `plan.md`, or `spec.md` in two-layer mode. */
  doc: string;
  twoLayer: boolean;
  checks: GateCheck[];
  /** Two-layer mode: every plan-N.md in number order. Empty in single-layer mode. */
  plans: PlanState[];
  note?: string;
  next?: string;
  tripwire?: string;
  wfDir?: string;
  source: WfDirSource;
  /** What workflow-cli wrote to stderr, such as a rejected DOCUMENT_WORKFLOW_DIR pin. */
  warning?: string;
};

/** workflow-cli could not be read; drawn instead of hidden so the cause is visible. */
export type WorkflowFailure = { error: string };

declare module "claude-code" {
  interface PluginState {
    "workflow-band": { snapshot: WorkflowSnapshot | WorkflowFailure | null };
  }
}
