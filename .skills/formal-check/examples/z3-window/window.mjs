// Two time windows are closed intervals [start, end] with start <= end.
// Property, for every start and end: a window overlaps itself.
export const assumptions = (ctx) => {
  const { Int } = ctx;
  return Int.const("start").le(Int.const("end"));
};

export const property = (ctx) => {
  const { Int, And } = ctx;
  const [start, end] = [Int.const("start"), Int.const("end")];
  // overlaps(a, b) = a.start <= b.end and b.start <= a.end, with a = b.
  return And(start.le(end), start.le(end));
};
