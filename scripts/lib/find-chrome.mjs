/**
 * Locate a Chrome/Chromium binary, or null.
 *
 * Shared by both browser smoke scripts (`smoke-dashboard-walk.mjs`, which reads
 * computed styles out of a page, and `smoke-dashboard-input.mjs`, which sends it
 * real mouse and key events). They need DIFFERENT things from the browser but the
 * same browser, and a second copy of this list would rot separately.
 */

import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

/**
 * An explicit $CHROME_PATH always wins so CI can pin one. Otherwise the usual
 * per-platform locations are tried, then PATH lookup on Unix.
 */
export function findChrome() {
  if (process.env.CHROME_PATH) {
    return existsSync(process.env.CHROME_PATH) ? process.env.CHROME_PATH : null;
  }

  const candidates = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/snap/bin/chromium',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  for (const name of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser']) {
    try {
      const found = execFileSync(process.platform === 'win32' ? 'where' : 'which', [name], {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
        // `where` on Windows emits CRLF, so split on either ending.
      }).split(/\r?\n/)[0].trim();
      if (found && existsSync(found)) return found;
    } catch {
      // Not on PATH — try the next.
    }
  }
  return null;
}
