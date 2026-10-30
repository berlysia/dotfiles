declare module "claude-code" {
  interface PluginState {
    "copy-pick": {
      pane: {
        items: {
          kind: "code" | "inline" | "full";
          text: string;
          label: string;
          truncated: boolean;
        }[];
        lines: string[];
        copyMessage: string | null;
        copiedText: string | null;
      };
    };
  }
}
