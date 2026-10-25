// Everything the harness prints may contain text from a model, a checker or a
// manifest, so terminals and log readers must not be able to act on it. One
// function is used for both the table and --json.

const MAX_CODE_POINTS = 4000;

// CSI (ESC [ ... final), OSC (ESC ] ... BEL or ESC \), and two-character
// escapes. A lone ESC left over is removed by stripControls below.
const ESCAPE_SEQUENCES =
  /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\)?|[@-Z\\-_])/g;
// C0 except tab and newline, DEL, C1, and bidirectional overrides/isolates.
// A function instead of a regex literal: the formatter rewrites \u202a-style
// escapes into the raw (invisible) characters, which would hide the very
// characters this module exists to remove.
function isControl(codePoint) {
  return (
    codePoint <= 0x08 ||
    (codePoint >= 0x0b && codePoint <= 0x1f) ||
    (codePoint >= 0x7f && codePoint <= 0x9f) ||
    (codePoint >= 0x202a && codePoint <= 0x202e) ||
    (codePoint >= 0x2066 && codePoint <= 0x2069)
  );
}

function stripControls(text) {
  let out = "";
  for (const char of text) if (!isControl(char.codePointAt(0))) out += char;
  return out;
}

// Strip first, cut second: cutting first could leave half an escape sequence
// that survives as plain text.
export function sanitize(text) {
  const cleaned = stripControls(String(text).replace(ESCAPE_SEQUENCES, ""));
  if (cleaned.length <= MAX_CODE_POINTS) return cleaned;
  // Spreading iterates by code point, so a surrogate pair is never split.
  return [...cleaned].slice(0, MAX_CODE_POINTS).join("");
}

// Strings in values and keys alike. fromEntries is used because assigning to
// `out["__proto__"]` would change the prototype instead of adding a key.
export function sanitizeDeep(value) {
  if (typeof value === "string") return sanitize(value);
  if (Array.isArray(value)) return value.map(sanitizeDeep);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, inner]) => [
        sanitize(key),
        sanitizeDeep(inner),
      ]),
    );
  }
  return value;
}
