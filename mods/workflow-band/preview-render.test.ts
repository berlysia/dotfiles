import { describe, expect, test } from "claude-code/testing";

import { SAMPLES, renderSamples } from "./preview-render";

describe("workflow-band preview", () => {
  test("prints every sample as the band's own rows", async () => {
    const lines = renderSamples({ columns: 100, useColor: false }).split("\n");

    for (const { title } of SAMPLES) {
      expect(lines.includes(`# ${title}`)).toEqual(true);
    }
    expect(lines.includes("  (nothing drawn)")).toEqual(true);
    expect(lines.includes(" WF plan.md ✓ ")).toEqual(true);
    expect(lines.includes(" WF plan.md [pinned] ✓ ")).toEqual(true);
    expect(
      lines.includes(" WF spec.md ✓ · plan 1✓ 2✗review 10✗parent "),
    ).toEqual(true);
    expect(lines.includes(" WF spec.md ✓ · plan ✓3")).toEqual(true);
    expect(
      lines.includes(
        " WF workflow-cli status exited 1: CLAUDE_PROJECT_DIR is not set",
      ),
    ).toEqual(true);
  });

  test("colour is the only difference between the coloured and plain output", async () => {
    const plain = renderSamples({ columns: 100, useColor: false });
    const coloured = renderSamples({ columns: 100, useColor: true });

    expect(coloured.includes("\u001b[1;36mWF \u001b[0m")).toEqual(true);
    expect(coloured.replace(/\u001b\[[0-9;]*m/g, "")).toEqual(plain);
  });
});
