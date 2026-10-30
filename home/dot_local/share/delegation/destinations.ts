/**
 * Delegation destinations. Imports types only, so the offload entry point can
 * read the tables without pulling in route.ts.
 */

import type { Effort } from "./schema.ts";

export type DestinationName =
  | "codex-terra"
  | "codex-luna-max"
  | "opencode"
  | "sarashina";
export type Destination = {
  name: DestinationName;
  /** Which ai-usage window the destination draws on. */
  provider: "codex" | "opencode" | "sarashina";
  /** Records counted for the destination: every field given must equal. */
  match: { harness: string; model?: string; effort?: string };
  effortTrials?: readonly Effort[];
  /**
   * Fixed text, including the launch command: never built from records. For a
   * row that sends out it is the read-only form of offloadDisplay; route adds
   * --write per kind.
   */
  display: string;
  /** Extra constraint appended to the display of a row that sends out. */
  displayNote?: string;
  /** Fixed short name for review lines; never built from records. */
  label: string;
  /** Whether the brief and the working tree leave the machine (to Z.ai or Sarashina). */
  sendsOut: boolean;
};

/**
 * The launch text of a row that sends out, built from the table's model so it
 * cannot drift from sendsOutModels(), the set the entry accepts.
 */
export function offloadDisplay(
  d: {
    label: string;
    match: { model?: string };
    displayNote?: string;
  },
  write: boolean,
): string {
  if (d.match.model === undefined) {
    throw new Error(`sendsOut destination without a model: ${d.label}`);
  }
  const note = d.displayNote === undefined ? "" : `、${d.displayNote}`;
  return `${d.label} (delegation offload --exposure external-ok --model ${d.match.model} --brief-file <絶対パス>${write ? " --write" : ""}。シェル無し。テストはメインループで${note})`;
}

export function effortTrialDisplay(
  d: Pick<Destination, "display">,
  effort: Effort,
): string {
  const settings = [...d.display.matchAll(/model_reasoning_effort=/g)];
  if (settings.length !== 1) {
    throw new Error(
      `expected exactly one model_reasoning_effort= setting in ${d.display}`,
    );
  }
  return d.display.replace(/(model_reasoning_effort=)[^ )]*/, `$1${effort}`);
}

const GLM_MODEL = "zai-coding-plan/glm-5.3";
const SARASHINA_MODEL = "sarashina/sarashina3.2-mini-thinking";
const FREE_DEEPSEEK_MODEL = "opencode/deepseek-v4.1-flash-free";
const FREE_GLM_MODEL = "opencode/glm-5.3-flash-free";

export const DESTINATIONS: Record<DestinationName, Destination> = {
  "codex-terra": {
    name: "codex-terra",
    provider: "codex",
    match: { harness: "codex-cli", model: "gpt-6.1-terra", effort: "high" },
    effortTrials: ["medium"],
    display:
      "codex Terra (codex exec -m gpt-6.1-terra -c model_reasoning_effort=high)",
    label: "codex Terra",
    sendsOut: false,
  },
  "codex-luna-max": {
    name: "codex-luna-max",
    provider: "codex",
    match: { harness: "codex-cli", model: "gpt-6-luna", effort: "max" },
    effortTrials: ["xhigh", "high"],
    display:
      "codex Luna max (codex exec -m gpt-6-luna -c model_reasoning_effort=max)",
    label: "codex Luna max",
    sendsOut: false,
  },
  opencode: {
    name: "opencode",
    provider: "opencode",
    // Pinned to GLM so Sarashina's records (same harness) do not count here.
    match: { harness: "opencode", model: GLM_MODEL },
    display: offloadDisplay(
      { label: "opencode", match: { model: GLM_MODEL } },
      false,
    ),
    label: "opencode",
    sendsOut: true,
  },
  sarashina: {
    name: "sarashina",
    provider: "sarashina",
    match: {
      harness: "opencode",
      model: SARASHINA_MODEL,
    },
    display: offloadDisplay(
      {
        label: "sarashina",
        match: { model: SARASHINA_MODEL },
        displayNote: "公開内容のみ",
      },
      false,
    ),
    displayNote: "公開内容のみ",
    label: "sarashina",
    sendsOut: true,
  },
};

export type FreeDestinationName =
  | "opencode-free-deepseek"
  | "opencode-free-glm";
export type FreeDestination = {
  name: FreeDestinationName;
  match: { harness: "opencode"; model: string };
  display: string;
  displayNote?: string;
  label: string;
  sendsOut: true;
};

export const FREE_DESTINATIONS: readonly FreeDestination[] = [
  {
    name: "opencode-free-deepseek",
    match: { harness: "opencode", model: FREE_DEEPSEEK_MODEL },
    display: offloadDisplay(
      {
        label: "opencode free deepseek",
        match: { model: FREE_DEEPSEEK_MODEL },
      },
      false,
    ),
    label: "opencode free deepseek",
    sendsOut: true,
  },
  {
    name: "opencode-free-glm",
    match: { harness: "opencode", model: FREE_GLM_MODEL },
    display: offloadDisplay(
      {
        label: "opencode free glm",
        match: { model: FREE_GLM_MODEL },
      },
      false,
    ),
    label: "opencode free glm",
    sendsOut: true,
  },
];

/**
 * Models the offload entry accepts: the `match.model` of every sendsOut row in
 * both tables. A sendsOut row without a model would widen the allowance to
 * every model, so it throws instead.
 */
export function sendsOutModels(): string[] {
  const models = new Set<string>();
  const rows: {
    name: string;
    sendsOut: boolean;
    model: string | undefined;
  }[] = [
    ...Object.values(DESTINATIONS).map((d) => ({
      name: d.name,
      sendsOut: d.sendsOut,
      model: d.match.model,
    })),
    ...FREE_DESTINATIONS.map((d) => ({
      name: d.name,
      sendsOut: d.sendsOut,
      model: d.match.model,
    })),
  ];
  for (const row of rows) {
    if (!row.sendsOut) continue;
    if (row.model === undefined) {
      throw new Error(`sendsOut destination without a model: ${row.name}`);
    }
    models.add(row.model);
  }
  return [...models].sort();
}

/**
 * Providers whose stored credentials may exist when the offload entry
 * starts opencode: the part before the first slash of each accepted model.
 */
export function allowedAuthProviders(): string[] {
  const providers = new Set<string>();
  for (const model of sendsOutModels()) {
    providers.add(model.slice(0, model.indexOf("/")));
  }
  return [...providers].sort();
}
