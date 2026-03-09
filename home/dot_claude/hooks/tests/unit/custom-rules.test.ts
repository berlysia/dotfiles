import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runCustomRules } from "../../lib/custom-rules.ts";

describe("runCustomRules", () => {
  const homeDir = process.env.HOME;

  it("detects hardcoded home directory in .sh files", () => {
    if (!homeDir) return;
    const content = `#!/bin/bash\ncp ${homeDir}/file.txt /tmp/\n`;
    const result = runCustomRules("script.sh", content);
    assert.ok(result);
    assert.ok(result.includes("no-hardcoded-home"));
    assert.ok(result.includes("WHY:"));
    assert.ok(result.includes("FIX:"));
  });

  it("detects hardcoded home directory in .tmpl files", () => {
    if (!homeDir) return;
    const content = `{{ if eq .chezmoi.os "linux" }}\npath = "${homeDir}/.config"\n{{ end }}\n`;
    const result = runCustomRules("config.sh.tmpl", content);
    assert.ok(result);
    assert.ok(result.includes("no-hardcoded-home"));
  });

  it("reports correct line number", () => {
    if (!homeDir) return;
    const content = `line1\nline2\n${homeDir}/foo\n`;
    const result = runCustomRules("script.sh", content);
    assert.ok(result);
    assert.ok(result.includes("(line 3)"));
  });

  it("returns null for files without violations", () => {
    const content = '#!/bin/bash\necho "$HOME/file.txt"\n';
    const result = runCustomRules("script.sh", content);
    assert.strictEqual(result, null);
  });

  it("returns null for non-matching file patterns", () => {
    if (!homeDir) return;
    const content = `import "${homeDir}/module";\n`;
    const result = runCustomRules("file.ts", content);
    assert.strictEqual(result, null);
  });

  it("detects multiple violations in one file", () => {
    if (!homeDir) return;
    const content = `${homeDir}/a\nok\n${homeDir}/b\n`;
    const result = runCustomRules("script.sh", content);
    assert.ok(result);
    const matches = result.match(/no-hardcoded-home/g);
    assert.ok(matches);
    assert.strictEqual(matches.length, 2);
  });

  it("includes [custom-rules] prefix in output", () => {
    if (!homeDir) return;
    const content = `${homeDir}/foo\n`;
    const result = runCustomRules("script.sh", content);
    assert.ok(result);
    assert.ok(result.startsWith("[custom-rules]"));
  });
});
