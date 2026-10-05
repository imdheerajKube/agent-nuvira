/**
 * A tiny browser-safe `basename`.
 *
 * `node:path` is not available in the dashboard bundle, and the pages only ever
 * need the last path segment — for a knowledge document's source file, for
 * example. Handles both `/` and `\` so a Windows path from the server reads the
 * same as a POSIX one.
 */
export function basename(p: string): string {
  const clean = p.replace(/[\\/]+$/, '');
  const idx = Math.max(clean.lastIndexOf('/'), clean.lastIndexOf('\\'));
  return idx >= 0 ? clean.slice(idx + 1) : clean;
}
