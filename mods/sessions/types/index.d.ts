declare module "claude-code" {
  interface PluginState {
    sessions: {
      /**
       * What the /sessions pane draws. `view` is null until the first fetch
       * settles; it mirrors `ListView` in hooks/read-list.ts (the contract file
       * must be self-contained, so the shape is repeated here). `fillFailed` is
       * true when the last press found the prompt unable to take the text.
       */
      pane: {
        view:
          | {
              kind: "ok";
              rows: {
                label: string;
                isSelf: boolean;
                fillText: string | null;
              }[];
              notes: string[];
            }
          | { kind: "unavailable"; message: string }
          | null;
        fillFailed: boolean;
      };
    };
  }
}
