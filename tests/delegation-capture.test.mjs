import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  AGENT_DEF_MODELS,
  agentsDirFrom,
  captureAgent,
  captureAgentFromDefinition,
  parseAgentModel,
  readAgentModel,
} from "../home/dot_local/share/delegation/capture.ts";
import { normalizeModel } from "../home/dot_local/share/delegation/schema.ts";

const fm = (...lines) => ["---", ...lines, "---", "body"].join("\n");

describe("parseAgentModel", () => {
  const accept = [
    ["plain", fm("model: sonnet"), "sonnet"],
    ["double quoted", fm('model: "opus"'), "opus"],
    ["single quoted", fm("model: 'haiku'"), "haiku"],
    ["fable", fm("model: fable"), "fable"],
    ["trailing space", fm("model: sonnet   "), "sonnet"],
    ["padded quoted", fm('model:   "sonnet"  '), "sonnet"],
    ["CRLF", fm("model: sonnet").replaceAll("\n", "\r\n"), "sonnet"],
    ["one BOM", "﻿" + fm("model: sonnet"), "sonnet"],
    ["tab after colon", fm("model:\tsonnet"), "sonnet"],
    [
      "second model after the closing line",
      fm("model: sonnet") + "\nmodel: opus\n",
      "sonnet",
    ],
  ];
  for (const [name, text, want] of accept) {
    it(`accepts ${name}`, () => assert.equal(parseAgentModel(text), want));
  }
  const refuse = [
    ["inherit", fm("model: inherit")],
    ["unlisted", fm("model: gpt-5")],
    ["empty", fm("model:")],
    ["open quote", fm('model: "sonnet')],
    ["trailing comment", fm("model: sonnet # x")],
    ["tab inside", fm("model: sonnet\tx")],
    ["no model line", fm("name: x")],
    ["two model lines", fm("model: sonnet", "model: opus")],
    ["Model only", fm("Model: sonnet")],
    ["models only", fm("models: sonnet")],
    ["indented only", fm("  model: sonnet")],
    ["commented only", fm("# model: sonnet")],
    ["unclosed", "---\nmodel: sonnet\n"],
    ["opening with trailing space", "--- \nmodel: sonnet\n---\n"],
    ["closing with text only", "---\nmodel: sonnet\n--- x\n"],
    ["no opening", "model: sonnet\n---\n"],
    ["empty text", ""],
    ["body only", "---\nname: x\n---\nmodel: sonnet\n"],
    ["two BOMs", "﻿﻿" + fm("model: sonnet")],
    ["no space after colon", fm("model:sonnet")],
    ["spaces only", fm("model:   ")],
  ];
  for (const [name, text] of refuse) {
    it(`refuses ${name}`, () => assert.equal(parseAgentModel(text), null));
  }
  it("AGENT_DEF_MODELS are all known to the schema", () => {
    for (const v of AGENT_DEF_MODELS) {
      assert.notEqual(normalizeModel("claude-code-agent", v), "unknown");
    }
  });
});

describe("agentsDirFrom", () => {
  it("takes a clean absolute override", () => {
    assert.equal(agentsDirFrom({ DELEGATION_AGENTS_DIR: "/t/a" }), "/t/a");
  });
  for (const bad of ["rel/x", "/a/../b", "/a//b", "/a/b/", "/", ""]) {
    it(`refuses override ${JSON.stringify(bad)} without falling back to HOME`, () => {
      assert.equal(
        agentsDirFrom({ DELEGATION_AGENTS_DIR: bad, HOME: "/h" }),
        null,
      );
    });
  }
  it("derives from HOME", () => {
    assert.equal(agentsDirFrom({ HOME: "/h" }), "/h/.claude/agents");
    assert.equal(agentsDirFrom({ HOME: "/h/" }), "/h/.claude/agents");
  });
  for (const h of [undefined, "", "rel"]) {
    it(`refuses HOME ${JSON.stringify(h)}`, () => {
      assert.equal(agentsDirFrom(h === undefined ? {} : { HOME: h }), null);
    });
  }
});

describe("readAgentModel", () => {
  const tmp = () => realpathSync(mkdtempSync(join(tmpdir(), "deleg-cap-")));
  const def = (dir, name, text = fm("model: sonnet")) =>
    writeFileSync(join(dir, `${name}.md`), text);

  it("reads a definition", () => {
    const d = tmp();
    try {
      def(d, "logic-validator");
      assert.equal(readAgentModel(d, "logic-validator"), "sonnet");
    } finally {
      rmSync(d, { recursive: true });
    }
  });

  it("caps at 64KB exactly", () => {
    const d = tmp();
    try {
      const head = fm("model: sonnet");
      const pad = (n) => head + "x".repeat(n - Buffer.byteLength(head));
      def(d, "ok", pad(65536));
      def(d, "big", pad(65537));
      assert.equal(readAgentModel(d, "ok"), "sonnet");
      assert.equal(readAgentModel(d, "big"), null);
    } finally {
      rmSync(d, { recursive: true });
    }
  });

  // Keep this table identical to the one in
  // mods/delegation-budget/hooks/track.test.ts.
  const BAD_NAMES = [
    "../x",
    "a/b",
    "a.b",
    "Logic",
    "Explore",
    "plugin:x",
    "a_b",
    "a".repeat(41),
    "",
    "a\0b",
    "a\nb",
    "x\n",
    3,
    undefined,
  ];
  it("refuses bad names and never reads outside the dir", () => {
    const root = tmp();
    try {
      const d = join(root, "agents");
      mkdirSync(d);
      writeFileSync(join(root, "x.md"), fm("model: sonnet"));
      for (const n of ["a_b", "plugin:x", "Logic", "Explore", "a.b"]) {
        writeFileSync(join(d, `${n}.md`), fm("model: sonnet"));
      }
      for (const n of BAD_NAMES)
        assert.equal(readAgentModel(d, n), null, String(n));
    } finally {
      rmSync(root, { recursive: true });
    }
  });

  it("refuses symlink, directory, missing", () => {
    const d = tmp();
    try {
      writeFileSync(join(d, "real.txt"), fm("model: sonnet"));
      symlinkSync(join(d, "real.txt"), join(d, "link.md"));
      mkdirSync(join(d, "dir.md"));
      assert.equal(readAgentModel(d, "link"), null);
      assert.equal(readAgentModel(d, "dir"), null);
      assert.equal(readAgentModel(d, "missing"), null);
    } finally {
      rmSync(d, { recursive: true });
    }
  });

  it("accepts an agents dir that is itself a symlink", () => {
    const d = tmp();
    try {
      mkdirSync(join(d, "real"));
      def(join(d, "real"), "x");
      symlinkSync(join(d, "real"), join(d, "agents"));
      assert.equal(readAgentModel(join(d, "agents"), "x"), "sonnet");
    } finally {
      rmSync(d, { recursive: true });
    }
  });
});

// A model on the call is taken as it is; cmdOpen never reads a definition then.
describe("captureAgent with a model on the call", () => {
  const cases = [
    ["opus", "opus", "subagent:logic-validator"],
    ["inherit", "inherit", "subagent:logic-validator"],
    ["", "unknown", "subagent:logic-validator"],
  ];
  for (const [model, want] of cases) {
    it(`model ${JSON.stringify(model)} -> ${want}`, () => {
      const c = captureAgent({ subagentType: "logic-validator", model });
      assert.equal(c.model, want);
      assert.deepEqual(c.invocation, ["subagent:logic-validator"]);
    });
  }
  it("sonnet with subagent_type ../x -> sonnet, empty invocation", () => {
    const c = captureAgent({ subagentType: "../x", model: "sonnet" });
    assert.equal(c.model, "sonnet");
    assert.deepEqual(c.invocation, []);
  });
  it("definition capture keeps effort and unknown fallback", () => {
    assert.equal(
      captureAgentFromDefinition("x", "haiku", "high").effort,
      "high",
    );
    assert.equal(captureAgentFromDefinition("x", "haiku").effort, "unknown");
  });
});
