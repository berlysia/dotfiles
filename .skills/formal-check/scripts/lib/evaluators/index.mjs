// kind -> child-side evaluator. Later kinds add a row here; model-child.mjs
// looks the kind up in this table and never builds a path from it.
import { evaluate as enumerate } from "./enumerate.mjs";

export const EVALUATORS = Object.freeze({ enumerate });
