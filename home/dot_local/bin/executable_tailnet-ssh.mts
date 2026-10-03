#!/usr/bin/env node
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import {
  execFileSync,
  type ExecFileSyncOptionsWithStringEncoding,
} from "node:child_process";
import { createHash } from "node:crypto";
import { homedir, hostname } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

interface Host {
  name: string;
  hostname: string;
  user: string;
}
interface Settings {
  clientPublicKey: string;
  authorizedKeys: string[];
  hosts: Host[];
  localName?: string;
  identityMode: "local" | "legacy-agent";
}
interface KeyReference {
  publicKey: string;
  keyFingerprint: string;
  legacyAgent?: true;
}
type RegisteredKey = KeyReference;
interface Machine extends Host {
  platform: "darwin" | "linux";
  localHostname: string;
  key: RegisteredKey;
  previousKeys: RegisteredKey[];
}
interface Inventory {
  version: 3;
  vault: string;
  machines: Machine[];
}
interface Snapshot {
  config: string;
  authorizedKeys: string;
  clientPublicKey: string;
  settings: string;
}
interface PlannedMachine {
  machine: Machine;
  before: Snapshot;
  stage: Settings;
  final: Settings;
}
interface SyncPlan {
  digest: string;
  scriptDigest: string;
  targets: PlannedMachine[];
}
type CommandRunner = (
  command: string,
  args: string[],
  options: ExecFileSyncOptionsWithStringEncoding,
) => string;
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected a JSON object");
  }
  return value as Record<string, unknown>;
}
function isArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}
const begin = "# BEGIN chezmoi tailnet-ssh";
const end = "# END chezmoi tailnet-ssh";

function publicKey(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^ssh-ed25519 [A-Za-z0-9+/]+={0,2}$/.test(value)
  ) {
    throw new Error("An Ed25519 public key without a comment is required");
  }
  const blob = Buffer.from(value.slice("ssh-ed25519 ".length), "base64");
  if (
    blob.length !== 51 ||
    blob.readUInt32BE(0) !== 11 ||
    blob.subarray(4, 15).toString() !== "ssh-ed25519" ||
    blob.readUInt32BE(15) !== 32
  ) {
    throw new Error("Invalid Ed25519 public key");
  }
  return value;
}

function token(
  value: unknown,
  label: string,
  pattern = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/,
) {
  if (typeof value !== "string" || !pattern.test(value)) {
    throw new Error(`Invalid ${label}`);
  }
  return value;
}

export function validateSettings(value: unknown): Settings {
  const input = record(value);
  if (!isArray(input.authorizedKeys) || !isArray(input.hosts)) {
    throw new Error(
      "Settings require clientPublicKey, authorizedKeys and hosts",
    );
  }
  const identityMode = input.identityMode ?? "local";
  if (identityMode !== "local" && identityMode !== "legacy-agent")
    throw new Error("Invalid identity mode");
  const clientPublicKey = publicKey(input.clientPublicKey);
  const authorizedKeys = [...new Set(input.authorizedKeys.map(publicKey))];
  const names = new Set<string>();
  const hosts = input.hosts.map((value) => {
    const host = record(value);
    const name = token(host.name, "host alias");
    if (names.has(name)) throw new Error(`Duplicate host alias: ${name}`);
    names.add(name);
    return {
      name,
      hostname: token(
        host.hostname,
        "hostname",
        /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/,
      ),
      user: token(host.user, "login user"),
    };
  });
  const localName =
    input.localName === undefined
      ? undefined
      : token(input.localName, "local machine name");
  if (localName !== undefined && !names.has(localName))
    throw new Error("Local machine name must refer to a configured host");
  return {
    clientPublicKey,
    identityMode,
    authorizedKeys,
    hosts,
    ...(localName !== undefined ? { localName } : {}),
  };
}

function regularFile(path: string) {
  const entry = lstatSync(path, { throwIfNoEntry: false });
  if (entry && !entry.isFile()) {
    throw new Error(`Expected a regular file: ${path}`);
  }
}

function readOptional(path: string) {
  regularFile(path);
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

export function replaceBlock(content: string, lines: string[]): string {
  const rows = content.split("\n");
  const starts = rows.flatMap((line, index) => (line === begin ? [index] : []));
  const stops = rows.flatMap((line, index) => (line === end ? [index] : []));
  const start = starts[0];
  const stop = stops[0];
  if (
    starts.length !== stops.length ||
    starts.length > 1 ||
    (start !== undefined && stop !== undefined && start >= stop)
  ) {
    throw new Error(
      "Malformed tailnet-ssh managed block; repair its markers first",
    );
  }
  const block = lines.length ? [begin, ...lines, end] : [];
  if (start !== undefined && stop !== undefined) {
    rows.splice(start, stop - start + 1, ...block);
    return rows.join("\n");
  }
  if (!block.length) return content;
  return `${content}${content && !content.endsWith("\n") ? "\n" : ""}${block.join("\n")}\n`;
}

function privateDirectory(path: string) {
  const entry = lstatSync(path, { throwIfNoEntry: false });
  if (entry && !entry.isDirectory()) {
    throw new Error(`Expected a real directory: ${path}`);
  }
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
}

function writePrivate(path: string, contents: string) {
  regularFile(path);
  if (existsSync(path) && readFileSync(path, "utf8") === contents) {
    chmodSync(path, 0o600);
    return;
  }
  const temporary = `${path}.tmp-${process.pid}`;
  try {
    writeFileSync(temporary, contents, { mode: 0o600, flag: "wx" });
    renameSync(temporary, path);
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

function readSnapshot(home: string): Snapshot {
  const directory = join(home, ".ssh");
  const entry = lstatSync(directory, { throwIfNoEntry: false });
  if (entry && !entry.isDirectory())
    throw new Error(`Expected a real directory: ${directory}`);
  return {
    config: readOptional(join(directory, "config")),
    authorizedKeys: readOptional(join(directory, "authorized_keys")),
    clientPublicKey: readOptional(join(directory, "tailnet-login.pub")),
    settings: readOptional(
      join(home, ".config", "tailnet-ssh", "settings.json"),
    ),
  };
}

function renderSnapshot(
  before: Snapshot,
  settings: Settings,
  platform: string,
): Snapshot {
  const configLines = settings.hosts.flatMap((host) => [
    `Host ${host.name}`,
    `    HostName ${host.hostname}`,
    `    User ${host.user}`,
    settings.identityMode === "legacy-agent"
      ? "    IdentityFile ~/.ssh/tailnet-login.pub"
      : `    IdentityFile ~/.ssh/tailnet-keys/${keyId(settings.clientPublicKey)}`,
    ...(settings.identityMode === "local" ? ["    IdentityAgent none"] : []),
    "    IdentitiesOnly yes",
    "    ForwardAgent no",
    ...(settings.identityMode === "legacy-agent" && platform === "darwin"
      ? [
          '    IdentityAgent "~/Library/Group Containers/2BUA8C4S2C.com.1password/t/agent.sock"',
        ]
      : []),
    "",
  ]);
  return {
    // Tailnet-specific values must precede broad user defaults. Reset Host scope
    // so the preserved Includes and defaults keep their original global scope.
    config: configLines.length
      ? replaceBlock("", [...configLines, "Host *", ""]) +
        replaceBlock(before.config, [])
      : replaceBlock(before.config, []),
    authorizedKeys: replaceBlock(
      before.authorizedKeys,
      settings.authorizedKeys.map(
        (key) => `from="100.64.0.0/10,fd7a:115c:a1e0::/48" ${key}`,
      ),
    ),
    clientPublicKey: `${settings.clientPublicKey}\n`,
    settings: `${JSON.stringify(settings, null, 2)}\n`,
  };
}

function commitSnapshot(
  home: string,
  next: Snapshot,
  persistSettings: boolean,
) {
  privateDirectory(join(home, ".ssh"));
  if (persistSettings) {
    const path = join(home, ".config", "tailnet-ssh", "settings.json");
    privateDirectory(dirname(path));
    // Persist desired state first: a later apply can repair an interrupted import.
    writePrivate(path, next.settings);
  }
  writePrivate(join(home, ".ssh", "authorized_keys"), next.authorizedKeys);
  writePrivate(join(home, ".ssh", "config"), next.config);
  // Switch the sending identity only after the receiving configuration is installed.
  writePrivate(join(home, ".ssh", "tailnet-login.pub"), next.clientPublicKey);
}

export function applySettings(
  home: string,
  input: unknown,
  platform: NodeJS.Platform = process.platform,
): Settings {
  const settings = validateSettings(input);
  if (settings.identityMode === "local")
    verifyLocalKey(home, settings.clientPublicKey);
  const next = renderSnapshot(readSnapshot(home), settings, platform);
  commitSnapshot(home, next, false);
  return settings;
}

function importSettings(home: string, input: unknown) {
  const settings = validateSettings(input);
  if (settings.identityMode === "local")
    verifyLocalKey(home, settings.clientPublicKey);
  const next = renderSnapshot(readSnapshot(home), settings, process.platform);
  commitSnapshot(home, next, true);
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function fingerprint(value: unknown): string {
  const key = publicKey(value);
  const blob = Buffer.from(key.slice("ssh-ed25519 ".length), "base64");
  return `SHA256:${createHash("sha256").update(blob).digest("base64").replace(/=+$/, "")}`;
}

function keyId(value: unknown): string {
  return Buffer.from(
    fingerprint(value).slice("SHA256:".length),
    "base64",
  ).toString("hex");
}

export function localKeyPath(home: string, key: unknown): string {
  return join(home, ".ssh", "tailnet-keys", keyId(key));
}

function verifyLocalKey(home: string, key: unknown): string {
  const expected = publicKey(key);
  const path = localKeyPath(home, expected);
  const directory = lstatSync(dirname(path), { throwIfNoEntry: false });
  const entry = lstatSync(path, { throwIfNoEntry: false });
  if (!directory?.isDirectory() || !entry?.isFile())
    throw new Error(
      "Machine-local private key is missing or not a regular file",
    );
  if ((entry.mode & 0o777) !== 0o600)
    throw new Error("Machine-local private key must have permissions 600");
  const derived = execFileSync("ssh-keygen", ["-y", "-P", "", "-f", path], {
    encoding: "utf8",
    timeout: 10_000,
  }).trim();
  if (derived !== expected)
    throw new Error(
      "Machine-local private key does not match the registered public key",
    );
  return path;
}

export function generateLocalKey(
  home: string,
  run: CommandRunner = execFileSync,
): KeyReference {
  privateDirectory(join(home, ".ssh"));
  const directory = join(home, ".ssh", "tailnet-keys");
  privateDirectory(directory);
  const temporary = mkdtempSync(join(directory, ".generate-"));
  try {
    const generated = join(temporary, "identity");
    run(
      "ssh-keygen",
      ["-q", "-t", "ed25519", "-N", "", "-C", "", "-f", generated],
      { encoding: "utf8", timeout: 30_000 },
    );
    const key = publicKey(readOptional(`${generated}.pub`).trim());
    const target = localKeyPath(home, key);
    regularFile(target);
    regularFile(`${target}.pub`);
    if (existsSync(target) || existsSync(`${target}.pub`))
      throw new Error("Generated key already exists; refusing to overwrite");
    chmodSync(generated, 0o600);
    renameSync(generated, target);
    writePrivate(`${target}.pub`, `${key}\n`);
    verifyLocalKey(home, key);
    // Export only public information. The private key stays in this home.
    return { publicKey: key, keyFingerprint: fingerprint(key) };
  } finally {
    rmSync(temporary, { recursive: true });
  }
}

function snapshotHash(snapshot: Snapshot): string {
  return hash(JSON.stringify(snapshot));
}

function shellQuote(value: string) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function read1PasswordField(
  run: CommandRunner,
  item: string,
  label: string,
  vault?: string,
): string {
  const args = [
    "item",
    "get",
    item,
    "--fields",
    `label=${label}`,
    "--format",
    "json",
  ];
  if (vault) args.push("--vault", vault);
  const result: unknown = JSON.parse(run("op", args, { encoding: "utf8" }));
  const field = isArray(result)
    ? result.find((entry) => {
        const field = record(entry);
        return field.label === label || field.id === label;
      })
    : result;
  const value =
    typeof field === "string"
      ? field
      : field === undefined
        ? undefined
        : record(field).value;
  if (typeof value !== "string" || !value.trim())
    throw new Error(`1Password field is empty or invalid: ${label}`);
  return value;
}

function loadInventory(run: CommandRunner): Inventory {
  const input = record(
    JSON.parse(read1PasswordField(run, "Tailnet SSH inventory", "notesPlain")),
  );
  if (
    Object.keys(input).some(
      (field) => !["version", "vault", "machines"].includes(field),
    )
  )
    throw new Error("Inventory must contain public information only");
  if (input.version !== 3)
    throw new Error(
      "Inventory version 3 with public keys and pinned fingerprints is required",
    );
  const vault = token(input.vault, "vault");
  if (!isArray(input.machines) || !input.machines.length)
    throw new Error("The private inventory must contain machines");
  const registered = new Set<string>();
  const readKey = (
    input: Record<string, unknown>,
    previous = false,
  ): RegisteredKey => {
    const allowed = new Set([
      "publicKey",
      "keyFingerprint",
      ...(previous ? ["legacyAgent"] : []),
    ]);
    if (previous && Object.keys(input).some((field) => !allowed.has(field)))
      throw new Error("Previous keys must contain public information only");
    const keyFingerprint = token(
      input.keyFingerprint,
      "key fingerprint",
      /^SHA256:[A-Za-z0-9+/]{43}$/,
    );
    const key = publicKey(input.publicKey);
    if (fingerprint(key) !== keyFingerprint)
      throw new Error("Registered public key fingerprint mismatch");
    if (registered.has(keyFingerprint))
      throw new Error(`A key is registered more than once: ${keyFingerprint}`);
    if (
      input.legacyAgent !== undefined &&
      (!previous || input.legacyAgent !== true)
    )
      throw new Error(
        "Legacy agents are only permitted for explicitly registered previous keys during migration",
      );
    registered.add(keyFingerprint);
    return {
      publicKey: key,
      keyFingerprint,
      ...(input.legacyAgent === true ? { legacyAgent: true } : {}),
    };
  };
  const names = new Set<string>();
  const destinations = new Set<string>();
  const identities = new Set<string>();
  const machines = input.machines.map((value): Machine => {
    const machine = record(value);
    const fields = new Set([
      "name",
      "hostname",
      "user",
      "platform",
      "localHostname",
      "publicKey",
      "keyFingerprint",
      "previousKeys",
    ]);
    if (Object.keys(machine).some((field) => !fields.has(field)))
      throw new Error(
        "Machine registrations must contain public information only",
      );
    const name = token(machine.name, "machine name");
    const address = token(
      machine.hostname,
      "hostname",
      /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/,
    );
    const user = token(machine.user, "login user");
    const platform = machine.platform;
    if (platform !== "darwin" && platform !== "linux")
      throw new Error(`Unsupported platform: ${name}`);
    const localHostname = token(machine.localHostname, "local hostname");
    const identity = `${platform}/${normalizeHostname(localHostname)}`;
    const destination = `${user}@${address.toLowerCase()}`;
    if (
      names.has(name) ||
      destinations.has(destination) ||
      identities.has(identity)
    )
      throw new Error(`Duplicate machine registration: ${name}`);
    names.add(name);
    destinations.add(destination);
    identities.add(identity);
    const previous = machine.previousKeys ?? [];
    if (!isArray(previous))
      throw new Error(`previousKeys must be an array: ${name}`);
    return {
      name,
      hostname: address,
      user,
      platform,
      localHostname,
      key: readKey(machine),
      previousKeys: previous.map((entry) => readKey(record(entry), true)),
    };
  });
  return { version: 3, vault, machines };
}

function normalizeHostname(value: string): string {
  return value.toLowerCase().replace(/\.local$/, "");
}

function localMachine(inventory: Inventory): Machine {
  const matches = inventory.machines.filter(
    (machine) =>
      machine.platform === process.platform &&
      normalizeHostname(machine.localHostname) ===
        normalizeHostname(hostname()),
  );
  const local = matches[0];
  if (matches.length !== 1 || !local)
    throw new Error(
      "Inventory must match this computer's platform and localHostname exactly once",
    );
  return local;
}

function settingsFor(
  inventory: Inventory,
  machine: Machine,
  includePrevious: boolean,
): Settings {
  return validateSettings({
    clientPublicKey: machine.key.publicKey,
    identityMode: "local",
    localName: machine.name,
    authorizedKeys: inventory.machines.flatMap((entry) => [
      entry.key.publicKey,
      ...(includePrevious
        ? entry.previousKeys.map((key) => key.publicKey)
        : []),
    ]),
    hosts: inventory.machines.map(({ name, hostname, user }) => ({
      name,
      hostname,
      user,
    })),
  });
}

export function bootstrapFrom1Password(
  name: string,
  run: CommandRunner = execFileSync,
): Settings {
  const inventory = loadInventory(run);
  const machine = inventory.machines.find((entry) => entry.name === name);
  if (!machine) throw new Error(`Machine is not registered: ${name}`);
  return settingsFor(inventory, machine, true);
}

function sshArgs(
  home: string,
  machine: Host,
  identity: string,
  fallbackIdentity?: string,
  legacyAgent = false,
): string[] {
  return [
    "-F",
    "/dev/null",
    "-o",
    "BatchMode=yes",
    "-o",
    "StrictHostKeyChecking=yes",
    "-o",
    `UserKnownHostsFile="${join(home, ".ssh", "known_hosts")}"`,
    "-o",
    "GlobalKnownHostsFile=/dev/null",
    "-o",
    "ConnectTimeout=10",
    "-o",
    "ServerAliveInterval=5",
    "-o",
    "ServerAliveCountMax=2",
    "-o",
    "ForwardAgent=no",
    "-o",
    "ClearAllForwardings=yes",
    "-o",
    "ForwardX11=no",
    "-o",
    "IdentitiesOnly=yes",
    ...(!legacyAgent
      ? ["-o", "IdentityAgent=none"]
      : process.platform === "darwin"
        ? [
            "-o",
            `IdentityAgent="${join(homedir(), "Library/Group Containers/2BUA8C4S2C.com.1password/t/agent.sock")}"`,
          ]
        : []),
    "-i",
    identity,
    ...(fallbackIdentity ? ["-i", fallbackIdentity] : []),
    `${machine.user}@${machine.hostname}`,
  ];
}

function nodeCommand(script: string): string {
  return `if command -v node >/dev/null 2>&1; then node -e ${shellQuote(script)}; else "$HOME/.local/bin/mise" exec -- node -e ${shellQuote(script)}; fi`;
}

// Used by both the read-only preflight and the remote installer's comparison.
const snapshotReader = `
const fs = require('node:fs');
const path = require('node:path');
const home = require('node:os').homedir();
const directory = path.join(home, '.ssh');
const sshEntry = fs.lstatSync(directory, {throwIfNoEntry:false});
if (sshEntry && !sshEntry.isDirectory()) throw new Error('Expected a real .ssh directory');
function read(file) {
  const entry = fs.lstatSync(file, {throwIfNoEntry:false});
  if (entry && !entry.isFile()) throw new Error('Expected a regular file: ' + file);
  return entry ? fs.readFileSync(file, 'utf8') : '';
}
const snapshot = {
  config: read(path.join(directory, 'config')),
  authorizedKeys: read(path.join(directory, 'authorized_keys')),
  clientPublicKey: read(path.join(directory, 'tailnet-login.pub')),
  settings: read(path.join(home, '.config', 'tailnet-ssh', 'settings.json')),
};
`;

function parseSnapshot(value: string): Snapshot {
  const input = record(JSON.parse(value));
  const string = (value: unknown): string => {
    if (typeof value !== "string") throw new Error("Invalid SSH snapshot");
    return value;
  };
  return {
    config: string(input.config),
    authorizedKeys: string(input.authorizedKeys),
    clientPublicKey: string(input.clientPublicKey),
    settings: string(input.settings),
  };
}

function keysInBlock(content: string): string[] {
  replaceBlock(content, []); // Validate markers before interpreting the block.
  const block = content.split(`${begin}\n`)[1]?.split(`\n${end}`)[0];
  if (!block) return [];
  return block
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => {
      const match =
        /^(?:from="100\.64\.0\.0\/10,fd7a:115c:a1e0::\/48" )?(ssh-ed25519 [A-Za-z0-9+/]+={0,2})$/.exec(
          line,
        );
      if (!match)
        throw new Error(
          "Unexpected directive in managed authorized_keys block",
        );
      return publicKey(match[1]);
    });
}

// A remote key-pair check returns no private material, only the SSH snapshot.
const remoteKeyVerifier = `
function verifyLocalKey(expected) {
  const crypto = require('node:crypto');
  const blob = Buffer.from(expected.slice('ssh-ed25519 '.length), 'base64');
  const id = crypto.createHash('sha256').update(blob).digest('hex');
  const keys = path.join(home, '.ssh', 'tailnet-keys');
  const file = path.join(keys, id);
  const directoryEntry = fs.lstatSync(keys, {throwIfNoEntry:false});
  const entry = fs.lstatSync(file, {throwIfNoEntry:false});
  if (!directoryEntry || !directoryEntry.isDirectory() || !entry || !entry.isFile()) throw new Error('Machine-local private key is missing or not a regular file');
  if ((entry.mode & 0o777) !== 0o600) throw new Error('Machine-local private key must have permissions 600');
  const derived = require('node:child_process').execFileSync('ssh-keygen', ['-y', '-P', '', '-f', file], {encoding:'utf8', timeout:10000}).trim();
  if (derived !== expected) throw new Error('Machine-local private key does not match the registered public key');
}
`;

function createPlan(
  home: string,
  inventory: Inventory,
  run: CommandRunner,
  script: string,
  probeKey: string,
  identity: string,
  legacyAgent: boolean,
): SyncPlan {
  const local = localMachine(inventory);
  const targets = inventory.machines.map((machine): PlannedMachine => {
    const before =
      machine === local
        ? readSnapshot(home)
        : parseSnapshot(
            run(
              "ssh",
              [
                ...sshArgs(home, machine, identity, probeKey, legacyAgent),
                nodeCommand(
                  `${snapshotReader}${remoteKeyVerifier}verifyLocalKey(${JSON.stringify(machine.key.publicKey)});process.stdout.write(JSON.stringify(snapshot));`,
                ),
              ],
              { encoding: "utf8", timeout: 30_000 },
            ),
          );
    const client = publicKey(before.clientPublicKey.trim());
    if (
      ![machine.key, ...machine.previousKeys].some(
        (key) => key.publicKey === client,
      )
    )
      throw new Error(
        `Unregistered client key on ${machine.name}; check the machine locally`,
      );
    const final = settingsFor(inventory, machine, false);
    const selected = [machine.key, ...machine.previousKeys].find(
      (key) => key.publicKey === client,
    );
    const stage: Settings = {
      ...settingsFor(inventory, machine, true),
      clientPublicKey: client,
      identityMode: selected?.legacyAgent ? "legacy-agent" : "local",
    };
    renderSnapshot(before, stage, machine.platform);
    keysInBlock(before.authorizedKeys);
    return { machine, before, stage, final };
  });
  const scriptDigest = hash(script);
  const digest = hash(
    JSON.stringify({
      inventory,
      targets,
      scriptDigest,
      knownHosts: hash(readOptional(join(home, ".ssh", "known_hosts"))),
    }),
  );
  return { digest, scriptDigest, targets };
}

function printPlan(plan: SyncPlan) {
  console.log(
    "tailnet-ssh: review this plan (no SSH configuration has changed)",
  );
  console.log(`helper SHA256:${plan.scriptDigest}`);
  for (const target of plan.targets) {
    const old = new Set(
      keysInBlock(target.before.authorizedKeys).map(fingerprint),
    );
    const next = new Set(target.final.authorizedKeys.map(fingerprint));
    console.log(
      `${target.machine.name}: ${target.machine.user}@${target.machine.hostname}`,
    );
    console.log(
      `  client ${fingerprint(target.before.clientPublicKey.trim())} -> ${fingerprint(target.final.clientPublicKey)}`,
    );
    console.log(`  registered public key ${target.machine.key.keyFingerprint}`);
    for (const previous of target.machine.previousKeys) {
      console.log(
        `  previous public key ${previous.keyFingerprint}${previous.legacyAgent ? " (legacy agent)" : ""}`,
      );
    }
    for (const key of next) if (!old.has(key)) console.log(`  add ${key}`);
    for (const key of old) if (!next.has(key)) console.log(`  remove ${key}`);
    for (const key of target.stage.authorizedKeys) {
      const pin = fingerprint(key);
      if (!next.has(pin))
        console.log(`  temporary ${old.has(pin) ? "keep" : "add"} ${pin}`);
    }
    console.log(
      `  configuration snapshot SHA256:${snapshotHash(target.before)}`,
    );
  }
  console.log(
    `node ~/.local/bin/tailnet-ssh.mts sync --approve ${plan.digest}`,
  );
}

const installer = `${snapshotReader}
const cp = require('node:child_process');
const crypto = require('node:crypto');
const payload = JSON.parse(fs.readFileSync(0, 'utf8'));
const digest = crypto.createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
if (digest !== payload.expectedSnapshot) throw new Error('SSH configuration changed since the approved plan');
const directoryBin = path.join(home, '.local', 'bin');
const directoryEntry = fs.lstatSync(directoryBin, {throwIfNoEntry:false});
if (directoryEntry && !directoryEntry.isDirectory()) throw new Error('Expected a real helper directory');
fs.mkdirSync(directoryBin, {recursive:true, mode:0o700});
const target = path.join(directoryBin, 'tailnet-ssh.mts');
const entry = fs.lstatSync(target, {throwIfNoEntry:false});
if (entry && !entry.isFile()) throw new Error('tailnet-ssh must be a regular file');
const temporary = path.join(directoryBin, 'tailnet-ssh.tmp-' + process.pid + '.mts');
try {
  fs.writeFileSync(temporary, payload.script, {mode:0o700, flag:'wx'});
  const url = require('node:url').pathToFileURL(temporary).href;
  cp.execFileSync(process.execPath, ['-e', 'import(' + JSON.stringify(url) + ')']);
  fs.renameSync(temporary, target);
} finally {
  if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
}
cp.execFileSync(process.execPath, [target, 'import'], {input:JSON.stringify(payload.settings), stdio:['pipe','inherit','inherit']});
`;

export function syncFrom1Password(
  home: string,
  run: CommandRunner = execFileSync,
  approval?: string,
): SyncPlan {
  const inventory = loadInventory(run);
  const local = localMachine(inventory);
  const current = publicKey(readSnapshot(home).clientPublicKey.trim());
  const selected = [local.key, ...local.previousKeys].find(
    (key) => key.publicKey === current,
  );
  if (!selected)
    throw new Error(
      `Unregistered client key on ${local.name}; check the machine locally`,
    );
  const legacyAgent = selected.legacyAgent === true;
  const identity = legacyAgent
    ? join(home, ".ssh", "tailnet-login.pub")
    : verifyLocalKey(home, current);
  const probeKey = verifyLocalKey(home, local.key.publicKey);
  const script = readFileSync(new URL(import.meta.url), "utf8");
  // Preflight and staging may use either registered controller key. This also
  // reaches receivers that already finalized before an earlier run failed.
  const plan = createPlan(
    home,
    inventory,
    run,
    script,
    probeKey,
    identity,
    legacyAgent,
  );
  if (approval === undefined) {
    printPlan(plan);
    return plan;
  }
  if (!/^[a-f0-9]{64}$/.test(approval) || plan.digest !== approval)
    throw new Error(
      "Plan changed or approval is invalid; review a fresh plan before syncing",
    );
  const apply = (
    target: PlannedMachine,
    settings: Settings,
    expected: Snapshot,
    final: boolean,
  ) => {
    if (target.machine === local) {
      if (snapshotHash(readSnapshot(home)) !== snapshotHash(expected))
        throw new Error(
          "Local SSH configuration changed since the approved plan",
        );
      importSettings(home, settings);
    } else {
      const args = final
        ? sshArgs(home, target.machine, probeKey)
        : sshArgs(home, target.machine, identity, probeKey, legacyAgent);
      run("ssh", [...args, nodeCommand(installer)], {
        encoding: "utf8",
        timeout: 30_000,
        input: JSON.stringify({
          script,
          settings,
          expectedSnapshot: snapshotHash(expected),
        }),
        stdio: ["pipe", "inherit", "inherit"],
      });
    }
  };
  // Stage only explicitly registered keys and preserve each sending identity.
  const remoteThenLocal = [
    ...plan.targets.filter((target) => target.machine !== local),
    ...plan.targets.filter((target) => target.machine === local),
  ];
  for (const target of remoteThenLocal) {
    console.log(`tailnet-ssh: stage ${target.machine.name}`);
    apply(target, target.stage, target.before, false);
  }
  // The new controller key must authenticate independently of the old one.
  for (const target of plan.targets) {
    if (target.machine === local) continue;
    run("ssh", [...sshArgs(home, target.machine, probeKey), "true"], {
      encoding: "utf8",
      timeout: 30_000,
    });
  }
  for (const target of remoteThenLocal) {
    console.log(`tailnet-ssh: final ${target.machine.name}`);
    apply(
      target,
      target.final,
      renderSnapshot(target.before, target.stage, target.machine.platform),
      true,
    );
  }
  console.log(
    "tailnet-ssh: all machines synchronized; verify outgoing access on each machine before deleting previous keys",
  );
  return plan;
}

export function checkConnections(
  home: string,
  run: CommandRunner = execFileSync,
) {
  const settings = validateSettings(
    JSON.parse(
      readOptional(join(home, ".config", "tailnet-ssh", "settings.json")),
    ),
  );
  if (settings.identityMode !== "local")
    throw new Error(
      "Finish migrating to a machine-local key before checking connections",
    );
  const identity = verifyLocalKey(home, settings.clientPublicKey);
  for (const host of settings.hosts) {
    if (host.name === settings.localName) continue;
    run("ssh", [...sshArgs(home, host, identity), "true"], {
      encoding: "utf8",
      timeout: 30_000,
    });
    console.log(`tailnet-ssh: authenticated ${host.name}`);
  }
}

function main() {
  const command = process.argv[2] ?? "apply";
  const home = homedir();
  const settingsPath = join(home, ".config", "tailnet-ssh", "settings.json");
  if (command === "keygen") {
    if (process.argv.length !== 3) throw new Error("Usage: tailnet-ssh keygen");
    process.stdout.write(
      `${JSON.stringify(generateLocalKey(home), null, 2)}\n`,
    );
  } else if (command === "import") {
    importSettings(home, JSON.parse(readFileSync(0, "utf8")));
    console.log(
      "tailnet-ssh: private settings imported and SSH configuration applied",
    );
  } else if (command === "apply") {
    if (!existsSync(settingsPath)) return;
    applySettings(home, JSON.parse(readOptional(settingsPath)));
    console.log("tailnet-ssh: SSH configuration applied");
  } else if (command === "plan" || command === "sync") {
    const args = process.argv.slice(3);
    if (command === "plan" && args.length)
      throw new Error("plan does not take arguments");
    if (args.length && (args.length !== 2 || args[0] !== "--approve"))
      throw new Error("Usage: tailnet-ssh sync --approve <plan hash>");
    syncFrom1Password(home, execFileSync, args[1]);
  } else if (command === "bootstrap") {
    const name = process.argv[3];
    if (!name || process.argv.length !== 4)
      throw new Error("Usage: tailnet-ssh bootstrap <registered machine name>");
    process.stdout.write(
      `${JSON.stringify(bootstrapFrom1Password(name), null, 2)}\n`,
    );
  } else if (command === "check") {
    checkConnections(home);
  } else {
    throw new Error(
      "Usage: tailnet-ssh [keygen|apply|import|bootstrap <machine>|plan|sync --approve <hash>|check]",
    );
  }
}

if (
  process.argv[1] &&
  pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url
) {
  try {
    main();
  } catch (error) {
    console.error(
      `tailnet-ssh: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  }
}
