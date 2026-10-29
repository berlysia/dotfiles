// 制御文字、ゼロ幅、bidi、soft hyphen、CGJ、Hangul filler、variation selector、Unicode tag
export const INVISIBLE =
  /[\u0000-\u001f\u007f-\u009f­͏ᅟᅠ​-‏‪-‮⁠-⁩ㅤ︀-️﻿ﾠ\u{e0000}-\u{e007f}\u{e0100}-\u{e01ef}]/gu;

export function stripInvisible(
  text: string,
  { keepNewlines }: { keepNewlines: boolean },
): string {
  return text.replace(INVISIBLE, (char) =>
    keepNewlines && (char === "\n" || char === "\t") ? char : "",
  );
}
