interface CustomRule {
  id: string;
  filePattern: RegExp;
  linePattern: RegExp;
  message: string;
  why: string;
  fix: string;
  adr?: string;
}

const homeDir = process.env.HOME;

const RULES: CustomRule[] = homeDir
  ? [
      {
        id: "no-hardcoded-home",
        filePattern: /\.(sh|tmpl)$/,
        linePattern: new RegExp(homeDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
        message: "Hardcoded home directory path found",
        why: "Hardcoded paths break portability — chezmoi templates should use variables",
        fix: "Use $HOME, ~, or chezmoi template variables (.chezmoi.homeDir)",
      },
    ]
  : [];

export function runCustomRules(
  filePath: string,
  content: string,
): string | null {
  const applicableRules = RULES.filter((rule) =>
    rule.filePattern.test(filePath),
  );
  if (applicableRules.length === 0) return null;

  const violations: string[] = [];
  const lines = content.split("\n");

  for (const rule of applicableRules) {
    for (const [i, line] of lines.entries()) {
      if (rule.linePattern.test(line)) {
        const adrLine = rule.adr ? `\n  ADR: ${rule.adr}` : "";
        violations.push(
          `[custom-rules] ${rule.id} (line ${i + 1}): ${rule.message}\n  WHY: ${rule.why}\n  FIX: ${rule.fix}${adrLine}`,
        );
      }
    }
  }

  return violations.length > 0 ? violations.join("\n") : null;
}
