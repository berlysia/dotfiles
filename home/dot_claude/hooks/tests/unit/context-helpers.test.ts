import { ok, strictEqual } from "node:assert";
import { describe, it } from "node:test";
import {
  BOUNDARY_DENY_GUIDANCE,
  MATCHED_TEXT_DENY_GUIDANCE,
  createBoundaryDenyResponse,
  createMatchedTextDenyResponse,
  shortenForReason,
} from "../../lib/context-helpers.ts";

describe("createBoundaryDenyResponse", () => {
  it("appends the guidance after a blank line and keeps the decision deny", () => {
    const res = createBoundaryDenyResponse("Destructive operation detected: x");
    const out = res.output.hookSpecificOutput;
    strictEqual(out.permissionDecision, "deny");
    strictEqual(
      out.permissionDecisionReason,
      `Destructive operation detected: x\n\n${BOUNDARY_DENY_GUIDANCE}`,
    );
    ok(BOUNDARY_DENY_GUIDANCE.includes("Do not retry the same effect"));
  });
});

describe("createMatchedTextDenyResponse", () => {
  it("appends the matched-text guidance after a blank line and keeps the decision deny", () => {
    const res = createMatchedTextDenyResponse("Blocked by security rules: x");
    const out = res.output.hookSpecificOutput;
    strictEqual(out.permissionDecision, "deny");
    strictEqual(
      out.permissionDecisionReason,
      `Blocked by security rules: x\n\n${MATCHED_TEXT_DENY_GUIDANCE}`,
    );
  });

  it("stops when the matched text is what the agent meant to run", () => {
    ok(
      MATCHED_TEXT_DENY_GUIDANCE.includes(
        "If the matched text is part of what you meant to run, do not retry with a different command, tool, or language",
      ),
    );
    ok(MATCHED_TEXT_DENY_GUIDANCE.includes("do not split or reword it"));
  });

  it("allows one reshaped retry only when the matched text is data", () => {
    ok(
      MATCHED_TEXT_DENY_GUIDANCE.includes(
        "If the matched text is only data you passed to a command that does not execute it (a search pattern, a commit message, a heredoc body for cat or tee)",
      ),
    );
    ok(
      MATCHED_TEXT_DENY_GUIDANCE.includes(
        "Text handed to a shell, an interpreter, eval, xargs, ssh or a -c option, and text the shell itself expands (a command substitution or a process substitution), is something you meant to run, not data.",
      ),
    );
    ok(
      MATCHED_TEXT_DENY_GUIDANCE.includes(
        "you may re-send once with the shape changed and nothing else",
      ),
    );
    ok(MATCHED_TEXT_DENY_GUIDANCE.includes("Same executables, same targets."));
    ok(
      MATCHED_TEXT_DENY_GUIDANCE.includes(
        "Never put anything that will be run in that file.",
      ),
    );
    ok(MATCHED_TEXT_DENY_GUIDANCE.includes("If it is denied again, stop"));
  });

  it("does not use effect-level wording, name an alternative verb, or defer to the reason text", () => {
    ok(!MATCHED_TEXT_DENY_GUIDANCE.includes("same operation"));
    ok(!MATCHED_TEXT_DENY_GUIDANCE.includes("unlink"));
    ok(!MATCHED_TEXT_DENY_GUIDANCE.includes("|"));
    ok(!MATCHED_TEXT_DENY_GUIDANCE.toLowerCase().includes("pipe"));
    ok(!MATCHED_TEXT_DENY_GUIDANCE.includes("other than"));
  });

  it("shares the stop clause with the plain guidance", () => {
    const stop = "stop and tell the user what you were trying to do and why";
    ok(BOUNDARY_DENY_GUIDANCE.includes(stop));
    ok(MATCHED_TEXT_DENY_GUIDANCE.includes(stop));
    strictEqual(
      BOUNDARY_DENY_GUIDANCE,
      "This is a protection boundary. Do not retry the same effect with a different command, tool, or language. If the operation is needed, stop and tell the user what you were trying to do and why.",
    );
  });
});

describe("shortenForReason", () => {
  it("keeps a text of 200 characters as is", () => {
    const text = "a".repeat(200);
    strictEqual(shortenForReason(text), text);
  });
  it("cuts a longer text at 200 characters and states the full length", () => {
    strictEqual(
      shortenForReason("a".repeat(201)),
      `${"a".repeat(200)}… (201 characters)`,
    );
  });
  it("puts a multi-line text on one line so a quoted command cannot start a line of the reason", () => {
    strictEqual(
      shortenForReason("a\nMatched: x\r\nb\rc"),
      "a\\nMatched: x\\nb\\nc",
    );
    // Built from code points so this file holds no raw separator character.
    const separators =
      String.fromCodePoint(0x2028) + String.fromCodePoint(0x2029);
    strictEqual(shortenForReason(`a${separators}b`), "a\\n\\nb");
  });
});
