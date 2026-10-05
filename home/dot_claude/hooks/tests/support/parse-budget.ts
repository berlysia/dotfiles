import { getParseBudgetMs, setParseBudgetMs } from "../../lib/bash-parser.ts";

/**
 * Runs `fn` with the parse budget set to `ms`, then restores the previous
 * budget even when `fn` throws, so a failed assertion cannot leave 0 for the
 * tests after it in the same file. The budget is process-wide: calls must not
 * overlap (no Promise.all, no concurrent tests in one file).
 */
export async function withParseBudget<T>(
  ms: number,
  fn: () => Promise<T> | T,
): Promise<T> {
  const previous = getParseBudgetMs();
  setParseBudgetMs(ms);
  try {
    return await fn();
  } finally {
    setParseBudgetMs(previous);
  }
}
