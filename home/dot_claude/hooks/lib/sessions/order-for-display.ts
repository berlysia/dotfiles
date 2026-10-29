/**
 * Display order shared by the CLI and the Mods: rows in the same repo as the
 * base come first, the rest follow, and each group is ordered by sessionId.
 * A row whose repo is null is never "the same repo" as anything, so a null
 * base matches nothing and the result is plain sessionId order.
 *
 * Code-unit comparison, not localeCompare: the order must not depend on the
 * runtime's locale, because order-for-display.cases.json is read by Mods too.
 */
export function orderForDisplay<
  T extends { sessionId: string; repo: string | null },
>(rows: readonly T[], baseRepo: string | null): T[] {
  const inBase = (row: T): boolean =>
    baseRepo !== null && row.repo === baseRepo;
  return [...rows].sort((a, b) => {
    const groupA = inBase(a) ? 0 : 1;
    const groupB = inBase(b) ? 0 : 1;
    if (groupA !== groupB) return groupA - groupB;
    return a.sessionId < b.sessionId ? -1 : a.sessionId > b.sessionId ? 1 : 0;
  });
}
