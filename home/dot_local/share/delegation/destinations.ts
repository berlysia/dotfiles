/**
 * Delegation destinations. Imports constants.ts only, so the offload entry
 * point can read the table without pulling in route.ts.
 */

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
  /** Fixed text, including the launch command: never built from records. */
  display: string;
  /** Fixed short name for review lines; never built from records. */
  label: string;
  /** Whether the brief and the working tree leave the machine (to Z.ai or Sarashina). */
  sendsOut: boolean;
};

export const DESTINATIONS: Record<DestinationName, Destination> = {
  "codex-terra": {
    name: "codex-terra",
    provider: "codex",
    match: { harness: "codex-cli", model: "gpt-6.1-terra" },
    display:
      "codex Terra (codex exec -m gpt-6.1-terra -c model_reasoning_effort=high)",
    label: "codex Terra",
    sendsOut: false,
  },
  "codex-luna-max": {
    name: "codex-luna-max",
    provider: "codex",
    match: { harness: "codex-cli", model: "gpt-6-luna", effort: "max" },
    display:
      "codex Luna max (codex exec -m gpt-6-luna -c model_reasoning_effort=max)",
    label: "codex Luna max",
    sendsOut: false,
  },
  opencode: {
    name: "opencode",
    provider: "opencode",
    // Pinned to GLM so Sarashina's records (same harness) do not count here.
    match: { harness: "opencode", model: "zai-coding-plan/glm-5.3" },
    display: "opencode (opencode run)",
    label: "opencode",
    sendsOut: true,
  },
  sarashina: {
    name: "sarashina",
    provider: "sarashina",
    match: {
      harness: "opencode",
      model: "sarashina/sarashina3.2-mini-thinking",
    },
    display:
      "sarashina (opencode run -m sarashina/sarashina3.2-mini-thinking、公開内容のみ)",
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
  label: string;
  sendsOut: true;
};

export const FREE_DESTINATIONS: readonly FreeDestination[] = [
  {
    name: "opencode-free-deepseek",
    match: { harness: "opencode", model: "opencode/deepseek-v4.1-flash-free" },
    display: "opencode free deepseek",
    label: "opencode free deepseek",
    sendsOut: true,
  },
  {
    name: "opencode-free-glm",
    match: { harness: "opencode", model: "opencode/glm-5.3-flash-free" },
    display: "opencode free glm",
    label: "opencode free glm",
    sendsOut: true,
  },
];
