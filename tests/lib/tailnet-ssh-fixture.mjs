import assert from "node:assert/strict";
import {
  copyFileSync,
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
  realpathSync,
} from "node:fs";
import { hostname, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync, execFileSync } from "node:child_process";
import {
  applySettings,
  syncFrom1Password,
  fingerprint,
  localKeyPath,
} from "../../home/dot_local/bin/executable_tailnet-ssh.mts";

// Fixtures shared by tests/tailnet-ssh.test.mjs and tests/heavy/tailnet-ssh.test.mjs.
// The key store is a factory: each test file creates its own and removes it in
// its own after(), so the two files share no module state.
export function createTailnetFixture() {
  const keyDirectory = realpathSync(
    mkdtempSync(join(tmpdir(), "tailnet-ssh-test-keys-")),
  );
  const testKeys = new Map();
  function key(number) {
    if (!testKeys.has(number)) {
      const file = join(keyDirectory, `test-${number}`);
      execFileSync("ssh-keygen", [
        "-q",
        "-t",
        "ed25519",
        "-N",
        "",
        "-C",
        "",
        "-f",
        file,
      ]);
      testKeys.set(number, readFileSync(`${file}.pub`, "utf8").trim());
    }
    return testKeys.get(number);
  }
  function installTestKey(home, number) {
    const publicKey = key(number);
    const target = localKeyPath(home, publicKey);
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    copyFileSync(join(keyDirectory, `test-${number}`), target);
    chmodSync(target, 0o600);
    writeFileSync(`${target}.pub`, `${publicKey}\n`, { mode: 0o600 });
  }

  function settings() {
    return {
      clientPublicKey: key(1),
      identityMode: "local",
      authorizedKeys: [key(1), key(2)],
      hosts: [
        { name: "example", hostname: "example.invalid", user: "example" },
      ],
    };
  }

  function fixture(t) {
    const home = realpathSync(mkdtempSync(join(tmpdir(), "tailnet-ssh-test-")));
    t.after(() => rmSync(home, { recursive: true, force: true }));
    mkdirSync(join(home, ".ssh"));
    installTestKey(home, 1);
    return home;
  }

  function scenario(t, { rotation = false, receivers = 1 } = {}) {
    const homes = Array.from({ length: receivers + 1 }, () => fixture(t));
    const initialKeys = homes.map((_, index) => key(index + 1));
    const desiredKeys = homes.map((_, index) =>
      key(rotation ? index + 4 : index + 1),
    );
    const inventory = {
      version: 3,
      vault: "Example",
      machines: homes.map((_, index) => {
        return {
          name: index ? `receiver${index}` : "controller",
          hostname: index ? `receiver${index}.invalid` : "controller.invalid",
          user: "example",
          platform: process.platform,
          localHostname: index ? `receiver${index}` : hostname(),
          publicKey: desiredKeys[index],
          keyFingerprint: fingerprint(desiredKeys[index]),
          previousKeys: rotation
            ? [
                {
                  publicKey: initialKeys[index],
                  keyFingerprint: fingerprint(initialKeys[index]),
                },
              ]
            : [],
        };
      }),
    };
    const hosts = inventory.machines.map(({ name, hostname, user }) => ({
      name,
      hostname,
      user,
    }));
    homes.forEach((home, index) => {
      installTestKey(home, index + 1);
      installTestKey(home, rotation ? index + 4 : index + 1);
      applySettings(home, {
        clientPublicKey: initialKeys[index],
        authorizedKeys: initialKeys,
        hosts,
      });
    });
    const model = {
      home: homes[0],
      homes,
      inventory,
      initialKeys,
      desiredKeys,
      uploads: [],
      probes: [],
      unavailable: new Set(),
      beforeUpload: undefined,
      beforeRead: undefined,
    };
    model.run = (command, args, options) => {
      if (command === "op") {
        assert.ok(args.includes("--format") && args.includes("json"));
        const label = args[args.indexOf("--fields") + 1];
        assert.ok(
          label === "label=notesPlain",
          "only the public-key inventory may be requested",
        );
        return JSON.stringify({
          value: JSON.stringify(inventory),
        });
      }
      assert.equal(command, "ssh");
      assert.ok(args.includes("StrictHostKeyChecking=yes"));
      assert.ok(args.includes("ForwardAgent=no"));
      assert.ok(
        args.includes("IdentityAgent=none") ||
          model.inventory.machines[0].previousKeys.some(
            (key) => key.legacyAgent === true,
          ),
      );
      const target = inventory.machines.findIndex((machine) =>
        args.includes(`${machine.user}@${machine.hostname}`),
      );
      assert.ok(target >= 0);
      const home = homes[target];
      const offered = args.flatMap((arg, index) =>
        arg === "-i"
          ? [
              readFileSync(
                args[index + 1].endsWith(".pub")
                  ? args[index + 1]
                  : `${args[index + 1]}.pub`,
                "utf8",
              ).trim(),
            ]
          : [],
      );
      const authorized = readFileSync(
        join(home, ".ssh/authorized_keys"),
        "utf8",
      );
      assert.ok(
        offered.some(
          (key) => !model.unavailable.has(key) && authorized.includes(key),
        ),
        "no offered key can authenticate",
      );
      if (args.at(-1) === "true") {
        model.probes.push({ target, offered });
        return "";
      }
      if (options.input) {
        assert.ok(!options.input.includes("BEGIN OPENSSH PRIVATE KEY"));
        const payload = JSON.parse(options.input);
        model.beforeUpload?.(target, payload);
        model.uploads.push({ target, payload });
      } else model.beforeRead?.(target);
      // Execute the actual snapshot reader / installer in a separate fixture home.
      const result = spawnSync("/bin/sh", ["-c", args.at(-1)], {
        input: options.input,
        encoding: "utf8",
        env: {
          ...process.env,
          HOME: home,
          PATH: `${dirname(process.execPath)}:${process.env.PATH}`,
        },
      });
      if (result.status !== 0) throw new Error(result.stderr);
      return result.stdout;
    };
    return model;
  }

  function authorize(model) {
    const plan = syncFrom1Password(model.home, model.run);
    return () => syncFrom1Password(model.home, model.run, plan.digest);
  }

  function identity(home) {
    return readFileSync(join(home, ".ssh/tailnet-login.pub"), "utf8").trim();
  }

  function authorized(home) {
    return readFileSync(join(home, ".ssh/authorized_keys"), "utf8");
  }

  return {
    keyDirectory,
    key,
    installTestKey,
    settings,
    fixture,
    scenario,
    authorize,
    identity,
    authorized,
    cleanup: () => rmSync(keyDirectory, { recursive: true, force: true }),
  };
}
