// lib/deny-input.ts — the one entry for deny-side reads of a Bash command
//
// Deny-side checks read the command with data-only heredoc bodies emptied
// (spec K1). They take both the whole text and the fragments from here, so
// a check cannot read the raw body by mistake. The allow side keeps reading
// the raw command through scanSafeList.

import {
  type ExtractedCommands,
  extractCommandsStructured,
} from "./bash-parser.ts";
import { maskDataHeredocBodies } from "./heredoc-data.ts";

export interface DenyInput {
  /**
   * For deny-side checks only; the shell runs the raw command. Never run,
   * show, allow on, or hand this to the LLM evaluator.
   */
  maskedText: string;
  individualCommands: string[];
  parsingMethod: ExtractedCommands["parsingMethod"];
}

/**
 * The command as deny-side checks read it. Deny-side hooks use this instead
 * of calling extractCommandsStructured on the raw command (the comment at
 * pattern-matcher.ts:79 is about the allow side and stays).
 *
 * When a body was emptied, `maskedText` reparses without errors and differs
 * from `raw` only by the removed body ranges. Otherwise `maskedText === raw`,
 * including when `raw` itself fails to parse. Masking is idempotent.
 */
export async function prepareDenyInput(raw: string): Promise<DenyInput> {
  const maskedText = await maskDataHeredocBodies(raw);
  const { individualCommands, parsingMethod } =
    await extractCommandsStructured(maskedText);
  return { maskedText, individualCommands, parsingMethod };
}
