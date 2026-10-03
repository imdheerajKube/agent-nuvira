/**
 * Open a URL in the user's default browser — one implementation for every
 * surface that needs it (the dashboard's auto-open, the `website` command).
 *
 * Platform-specific by necessity: macOS uses `open`, Linux uses `xdg-open`, and
 * Windows uses the `start` shell built-in (which is why the Windows branch needs
 * `shell: true` and a throwaway first argument for the window title). A missing
 * launcher is never fatal — the caller prints the URL so the user can open it
 * themselves.
 */

import { spawn } from 'node:child_process';

/**
 * Best-effort open of `url`. Returns whether a launcher was spawned; a `false`
 * means the caller should show the URL instead. Never throws.
 */
export function openInBrowser(url: string): boolean {
  const platform = process.platform;
  const isWindows = platform === 'win32';
  const cmd = isWindows ? 'start' : platform === 'darwin' ? 'open' : 'xdg-open';

  try {
    // Windows `start` is a shell built-in, not an executable — needs shell: true.
    // Syntax: start "" "http://…" (the first arg is the window title).
    const args = isWindows ? ['', url] : [url];
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true, shell: isWindows });
    child.unref();
    return true;
  } catch {
    return false;
  }
}
