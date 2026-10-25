// The same cap, with the boundary comparison off by one (<= for <): a count of
// exactly 10 is still allowed and the next use ends at 11.
const CAP = 10;

const allows = (used) => used <= CAP;

export const domain = () => Array.from({ length: 21 }, (_, used) => used);

export const property = (used) => !allows(used) || used + 1 <= CAP;
