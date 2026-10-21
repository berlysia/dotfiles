import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import test, { after } from "node:test";
import { localKeyPath } from "../../home/dot_local/bin/executable_tailnet-ssh.mts";
import { createTailnetFixture } from "../lib/tailnet-ssh-fixture.mjs";

const fx = createTailnetFixture();
after(() => fx.cleanup());
const { key, scenario, authorize, identity, authorized } = fx;

test("the one-time migration uses the old agent without copying its private keys and switches entirely to local files", (t) => {
  const model = scenario(t, { rotation: true });
  model.inventory.machines.forEach((machine, index) => {
    machine.previousKeys[0].legacyAgent = true;
    rmSync(localKeyPath(model.homes[index], model.initialKeys[index]));
  });
  authorize(model)();
  assert.deepEqual(model.homes.map(identity), model.desiredKeys);
  model.homes.forEach((home, index) => {
    assert.ok(!existsSync(localKeyPath(home, model.initialKeys[index])));
    assert.match(
      readFileSync(join(home, ".ssh/config"), "utf8"),
      /IdentityAgent none/,
    );
    const input = JSON.parse(
      readFileSync(join(home, ".config/tailnet-ssh/settings.json"), "utf8"),
    );
    assert.equal(input.identityMode, "local");
    assert.ok(!authorized(home).includes(model.initialKeys[index]));
  });
});

test("failed new local-key authentication preserves old identities and can be retried", (t) => {
  const model = scenario(t, { rotation: true });
  const apply = authorize(model);
  model.unavailable.add(key(4));
  assert.throws(apply, /no offered key can authenticate/);
  assert.deepEqual(model.homes.map(identity), model.initialKeys);
  model.homes.forEach((home) => assert.ok(authorized(home).includes(key(1))));
  model.unavailable.clear();
  authorize(model)();
  assert.deepEqual(model.homes.map(identity), model.desiredKeys);
  model.homes.forEach((home) => assert.ok(!authorized(home).includes(key(1))));
});

test("a partial final phase remains retryable even when a receiver has removed the old controller key", (t) => {
  const model = scenario(t, { rotation: true, receivers: 2 });
  const apply = authorize(model);
  model.beforeUpload = (target, payload) => {
    if (target === 2 && payload.settings.clientPublicKey === key(6))
      throw new Error("receiver disconnected");
  };
  assert.throws(apply, /receiver disconnected/);
  assert.equal(identity(model.home), key(1));
  assert.equal(identity(model.homes[1]), key(5));
  assert.ok(!authorized(model.homes[1]).includes(key(1)));
  model.beforeUpload = undefined;
  authorize(model)();
  assert.deepEqual(model.homes.map(identity), model.desiredKeys);
  assert.ok(
    model.probes.every(
      ({ offered }) => offered.length === 1 && offered[0] === key(4),
    ),
  );
  for (const home of model.homes) {
    for (const old of model.initialKeys)
      assert.ok(!authorized(home).includes(old));
    const stored = JSON.parse(
      readFileSync(join(home, ".config/tailnet-ssh/settings.json"), "utf8"),
    );
    assert.deepEqual(stored.authorizedKeys, model.desiredKeys);
  }
});
