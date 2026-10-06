// What `preview.ts` prints: sample workflow-cli output for each state the band
// can be in, and the band's rows as terminal lines. Kept apart from the entry
// point because a file the Mod's tests load may import only its own files.
import { layoutBand } from "./hooks/layout";
import type { Segment } from "./hooks/layout";
import { toSnapshot } from "./hooks/parse";

const CONDITIONS = [
  "research.md",
  "Plan Status",
  "Review Status",
  "Approval Status",
  "marker verdict",
  "hash match",
  "approval",
];

/** `workflow-cli status` text with the named conditions unmet and the rest met. */
function statusText(options: {
  doc: "plan.md" | "spec.md";
  unmet?: string[];
  next: string;
  plans?: string[];
}): string {
  const unmet = options.unmet ?? [];
  return [
    `Document workflow gate${options.doc === "spec.md" ? " (two-layer)" : ""}: conditions on \`${options.doc}\`:`,
    ...CONDITIONS.map((name) =>
      unmet.includes(name)
        ? `  ✗ ${name} (missing; expected: ...)`
        : `  ✓ ${name}`,
    ),
    `Next: ${options.next}`,
    ...(options.plans ?? []).map((plan) => `plan: ${plan}`),
    "tripwire: armed",
    "",
  ].join("\n");
}

const DERIVED = "wfDir=/work/proj/.tmp/sessions/1ec067a4\nsource=derived\n";
const SATISFIED = "The gate conditions are satisfied.";
const APPROVE_PLAN = "approve plan-N.md (the plan that lists the target).";

/** One finished workflow-cli invocation. */
export type CliRun = { exitCode: number; stdout: string; stderr: string };

type Sample = {
  title: string;
  status: CliRun;
  dir?: string;
};

function sample(
  title: string,
  stdout: string,
  rest: { stderr?: string; dir?: string } = {},
): Sample {
  return {
    title,
    status: { exitCode: 0, stdout, stderr: rest.stderr ?? "" },
    ...(rest.dir ? { dir: rest.dir } : {}),
  };
}

export const SAMPLES: Sample[] = [
  sample(
    "nothing written yet",
    statusText({
      doc: "plan.md",
      unmet: CONDITIONS,
      next: "Write research.md.",
    }),
  ),
  sample(
    "in review",
    statusText({
      doc: "plan.md",
      unmet: ["Review Status", "Approval Status", "marker verdict", "approval"],
      next: "Re-run the non-pass reviewers.",
    }),
  ),
  sample(
    "every condition met",
    statusText({ doc: "plan.md", next: SATISFIED }),
  ),
  sample(
    "every condition met, pinned workflow dir",
    statusText({ doc: "plan.md", next: SATISFIED }),
    { dir: "wfDir=/work/proj/.tmp/sessions/old12345\nsource=env\n" },
  ),
  sample(
    "two-layer: spec.md in review",
    statusText({
      doc: "spec.md",
      unmet: ["Approval Status", "approval"],
      next: "Ask for approval of spec.md.",
    }),
  ),
  sample(
    "two-layer: spec.md met, no plan-N.md yet",
    statusText({ doc: "spec.md", next: APPROVE_PLAN }),
  ),
  sample(
    "two-layer: plans held back",
    statusText({
      doc: "spec.md",
      next: APPROVE_PLAN,
      plans: [
        "plan-1.md ✓",
        "plan-2.md ✗ Review Status",
        "plan-10.md ✗ parent-spec-hash",
      ],
    }),
  ),
  sample(
    "two-layer: every plan met",
    statusText({
      doc: "spec.md",
      next: APPROVE_PLAN,
      plans: ["plan-1.md ✓", "plan-2.md ✓", "plan-10.md ✓"],
    }),
  ),
  sample(
    "workflow-cli warned on stderr",
    statusText({ doc: "plan.md", next: SATISFIED }),
    { stderr: "DOCUMENT_WORKFLOW_DIR points outside the project; ignored." },
  ),
  {
    title: "workflow-cli failed",
    status: {
      exitCode: 1,
      stdout: "",
      stderr: "CLAUDE_PROJECT_DIR is not set",
    },
  },
];

const ANSI_COLOR = { red: 31, green: 32, yellow: 33, cyan: 36 } as const;

function paint(segment: Segment, useColor: boolean): string {
  if (!useColor) return segment.text;
  const codes = [
    ...(segment.bold ? [1] : []),
    ...(segment.dim ? [2] : []),
    ...(segment.color ? [ANSI_COLOR[segment.color]] : []),
  ];
  return codes.length === 0
    ? segment.text
    : `\u001b[${codes.join(";")}m${segment.text}\u001b[0m`;
}

export type RenderOptions = {
  /** Terminal width; the band keeps one column of padding on each side. */
  columns: number;
  useColor: boolean;
};

/** The band for one status/dir pair, as the lines a terminal would show. */
export function renderBand(
  status: CliRun,
  dir: string,
  { columns, useColor }: RenderOptions,
): string[] {
  const rows = layoutBand(toSnapshot(status, { stdout: dir }), {
    columns: columns - 2,
    maxRows: 10,
  });
  if (rows === null) return ["  (nothing drawn)"];
  return rows.map(
    (row) => ` ${row.map((segment) => paint(segment, useColor)).join("")}`,
  );
}

export function renderSamples(options: RenderOptions): string {
  return SAMPLES.flatMap(({ title, status, dir }) => [
    `# ${title}`,
    ...renderBand(status, dir ?? DERIVED, options),
    "",
  ]).join("\n");
}
