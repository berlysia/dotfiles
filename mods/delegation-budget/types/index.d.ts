declare module "claude-code" {
  interface PluginState {
    "delegation-budget": {
      /**
       * Background delegations whose end has not been heard, oldest first,
       * at most 50 (the oldest is dropped past that). A list and not a map
       * so the drop order survives JSON. Gone when the session ends; the
       * ledger lapses the matching pending record after 7 days.
       */
      pending: Array<{
        agentId: string;
        /** The four validated words `delegation open` printed. */
        id: string;
        harness: string;
        model: string;
        effort: string;
        /** `$.clock.now()` at the launch. */
        startedAt: number;
      }>;
      /**
       * Prompt lines waiting for the next task-notification prompt, at most
       * 5 (the oldest is dropped past that).
       */
      notices: string[];
    };
  }
}
