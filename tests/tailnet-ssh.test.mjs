import assert from "node:assert/strict";
import {
  copyFileSync,
  existsSync,
  chmodSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { spawnSync, execFileSync } from "node:child_process";
import {
  applySettings,
  replaceBlock,
  validateSettings,
  syncFrom1Password,
  bootstrapFrom1Password,
  checkConnections,
  fingerprint,
  generateLocalKey,
  localKeyPath,
} from "../home/dot_local/bin/executable_tailnet-ssh.mts";
import { createTailnetFixture } from "./lib/tailnet-ssh-fixture.mjs";

const fx = createTailnetFixture();
after(() => fx.cleanup());
const {
  keyDirectory,
  key,
  installTestKey,
  settings,
  fixture,
  scenario,
  authorize,
  identity,
  authorized,
} = fx;

test("the distributed TypeScript helper imports settings outside the repository", (t) => {
  const home = fixture(t);
  const script = join(home, "tailnet-ssh.mts");
  copyFileSync(
    new URL(
      "../home/dot_local/bin/executable_tailnet-ssh.mts",
      import.meta.url,
    ),
    script,
  );
  const result = spawnSync(process.execPath, [script, "import"], {
    input: JSON.stringify(settings()),
    encoding: "utf8",
    env: { ...process.env, HOME: home },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(
    JSON.parse(
      readFileSync(join(home, ".config/tailnet-ssh/settings.json"), "utf8"),
    ),
    settings(),
  );
  assert.match(readFileSync(join(home, ".ssh/config"), "utf8"), /Host example/);
});

test("existing SSH access survives repeated applies and key rotation removes the old managed key", (t) => {
  const home = fixture(t);
  const configPath = join(home, ".ssh/config");
  const authorizedPath = join(home, ".ssh/authorized_keys");
  const existingConfig =
    "Include ~/.orbstack/ssh/config\n\nHost *\n    ServerAliveInterval 30\n";
  const existingKey = `restrict ${key(3)} unmanaged\n`;
  writeFileSync(configPath, existingConfig);
  writeFileSync(authorizedPath, existingKey);
  applySettings(home, settings(), "darwin");
  const config = readFileSync(configPath, "utf8");
  const authorized = readFileSync(authorizedPath, "utf8");
  assert.ok(config.endsWith(existingConfig));
  assert.ok(authorized.startsWith(existingKey));
  assert.match(config, /IdentitiesOnly yes/);
  assert.match(config, /IdentityAgent none/);
  assert.match(authorized, /from="100\.64\.0\.0\/10,fd7a:115c:a1e0::\/48"/);
  applySettings(home, settings(), "darwin");
  assert.equal(readFileSync(configPath, "utf8"), config);
  assert.equal(readFileSync(authorizedPath, "utf8"), authorized);
  const rotated = { ...settings(), authorizedKeys: [key(2)] };
  applySettings(home, rotated, "darwin");
  const after = readFileSync(authorizedPath, "utf8");
  assert.ok(after.startsWith(existingKey));
  assert.ok(!after.includes(key(1)));
  assert.ok(after.includes(key(2)));
  assert.equal(statSync(authorizedPath).mode & 0o777, 0o600);
  assert.equal(statSync(configPath).mode & 0o777, 0o600);
  assert.equal(
    statSync(join(home, ".ssh/tailnet-login.pub")).mode & 0o777,
    0o600,
  );
  assert.equal(statSync(join(home, ".ssh")).mode & 0o777, 0o700);
});

test("WSL disables the shared agent and duplicate public keys are consolidated", (t) => {
  const home = fixture(t);
  const input = settings();
  input.authorizedKeys.push(key(1));
  applySettings(home, input, "linux");
  assert.ok(
    readFileSync(join(home, ".ssh/config"), "utf8").includes(
      "IdentityAgent none",
    ),
  );
  assert.equal(
    readFileSync(join(home, ".ssh/authorized_keys"), "utf8").split(key(1))
      .length,
    2,
  );
});

test("malformed markers abort before any SSH files change", (t) => {
  const home = fixture(t);
  const configPath = join(home, ".ssh/config");
  const authorizedPath = join(home, ".ssh/authorized_keys");
  writeFileSync(configPath, "Host example\n");
  writeFileSync(authorizedPath, "# BEGIN chezmoi tailnet-ssh\nexisting\n");
  assert.throws(() => applySettings(home, settings()), /Malformed/);
  assert.equal(readFileSync(configPath, "utf8"), "Host example\n");
  assert.equal(
    readFileSync(authorizedPath, "utf8"),
    "# BEGIN chezmoi tailnet-ssh\nexisting\n",
  );
});

test("removing all managed keys preserves unmanaged keys", () => {
  assert.equal(
    replaceBlock(
      "keep\n# BEGIN chezmoi tailnet-ssh\nremove\n# END chezmoi tailnet-ssh\n",
      [],
    ),
    "keep\n",
  );
});

test("host directives, secret keys and invalid key blobs are rejected", () => {
  assert.throws(() =>
    validateSettings({ ...settings(), clientPublicKey: "PRIVATE KEY" }),
  );
  assert.throws(() =>
    validateSettings({ ...settings(), clientPublicKey: "ssh-ed25519 AAAA" }),
  );
  assert.throws(() =>
    validateSettings({
      ...settings(),
      hosts: [{ name: "*", hostname: "example", user: "example" }],
    }),
  );
  assert.throws(() =>
    validateSettings({
      ...settings(),
      hosts: [
        {
          name: "example",
          hostname: "example\nProxyCommand evil",
          user: "example",
        },
      ],
    }),
  );
  assert.throws(() =>
    validateSettings({
      ...settings(),
      hosts: [...settings().hosts, ...settings().hosts],
    }),
  );
});

test("a symlink, including a dangling one, must not be replaced", (t) => {
  const home = fixture(t);
  symlinkSync(join(home, "missing"), join(home, ".ssh/config"));
  assert.throws(() => applySettings(home, settings()), /regular file/);
});

test("tailnet SSH uses a machine-local private key and disables the shared agent", (t) => {
  const home = fixture(t);
  applySettings(home, settings(), "darwin");
  const config = readFileSync(join(home, ".ssh/config"), "utf8");
  assert.match(config, /IdentityAgent none/);
  assert.match(config, /IdentityFile ~\/.ssh\/tailnet-keys\/[a-f0-9]{64}/);
  assert.ok(!config.includes("1password"));
});

test("a missing local private key cannot fall back to a shared agent", (t) => {
  const home = fixture(t);
  rmSync(localKeyPath(home, key(1)));
  assert.throws(() => applySettings(home, settings()), /local private key/i);
});

test("generated private keys stay in their originating home and only public information is exported", (t) => {
  const home = fixture(t);
  const other = fixture(t);
  const generated = generateLocalKey(home);
  assert.deepEqual(Object.keys(generated).sort(), [
    "keyFingerprint",
    "publicKey",
  ]);
  assert.equal(generated.keyFingerprint, fingerprint(generated.publicKey));
  const privatePath = localKeyPath(home, generated.publicKey);
  assert.equal(statSync(privatePath).mode & 0o777, 0o600);
  assert.equal(statSync(dirname(privatePath)).mode & 0o777, 0o700);
  assert.ok(!existsSync(localKeyPath(other, generated.publicKey)));
  assert.equal(
    execFileSync("ssh-keygen", ["-y", "-P", "", "-f", privatePath], {
      encoding: "utf8",
    }).trim(),
    generated.publicKey,
  );
});

test("private-key mismatches and permissive file modes abort before changing SSH configuration", (t) => {
  const home = fixture(t);
  const path = localKeyPath(home, key(1));
  chmodSync(path, 0o644);
  assert.throws(() => applySettings(home, settings()), /permissions 600/);
  chmodSync(path, 0o600);
  key(2);
  copyFileSync(join(keyDirectory, "test-2"), path);
  assert.throws(() => applySettings(home, settings()), /does not match/);
  assert.ok(!existsSync(join(home, ".ssh/config")));
});

test("unmanaged defaults cannot override tailnet local-key selection or lose their scope", (t) => {
  const home = fixture(t);
  const config = join(home, ".ssh/config");
  writeFileSync(
    config,
    "Host *\n    IdentityAgent /pretend/shared-agent\n    ForwardAgent yes\n",
  );
  applySettings(home, settings());
  const tailnet = execFileSync("ssh", ["-G", "-F", config, "example"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  const other = execFileSync("ssh", ["-G", "-F", config, "unmanaged"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  assert.match(tailnet, /^identityagent none$/m);
  assert.match(tailnet, /^forwardagent no$/m);
  assert.match(other, /^identityagent \/pretend\/shared-agent$/m);
  assert.match(other, /^forwardagent yes$/m);
});

test("a key substituted on a receiver is rejected before any machine changes", (t) => {
  const model = scenario(t);
  writeFileSync(join(model.homes[1], ".ssh/tailnet-login.pub"), key(9));
  const before = authorized(model.home);
  assert.throws(
    () => syncFrom1Password(model.home, model.run),
    /unregistered client key/i,
  );
  assert.equal(model.uploads.length, 0);
  assert.equal(authorized(model.home), before);
});

test("plan and sync without approval cannot mutate SSH settings or install helpers", (t) => {
  const model = scenario(t, { rotation: true });
  const before = model.homes.map(authorized);
  const plan = syncFrom1Password(model.home, model.run);
  assert.match(plan.digest, /^[a-f0-9]{64}$/);
  assert.equal(model.uploads.length, 0);
  assert.deepEqual(model.homes.map(authorized), before);
  assert.deepEqual(model.homes.map(identity), model.initialKeys);
});

test("missing or mismatched 1Password key fingerprints fail closed", (t) => {
  const model = scenario(t);
  model.inventory.machines[0].keyFingerprint = fingerprint(key(9));
  assert.throws(
    () => syncFrom1Password(model.home, model.run),
    /fingerprint mismatch/,
  );
  delete model.inventory.machines[0].keyFingerprint;
  assert.throws(
    () => syncFrom1Password(model.home, model.run),
    /Invalid key fingerprint/,
  );
  assert.equal(model.uploads.length, 0);
});

test("the plan explicitly reports newly authorized temporary keys", (t) => {
  const model = scenario(t);
  model.inventory.machines[1].previousKeys.push({
    publicKey: key(9),
    keyFingerprint: fingerprint(key(9)),
  });
  const lines = [];
  t.mock.method(console, "log", (line) => lines.push(line));
  syncFrom1Password(model.home, model.run);
  assert.ok(lines.includes(`  temporary add ${fingerprint(key(9))}`));
  assert.ok(lines.includes(`  previous public key ${fingerprint(key(9))}`));
  assert.equal(model.uploads.length, 0);
});

test("legacy inventories and duplicate machines are rejected", (t) => {
  const model = scenario(t);
  delete model.inventory.version;
  assert.throws(() => syncFrom1Password(model.home, model.run), /version 3/);
  model.inventory.version = 3;
  model.inventory.machines.push({ ...model.inventory.machines[0] });
  assert.throws(
    () => syncFrom1Password(model.home, model.run),
    /Duplicate machine/,
  );
  assert.equal(model.uploads.length, 0);
});

test("private-key fields and SSH Key item references are rejected in the shared inventory", (t) => {
  const model = scenario(t);
  model.inventory.machines[0].privateKey = "PRIVATE KEY";
  assert.throws(
    () => syncFrom1Password(model.home, model.run),
    /public information only/,
  );
  delete model.inventory.machines[0].privateKey;
  model.inventory.machines[0].keyItem = "sharedSecretItem";
  assert.throws(
    () => syncFrom1Password(model.home, model.run),
    /public information only/,
  );
  assert.equal(model.uploads.length, 0);
});

test("an unknown controller identity is never used to contact receivers", (t) => {
  const model = scenario(t);
  writeFileSync(join(model.home, ".ssh/tailnet-login.pub"), key(9));
  // Use the original 1Password response while forbidding SSH entirely.
  const run = (command) => {
    assert.equal(command, "op");
    return JSON.stringify({
      value: JSON.stringify(model.inventory),
    });
  };
  assert.throws(
    () => syncFrom1Password(model.home, run),
    /Unregistered client key/,
  );
});

test("an incorrect approval or changed inventory cannot apply an old plan", (t) => {
  const model = scenario(t, { rotation: true });
  const apply = authorize(model);
  assert.throws(
    () => syncFrom1Password(model.home, model.run, "0".repeat(64)),
    /Plan changed/,
  );
  model.inventory.machines[1].publicKey = key(8);
  installTestKey(model.homes[1], 8);
  model.inventory.machines[1].keyFingerprint = fingerprint(key(8));
  assert.throws(apply, /Plan changed/);
  assert.equal(model.uploads.length, 0);
  assert.deepEqual(model.homes.map(identity), model.initialKeys);
});

test("SSH configuration or known_hosts changes invalidate approval before any writes", (t) => {
  const model = scenario(t);
  const apply = authorize(model);
  writeFileSync(join(model.homes[1], ".ssh/config"), "# concurrent edit\n", {
    flag: "a",
  });
  assert.throws(apply, /Plan changed/);
  const applyAgain = authorize(model);
  writeFileSync(join(model.home, ".ssh/known_hosts"), "# changed trust\n");
  assert.throws(applyAgain, /Plan changed/);
  assert.equal(model.uploads.length, 0);
});

test("the remote installer rejects a change between preflight and installation", (t) => {
  const model = scenario(t, { rotation: true });
  const apply = authorize(model);
  model.beforeUpload = (target) => {
    writeFileSync(join(model.homes[target], ".ssh/config"), "# race\n", {
      flag: "a",
    });
  };
  assert.throws(apply, /configuration changed since the approved plan/);
  assert.deepEqual(model.homes.map(identity), model.initialKeys);
  assert.equal(authorized(model.home).includes(key(4)), false);
});

test("unregistered managed keys are removed, never retained or propagated during staging", (t) => {
  const model = scenario(t, { rotation: true });
  const path = join(model.homes[1], ".ssh/authorized_keys");
  writeFileSync(
    path,
    authorized(model.homes[1]).replace(
      "# END chezmoi tailnet-ssh",
      `${key(9)}\n# END chezmoi tailnet-ssh`,
    ),
  );
  const apply = authorize(model);
  model.unavailable.add(key(4));
  assert.throws(apply, /no offered key can authenticate/);
  for (const home of model.homes) {
    assert.ok(!authorized(home).includes(key(9)));
    assert.ok(authorized(home).includes(key(1)));
  }
  for (const { payload } of model.uploads)
    assert.ok(!payload.settings.authorizedKeys.includes(key(9)));
});

test("malformed markers on any receiver abort before local or remote updates", (t) => {
  const model = scenario(t, { rotation: true });
  writeFileSync(
    join(model.homes[1], ".ssh/authorized_keys"),
    `# BEGIN chezmoi tailnet-ssh\n${key(1)}\n`,
  );
  assert.throws(() => syncFrom1Password(model.home, model.run), /Malformed/);
  assert.equal(model.uploads.length, 0);
  assert.equal(identity(model.home), key(1));
});

test("bootstrap only emits keys registered and pinned in 1Password", (t) => {
  const model = scenario(t, { rotation: true });
  const input = bootstrapFrom1Password("receiver1", model.run);
  assert.equal(input.clientPublicKey, key(5));
  assert.deepEqual(
    new Set(input.authorizedKeys),
    new Set([key(4), key(1), key(5), key(2)]),
  );
  assert.throws(
    () => bootstrapFrom1Password("unknown", model.run),
    /not registered/,
  );
  assert.equal(model.uploads.length, 0);
});

test("outgoing access checks use only the selected local private key", (t) => {
  const model = scenario(t);
  const privateDir = join(model.home, ".config/tailnet-ssh");
  mkdirSync(privateDir, { recursive: true });
  const hosts = model.inventory.machines.map(({ name, hostname, user }) => ({
    name,
    hostname,
    user,
  }));
  writeFileSync(
    join(privateDir, "settings.json"),
    JSON.stringify({ ...settings(), hosts }),
  );
  checkConnections(model.home, model.run);
  assert.equal(model.probes.length, 2);
  model.unavailable.add(key(1));
  assert.throws(
    () => checkConnections(model.home, model.run),
    /no offered key can authenticate/,
  );
});

test("WSL agent starts without requiring pwsh.exe on PATH", (t) => {
  const home = fixture(t);
  const agent = join(home, "agent");
  writeFileSync(
    agent,
    '#!/bin/sh\n[ "$#" -eq 0 ] || exit 1\nprintf "%s\\n" "export SSH_AUTH_SOCK=default-agent-socket"\n',
    { mode: 0o700 },
  );
  const helper = new URL(
    "../home/dot_shell_common/wsl_ssh_agent.sh",
    import.meta.url,
  ).pathname;
  const result = spawnSync(
    "/bin/sh",
    [
      "-c",
      '. "$1"; initialize_wsl_ssh_agent "$2" && printf "%s" "$SSH_AUTH_SOCK"',
      "wsl-agent-test",
      helper,
      agent,
    ],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "default-agent-socket");
});

test("failed WSL agent startup reports the error and does not evaluate its output", (t) => {
  const home = fixture(t);
  const agent = join(home, "agent");
  writeFileSync(
    agent,
    '#!/bin/sh\nprintf "%s\\n" "export SSH_AUTH_SOCK=wrong-agent"\nexit 1\n',
    { mode: 0o700 },
  );
  const helper = new URL(
    "../home/dot_shell_common/wsl_ssh_agent.sh",
    import.meta.url,
  ).pathname;
  const result = spawnSync(
    "/bin/sh",
    [
      "-c",
      '. "$1"; original_agent=$SSH_AUTH_SOCK; initialize_wsl_ssh_agent "$2"; status=$?; [ "$SSH_AUTH_SOCK" = "$original_agent" ] || exit 99; exit "$status"',
      "wsl-agent-test",
      helper,
      agent,
    ],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /could not start/);
});
