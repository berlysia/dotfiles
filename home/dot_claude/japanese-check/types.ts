// 検査器とゲートが共有する、型と値の列挙。import は持たない。

export const GENRES = ["tech", "business", "essay"] as const;
export const STRUCTURES = ["business", "book", "keep", "caller"] as const;
export const READERS = ["adhd"] as const;

export type Genre = (typeof GENRES)[number];
export type Structure = (typeof STRUCTURES)[number];
export type Reader = (typeof READERS)[number];

// One candidate a check reports: a line, a 1-based UTF-16 column and the text
// of the range. It lives here so that analyze.ts and phrases.ts both read it
// without importing each other.
export interface Finding {
  rule: string;
  line: number;
  column: number;
  text: string;
  reason: string;
}
