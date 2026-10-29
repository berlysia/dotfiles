import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const ISOLATED = [
  "HOME",
  "XDG_DATA_HOME",
  "XDG_CONFIG_HOME",
  "ZAI_API_KEY",
  "ZAI_CODING_API_KEY",
  "SARASHINA_API_KEY",
];

/** Run fn with HOME at a fresh temp dir and the credential env vars removed. */
export function withHome(fn) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "delegation-offload-")));
  const saved = {};
  for (const k of Object.keys(process.env)) {
    if (ISOLATED.includes(k) || k.startsWith("OPENCODE_")) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  }
  process.env.HOME = root;
  const dir = join(root, ".local", "share", "opencode");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  try {
    return fn({ root, dir });
  } finally {
    for (const k of Object.keys(process.env)) {
      if (ISOLATED.includes(k) || k.startsWith("OPENCODE_")) {
        delete process.env[k];
      }
    }
    Object.assign(process.env, saved);
    rmSync(root, { recursive: true, force: true });
  }
}
