/**
 * `## Files` section parsing shared by document-workflow-guard (which owns
 * the realpath resolution) and review selection (which only needs the raw
 * paths). One parser so the two never disagree on what a plan lists.
 */

const PROSE_EXTENSIONS = [".md", ".mdx", ".markdown", ".txt", ".rst", ".adoc"];

/**
 * Raw project-relative paths from the fenced code blocks under `## Files`.
 * `#` lines and blank lines are skipped. A block containing any line with
 * internal whitespace is dropped whole (conservative: a malformed block must
 * not partially authorize writes in the guard).
 */
export function parseFilesPaths(planContent: string): string[] {
  const sections = planContent.split(/^##\s+/m);
  const filesSection = sections.find((s) =>
    /^Files\s*$/m.test(s.split("\n")[0] ?? ""),
  );
  if (!filesSection) return [];
  const sectionBody = filesSection.replace(/^Files\s*\n/, "");
  const collected: string[] = [];
  for (const match of sectionBody.matchAll(/^```[^\n]*\n([\s\S]*?)\n```/gm)) {
    const block = match[1];
    if (block === undefined) continue;
    const blockPaths: string[] = [];
    let blockValid = true;
    for (const rawLine of block.split("\n")) {
      const line = rawLine.trim();
      if (line === "" || line.startsWith("#")) continue;
      if (/\s/.test(line)) {
        blockValid = false;
        break;
      }
      blockPaths.push(line);
    }
    if (blockValid) collected.push(...blockPaths);
  }
  return collected;
}

/**
 * True when `## Files` lists at least one path and every path is prose.
 * Code-quality reviewers (security, resilience, ...) have nothing to review
 * in such a change. Missing/empty Files returns false so the caller falls
 * back to keyword selection (spec.md never has Files).
 */
export function isProseOnlyChange(planContent: string): boolean {
  const paths = parseFilesPaths(planContent);
  if (paths.length === 0) return false;
  return paths.every((p) => {
    const lower = p.toLowerCase().replace(/\.tmpl$/, "");
    return PROSE_EXTENSIONS.some((ext) => lower.endsWith(ext));
  });
}
