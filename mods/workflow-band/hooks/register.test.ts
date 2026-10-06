import { describe, expect, test } from "claude-code/testing";

const IDLE = `Document workflow gate: conditions on \`plan.md\`:
  ✗ research.md (missing; expected: research.md in the workflow dir)
  ✗ Plan Status (missing; expected: - Plan Status: complete)
  ✗ Review Status (missing; expected: - Review Status: pass)
  ✗ Approval Status (missing; expected: - Approval Status: approved)
  ✗ marker verdict (missing; expected: <!-- auto-review: verdict=pass; ... -->)
  ✗ hash match (missing; expected: marker hash == computed hash)
  ✗ approval (missing; expected: approvals.log records the current hash)
Next: Write research.md in the workflow dir (\`workflow-cli dir\` prints the path), as in step 1 of rules/workflow.md.
tripwire: not yet armed
`;

const IN_REVIEW = `Document workflow gate: conditions on \`plan.md\`:
  ✓ research.md
  ✓ Plan Status
  ✗ Review Status (found: - Review Status: needs-work; expected: - Review Status: pass)
  ✗ Approval Status (missing; expected: - Approval Status: approved)
  ✗ marker verdict (found: verdict=needs-work; expected: <!-- auto-review: verdict=pass; ... -->)
  ✓ hash match
  ✗ approval (missing; expected: approvals.log records the current hash)
Next: Re-run the non-pass reviewers.
tripwire: not yet armed
`;

const ALL_PASS = `Document workflow gate: conditions on \`plan.md\`:
  ✓ research.md
  ✓ Plan Status
  ✓ Review Status
  ✓ Approval Status
  ✓ marker verdict
  ✓ hash match
  ✓ approval
Next: The gate conditions are satisfied.
tripwire: armed
`;

const ROOT = "/work/proj";
const SESSION_ID = "1ec067a4-9987-4ec4-ab30-b00e281a6313";

describe("workflow-band", () => {
  for (const surface of ["terminal", "desktop"] as const) {
    test(`${surface}: draws the gate once the workflow has started, hides while idle`, async ($, on) => {
      let statusOut = IDLE;
      let dirOut = `wfDir=${ROOT}/.tmp/sessions/1ec067a4\nsource=derived\n`;
      const calls: { argv: readonly string[]; env?: Record<string, string> }[] =
        [];

      on("session.root", () => ({ value: ROOT }));
      on("session.id", () => ({ value: SESSION_ID }));
      on("process.run", ($, e) => {
        calls.push({ argv: e.argv, env: e.init?.env });
        const stdout = e.argv[1] === "status" ? statusOut : dirOut;
        return {
          value: {
            exitCode: 0,
            stdout,
            stderr: "",
            isStdoutTruncated: false,
            isStderrTruncated: false,
          },
        };
      });
      on("session.start", ($, e) => ({ cwd: e.cwd }));
      on("turn.complete", () => ({ text: "" }));
      // The engine's own band: nothing.
      on("ui.render", ($, e) => $.ui.resolve(e).Box({}));

      await $.session.start({ surface, isInteractive: true, cwd: ROOT } as any);
      const ui = await $.ui.mount({
        plugin: "workflow-band",
        surface,
        component: "AbovePrompt",
        props: {
          hasSurvey: false,
          isWorking: false,
          maxRows: 10,
          bodyColumns: 120,
        },
      } as any);

      // Idle: every check fails, so the band stays empty.
      expect(await ui.find({ type: "Text", text: /^WF/ })).toBeUndefined();

      // The CLI gets the two variables the Bash tool would have, and nothing else.
      expect(calls[0]?.env).toEqual({
        CLAUDE_PROJECT_DIR: ROOT,
        CLAUDE_CODE_SESSION_ID: SESSION_ID,
      });

      statusOut = IN_REVIEW;
      dirOut = `wfDir=${ROOT}/.tmp/sessions/old12345\nsource=env\n`;
      await $.turn.complete({
        reason: "answer",
        answer: "ok",
        durationMs: 1,
      } as any);

      expect(await ui.find({ type: "Text", text: /^WF/ })).toBeDefined();
      expect(await ui.find({ type: "Text", text: /✓research/ })).toBeDefined();
      expect(await ui.find({ type: "Text", text: /✗review/ })).toBeDefined();
      expect(await ui.find({ type: "Text", text: /\[pinned\]/ })).toBeDefined();
      expect(
        await ui.find({
          type: "Text",
          text: /Next: Re-run the non-pass reviewers\./,
        }),
      ).toBeDefined();

      // Every check passes: one mark stands in for the checklist and `Next:`.
      statusOut = ALL_PASS;
      await $.turn.complete({
        reason: "answer",
        answer: "ok",
        durationMs: 1,
      } as any);

      expect(await ui.find({ type: "Text", text: /^WF/ })).toBeDefined();
      expect(await ui.find({ type: "Text", text: /^✓ $/ })).toBeDefined();
      expect(
        await ui.find({ type: "Text", text: /✓research/ }),
      ).toBeUndefined();
      expect(await ui.find({ type: "Text", text: /Next:/ })).toBeUndefined();
      expect(await ui.find({ type: "Text", text: /\[pinned\]/ })).toBeDefined();
      await ui.unmount();
    });
  }

  test("two-layer: draws each plan-N.md beside spec.md, and one count once all clear", async ($, on) => {
    let planLines = [
      "plan: plan-1.md ✓",
      "plan: plan-2.md ✗ Review Status",
      "plan: plan-10.md ✗ parent-spec-hash",
    ];
    const twoLayerStatus = () =>
      `${ALL_PASS.replace(
        "Document workflow gate: conditions on `plan.md`:",
        "Document workflow gate (two-layer): conditions on `spec.md`:",
      ).replace(
        "Next: The gate conditions are satisfied.",
        "Next: approve plan-N.md",
      )}${planLines.join("\n")}\n`;

    on("session.root", () => ({ value: ROOT }));
    on("session.id", () => ({ value: SESSION_ID }));
    on("process.run", ($, e) => ({
      value: {
        exitCode: 0,
        stdout:
          e.argv[1] === "status"
            ? twoLayerStatus()
            : `wfDir=${ROOT}/.tmp/sessions/1ec067a4\nsource=derived\n`,
        stderr: "",
        isStdoutTruncated: false,
        isStderrTruncated: false,
      },
    }));
    on("session.start", ($, e) => ({ cwd: e.cwd }));
    on("turn.complete", () => ({ text: "" }));
    on("ui.render", ($, e) => $.ui.resolve(e).Box({}));

    await $.session.start({
      surface: "terminal",
      isInteractive: true,
      cwd: ROOT,
    } as any);
    const ui = await $.ui.mount({
      plugin: "workflow-band",
      surface: "terminal",
      component: "AbovePrompt",
      props: {
        hasSurvey: false,
        isWorking: false,
        maxRows: 10,
        bodyColumns: 120,
      },
    } as any);

    // spec.md is all green, but two plans are held back: `Next:` stays.
    expect(await ui.find({ type: "Text", text: /^✓ $/ })).toBeDefined();
    expect(await ui.find({ type: "Text", text: /^1✓ $/ })).toBeDefined();
    expect(await ui.find({ type: "Text", text: /^2✗review $/ })).toBeDefined();
    expect(await ui.find({ type: "Text", text: /^10✗parent $/ })).toBeDefined();
    expect(await ui.find({ type: "Text", text: /^Next: / })).toBeDefined();

    planLines = planLines.map((line) => line.replace(/ ✗ .*$/, " ✓"));
    await $.turn.complete({
      reason: "answer",
      answer: "ok",
      durationMs: 1,
    } as any);

    expect(await ui.find({ type: "Text", text: /^✓3$/ })).toBeDefined();
    expect(await ui.find({ type: "Text", text: /^1✓ $/ })).toBeUndefined();
    expect(await ui.find({ type: "Text", text: /^Next: / })).toBeUndefined();
    await ui.unmount();
  });

  test("a failing workflow-cli shows its reason instead of hiding", async ($, on) => {
    on("session.root", () => ({ value: ROOT }));
    on("session.id", () => ({ value: SESSION_ID }));
    on("process.run", () => ({
      value: {
        exitCode: 1,
        stdout: "",
        stderr: "CLAUDE_PROJECT_DIR is not set",
        isStdoutTruncated: false,
        isStderrTruncated: false,
      },
    }));
    on("session.start", ($, e) => ({ cwd: e.cwd }));
    on("ui.render", ($, e) => $.ui.resolve(e).Box({}));

    await $.session.start({
      surface: "terminal",
      isInteractive: true,
      cwd: ROOT,
    } as any);
    const ui = await $.ui.mount({
      plugin: "workflow-band",
      surface: "terminal",
      component: "AbovePrompt",
      props: {
        hasSurvey: false,
        isWorking: false,
        maxRows: 10,
        bodyColumns: 120,
      },
    } as any);
    expect(
      await ui.find({
        type: "Text",
        text: /WF workflow-cli status exited 1: CLAUDE_PROJECT_DIR is not set/,
      }),
    ).toBeDefined();
    await ui.unmount();
  });
});
