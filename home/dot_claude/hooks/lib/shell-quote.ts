/**
 * Quote a value so that sourcing `export NAME=<quoted>` in a POSIX shell
 * yields the value byte for byte. Inside single quotes nothing is special
 * except the quote itself, which is closed, escaped and reopened.
 */
export function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}
