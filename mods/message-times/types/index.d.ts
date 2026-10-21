declare module "claude-code" {
  interface PluginState {
    "message-times": {
      /**
       * When `session.append` stored each user or assistant row, in
       * `$.clock.now()`'s milliseconds, by the row's uuid (a message row's
       * `requestId`); null for a row stored before the mod loaded.
       */
      storedAt: StateFamily<number | null>;
    };
  }
}
