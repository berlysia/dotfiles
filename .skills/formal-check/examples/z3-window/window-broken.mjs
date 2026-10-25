// The same check with the boundary comparison made strict (< for <=): a window
// whose start equals its end no longer overlaps itself.
export const assumptions = (ctx) => {
  const { Int } = ctx;
  return Int.const("start").le(Int.const("end"));
};

export const property = (ctx) => {
  const { Int, And } = ctx;
  const [start, end] = [Int.const("start"), Int.const("end")];
  return And(start.lt(end), start.lt(end));
};
