// A usage cap of 10: a use is allowed only while fewer than 10 have been used.
// Property: an allowed use never takes the count past the cap.
const CAP = 10;

const allows = (used) => used < CAP;

// 0..20 covers both sides of the boundary, including counts already past it.
export const domain = () => Array.from({ length: 21 }, (_, used) => used);

export const property = (used) => !allows(used) || used + 1 <= CAP;
