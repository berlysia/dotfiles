import type { SourcedRule } from "../lib/pattern-matcher.ts";

/** Tag rule strings with one settings root, for tests that pass rule lists. */
export const sourced = (
  rules: string[],
  settingsRoot = "/settings-root",
): SourcedRule[] => rules.map((rule) => ({ rule, settingsRoot }));
