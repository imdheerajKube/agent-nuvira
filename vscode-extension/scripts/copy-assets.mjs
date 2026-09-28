#!/usr/bin/env node
/**
 * Copy non-TypeScript assets the extension needs at runtime into `out/`.
 *
 * WHY: `tsc` compiles `.ts` and nothing else, and a packaged VSIX excludes
 * `src/**`. The chat webview template therefore has to live *beside the compiled
 * JS* to be readable after packaging. Copying it at build time (rather than
 * committing a second copy under `out/`) guarantees the shipped template can
 * never drift from its source, and lets `src/` be excluded wholesale.
 */

import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/** [source relative to package root, destination relative to package root] */
const ASSETS = [['src/chatPanel.html', 'out/chatPanel.html']];

let copied = 0;
for (const [from, to] of ASSETS) {
  const src = join(root, from);
  const dest = join(root, to);
  if (!existsSync(src)) {
    console.error(`copy-assets: missing source ${from}`);
    process.exit(1);
  }
  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(src, dest);
  copied += 1;
}

console.log(`copy-assets: copied ${copied} asset(s)`);
