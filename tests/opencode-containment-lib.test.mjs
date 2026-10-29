import assert from "node:assert/strict";
import test from "node:test";
import {
  checkAgentPermissions,
  checkConfigSources,
  effectiveAllowedActions,
  extractStraceComms,
  findAgentPermissions,
  findConfigSources,
  makeSample,
  parseContainmentArgs,
  parseJsonLoose,
  redactText,
} from "./lib/opencode-containment-lib.mjs";

const MODELS = ["a/one", "b/two"];

test("args: a model run needs --model", () => {
  assert.equal(parseContainmentArgs([], MODELS).ok, false);
  const r = parseContainmentArgs(
    ["--model", "a/one", "--accept-aux", "zai"],
    MODELS,
  );
  assert.deepEqual(r, {
    ok: true,
    models: ["a/one"],
    acceptAux: ["zai"],
    probe: false,
  });
});

test("args: probe needs no model; bad inputs are refused", () => {
  assert.equal(parseContainmentArgs(["--probe"], MODELS).ok, true);
  for (const argv of [
    ["--model", "c/three"],
    ["--model", "a/one", "--model", "a/one"],
    ["--model"],
    ["--model", "--probe"],
    ["--model", "a/one", "--accept-aux", "Bad_Name"],
    ["--model", "a/one", "--accept-aux", "x".repeat(33)],
    ["--model", "a/one", "--unknown"],
  ]) {
    assert.equal(parseContainmentArgs(argv, MODELS).ok, false, argv.join(" "));
  }
});

test("redact: canary, home, keyword values and long tokens", () => {
  const text = [
    "canary CANARY-abc123 here",
    "path /home/u/.config/opencode/x",
    "Authorization: Bearer abcdef",
    'apikey="s3cret"',
    "api_key=zzz",
    "key sk-proj-AAAA",
    "blob ABCDEFGHIJKLMNOPQRST12345",
    "short ok-token",
  ].join("\n");
  const r = redactText(text, { secrets: ["CANARY-abc123"], home: ["/home/u"] });
  for (const leaked of [
    "CANARY-abc123",
    "/home/u",
    "abcdef",
    "s3cret",
    "zzz",
    "sk-proj",
    "ABCDEFGHIJKLMNOPQRST",
  ]) {
    assert.ok(!r.includes(leaked), leaked);
  }
  assert.ok(r.includes("$HOME/.config/opencode/x"));
  assert.ok(r.includes("short ok-token"));
});

test("redact: labelled fake root keeps paths readable", () => {
  const r = redactText("/tmp/oc-fake-Ab12Cd34Ef56Gh78/repo/.env", {
    labels: [["/tmp/oc-fake-Ab12Cd34Ef56Gh78", "<FAKE>"]],
  });
  assert.equal(r, "<FAKE>/repo/.env");
});

test("sample: truncates lines and counts", () => {
  const s = makeSample("a\nb\nc\nd", {}, 2, 300);
  assert.equal(s, "a\nb\n… (2 行省略)");
  assert.ok(makeSample("ab ".repeat(10), {}, 5, 10).includes("…"));
});

test("strace comms", () => {
  const t = "123<opencode> openat(...)\n[pid 456<git>] openat(...)\n789<> x";
  assert.deepEqual(extractStraceComms(t), ["", "git", "opencode"]);
});

test("loose json and config sources", () => {
  assert.deepEqual(parseJsonLoose('log line\n{"a":1}'), { a: 1 });
  assert.equal(parseJsonLoose("nothing"), undefined);
  const src = [
    { type: "document", path: "/h/.config/opencode/opencode.jsonc" },
  ];
  assert.deepEqual(findConfigSources({ x: { loaded: src } }), src);
  assert.equal(findConfigSources({ x: [1] }), undefined);
});

test("config sources: only the three expected", () => {
  const ok = [
    { type: "document", path: "/h/.config/opencode/opencode.jsonc" },
    { type: "directory", path: "/h/.config/opencode" },
    { type: "directory", path: "/h/.opencode" },
  ];
  assert.deepEqual(checkConfigSources(ok, ["/h"]), []);
  const bad = [...ok, { type: "directory", path: "/tmp/x/.opencode" }];
  assert.equal(checkConfigSources(bad, ["/h"]).length, 1);
  assert.equal(
    checkConfigSources(
      [{ type: "directory", path: "/h/.config/opencode/opencode.jsonc" }],
      ["/h"],
    ).length,
    1,
  );
});

const rule = (action, effect, resource = "*") => ({ action, resource, effect });

test("agent permissions: read and edit sets", () => {
  const readPerms = [
    rule("*", "allow"),
    rule("*", "deny"),
    rule("read", "allow"),
    rule("glob", "allow"),
    rule("list", "ask"),
    rule("read", "deny", "**/.env"),
  ];
  assert.deepEqual(effectiveAllowedActions(readPerms).actions, [
    "glob",
    "list",
    "read",
  ]);
  assert.deepEqual(checkAgentPermissions(readPerms, "read"), []);
  assert.equal(checkAgentPermissions(readPerms, "edit").length, 1);
});

test("agent permissions: extra action, external_directory, missing deny-all", () => {
  const base = [
    rule("*", "deny"),
    rule("read", "allow"),
    rule("glob", "allow"),
    rule("list", "allow"),
  ];
  assert.ok(
    checkAgentPermissions([...base, rule("bash", "allow")], "read").length > 0,
  );
  const ext = checkAgentPermissions(
    [...base, rule("external_directory", "allow")],
    "read",
  );
  assert.ok(ext.some((p) => p.includes("external_directory")));
  assert.ok(
    checkAgentPermissions(base.slice(1), "read").some((p) =>
      p.includes("全拒否"),
    ),
  );
  // an allow placed before the deny-all is overridden
  assert.deepEqual(
    checkAgentPermissions([rule("bash", "allow"), ...base], "read"),
    [],
  );
});

test("agent permissions: found in array or keyed shapes", () => {
  const perms = [rule("*", "deny")];
  assert.equal(
    findAgentPermissions(
      [{ name: "worktree-read", permissions: perms }],
      "worktree-read",
    ),
    perms,
  );
  assert.equal(
    findAgentPermissions(
      { agents: { "worktree-edit": { permissions: perms } } },
      "worktree-edit",
    ),
    perms,
  );
  assert.equal(findAgentPermissions({}, "worktree-read"), undefined);
});
