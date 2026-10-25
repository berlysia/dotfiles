// Child-side evaluator for kind "enumerate". Runs inside the model child, so it
// imports nothing.

// nonBoolean is the 1-based position of the offending input. firstFalse is the
// input itself; undefined is mapped to null so the key survives JSON.
export async function evaluate(namespace, _args) {
  if (typeof namespace.domain !== "function")
    throw new TypeError("the model must export domain()");
  if (typeof namespace.property !== "function")
    throw new TypeError("the model must export property(input)");
  let cases = 0;
  for await (const input of namespace.domain()) {
    cases += 1;
    const result = await namespace.property(input);
    if (result === false)
      return { cases, firstFalse: input === undefined ? null : input };
    if (result !== true) return { cases, nonBoolean: cases };
  }
  return { cases };
}
