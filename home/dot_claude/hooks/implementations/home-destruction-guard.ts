#!/usr/bin/env -S bun run --silent

import { userInfo } from "node:os";
import { defineHook } from "cc-hooks-ts";
import {
  parserGiveUpMark,
  parserGiveUpReasonSince,
} from "../lib/bash-parser.ts";
import {
  checkHomeDestruction,
  getCommandFromToolInput,
} from "../lib/command-parsing.ts";
import {
  createBoundaryDenyResponse,
  createDenyResponse,
  shortenForReason,
} from "../lib/context-helpers.ts";
import { prepareDenyInput } from "../lib/deny-input.ts";
import { getHomeDir } from "../lib/path-utils.ts";
import "../types/tool-schemas.ts";

/**
 * Denies recursive deletes and moves of the home directory or its direct
 * children. Registered only while the auto-approval hooks are stopped
 * (claude_hooks.auto_approval is false); auto-approve.ts makes the same call
 * when it is registered. The rule itself lives in checkHomeDestruction.
 */
const hook = defineHook({
  trigger: { PreToolUse: true },
  run: async (context) => {
    const { tool_name, tool_input } = context.input;
    if (tool_name !== "Bash") {
      return context.success({});
    }

    try {
      const command = getCommandFromToolInput("Bash", tool_input) || "";
      // Taken before the parser runs: a give-up raised by the next call would
      // otherwise go unseen, and the home check needs a text the parser read
      // to the end.
      const mark = parserGiveUpMark();
      const { maskedText } = await prepareDenyInput(command);
      const gaveUp = parserGiveUpReasonSince(mark);
      if (gaveUp !== null) {
        return context.json(
          createBoundaryDenyResponse(
            `${gaveUp}\nCommand: ${shortenForReason(command)}`,
          ),
        );
      }

      // `home` comes from this process, never from the command. Without the
      // cwd fallback a cwd-dependent command (`rm -rf *`) could not be judged.
      const result = checkHomeDestruction(maskedText, {
        home: getHomeDir(),
        cwd: context.input.cwd || process.cwd(),
        user: currentUserName(),
      });
      if (result.isDangerous) {
        return context.json(
          createBoundaryDenyResponse(
            `${result.reason}\nCommand: ${shortenForReason(command)}`,
          ),
        );
      }
      return context.success({});
    } catch (error) {
      return context.json(
        createDenyResponse(`Error in home destruction check: ${error}`),
      );
    }
  },
});

function currentUserName(): string | undefined {
  try {
    return userInfo().username;
  } catch {
    return undefined;
  }
}

export default hook;

if (import.meta.main) {
  const { runHook } = await import("cc-hooks-ts");
  await runHook(hook);
}
