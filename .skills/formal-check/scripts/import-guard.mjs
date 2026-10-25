// Preloaded into the model child (node --import). Collects the allow-list from
// the child's own arguments and registers the resolve hook that enforces it.
// The point is that what the human approved (model + declared imports) is what
// the model imports directly; it is not a sandbox (see import-guard-hooks.mjs).
import { realpathSync } from "node:fs";
import { register } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const real = (path) => {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
};

let model = "";
const imports = [];
const argv = process.argv.slice(2);
for (let i = 0; i + 1 < argv.length; i += 2) {
  if (argv[i] === "--model") model = argv[i + 1];
  else if (argv[i] === "--import") imports.push(argv[i + 1]);
}

const scriptsDir = real(dirname(fileURLToPath(import.meta.url)));
register("./import-guard-hooks.mjs", import.meta.url, {
  data: {
    model: real(model),
    imports: imports.map(real),
    // Not the whole scripts dir: the model must not be able to import run.mjs,
    // proc.mjs and friends. Only what the child itself needs.
    harnessFiles: ["model-child.mjs", "lib/codes.mjs", "lib/version.mjs"].map(
      (f) => join(scriptsDir, f),
    ),
    harnessDirs: [join(scriptsDir, "lib", "evaluators")],
  },
});
