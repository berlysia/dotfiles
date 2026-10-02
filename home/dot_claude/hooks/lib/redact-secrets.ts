const DEFAULT_REDACT_PATTERNS: RegExp[] = [
  /sk-(?:ant-)?[A-Za-z0-9_-]{20,}/g,
  /xox[abprs]-[\w-]{10,}/g,
  /ghp_[A-Za-z0-9]{20,}/g,
  /github_pat_[A-Za-z0-9_]{20,}/g,
  /AKIA[0-9A-Z]{16}/g,
  /AIza[0-9A-Za-z_-]{35}/g,
  /npm_[A-Za-z0-9]{36}/g,
  /glpat-[A-Za-z0-9_-]{20,64}/g,
  // Only user:pass is replaced so the host stays readable in redacted text.
  /(?<=:\/\/)[^\s/@:]+:[^\s/@]+(?=@)/g,
  /eyJ[\w-]+\.[\w-]+\.[\w-]+/g,
  /-----BEGIN (?:[A-Z ]*)?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z ]*)?PRIVATE KEY-----/g,
  /Authorization:\s*Bearer\s+\S+/gi,
  /^[A-Z][A-Z0-9_]{2,}=\S+$/gm,
];

// Broader than the defaults on purpose: it also eats prose such as
// "token: 1M", which is acceptable for a compaction snapshot but would be
// noise in the insight digest. Callers opt in via `extraPatterns`.
export const COMPACTION_EXTRA_PATTERNS: RegExp[] = [
  /["']?\b(?:api[_-]?key|secret|token|password|passwd)\b["']?\s*[:=]\s*(?:"[^"\n]{0,200}"|'[^'\n]{0,200}'|\S{1,200})/gi,
  /\b[A-Za-z0-9_]*(?:SECRET|TOKEN|PASSWORD|API_KEY)[A-Za-z0-9_]*\s*=\s*\S{1,200}/gi,
  /(?:Authorization|Cookie|Set-Cookie):[^\n]{1,400}/gi,
];

export function sanitize(
  text: string,
  extraPatterns: RegExp[] = [],
): { text: string; hits: number } {
  let hits = 0;
  let result = text;
  const all = [...DEFAULT_REDACT_PATTERNS, ...extraPatterns];
  for (const pattern of all) {
    const flags = pattern.flags.includes("g")
      ? pattern.flags
      : `${pattern.flags}g`;
    const re = new RegExp(pattern.source, flags);
    result = result.replace(re, () => {
      hits += 1;
      return "[REDACTED]";
    });
  }
  return { text: result, hits };
}
