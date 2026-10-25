// kind -> parent-side adapter. A new kind adds a row here and in
// evaluators/index.mjs; run.mjs and model-child.mjs do not branch on kind.
import * as enumerate from "./enumerate.mjs";
import * as tla from "./tla.mjs";
import * as z3 from "./z3.mjs";

export const ADAPTERS = Object.freeze({ enumerate, z3, tla });
