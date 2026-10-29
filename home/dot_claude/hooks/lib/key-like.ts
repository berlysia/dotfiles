const KEY_LIKE = /[A-Za-z0-9+/=_-]{32,}/g;

export function containsKeyLike(text: string): boolean {
  for (const token of text.match(KEY_LIKE) ?? []) {
    if (/[A-Z]/.test(token) && /[a-z]/.test(token) && /[0-9]/.test(token)) {
      return true;
    }
  }
  return false;
}
