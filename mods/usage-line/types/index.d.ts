declare module "claude-code" {
  interface PluginState {
    "usage-line": {
      /**
       * The usage line as last built: context, the 5-hour and weekly windows
       * and their forecasts; null when there is nothing to show.
       */
      line: string | null;
    };
  }
}
